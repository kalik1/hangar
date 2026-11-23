/*
 * Datastores as Hangar edits them: a new StorageClass made from an existing
 * one of the same driver (its secrets and tuning come along, the user picks
 * the pool or device class and the policies), the "default for new VMs"
 * flag, and when a datastore may be deleted.
 */

import { Obj } from './types';

/** KubeVirt/CDI's default for VM disks; wins over the cluster default for DataVolumes. */
export const A_VIRT_DEFAULT = 'storageclass.kubevirt.io/is-default-virt-class';
/** Kubernetes' default StorageClass. */
export const A_CLUSTER_DEFAULT = 'storageclass.kubernetes.io/is-default-class';

const RBD = /(^|\.)rbd\.csi\.ceph\.com$/;
const TOPOLVM = /^topolvm\.(io|cybozu\.com)$/;
const DEVICE_CLASS = 'topolvm.io/device-class';

export const isRbd = (sc: Obj | undefined) => RBD.test(sc?.provisioner ?? '');
export const isTopolvm = (sc: Obj | undefined) => TOPOLVM.test(sc?.provisioner ?? '');

export function isVirtDefault(sc: Obj): boolean {
  return sc.metadata.annotations?.[A_VIRT_DEFAULT] === 'true';
}

export function isClusterDefault(sc: Obj): boolean {
  return sc.metadata.annotations?.[A_CLUSTER_DEFAULT] === 'true';
}

/**
 * The datastore new VM disks land on when none is picked: CDI takes the
 * virt default first, then the cluster default.
 */
export function effectiveVmDefault(scs: Obj[]): string | undefined {
  return (scs.find(isVirtDefault) ?? scs.find(isClusterDefault))?.metadata.name;
}

export interface NewDatastoreInput {
  name: string;
  /** An existing StorageClass of the driver: its parameters (secrets, cluster…) are copied. */
  base: Obj;
  /** Ceph RBD: the block pool. */
  pool?: string;
  /** TopoLVM: the device class ("" = the default class). */
  deviceClass?: string;
  reclaim: 'Delete' | 'Retain';
  expansion: boolean;
  binding: 'Immediate' | 'WaitForFirstConsumer';
  description?: string;
}

/** The StorageClass for a new datastore. */
export function storageClassFrom(i: NewDatastoreInput): Obj {
  const parameters: Record<string, string> = { ...(i.base.parameters ?? {}) };
  if (isRbd(i.base) && i.pool) parameters.pool = i.pool;
  if (isTopolvm(i.base) && i.deviceClass !== undefined) {
    if (i.deviceClass) parameters[DEVICE_CLASS] = i.deviceClass;
    else delete parameters[DEVICE_CLASS];
  }
  const sc: Obj = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: i.name,
      labels: { 'hangar.magesgate.com/created-by': 'hangar' },
      ...(i.description ? { annotations: { description: i.description } } : {}),
    },
    provisioner: i.base.provisioner,
    parameters,
    reclaimPolicy: i.reclaim,
    allowVolumeExpansion: i.expansion,
    volumeBindingMode: i.binding,
  } as Obj;
  if (i.base.mountOptions?.length) (sc as any).mountOptions = [...i.base.mountOptions];
  return sc;
}

/** Patches that make `target` the default for new VMs and clear the flag elsewhere. */
export type Patch = Record<string, unknown>;

export function defaultPatches(scs: Obj[], target: string): { name: string; patch: Patch }[] {
  const out: { name: string; patch: Patch }[] = [];
  for (const sc of scs) {
    const name = sc.metadata.name;
    if (name === target) {
      if (!isVirtDefault(sc)) out.push({ name, patch: { metadata: { annotations: { [A_VIRT_DEFAULT]: 'true' } } } });
    } else if (sc.metadata.annotations?.[A_VIRT_DEFAULT] !== undefined) {
      out.push({ name, patch: { metadata: { annotations: { [A_VIRT_DEFAULT]: null } } } });
    }
  }
  // The target first: there is never a moment without a default.
  return out.sort((a, b) => (a.name === target ? -1 : b.name === target ? 1 : 0));
}

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function datastoreNameProblem(name: string, taken: string[]): string | null {
  if (!name) return 'Enter a name.';
  if (name.length > 253) return 'At most 253 characters.';
  if (!DNS_SUBDOMAIN.test(name)) return 'Lowercase letters, digits, "-" and "." only; start and end with a letter or digit.';
  if (taken.includes(name)) return `A datastore named ${name} exists already.`;
  return null;
}

/** Why a datastore cannot be deleted now, or null. */
export function deleteProblem(name: string, pvcs: Obj[]): string | null {
  const n = pvcs.filter(p => p.spec?.storageClassName === name).length;
  return n ? `${n} disk${n === 1 ? ' is' : 's are'} on it: move or delete ${n === 1 ? 'it' : 'them'} first` : null;
}

/** TopoLVM device classes the hosts announce (capacity.topolvm.io/<class> node annotations). */
export function topolvmDeviceClasses(nodes: Obj[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    for (const k of Object.keys(n.metadata.annotations ?? {})) {
      if (!k.startsWith('capacity.topolvm.io/')) continue;
      const dc = k.slice('capacity.topolvm.io/'.length);
      if (dc !== '00default') out.add(dc);
    }
  }
  return [...out].sort();
}

/** VolumeSnapshots of each disk, by "namespace/claim". */
export function snapshotsByClaim(volumeSnapshots: Obj[]): Map<string, Obj[]> {
  const out = new Map<string, Obj[]>();
  for (const s of volumeSnapshots) {
    const claim = s.spec?.source?.persistentVolumeClaimName;
    if (!claim) continue;
    const k = `${s.metadata.namespace}/${claim}`;
    out.set(k, [...(out.get(k) ?? []), s]);
  }
  return out;
}

/** The Ceph pool and RBD image behind a disk, from its PersistentVolume. */
export function rbdImageOf(pv: Obj | undefined): { pool: string; image: string } | null {
  const csi = pv?.spec?.csi;
  if (!csi || !RBD.test(csi.driver ?? '')) return null;
  const image = csi.volumeAttributes?.imageName;
  const pool = csi.volumeAttributes?.pool;
  return image && pool ? { pool, image } : null;
}
