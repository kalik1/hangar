/*
 * Datastore operations: create a StorageClass, make one the default for new
 * VMs, delete one. StorageClasses are cluster objects: the user's role
 * decides (the views ask first and say so).
 */

import { defaultPatches } from '../model/datastoreSpec';
import { Obj } from '../model/types';
import { runTask } from './actions';
import { kdelete, kmerge, kpost } from './client';

const SC = '/apis/storage.k8s.io/v1/storageclasses';
const target = (name: string) => ({ kind: 'datastore' as const, name });

export function createDatastore(sc: Obj) {
  const name = sc.metadata.name;
  return runTask({ title: `Create datastore ${name}`, target: target(name) }, () => kpost(SC, sc));
}

export function setDefaultDatastore(scs: Obj[], name: string) {
  return runTask({ title: `Make ${name} the default for new VMs`, target: target(name) }, async () => {
    for (const p of defaultPatches(scs, name)) await kmerge(`${SC}/${encodeURIComponent(p.name)}`, p.patch);
  });
}

export function deleteDatastore(name: string) {
  return runTask({ title: `Delete datastore ${name}`, target: target(name) }, () => kdelete(`${SC}/${encodeURIComponent(name)}`));
}
