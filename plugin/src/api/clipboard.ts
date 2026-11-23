/*
 * Turning clipboard sharing on or off for a VM: the Sidecar feature gate on
 * the KubeVirt resource (cluster-wide, read-modify-write), the hook script
 * in a ConfigMap of the VM's folder, and the hook on the VM's template.
 */

import {
  CLIPBOARD_HOOK_CM,
  CLIPBOARD_HOOK_KEY,
  CLIPBOARD_HOOK_SCRIPT,
  sidecarGateOn,
  sidecarImage,
  withClipboard,
  withSidecarGate,
} from '../model/clipboard';
import { Obj, VM } from '../model/types';
import { runTask } from './actions';
import { kreq } from './client';
import { PATHS } from './resources';

const kubevirtPath = (ns: string, name: string) => `/apis/kubevirt.io/v1/namespaces/${ns}/kubevirts/${name}`;
const cmPath = (ns: string, name = '') => `/api/v1/namespaces/${ns}/configmaps${name ? '/' + name : ''}`;

/** Adds the Sidecar gate to the KubeVirt resource, retrying on concurrent edits. */
export async function ensureSidecarGate(kubevirt: Obj): Promise<void> {
  const ns = kubevirt.metadata.namespace as string;
  const name = kubevirt.metadata.name;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await kreq<Obj>(kubevirtPath(ns, name));
    if (sidecarGateOn(fresh)) return;
    try {
      await kreq(kubevirtPath(ns, name), { method: 'PUT', body: { ...withSidecarGate(fresh), status: undefined } });
      return;
    } catch (e: any) {
      if (e?.status !== 409 || attempt === 2) throw e;
    }
  }
}

/** The hook script in the folder (namespace): created, or brought up to date. */
export async function ensureClipboardHook(namespace: string): Promise<void> {
  let current: Obj | null = null;
  try {
    current = await kreq<Obj>(cmPath(namespace, CLIPBOARD_HOOK_CM));
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
  const data = { [CLIPBOARD_HOOK_KEY]: CLIPBOARD_HOOK_SCRIPT };
  const labels = { 'app.kubernetes.io/managed-by': 'hangar', 'app.kubernetes.io/component': 'clipboard-hook' };
  if (!current) {
    await kreq(cmPath(namespace), {
      method: 'POST',
      body: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: CLIPBOARD_HOOK_CM, namespace, labels }, data },
    });
  } else if (current.data?.[CLIPBOARD_HOOK_KEY] !== CLIPBOARD_HOOK_SCRIPT) {
    await kreq(cmPath(namespace, CLIPBOARD_HOOK_CM), {
      method: 'PUT',
      body: { ...current, metadata: { ...current.metadata, labels: { ...(current.metadata.labels ?? {}), ...labels } }, data: { ...(current.data ?? {}), ...data } },
    });
  }
}

/** Everything a VM with clipboard sharing needs before it starts (also used by the New VM wizard). */
export async function prepareClipboard(namespace: string, kubevirt: Obj | null): Promise<void> {
  if (!kubevirt) throw new Error('KubeVirt is not installed or not readable.');
  await ensureSidecarGate(kubevirt);
  await ensureClipboardHook(namespace);
}

/** Turns clipboard sharing on or off; it takes effect at the next power-on. */
export function setVmClipboard(vm: VM, on: boolean, kubevirt: Obj | null) {
  const ns = vm.metadata.namespace as string;
  return runTask(
    { title: on ? 'Turn on clipboard sharing' : 'Turn off clipboard sharing', target: { kind: 'vm', namespace: ns, name: vm.metadata.name } },
    async () => {
      if (on) await prepareClipboard(ns, kubevirt);
      const fresh = await kreq<VM>(PATHS.vm(ns, vm.metadata.name));
      const next = withClipboard(fresh, on, sidecarImage(kubevirt));
      await kreq(PATHS.vm(ns, vm.metadata.name), { method: 'PUT', body: { ...next, status: undefined } });
    }
  );
}
