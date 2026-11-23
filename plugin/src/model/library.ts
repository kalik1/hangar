/*
 * The image library: a namespace of disk images and ISOs (DataVolumes and
 * PVCs labelled hangar.magesgate.com/image), shared with every folder.
 * Pure functions: the list, the manifests Hangar creates, the file sniffing
 * for uploads.
 */

import { L_LIBRARY } from './inventory';
import { claimSize, DiskState, diskState, L_IMAGE } from './storage';
import { Obj } from './types';
import { GiB, MiB } from './units';
import { key, osIdFrom } from './vm';

export { L_IMAGE };
export const A_DISPLAY = 'hangar.magesgate.com/display-name';
export const A_OS = 'hangar.magesgate.com/os';
export const A_MEDIA = 'hangar.magesgate.com/media';
export const A_DESCRIPTION = 'description';
export const A_BIND_IMMEDIATE = 'cdi.kubevirt.io/storage.bind.immediate.requested';
export const SHARING_NAME = 'hangar-library-clone';

export type Media = 'disk' | 'iso';

export type SourceKind = 'http' | 'registry' | 'upload' | 'clone' | 'snapshot' | 'blank' | 'other';

export interface LibraryItem {
  key: string;
  namespace: string;
  name: string;
  displayName: string;
  os: string;
  media: Media;
  sizeBytes: number;
  state: DiskState;
  created?: string;
  source: { kind: SourceKind; detail?: string };
  description?: string;
  dv?: Obj;
  pvc?: Obj;
}

function mediaOf(o: Obj): Media {
  const m = o.metadata.annotations?.[A_MEDIA];
  if (m === 'iso' || m === 'disk') return m;
  return /(^|[-_.])iso($|[-_.])/i.test(o.metadata.name) ? 'iso' : 'disk';
}

function sourceOf(dv: Obj | undefined): LibraryItem['source'] {
  const s = dv?.spec?.source ?? {};
  if (s.http) return { kind: 'http', detail: s.http.url };
  if (s.registry) return { kind: 'registry', detail: s.registry.url ?? s.registry.imageStream };
  if (s.upload) return { kind: 'upload' };
  if (s.pvc) return { kind: 'clone', detail: `${s.pvc.namespace}/${s.pvc.name}` };
  if (s.snapshot) return { kind: 'snapshot', detail: `${s.snapshot.namespace}/${s.snapshot.name}` };
  if (s.blank) return { kind: 'blank' };
  if (dv?.spec?.sourceRef) return { kind: 'clone', detail: `${dv.spec.sourceRef.namespace ?? ''}/${dv.spec.sourceRef.name}` };
  return { kind: 'other' };
}

/** The images of the library: labelled DataVolumes and PVCs, plus everything in the library namespace. */
export function libraryItems(dvs: Obj[], pvcs: Obj[], libraryNs: string): LibraryItem[] {
  const isImage = (o: Obj) => o.metadata.labels?.[L_IMAGE] === 'true' || o.metadata.namespace === libraryNs;
  const pvcIdx = new Map(pvcs.map(p => [key(p), p]));
  const dvIdx = new Map(dvs.map(d => [key(d), d]));
  const keys = new Set<string>();
  for (const d of dvs) if (isImage(d)) keys.add(key(d));
  for (const p of pvcs) if (isImage(p) && !isHiddenClaim(p)) keys.add(key(p));
  const out: LibraryItem[] = [];
  for (const k of keys) {
    const dv = dvIdx.get(k);
    const pvc = pvcIdx.get(k);
    const o = (dv ?? pvc) as Obj;
    const a = { ...(pvc?.metadata.annotations ?? {}), ...(dv?.metadata.annotations ?? {}) };
    out.push({
      key: k,
      namespace: o.metadata.namespace as string,
      name: o.metadata.name,
      displayName: a[A_DISPLAY] || o.metadata.name,
      os: a[A_OS] || osIdFrom(o.metadata.name) || '',
      media: mediaOf({ ...o, metadata: { ...o.metadata, annotations: a } }),
      sizeBytes: claimSize(pvc, dv),
      state: diskState(pvc, dv),
      created: o.metadata.creationTimestamp,
      source: sourceOf(dv),
      description: a[A_DESCRIPTION],
      dv,
      pvc,
    });
  }
  return out.sort((x, y) => x.displayName.localeCompare(y.displayName, undefined, { numeric: true }));
}

function isHiddenClaim(p: Obj): boolean {
  return (
    (p.metadata.ownerReferences ?? []).some(o => o.kind === 'PersistentVolumeClaim') ||
    /^(prime|tmp-pvc)-[0-9a-f]{8}-/.test(p.metadata.name) ||
    /-scratch$/.test(p.metadata.name)
  );
}

/** A Kubernetes name from what the user typed: "Ubuntu 24.04 LTS" → "ubuntu-24-04-lts". */
export function slugName(text: string, taken: Set<string> = new Set(), max = 50): string {
  let base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  if (!base || !/^[a-z]/.test(base)) base = `image-${base}`.replace(/-+$/, '');
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base.slice(0, max - 3)}-${i}`;
    if (!taken.has(n)) return n;
  }
  return `${base.slice(0, max - 7)}-${Date.now().toString(36).slice(-6)}`;
}

/** "quay.io/containerdisks/fedora:41" → "docker://quay.io/containerdisks/fedora:41". */
export function registryUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/^(docker|oci-archive):\/\//.test(s)) return s;
  return `docker://${s.replace(/^https?:\/\//, '')}`;
}

/** Problems with an image reference or URL, in words. */
export function urlProblem(kind: 'http' | 'registry', input: string): string | null {
  const s = input.trim();
  if (!s) return kind === 'http' ? 'Enter the address of the image file.' : 'Enter the image reference.';
  if (kind === 'http') {
    if (!/^(https?|s3|gcs):\/\//.test(s)) return 'Use an http:// or https:// address.';
    try {
      // eslint-disable-next-line no-new
      new URL(s.replace(/^(s3|gcs):/, 'https:'));
    } catch {
      return 'This is not a valid address.';
    }
    return null;
  }
  const ref = registryUrl(s).replace(/^docker:\/\//, '');
  if (/\s/.test(ref)) return 'An image reference has no spaces.';
  if (!/^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-zA-Z0-9._-]+)+(:[\w.-]+|@sha256:[a-f0-9]{64})?$/.test(ref))
    return 'Use a reference like quay.io/containerdisks/fedora:latest.';
  return null;
}

/** Container disk images worth offering. */
export const REGISTRY_SUGGESTIONS: { ref: string; os: string; label: string }[] = [
  { ref: 'quay.io/containerdisks/fedora:latest', os: 'fedora', label: 'Fedora (latest)' },
  { ref: 'quay.io/containerdisks/ubuntu:24.04', os: 'ubuntu', label: 'Ubuntu 24.04' },
  { ref: 'quay.io/containerdisks/debian:12', os: 'debian', label: 'Debian 12' },
  { ref: 'quay.io/containerdisks/centos-stream:10', os: 'centos', label: 'CentOS Stream 10' },
  { ref: 'quay.io/containerdisks/opensuse-leap:15.6', os: 'linux', label: 'openSUSE Leap 15.6' },
  { ref: 'quay.io/kubevirt/cirros-container-disk-demo:latest', os: 'cirros', label: 'CirrOS (test)' },
];

/** A name and OS guessed from a file name or URL. */
export function guessFromName(nameOrUrl: string): { displayName: string; os: string; media: Media } {
  const file = decodeURIComponent(nameOrUrl.split(/[?#]/)[0].split('/').pop() ?? '').trim();
  const media: Media = /\.iso(\.(gz|xz))?$/i.test(file) ? 'iso' : 'disk';
  const base = file.replace(/\.(gz|xz|zst|bz2)$/i, '').replace(/\.(iso|img|qcow2|raw|vmdk|vhdx?|vdi)$/i, '');
  return { displayName: base || file, os: osIdFrom(file), media };
}

export interface ImageManifestInput {
  namespace: string;
  name: string;
  displayName: string;
  os?: string;
  media: Media;
  sizeBytes: number;
  source: { http: string } | { registry: string } | { upload: true };
  storageClass?: string;
  description?: string;
}

/** A size as an API quantity: whole GiB when it is, else MiB rounded up. */
export function sizeQuantity(bytes: number): string {
  if (bytes >= GiB && bytes % GiB === 0) return `${bytes / GiB}Gi`;
  return `${Math.ceil(bytes / MiB)}Mi`;
}

/** The DataVolume of a new library image. */
export function imageDataVolume(i: ImageManifestInput): Obj {
  const source =
    'http' in i.source
      ? { http: { url: i.source.http.trim() } }
      : 'registry' in i.source
      ? { registry: { url: registryUrl(i.source.registry) } }
      : { upload: {} };
  return {
    apiVersion: 'cdi.kubevirt.io/v1beta1',
    kind: 'DataVolume',
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { [L_IMAGE]: 'true' },
      annotations: {
        [A_DISPLAY]: i.displayName.trim() || i.name,
        [A_MEDIA]: i.media,
        ...(i.os ? { [A_OS]: i.os } : {}),
        ...(i.description ? { [A_DESCRIPTION]: i.description } : {}),
        // Library images have no consumer: import now even on wait-for-first-consumer storage.
        [A_BIND_IMMEDIATE]: 'true',
      },
    },
    spec: {
      source,
      storage: {
        resources: { requests: { storage: sizeQuantity(i.sizeBytes) } },
        ...(i.storageClass ? { storageClassName: i.storageClass } : {}),
      },
    },
  };
}

/** Merge patch for a new name, OS or description (empty string removes the annotation). */
export function editPatch(p: { displayName?: string; os?: string; description?: string; media?: Media }): Obj {
  const ann: Record<string, string | null> = {};
  if (p.media !== undefined) ann[A_MEDIA] = p.media;
  if (p.displayName !== undefined) ann[A_DISPLAY] = p.displayName.trim() || null;
  if (p.os !== undefined) ann[A_OS] = p.os || null;
  if (p.description !== undefined) ann[A_DESCRIPTION] = p.description.trim() || null;
  return { metadata: { annotations: ann } } as unknown as Obj;
}

/** The library namespace and the RBAC that lets every folder clone from it. */
export function libraryManifests(ns: string): { namespace: Obj; role: Obj; binding: Obj } {
  const managed = { 'hangar.magesgate.com/managed': 'true' };
  return {
    namespace: {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: ns, labels: { [L_LIBRARY]: 'true' } },
    },
    role: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: SHARING_NAME, namespace: ns, labels: managed },
      rules: [
        { apiGroups: ['cdi.kubevirt.io'], resources: ['datavolumes/source'], verbs: ['create'] },
        { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['get', 'list', 'watch'] },
        { apiGroups: ['cdi.kubevirt.io'], resources: ['datavolumes', 'datasources'], verbs: ['get', 'list', 'watch'] },
      ],
    },
    binding: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: SHARING_NAME, namespace: ns, labels: managed },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: SHARING_NAME },
      subjects: [
        { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:serviceaccounts' },
        { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:authenticated' },
      ],
    },
  };
}

/** VM disks being copied from an image right now (deleting it would break them). */
export function clonesInProgress(item: { namespace: string; name: string }, dvs: Obj[]): Obj[] {
  return dvs.filter(d => {
    const src = d.spec?.source?.pvc;
    const ref = d.spec?.sourceRef;
    const fromIt =
      (src && src.namespace === item.namespace && src.name === item.name) ||
      (ref && ref.namespace === item.namespace && ref.name === item.name);
    return fromIt && d.status?.phase !== 'Succeeded' && d.status?.phase !== 'Failed';
  });
}

/* ------------------------------------------------- DataSources & crons */

export interface SourceRow {
  key: string;
  namespace: string;
  name: string;
  ready: boolean;
  /** What it points at: a PVC or a snapshot. */
  target?: string;
  /** Kept current by a DataImportCron. */
  cron?: { name: string; schedule?: string; source?: string; lastImport?: string; upToDate?: boolean };
  message?: string;
}

export function sourceRows(dataSources: Obj[], crons: Obj[]): SourceRow[] {
  return dataSources
    .map(ds => {
      const src = ds.status?.source ?? ds.spec?.source ?? {};
      const target = src.pvc
        ? `${src.pvc.namespace ?? ds.metadata.namespace}/${src.pvc.name}`
        : src.snapshot
        ? `${src.snapshot.namespace ?? ds.metadata.namespace}/${src.snapshot.name} (snapshot)`
        : undefined;
      const ready = (ds.status?.conditions ?? []).find((c: any) => c.type === 'Ready');
      const cronName = ds.metadata.labels?.['cdi.kubevirt.io/dataImportCron'];
      const cron = crons.find(
        c =>
          c.metadata.namespace === ds.metadata.namespace &&
          (c.metadata.name === cronName || c.spec?.managedDataSource === ds.metadata.name)
      );
      const upToDate = (cron?.status?.conditions ?? []).find((c: any) => c.type === 'UpToDate');
      return {
        key: key(ds),
        namespace: ds.metadata.namespace as string,
        name: ds.metadata.name,
        ready: ready?.status === 'True',
        target,
        message: ready?.status === 'True' ? undefined : ready?.message,
        cron: cron
          ? {
              name: cron.metadata.name,
              schedule: cron.spec?.schedule,
              source: cron.spec?.template?.spec?.source?.registry?.url,
              lastImport: cron.status?.lastImportTimestamp,
              upToDate: upToDate ? upToDate.status === 'True' : undefined,
            }
          : undefined,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/* ---------------------------------------------------------- file sniff */

export type ImageFormat = 'qcow2' | 'iso' | 'vmdk' | 'vhdx' | 'vhd' | 'vdi' | 'gzip' | 'xz' | 'zstd' | 'raw';

export interface ImageInfo {
  format: ImageFormat;
  /** The disk size the image describes (qcow2, vmdk); raw and ISO: the file size. */
  virtualSize?: number;
}

/** How many bytes `sniffImage` wants: the ISO 9660 signature sits at 32769. */
export const SNIFF_BYTES = 34 * 1024;

const u64be = (b: Uint8Array, o: number) => {
  let v = 0;
  for (let i = 0; i < 8; i++) v = v * 256 + b[o + i];
  return v;
};
const u64le = (b: Uint8Array, o: number) => {
  let v = 0;
  for (let i = 7; i >= 0; i--) v = v * 256 + b[o + i];
  return v;
};
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...Array.from(b.subarray(o, o + n)));

/** Recognises the image format from the first bytes of a file. */
export function sniffImage(head: Uint8Array, fileSize: number): ImageInfo {
  if (head.length >= 32 && ascii(head, 0, 4) === 'QFI\xfb') return { format: 'qcow2', virtualSize: u64be(head, 24) };
  if (head.length >= 20 && ascii(head, 0, 4) === 'KDMV') return { format: 'vmdk', virtualSize: u64le(head, 12) * 512 };
  if (head.length >= 8 && ascii(head, 0, 8) === 'vhdxfile') return { format: 'vhdx' };
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return { format: 'gzip' };
  if (head.length >= 6 && ascii(head, 0, 6) === '\xfd7zXZ\x00') return { format: 'xz' };
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd)
    return { format: 'zstd' };
  if (head.length >= 0x48 && ascii(head, 0x40, 4) === '\x7f\x10\xda\xbe') return { format: 'vdi' };
  if (head.length >= 32774 && ascii(head, 32769, 5) === 'CD001') return { format: 'iso', virtualSize: fileSize };
  if (head.length >= 8 && ascii(head, 0, 8) === 'conectix') return { format: 'vhd' };
  return { format: 'raw', virtualSize: fileSize };
}

/** A disk size for an image: its virtual size (or the file), rounded up to whole GiB, at least 1 GiB. */
export function suggestedSize(info: ImageInfo | null, fileSize: number): number {
  const v = Math.max(info?.virtualSize ?? 0, fileSize);
  // Compressed files grow when unpacked: leave room.
  const need = info && ['gzip', 'xz', 'vhd', 'vhdx'].includes(info.format) && !info.virtualSize ? v * 3 : v;
  return Math.max(GiB, Math.ceil(need / GiB) * GiB);
}

export const FORMAT_LABELS: Record<ImageFormat, string> = {
  qcow2: 'QCOW2 disk image',
  iso: 'ISO image',
  vmdk: 'VMware disk (VMDK)',
  vhdx: 'Hyper-V disk (VHDX)',
  vhd: 'Virtual PC / Hyper-V disk (VHD)',
  vdi: 'VirtualBox disk (VDI)',
  gzip: 'Compressed (gzip)',
  xz: 'Compressed (xz)',
  zstd: 'Compressed (zstd)',
  raw: 'Raw disk image',
};
