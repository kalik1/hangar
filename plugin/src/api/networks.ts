/* Network operations: create and delete NetworkAttachmentDefinitions. */

import { NadInput, nadManifest, NetworkRow } from '../model/networks';
import { runTask } from './actions';
import { kdelete, kpost } from './client';
import { nadOverlay } from './optimistic';
import { SPATHS } from './storageResources';

export function createNetwork(i: NadInput) {
  return runTask({ title: `Create network ${i.name}`, target: { kind: 'network', namespace: i.namespace, name: i.name } }, async () => {
    const created = await kpost(SPATHS.nads(i.namespace), nadManifest(i));
    nadOverlay.add(created ?? nadManifest(i));
  });
}

export function deleteNetwork(row: NetworkRow) {
  return runTask({ title: `Delete network ${row.name}`, target: { kind: 'network', namespace: row.namespace, name: row.name } }, async () => {
    await kdelete(SPATHS.nads(row.namespace as string, row.name));
    nadOverlay.remove(row.key);
  });
}
