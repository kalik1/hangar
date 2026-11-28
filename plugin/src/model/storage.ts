/*
 * Storage as a virtualizer shows it: datastores (StorageClasses) with their
 * type in plain words and honest capacity, and disks (PVCs and
 * DataVolumes) classified as VM disks, library images, unattached disks,
 * container volumes, or CDI internals that stay hidden.
 */

import { Datastore } from './capacity';
import { Obj } from './types';
import { parseQuantity } from './units';
import { claimNames, disks, key } from './vm';

/* ------------------------------------------------------- datastore type */

export interface StorageKind {
  /** Plain words: "Local thin LVM (TopoLVM)". */
  label: string;
  /** One line more, for the tooltip or the details. */
  detail: string;
  /** The family, for an icon. */
  family: 'local' | 'block' | 'file' | 'object' | 'cloud' | 'other';
}

const KINDS: [RegExp, StorageKind][] = [
  [/^topolvm\.(io|cybozu\.com)$/, { label: 'Local LVM (TopoLVM)', detail: 'Logical volumes on each host', family: 'local' }],
  [/(^|\.)rbd\.csi\.ceph\.com$/, { label: 'Ceph RBD', detail: 'Replicated block devices on a Ceph cluster', family: 'block' }],
  [/(^|\.)cephfs\.csi\.ceph\.com$/, { label: 'CephFS', detail: 'Shared file system on a Ceph cluster', family: 'file' }],
  [/^nfs\.csi\.k8s\.io$/, { label: 'NFS', detail: 'Files on an NFS server', family: 'file' }],
  [/nfs-subdir-external-provisioner|nfs-client/, { label: 'NFS (folders)', detail: 'A folder per disk on an NFS share', family: 'file' }],
  [/^smb\.csi\.k8s\.io$/, { label: 'SMB', detail: 'Files on an SMB share', family: 'file' }],
  [/^iscsi\.csi\.k8s\.io$/, { label: 'iSCSI', detail: 'LUNs on an iSCSI target', family: 'block' }],
  [/^driver\.longhorn\.io$/, { label: 'Longhorn', detail: 'Replicated block storage across the hosts', family: 'block' }],
  [/^linstor\.csi\.linbit\.com$/, { label: 'LINSTOR (DRBD)', detail: 'Replicated block storage across the hosts', family: 'block' }],
  [/^kubernetes\.io\/no-provisioner$/, { label: 'Local disks (static)', detail: 'Disks prepared by hand on each host', family: 'local' }],
  [/^rancher\.io\/local-path$/, { label: 'Local folder (local-path)', detail: 'A folder on one host per disk', family: 'local' }],
  [/hostpath\.csi\.kubevirt\.io|kubevirt\.io\.hostpath-provisioner/, { label: 'Host path (KubeVirt)', detail: 'Files in a folder of each host', family: 'local' }],
  [/^(local\.csi\.openebs\.io|openebs\.io\/local)$/, { label: 'OpenEBS local', detail: 'Local volumes on each host', family: 'local' }],
  [/^zfs\.csi\.openebs\.io$/, { label: 'ZFS (OpenEBS)', detail: 'ZFS volumes on each host', family: 'local' }],
  [/^lvm\.csi\.openebs\.io|local\.csi\.openebs\.io\/lvm$/, { label: 'Local LVM (OpenEBS)', detail: 'Logical volumes on each host', family: 'local' }],
  [/^ebs\.csi\.aws\.com$/, { label: 'Amazon EBS', detail: 'Cloud block volumes', family: 'cloud' }],
  [/^efs\.csi\.aws\.com$/, { label: 'Amazon EFS', detail: 'Cloud shared file system', family: 'cloud' }],
  [/^pd\.csi\.storage\.gke\.io$/, { label: 'Google Persistent Disk', detail: 'Cloud block volumes', family: 'cloud' }],
  [/^disk\.csi\.azure\.com$/, { label: 'Azure Disk', detail: 'Cloud block volumes', family: 'cloud' }],
  [/^file\.csi\.azure\.com$/, { label: 'Azure Files', detail: 'Cloud shared file system', family: 'cloud' }],
  [/^csi\.vsphere\.vmware\.com$/, { label: 'vSphere (CNS)', detail: 'Virtual disks on vSphere datastores', family: 'block' }],
  [/^csi\.trident\.netapp\.io$/, { label: 'NetApp (Trident)', detail: 'Volumes on a NetApp array', family: 'block' }],
  [/^pure-csi$|^pure\.csi/, { label: 'Pure Storage', detail: 'Volumes on a Pure array', family: 'block' }],
  [/^csi\.hpe\.com$/, { label: 'HPE storage', detail: 'Volumes on an HPE array', family: 'block' }],
  [/powerstore|powermax|powerflex|isilon/, { label: 'Dell storage', detail: 'Volumes on a Dell array', family: 'block' }],
  [/democratic-csi|truenas/, { label: 'NAS (democratic-csi)', detail: 'Volumes on a NAS', family: 'file' }],
];

export function storageKind(provisioner: string | undefined): StorageKind {
  const p = provisioner ?? '';
  for (const [re, k] of KINDS) if (re.test(p)) return k;
  return { label: p || 'Unknown', detail: 'A storage driver Hangar does not know', family: 'other' };
}

export const CLONE_LABELS: Record<string, string> = {
  'csi-clone': 'Instant (storage clone)',
  snapshot: 'Through a snapshot',
  copy: 'Full copy over the network',
};

export function cloneLabel(strategy: string | undefined): string {
  if (!strategy) return 'Chosen by CDI';
  return CLONE_LABELS[strategy] ?? strategy;
}

/* -------------------------------------------------- TopoLVM thin pools */

/** One TopoLVM device class on one host, from topolvm-node's metrics. */
export interface PoolSample {
  node: string;
  deviceClass: string;
  vgSize?: number;
  vgFree?: number;
  thinSize?: number;
  /** 0..100 */
  thinDataPercent?: number;
  thinMetaPercent?: number;
  /** What can still be provisioned with the overprovision ratio. */
  thinOverprovisionedAvailable?: number;
}

const METRIC_MAP: Record<string, keyof PoolSample> = {
  topolvm_volumegroup_size_bytes: 'vgSize',
  topolvm_volumegroup_available_bytes: 'vgFree',
  topolvm_thinpool_size_bytes: 'thinSize',
  topolvm_thinpool_data_percent: 'thinDataPercent',
  topolvm_thinpool_metadata_percent: 'thinMetaPercent',
  topolvm_thinpool_overprovisioned_available: 'thinOverprovisionedAvailable',
};

/** Parses the Prometheus text of a topolvm-node pod. */
export function parseTopolvmMetrics(text: string): PoolSample[] {
  const out = new Map<string, PoolSample>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('topolvm_')) continue;
    const m = line.match(/^(\w+)\{([^}]*)\}\s+(\S+)/);
    if (!m) continue;
    const field = METRIC_MAP[m[1]];
    if (!field) continue;
    const labels: Record<string, string> = {};
    for (const l of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
    const node = labels.node ?? '';
    const dc = labels.device_class ?? '';
    const k = `${node}/${dc}`;
    const s = out.get(k) ?? { node, deviceClass: dc };
    const v = Number(m[3]);
    if (isFinite(v)) (s as any)[field] = v;
    out.set(k, s);
  }
  return [...out.values()];
}

/**
 * The device class a StorageClass uses. Without the parameter it is the
 * default class: TopoLVM annotates nodes with `capacity.topolvm.io/00default`
 * and with the default class's own name, both with the same value.
 */
export function topolvmDeviceClass(sc: Obj, nodes: Obj[]): string | undefined {
  const p = sc.parameters?.['topolvm.io/device-class'];
  if (p) return p;
  for (const n of nodes) {
    const a = n.metadata.annotations ?? {};
    const def = a['capacity.topolvm.io/00default'];
    if (def === undefined) continue;
    const named = Object.keys(a).find(
      k => k.startsWith('capacity.topolvm.io/') && k !== 'capacity.topolvm.io/00default' && a[k] === def
    );
    if (named) return named.slice('capacity.topolvm.io/'.length);
  }
  return undefined;
}

export interface PoolSummary {
  thin: boolean;
  hosts: number;
  /** Physical size: thin pools, else volume groups. */
  sizeBytes: number;
  /** Physically written (thin) or allocated (thick). */
  usedBytes: number;
  /** What the storage still accepts: overprovisioned for thin pools. */
  provisionableBytes?: number;
  /** provisioned / size, for thin pools. */
  overcommit?: number;
}

/** Sums the samples of a device class across the hosts. */
export function poolSummary(samples: PoolSample[], deviceClass: string | undefined, provisionedBytes: number): PoolSummary | null {
  const mine = samples.filter(s => !deviceClass || s.deviceClass === deviceClass);
  if (!mine.length) return null;
  const thin = mine.some(s => s.thinSize !== undefined);
  let size = 0;
  let used = 0;
  let prov = 0;
  let hasProv = false;
  for (const s of mine) {
    if (thin) {
      const sz = s.thinSize ?? 0;
      size += sz;
      used += (sz * (s.thinDataPercent ?? 0)) / 100;
      if (s.thinOverprovisionedAvailable !== undefined) {
        prov += s.thinOverprovisionedAvailable;
        hasProv = true;
      }
    } else {
      size += s.vgSize ?? 0;
      used += (s.vgSize ?? 0) - (s.vgFree ?? 0);
      if (s.vgFree !== undefined) {
        prov += s.vgFree;
        hasProv = true;
      }
    }
  }
  return {
    thin,
    hosts: new Set(mine.map(s => s.node)).size,
    sizeBytes: size,
    usedBytes: used,
    provisionableBytes: hasProv ? prov : undefined,
    overcommit: thin && size > 0 ? provisionedBytes / size : undefined,
  };
}

/* ---------------------------------------------------------------- disks */

export type DiskKind = 'vm' | 'image' | 'unattached' | 'container' | 'internal';

export interface DiskUse {
  vm: Obj;
  /** The disk's name in the VM ("rootdisk"). */
  slot: string;
  device: 'disk' | 'cdrom' | 'lun' | 'state';
}

/** Which VMs use which claims ("ns/claim" → uses), from VM specs and running instances. */
export function claimUsers(vms: Obj[], vmis: Map<string, Obj>): Map<string, DiskUse[]> {
  const out = new Map<string, DiskUse[]>();
  const add = (k: string, u: DiskUse) => {
    const list = out.get(k) ?? [];
    if (!list.some(x => x.vm === u.vm)) list.push(u);
    out.set(k, list);
  };
  for (const vm of vms) {
    const ns = vm.metadata.namespace as string;
    for (const d of disks(vm)) {
      if (d.claimName) add(`${ns}/${d.claimName}`, { vm, slot: d.name, device: d.device });
    }
    // Hot-plugged volumes the running instance has but the VM spec does not (yet).
    const vmi = vmis.get(key(vm));
    for (const v of vmi?.spec?.volumes ?? []) {
      const c = v.persistentVolumeClaim?.claimName ?? v.dataVolume?.name;
      if (c && !claimNames(vm).includes(c)) add(`${ns}/${c}`, { vm, slot: v.name, device: 'disk' });
    }
  }
  return out;
}

const CDI_INTERNAL = [/^prime-[0-9a-f]{8}-/, /^tmp-pvc-[0-9a-f]{8}-/, /^tmp-source-pvc-/, /^cdi-tmp-/];

/** CDI's scratch, prime and temporary claims, and claims owned by another claim. */
export function isInternalClaim(pvc: Obj): boolean {
  const name = pvc.metadata.name;
  if ((pvc.metadata.ownerReferences ?? []).some(o => o.kind === 'PersistentVolumeClaim')) return true;
  if (CDI_INTERNAL.some(re => re.test(name))) return true;
  const cdi =
    pvc.metadata.labels?.app === 'containerized-data-importer' ||
    Object.keys(pvc.metadata.annotations ?? {}).some(k => k.startsWith('cdi.kubevirt.io/'));
  if (cdi && /-scratch$/.test(name)) return true;
  return false;
}

/** Made by CDI or KubeVirt for a VM (so a VM disk, even when no VM uses it now). */
export function isVmManagedClaim(pvc: Obj | undefined, dv: Obj | undefined): boolean {
  if (dv) return true;
  if (!pvc) return false;
  const l = pvc.metadata.labels ?? {};
  const a = pvc.metadata.annotations ?? {};
  return (
    (pvc.metadata.ownerReferences ?? []).some(o => o.kind === 'DataVolume' || o.kind === 'VirtualMachine') ||
    l['app.kubernetes.io/managed-by'] === 'cdi-controller' ||
    !!l['kubevirt.io/created-by'] ||
    !!l['persistent-state-for'] ||
    'cdi.kubevirt.io/storage.contentType' in a ||
    'restore.kubevirt.io/name' in a
  );
}

/** KubeVirt's backend storage of a VM: its TPM and UEFI state ("persistent-state-for": the VM's name). */
export function isVmStateClaim(pvc: Obj | undefined): boolean {
  return !!pvc?.metadata.labels?.['persistent-state-for'];
}

export const L_IMAGE = 'hangar.magesgate.com/image';

export function isImageClaim(o: Obj, libraryNs: string): boolean {
  return o.metadata.labels?.[L_IMAGE] === 'true' || o.metadata.namespace === libraryNs;
}

export function classifyDisk(
  pvc: Obj | undefined,
  dv: Obj | undefined,
  uses: DiskUse[] | undefined,
  libraryNs: string
): DiskKind {
  const o = (pvc ?? dv) as Obj;
  if (pvc && isInternalClaim(pvc)) return 'internal';
  // KubeVirt's VM state (TPM, UEFI variables): never a disk to attach.
  if (isVmStateClaim(pvc)) return 'internal';
  if (isImageClaim(o, libraryNs) || (dv && isImageClaim(dv, libraryNs))) return 'image';
  if (uses?.length) return 'vm';
  if (isVmManagedClaim(pvc, dv)) return 'unattached';
  return 'container';
}

export type DiskTone = 'on' | 'busy' | 'standby' | 'fault' | 'off';

export interface DiskState {
  label: string;
  tone: DiskTone;
  /** 0..100 while importing, copying, uploading. */
  progress?: number;
  detail?: string;
  ready: boolean;
}

function progressOf(dv: Obj | undefined): number | undefined {
  const p = parseFloat(String(dv?.status?.progress ?? '').replace('%', ''));
  return isFinite(p) ? p : undefined;
}

function dvMessage(dv: Obj): string | undefined {
  const c = (dv.status?.conditions ?? []) as { type: string; status: string; message?: string; reason?: string }[];
  const running = c.find(x => x.type === 'Running');
  const bound = c.find(x => x.type === 'Bound');
  return running?.message || bound?.message || undefined;
}

/** The state of a disk from its DataVolume (when it has one) and its claim. */
export function diskState(pvc: Obj | undefined, dv: Obj | undefined): DiskState {
  if ((pvc ?? dv)?.metadata.deletionTimestamp) return { label: 'Deleting', tone: 'busy', ready: false };
  if (dv) {
    const phase: string = dv.status?.phase ?? '';
    const progress = progressOf(dv);
    const restarts = Number(dv.status?.restartCount ?? 0);
    const retry = restarts > 0 ? ` (retry ${restarts})` : '';
    switch (phase) {
      case 'Succeeded':
        break;
      case 'ImportInProgress':
        return { label: `Importing${progress !== undefined ? ` ${Math.round(progress)}%` : ''}${retry}`, tone: restarts ? 'standby' : 'busy', progress, detail: dvMessage(dv), ready: false };
      case 'CloneInProgress':
      case 'CSICloneInProgress':
      case 'SnapshotForSmartCloneInProgress':
      case 'CloneFromSnapshotSourceInProgress':
      case 'SmartClonePVCInProgress':
      case 'PrepClaimInProgress':
      case 'RebindInProgress':
      case 'ExpansionInProgress':
      case 'NamespaceTransferInProgress':
        return { label: `Copying${progress !== undefined ? ` ${Math.round(progress)}%` : ''}`, tone: 'busy', progress, detail: dvMessage(dv), ready: false };
      case 'UploadReady':
        return { label: 'Waiting for the upload', tone: 'standby', detail: 'The disk is ready to receive a file.', ready: false };
      case 'UploadScheduled':
        return { label: 'Preparing the upload', tone: 'busy', ready: false };
      case 'ImportScheduled':
      case 'CloneScheduled':
      case 'Pending':
      case '':
        return { label: 'Pending', tone: 'busy', detail: dvMessage(dv), ready: false };
      case 'WaitForFirstConsumer':
      case 'PendingPopulation':
        return { label: 'Waits for a VM', tone: 'standby', detail: 'The storage creates it when a VM first uses it.', ready: false };
      case 'Paused':
        return { label: 'Paused', tone: 'standby', detail: dvMessage(dv), ready: false };
      case 'Failed':
        return { label: 'Error', tone: 'fault', detail: dvMessage(dv) ?? 'The import failed', ready: false };
      case 'Unknown':
      default:
        if (phase !== 'Succeeded') return { label: phase || 'Unknown', tone: 'standby', detail: dvMessage(dv), ready: false };
    }
  }
  if (!pvc) return { label: 'Pending', tone: 'busy', ready: false };
  const phase = pvc.status?.phase;
  if (phase === 'Lost') return { label: 'Error', tone: 'fault', detail: 'The volume behind this disk is lost.', ready: false };
  if (phase === 'Pending') return { label: 'Pending', tone: 'busy', detail: 'Waiting for the storage to create it.', ready: false };
  const conds = (pvc.status?.conditions ?? []) as { type: string; status: string; message?: string }[];
  if (conds.some(c => c.type === 'Resizing' && c.status === 'True')) return { label: 'Expanding', tone: 'busy', ready: true };
  if (conds.some(c => c.type === 'FileSystemResizePending' && c.status === 'True'))
    return { label: 'Expands at next power-on', tone: 'standby', ready: true };
  if (conds.some(c => /ResizeError|ControllerResizeError|NodeResizeError/.test(c.type) && c.status === 'True'))
    return { label: 'Expand failed', tone: 'fault', detail: conds.find(c => /ResizeError/.test(c.type))?.message, ready: true };
  return { label: 'Ready', tone: 'on', ready: true };
}

export function claimSize(pvc: Obj | undefined, dv: Obj | undefined): number {
  const q = parseQuantity(
    pvc?.status?.capacity?.storage ??
      pvc?.spec?.resources?.requests?.storage ??
      dv?.spec?.storage?.resources?.requests?.storage ??
      dv?.spec?.pvc?.resources?.requests?.storage
  );
  return isFinite(q) ? q : 0;
}

/** Requested size (what the disk is being expanded to), when it differs from the capacity. */
export function requestedSize(pvc: Obj | undefined): number | undefined {
  const req = parseQuantity(pvc?.spec?.resources?.requests?.storage);
  const cap = parseQuantity(pvc?.status?.capacity?.storage);
  return isFinite(req) && isFinite(cap) && req > cap ? req : undefined;
}

export interface DiskRow {
  key: string;
  namespace: string;
  name: string;
  kind: DiskKind;
  pvc?: Obj;
  dv?: Obj;
  uses: DiskUse[];
  sizeBytes: number;
  datastore?: string;
  state: DiskState;
  /** ISO or CD-ROM content. */
  media: 'disk' | 'iso';
  /** The VM that created it, when it was deleted and the disk kept ("kubevirt.io/created-by"). */
  formerVmUid?: string;
}

export interface DiskInventory {
  rows: DiskRow[];
  /** How many claims were hidden: CDI internals, and VM state claims whose VM is gone. */
  hidden: number;
}

/** Every disk of the cluster, from its claims and DataVolumes. */
export function diskInventory(
  pvcs: Obj[],
  dvs: Obj[],
  vms: Obj[],
  vmis: Map<string, Obj>,
  libraryNs: string
): DiskInventory {
  const users = claimUsers(vms, vmis);
  const dvIdx = new Map(dvs.map(d => [key(d), d]));
  const pvcIdx = new Map(pvcs.map(p => [key(p), p]));
  const rows: DiskRow[] = [];
  let hidden = 0;
  const keys = new Set<string>([...pvcIdx.keys(), ...dvIdx.keys()]);
  for (const k of keys) {
    const pvc = pvcIdx.get(k);
    const dv = dvIdx.get(k);
    const uses = users.get(k) ?? [];
    const stateFor = pvc?.metadata.labels?.['persistent-state-for'];
    // A VM state claim is listed under its VM (it takes room on the datastore), and hidden once its VM is gone.
    const stateOf = stateFor ? vms.filter(v => v.metadata.namespace === pvc?.metadata.namespace && v.metadata.name === stateFor) : [];
    const kind = stateOf.length ? 'vm' : classifyDisk(pvc, dv, uses, libraryNs);
    if (kind === 'internal') {
      hidden++;
      continue;
    }
    const o = (pvc ?? dv) as Obj;
    const a = { ...(dv?.metadata.annotations ?? {}), ...(pvc?.metadata.annotations ?? {}) };
    const isIso =
      a['hangar.magesgate.com/media'] === 'iso' ||
      uses.some(u => u.device === 'cdrom') ||
      (kind === 'image' && /(^|[-_.])iso($|[-_.])/i.test(o.metadata.name));
    rows.push({
      key: k,
      namespace: o.metadata.namespace as string,
      name: o.metadata.name,
      kind,
      pvc,
      dv,
      uses: stateOf.length && !uses.length ? stateOf.map(vm => ({ vm, slot: 'VM state', device: 'state' as const })) : uses,
      sizeBytes: claimSize(pvc, dv),
      datastore: pvc?.spec?.storageClassName ?? dv?.spec?.storage?.storageClassName ?? dv?.spec?.pvc?.storageClassName,
      state: diskState(pvc, dv),
      media: isIso ? 'iso' : 'disk',
      formerVmUid: pvc?.metadata.labels?.['kubevirt.io/created-by'] ?? dv?.metadata.labels?.['kubevirt.io/created-by'],
    });
  }
  return { rows, hidden };
}

/** What blocks expanding a disk, or null when it can be expanded. */
export function expandProblem(row: DiskRow, sc: Obj | undefined): string | null {
  if (!row.pvc) return 'The disk is not created yet.';
  if (!row.state.ready) return 'Wait until the disk is ready.';
  if (!sc) return `The datastore ${row.datastore ?? ''} does not exist: its size cannot change.`.replace('  ', ' ');
  if (!sc.allowVolumeExpansion) return `The datastore ${sc.metadata.name} does not allow growing disks.`;
  if (requestedSize(row.pvc) !== undefined) return 'The disk is being expanded already.';
  return null;
}

/** Datastore numbers from the disks Hangar shows (internals excluded from the count, not from the space). */
export interface DatastoreRow extends Datastore {
  kind: StorageKind;
  vmDisks: number;
  images: number;
  unattached: number;
  containers: number;
  /** The StorageClass's volume binding mode, reclaim policy. */
  binding?: string;
  reclaim?: string;
  deviceClass?: string;
  pool?: PoolSummary | null;
  missing?: boolean;
}

export function datastoreRows(base: Datastore[], storageClasses: Obj[], inv: DiskInventory): DatastoreRow[] {
  const out: DatastoreRow[] = base.map(ds => {
    const sc = storageClasses.find(s => s.metadata.name === ds.name);
    const mine = inv.rows.filter(r => r.datastore === ds.name);
    return {
      ...ds,
      kind: storageKind(ds.provisioner),
      vmDisks: mine.filter(r => r.kind === 'vm').length,
      images: mine.filter(r => r.kind === 'image').length,
      unattached: mine.filter(r => r.kind === 'unattached').length,
      containers: mine.filter(r => r.kind === 'container').length,
      binding: sc?.volumeBindingMode,
      reclaim: sc?.reclaimPolicy,
    };
  });
  // Claims on a class that does not exist (static volumes): show it, marked.
  const known = new Set(out.map(d => d.name));
  const orphans = new Map<string, DiskRow[]>();
  for (const r of inv.rows) {
    if (!r.datastore || known.has(r.datastore)) continue;
    orphans.set(r.datastore, [...(orphans.get(r.datastore) ?? []), r]);
  }
  for (const [name, rows] of orphans) {
    out.push({
      name,
      provisioner: '',
      isDefault: false,
      provisionedBytes: rows.reduce((s, r) => s + r.sizeBytes, 0),
      disks: rows.length,
      expandable: false,
      shared: rows.some(r => (r.pvc?.spec?.accessModes ?? []).includes('ReadWriteMany')),
      snapshots: false,
      volumeModes: [],
      kind: { label: 'Static volumes (no class)', detail: 'Volumes made by hand; the class they name does not exist', family: 'local' },
      vmDisks: rows.filter(r => r.kind === 'vm').length,
      images: rows.filter(r => r.kind === 'image').length,
      unattached: rows.filter(r => r.kind === 'unattached').length,
      containers: rows.filter(r => r.kind === 'container').length,
      missing: true,
    });
  }
  return out;
}
