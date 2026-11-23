/*
 * Library operations: import an image (URL or container registry), edit,
 * delete, create the library namespace and share it with every folder.
 * Uploads live in ./upload.ts.
 */

import { editPatch, LibraryItem, libraryManifests, Media, SHARING_NAME } from '../model/library';
import { Obj } from '../model/types';
import { runTask } from './actions';
import { kdelete, kmerge, kpost, kreq } from './client';
import { PATHS } from './resources';
import { SPATHS } from './storageResources';

const target = (ns: string, name: string) => ({ kind: 'image' as const, namespace: ns, name });

/** Creates an image's DataVolume and waits for the import. */
export function importImage(dv: Obj, title: string) {
  const ns = dv.metadata.namespace as string;
  return runTask(
    {
      title,
      target: target(ns, dv.metadata.name),
      until: { type: 'dataVolume', namespace: ns, name: dv.metadata.name },
      timeoutMs: 3 * 60 * 60 * 1000,
    },
    () => kpost(PATHS.dv(ns), dv)
  );
}

export function editImage(item: LibraryItem, p: { displayName?: string; os?: string; description?: string; media?: Media }) {
  const patch = editPatch(p);
  return runTask({ title: 'Edit image', target: target(item.namespace, item.name) }, async () => {
    if (item.dv) await kmerge(PATHS.dv(item.namespace, item.name), patch);
    // The claim carries the same annotations, for images that are only a claim or read from it.
    if (item.pvc) await kmerge(PATHS.pvc(item.namespace, item.name), patch).catch(e => (item.dv ? undefined : Promise.reject(e)));
  });
}

export function deleteImage(item: LibraryItem) {
  return runTask({ title: `Delete image ${item.displayName}`, target: target(item.namespace, item.name) }, async () => {
    if (item.dv) await kdelete(PATHS.dv(item.namespace, item.name));
    else if (item.pvc) await kdelete(PATHS.pvc(item.namespace, item.name));
  });
}

async function createOrKeep(path: string, body: Obj) {
  try {
    await kpost(path, body);
  } catch (e: any) {
    if (e?.status !== 409) throw e;
  }
}

/** Lets every folder clone from the library (CDI checks datavolumes/source in the source namespace). */
export function shareLibrary(ns: string) {
  const m = libraryManifests(ns);
  return runTask({ title: 'Share the library with every folder', target: { kind: 'folder', name: ns } }, async () => {
    await createOrKeep(SPATHS.roles(ns), m.role);
    await createOrKeep(SPATHS.roleBindings(ns), m.binding);
  });
}

export function createLibrary(ns: string) {
  const m = libraryManifests(ns);
  return runTask({ title: 'Create the image library', target: { kind: 'folder', name: ns } }, async () => {
    await createOrKeep(PATHS.ns(), m.namespace);
    await createOrKeep(SPATHS.roles(ns), m.role);
    await createOrKeep(SPATHS.roleBindings(ns), m.binding);
  });
}

export type SharingState = 'shared' | 'missing' | 'unknown';

/** Is the library shared? 'unknown' when the user may not read RBAC there. */
export async function sharingState(ns: string): Promise<SharingState> {
  try {
    await kreq(SPATHS.roleBindings(ns, SHARING_NAME));
    return 'shared';
  } catch (e: any) {
    if (e?.status === 404) {
      // Another binding may grant it: look for any that binds every user.
      try {
        const list = await kreq<{ items: Obj[] }>(SPATHS.roleBindings(ns));
        const any = (list.items ?? []).some(b =>
          (b.subjects ?? []).some((s: any) => s.kind === 'Group' && (s.name === 'system:authenticated' || s.name === 'system:serviceaccounts'))
        );
        return any ? 'shared' : 'missing';
      } catch {
        return 'missing';
      }
    }
    return 'unknown';
  }
}
