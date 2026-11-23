/*
 * Flavors on the cluster: cluster-wide and folder instancetypes, their
 * creation/edit/deletion, and the cluster's default CPU model (KubeVirt CR).
 * KubeVirt's own instancetypes (managed by virt-operator) are never written.
 */

import React from 'react';
import { buildFlavor, FlavorDef, KIND_NS, updatedFlavor } from '../model/flavors';
import { Obj } from '../model/types';
import { runTask } from './actions';
import { kdelete, kmerge, kpost, kreq } from './client';

const G = '/apis/instancetype.kubevirt.io/v1beta1';

export const FLAVOR_PATHS = {
  clusterList: `${G}/virtualmachineclusterinstancetypes`,
  cluster: (name: string) => `${G}/virtualmachineclusterinstancetypes/${name}`,
  nsList: (ns: string) => `${G}/namespaces/${ns}/virtualmachineinstancetypes`,
  ns: (ns: string, name: string) => `${G}/namespaces/${ns}/virtualmachineinstancetypes/${name}`,
  allNs: `${G}/virtualmachineinstancetypes`,
  prefsNs: `${G}/virtualmachinepreferences`,
};

/* Folder (namespaced) instancetypes and preferences: fetched here, refreshed
 * every minute and at once after Hangar changes a flavor. */

const listeners = new Set<() => void>();

/** Tell every view to reload flavors now (after a create, edit or delete). */
export function flavorsChanged() {
  listeners.forEach(l => l());
}

async function listAll(path: string): Promise<Obj[]> {
  try {
    const r = await kreq<{ items?: Obj[] }>(path);
    return r?.items ?? [];
  } catch {
    return [];
  }
}

export interface FlavorLists {
  /** Cluster-wide instancetypes (null until loaded: use useHangar()'s meanwhile). */
  cluster: Obj[] | null;
  /** Folder (namespaced) instancetypes and preferences. */
  instancetypes: Obj[];
  preferences: Obj[];
}

/** Instancetypes and folder preferences, reloaded every minute and at once after Hangar changes a flavor. */
export function useFolderFlavors(): FlavorLists {
  const [state, setState] = React.useState<FlavorLists>({ cluster: null, instancetypes: [], preferences: [] });
  React.useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([listAll(FLAVOR_PATHS.clusterList), listAll(FLAVOR_PATHS.allNs), listAll(FLAVOR_PATHS.prefsNs)]).then(([cluster, instancetypes, preferences]) => {
        if (live) setState({ cluster, instancetypes, preferences });
      });
    load();
    const id = window.setInterval(load, 60000);
    listeners.add(load);
    return () => {
      live = false;
      window.clearInterval(id);
      listeners.delete(load);
    };
  }, []);
  return state;
}

const target = (def: { name: string; namespace?: string }) => ({ kind: 'flavor' as const, name: def.name, namespace: def.namespace });

export function createFlavors(defs: FlavorDef[], title: string) {
  return runTask({ title, target: defs.length === 1 ? target(defs[0]) : { kind: 'flavor', name: defs[0]?.familyLabel ?? 'flavors' } }, async () => {
    for (const def of defs) {
      const body = buildFlavor(def);
      await kpost(def.namespace ? FLAVOR_PATHS.nsList(def.namespace) : FLAVOR_PATHS.clusterList, body);
    }
    flavorsChanged();
  });
}

export function updateFlavor(obj: Obj, def: FlavorDef) {
  const path = obj.metadata.namespace ? FLAVOR_PATHS.ns(obj.metadata.namespace, obj.metadata.name) : FLAVOR_PATHS.cluster(obj.metadata.name);
  return runTask({ title: `Change flavor ${obj.metadata.name}`, target: target(def) }, async () => {
    await kreq(path, { method: 'PUT', body: updatedFlavor(obj, def) });
    flavorsChanged();
  });
}

export function deleteFlavors(objs: Obj[], title: string) {
  return runTask({ title, target: objs.length === 1 ? { kind: 'flavor', name: objs[0].metadata.name, namespace: objs[0].metadata.namespace } : { kind: 'flavor', name: title } }, async () => {
    for (const o of objs) {
      const path = o.kind === KIND_NS || o.metadata.namespace ? FLAVOR_PATHS.ns(o.metadata.namespace as string, o.metadata.name) : FLAVOR_PATHS.cluster(o.metadata.name);
      await kdelete(path).catch((e: any) => (e?.status === 404 ? undefined : Promise.reject(e)));
    }
    flavorsChanged();
  });
}

/** Cluster default CPU model for VMs started afterwards; '' goes back to KubeVirt's default (host-model). */
export function setClusterCpuModel(kv: Obj, model: string) {
  const path = `/apis/kubevirt.io/v1/namespaces/${kv.metadata.namespace}/kubevirts/${kv.metadata.name}`;
  return runTask({ title: model ? `Default CPU model: ${model}` : 'Default CPU model: host model', target: { kind: 'flavor', name: 'CPU models' } }, () =>
    // A merge patch touches only this field; resourceVersion makes it fail if the CR changed meanwhile.
    kmerge(path, { metadata: { resourceVersion: kv.metadata.resourceVersion }, spec: { configuration: { cpuModel: model || null } } })
  );
}
