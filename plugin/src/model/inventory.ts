/*
 * The inventory trees: folders (namespaces) with their VMs and templates,
 * hosts (nodes) with the VMs running on them.
 */

import { Obj } from './types';
import { isTemplate } from './vm';

export const L_FOLDER = 'hangar.magesgate.com/folder';
export const L_LIBRARY = 'hangar.magesgate.com/library';

export interface Folder {
  name: string;
  vms: Obj[];
  templates: Obj[];
  running: number;
}

const byName = (a: Obj, b: Obj) => a.metadata.name.localeCompare(b.metadata.name, undefined, { numeric: true });

/** Folders: namespaces with VMs, plus empty ones marked as folders. The library is not a folder. */
export function folders(vms: Obj[], namespaces: Obj[], vmis: Obj[], libraryNs: string): Folder[] {
  const map = new Map<string, Folder>();
  const ensure = (name: string) => {
    let f = map.get(name);
    if (!f) {
      f = { name, vms: [], templates: [], running: 0 };
      map.set(name, f);
    }
    return f;
  };
  for (const ns of namespaces) {
    if (ns.metadata.labels?.[L_FOLDER] === 'true' && ns.metadata.name !== libraryNs) ensure(ns.metadata.name);
  }
  const running = new Set(vmis.map(v => `${v.metadata.namespace}/${v.metadata.name}`));
  for (const vm of vms) {
    const f = ensure(vm.metadata.namespace as string);
    if (isTemplate(vm)) f.templates.push(vm);
    else {
      f.vms.push(vm);
      if (running.has(`${vm.metadata.namespace}/${vm.metadata.name}`)) f.running++;
    }
  }
  for (const f of map.values()) {
    f.vms.sort(byName);
    f.templates.sort(byName);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface HostNode {
  node: Obj;
  vmis: Obj[];
}

export function hostTree(nodes: Obj[], vmis: Obj[]): HostNode[] {
  return [...nodes]
    .sort(byName)
    .map(node => ({
      node,
      vmis: vmis.filter(v => v.status?.nodeName === node.metadata.name).sort(byName),
    }));
}

/* ---------------------------------------------------------------- hosts */

export interface HostState {
  ready: boolean;
  maintenance: boolean;
  /** Can run VMs (KubeVirt's handler is there and the node is schedulable for VMs). */
  virt: boolean;
  label: string;
  tone: 'on' | 'standby' | 'fault' | 'busy' | 'off';
}

export function hostState(node: Obj): HostState {
  const ready = (node.status?.conditions ?? []).find((c: any) => c.type === 'Ready')?.status === 'True';
  const maintenance = !!node.spec?.unschedulable;
  const virt = node.metadata.labels?.['kubevirt.io/schedulable'] === 'true';
  if (!ready) return { ready, maintenance, virt, label: 'Not responding', tone: 'fault' };
  if (maintenance) return { ready, maintenance, virt, label: 'In maintenance', tone: 'standby' };
  if (!virt) return { ready, maintenance, virt, label: 'Connected, no virtualization', tone: 'standby' };
  return { ready, maintenance, virt, label: 'Connected', tone: 'on' };
}

export function hostRoles(node: Obj): string[] {
  return Object.keys(node.metadata.labels ?? {})
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.split('/')[1])
    .filter(Boolean);
}

export function hostCpuModel(node: Obj): string | undefined {
  const labels = node.metadata.labels ?? {};
  const hm = Object.keys(labels).find(k => k.startsWith('host-model-cpu.node.kubevirt.io/'));
  return hm?.split('/')[1];
}

/**
 * The datacenter's display name: the cluster name, except Headlamp's
 * generic in-cluster "main", where the hosts' common DNS domain reads better.
 */
export function datacenterName(cluster: string, nodes: Obj[]): string {
  if (cluster && cluster !== 'main') return cluster;
  const domains = nodes.map(n => n.metadata.name.split('.').slice(1).join('.')).filter(Boolean);
  if (domains.length && domains.every(x => x === domains[0])) return domains[0];
  return cluster || 'Datacenter';
}
