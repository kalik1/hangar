/*
 * Capacity of the datacenter: what the hosts have, what the VMs are given
 * (allocated), what they use (measured), and the datastores.
 */

import { Obj } from './types';
import { parseQuantity } from './units';
import { hardware, key } from './vm';

export interface Compute {
  cpuCores: number;
  memBytes: number;
  vcpuAllocated: number;
  memAllocated: number;
  vcpuAllVms: number;
  memAllVms: number;
}

/** Host totals (allocatable) and what running VMs are sized at. */
export function compute(nodes: Obj[], vms: Obj[], vmiIdx: Map<string, Obj>, instancetypes: Obj[]): Compute {
  let cpuCores = 0;
  let memBytes = 0;
  for (const n of nodes) {
    cpuCores += parseQuantity(n.status?.allocatable?.cpu) || 0;
    memBytes += parseQuantity(n.status?.allocatable?.memory) || 0;
  }
  let vcpuAllocated = 0;
  let memAllocated = 0;
  let vcpuAllVms = 0;
  let memAllVms = 0;
  for (const vm of vms) {
    const vmi = vmiIdx.get(key(vm));
    const hw = hardware(vm, vmi, instancetypes);
    vcpuAllVms += hw.vcpus;
    memAllVms += hw.memoryBytes;
    if (vmi) {
      vcpuAllocated += hw.vcpus;
      memAllocated += hw.memoryBytes;
    }
  }
  return { cpuCores, memBytes, vcpuAllocated, memAllocated, vcpuAllVms, memAllVms };
}

export interface Datastore {
  name: string;
  provisioner: string;
  isDefault: boolean;
  /** Sum of the disks' sizes on it. */
  provisionedBytes: number;
  /** Free space the storage reports (TopoLVM node annotations, CSIStorageCapacity), if any. */
  freeBytes?: number;
  disks: number;
  expandable: boolean;
  /** Can a disk on it be shared by two hosts at once (needed to live-migrate). */
  shared: boolean;
  /** Has a snapshot class for its driver. */
  snapshots: boolean;
  /** CDI's way to copy a disk on it: csi-clone, snapshot or copy. */
  cloneStrategy?: string;
  volumeModes: string[];
}

export function datastores(
  storageClasses: Obj[],
  pvcs: Obj[],
  nodes: Obj[],
  profiles: Obj[],
  snapshotClasses: Obj[]
): Datastore[] {
  return storageClasses.map(sc => {
    const name = sc.metadata.name;
    const mine = pvcs.filter(p => p.spec?.storageClassName === name);
    const provisionedBytes = mine.reduce(
      (s, p) => s + (parseQuantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage) || 0),
      0
    );
    let freeBytes: number | undefined;
    if (sc.provisioner === 'topolvm.io') {
      const dc = sc.parameters?.['topolvm.io/device-class'] ?? '00default';
      let sum = 0;
      let found = false;
      for (const n of nodes) {
        const a = n.metadata.annotations ?? {};
        const v = a[`capacity.topolvm.io/${dc}`] ?? (dc === '00default' ? a['capacity.topolvm.io/default'] : undefined);
        if (v !== undefined) {
          found = true;
          sum += Number(v) || 0;
        }
      }
      if (found) freeBytes = sum;
    }
    const profile = profiles.find(p => p.metadata.name === name);
    const sets: { accessModes?: string[]; volumeMode?: string }[] = profile?.status?.claimPropertySets ?? [];
    const shared = sets.some(s => (s.accessModes ?? []).includes('ReadWriteMany'));
    return {
      name,
      provisioner: sc.provisioner,
      isDefault:
        sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ||
        sc.metadata.annotations?.['storageclass.kubevirt.io/is-default-virt-class'] === 'true',
      provisionedBytes,
      freeBytes,
      disks: mine.length,
      expandable: !!sc.allowVolumeExpansion,
      shared,
      snapshots: snapshotClasses.some(c => c.driver === sc.provisioner),
      cloneStrategy: profile?.status?.cloneStrategy,
      volumeModes: [...new Set(sets.map(s => s.volumeMode).filter(Boolean) as string[])],
    };
  });
}
