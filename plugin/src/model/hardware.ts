/*
 * Host hardware and device passthrough.
 *
 * The inventory comes from Hangar's node agent (hangar/distribution/
 * node-agent): every PCI and USB device and disk of a host, its driver,
 * IOMMU group, which VM holds it, and what the host itself needs.
 *
 * KubeVirt passes a device to a VM by resource name. A "device mapping"
 * (Proxmox's resource mapping) is one entry of the KubeVirt CR's
 * permittedHostDevices: PCI devices by vendor:device id, mediated devices
 * (vGPU profiles) by type name, USB devices by vendor/product. Which
 * physical devices a host offers is the set Hangar bound to vfio-pci on
 * that host: identical devices there form a pool, and a VM gets a free one.
 */

import { clone } from './edit';
import { Obj, VM } from './types';
import { parseQuantity } from './units';
import { launcherVmName } from './vm';
import { slugify } from './vmspec';

/* ------------------------------------------------------------ inventory */

export interface MdevType {
  id: string;
  name: string;
  available: number | null;
  api: string;
  description: string;
}

export interface PciDevice {
  address: string;
  /** Six hex digits: class, subclass, programming interface. */
  class: string;
  className: string | null;
  subclassName: string | null;
  vendor: string;
  device: string;
  vendorName: string | null;
  deviceName: string | null;
  subsystemVendor: string;
  subsystemDevice: string;
  subsystemVendorName: string | null;
  subsystemName: string | null;
  revision: string;
  driver: string | null;
  driverOverride: string | null;
  iommuGroup: string | null;
  numaNode: number | null;
  sriovTotalVfs: number | null;
  sriovNumVfs: number | null;
  /** For a virtual function: its physical function's address. */
  physfn: string | null;
  bootVga: boolean;
  parent: string | null;
  /** Why the host keeps it (its disk controller, its network…). */
  hostNeeds: string | null;
  /** "namespace/name" of the VM holding it now. */
  usedBy: string | null;
  /** Hangar asked the agent to give it to VMs. */
  desired: boolean;
  /** The agent bound it (and will give it back). */
  managed: boolean;
  binder: { state: string; message: string } | null;
  mdevTypes: MdevType[];
}

export interface MdevDevice {
  uuid: string;
  parent: string | null;
  type: string | null;
  iommuGroup: string | null;
  usedBy: string | null;
}

export interface UsbDevice {
  path: string;
  bus: number | null;
  device: number | null;
  vendor: string;
  product: string;
  vendorName: string | null;
  productName: string | null;
  manufacturer: string | null;
  productString: string | null;
  serial: string | null;
  speed: string | null;
  deviceClass: string | null;
  className: string | null;
  interfaceClasses: string[];
  interfaceClassNames: string[];
  drivers: string[];
  controller: string | null;
  usedBy: string | null;
}

export interface HostDisk {
  name: string;
  sizeBytes: number | null;
  model: string | null;
  vendor: string | null;
  serial: string | null;
  wwid: string | null;
  rotational: boolean;
  removable: boolean;
  byId: string[];
  partitions: string[];
  holders: string[];
  mounts: string[];
  controller: string | null;
  transport: string;
  /** What its first blocks hold: ceph, lvm, gpt, mbr, xfs, ext, btrfs, swap, luks. */
  signatures: string[];
  /** Host processes that hold it open (e.g. ceph-osd). */
  openBy: string[];
}

export interface Inventory {
  node: string;
  agent: string;
  generated: string;
  kernel: string;
  cmdline: string;
  iommuGroups: number | null;
  vfioLoaded: boolean;
  /** Unix seconds of the agent's last vfio-pci bind. */
  lastBind: number | null;
  /** firewalld runs on the host (published host ports need opening there); null from an agent that does not tell. */
  firewalld: boolean | null;
  pci: PciDevice[];
  mdevs: MdevDevice[];
  usb: UsbDevice[];
  disks: HostDisk[];
}

/** Parses the agent's JSON, tolerating fields a newer or older agent adds or lacks. */
export function parseInventory(text: string): Inventory {
  const raw = JSON.parse(text);
  const arr = (x: any) => (Array.isArray(x) ? x : []);
  return {
    node: String(raw.node ?? ''),
    agent: String(raw.agent ?? ''),
    generated: String(raw.generated ?? ''),
    kernel: String(raw.kernel ?? ''),
    cmdline: String(raw.cmdline ?? ''),
    iommuGroups: typeof raw.iommuGroups === 'number' ? raw.iommuGroups : null,
    vfioLoaded: !!raw.vfioLoaded,
    lastBind: typeof raw.lastBind === 'number' ? raw.lastBind : null,
    firewalld: typeof raw.firewalld === 'boolean' ? raw.firewalld : null,
    pci: arr(raw.pci).map((p: any) => ({ ...p, mdevTypes: arr(p.mdevTypes) })),
    mdevs: arr(raw.mdevs),
    usb: arr(raw.usb).map((u: any) => ({ ...u, interfaceClasses: arr(u.interfaceClasses), interfaceClassNames: arr(u.interfaceClassNames), drivers: arr(u.drivers) })),
    disks: arr(raw.disks).map((b: any) => ({ ...b, byId: arr(b.byId), partitions: arr(b.partitions), holders: arr(b.holders), mounts: arr(b.mounts), signatures: arr(b.signatures), openBy: arr(b.openBy) })),
  };
}

export const iommuOn = (inv: Inventory) => (inv.iommuGroups ?? 0) > 0;

/* --------------------------------------------------------- PCI classes */

export type PciKind = 'gpu' | 'accelerator' | 'storage' | 'network' | 'usb' | 'multimedia' | 'bridge' | 'other';

export const PCI_KINDS: { kind: PciKind; label: string; icon: string }[] = [
  { kind: 'gpu', label: 'Graphics', icon: 'mdi:expansion-card' },
  { kind: 'accelerator', label: 'Accelerators', icon: 'mdi:chip' },
  { kind: 'storage', label: 'Storage controllers', icon: 'mdi:harddisk' },
  { kind: 'network', label: 'Network controllers', icon: 'mdi:ethernet' },
  { kind: 'usb', label: 'USB controllers', icon: 'mdi:usb' },
  { kind: 'multimedia', label: 'Audio and video', icon: 'mdi:volume-high' },
  { kind: 'other', label: 'Other devices', icon: 'mdi:puzzle-outline' },
  { kind: 'bridge', label: 'Bridges and chipset', icon: 'mdi:transit-connection-variant' },
];

export function pciKind(cls: string): PciKind {
  const c = cls.slice(0, 2);
  const sc = cls.slice(0, 4);
  if (c === '03') return 'gpu';
  if (c === '12' || c === '0b') return 'accelerator';
  if (c === '01') return 'storage';
  if (c === '02' || c === '0d') return 'network';
  if (sc === '0c03') return 'usb';
  if (c === '04') return 'multimedia';
  if (c === '06' || c === '08' || sc === '0c05' || c === '05') return 'bridge';
  return 'other';
}

const STORAGE_KINDS: Record<string, string> = {
  '0100': 'SCSI',
  '0101': 'IDE',
  '0104': 'RAID',
  '0105': 'ATA',
  '0106': 'SATA',
  '0107': 'SAS',
  '0108': 'NVMe',
  '0109': 'UFS',
};

/** "SAS controller", "NVMe controller"… for storage, else the subclass name. */
export function pciKindLabel(p: PciDevice): string {
  const sc = p.class.slice(0, 4);
  if (STORAGE_KINDS[sc]) return `${STORAGE_KINDS[sc]} controller`;
  return p.subclassName ?? p.className ?? `Class ${p.class}`;
}

export function pciName(p: PciDevice): string {
  return p.deviceName ?? `Device ${p.vendor}:${p.device}`;
}

export function pciVendor(p: PciDevice): string {
  return p.vendorName ?? `Vendor ${p.vendor}`;
}

export const pciId = (p: { vendor: string; device: string }) => `${p.vendor}:${p.device}`.toLowerCase();

export const isVf = (p: PciDevice) => !!p.physfn;

/* ------------------------------------------------------------- states */

export type DeviceState =
  | { kind: 'assigned'; vm: string; label: string }
  | { kind: 'ready'; label: string; outside?: boolean }
  | { kind: 'preparing'; label: string }
  | { kind: 'returning'; label: string; message?: string }
  | { kind: 'failed'; label: string; message: string }
  | { kind: 'host'; label: string; driver: string }
  | { kind: 'idle'; label: string };

/** Where a PCI device stands, as one line. */
export function pciState(p: PciDevice): DeviceState {
  if (p.usedBy) return { kind: 'assigned', vm: p.usedBy, label: `In use by ${p.usedBy.split('/')[1] ?? p.usedBy}` };
  if (p.binder?.state === 'failed' || p.binder?.state === 'refused' || p.binder?.state === 'missing')
    return { kind: 'failed', label: p.binder.state === 'refused' ? 'Kept for the host' : 'Could not prepare', message: p.binder.message };
  if (p.driver === 'vfio-pci') {
    if (p.managed && !p.desired) return { kind: 'returning', label: 'Going back to the host', message: p.binder?.message };
    return { kind: 'ready', label: 'Ready for VMs', outside: !p.managed && !p.desired };
  }
  if (p.desired) return { kind: 'preparing', label: 'Preparing for VMs' };
  if (p.driver) return { kind: 'host', label: `Host driver ${p.driver}`, driver: p.driver };
  return { kind: 'idle', label: 'No driver' };
}

/** Other endpoint devices in the same IOMMU group (bridges do not count). */
export function groupMates(inv: Inventory, p: PciDevice): PciDevice[] {
  if (!p.iommuGroup) return [];
  return inv.pci.filter(x => x.address !== p.address && x.iommuGroup === p.iommuGroup && pciKind(x.class) !== 'bridge');
}

/** Whether Hangar can give this PCI device to VMs, and why not. */
export function canPassThrough(inv: Inventory, p: PciDevice): { ok: boolean; why?: string } {
  if (!iommuOn(inv)) return { ok: false, why: 'The IOMMU is off on this host.' };
  if (pciKind(p.class) === 'bridge') return { ok: false, why: 'Bridges and chipset devices stay with the host.' };
  if (p.hostNeeds) return { ok: false, why: `The host needs it: it ${p.hostNeeds}.` };
  if ((p.sriovNumVfs ?? 0) > 0) return { ok: false, why: `It runs ${p.sriovNumVfs} virtual functions: give those to VMs instead.` };
  const busy = groupMates(inv, p).find(m => m.hostNeeds);
  if (busy) return { ok: false, why: `It shares IOMMU group ${p.iommuGroup} with ${busy.address}, which the host needs.` };
  return { ok: true };
}

export function usbName(u: UsbDevice): string {
  return u.productString ?? u.productName ?? `Device ${u.vendor}:${u.product}`;
}

export function usbVendor(u: UsbDevice): string {
  return u.manufacturer ?? u.vendorName ?? `Vendor ${u.vendor}`;
}

/** A disk Hangar may hand to a VM whole: nothing on it the host uses. */
export function diskFree(d: HostDisk): { ok: boolean; why?: string } {
  if (d.transport === 'cdrom') return { ok: false, why: 'CD/DVD drives are not passed through.' };
  if (d.mounts.length) return { ok: false, why: `The host has it mounted (${d.mounts.join(', ')}).` };
  if (d.openBy.length) return { ok: false, why: `The host uses it (${d.openBy.map(x => (x === 'ceph-osd' ? 'Ceph OSD' : x)).join(', ')}).` };
  if (d.holders.length) return { ok: false, why: `The host uses it (${d.holders.length} volume${d.holders.length === 1 ? '' : 's'} on it).` };
  if (d.partitions.length) return { ok: false, why: `It has partitions (${d.partitions.join(', ')}): wipe it on the host first if it is really free.` };
  if (d.signatures.length)
    return { ok: false, why: `It holds ${d.signatures.map(x => SIGNATURES[x] ?? x).join(', ')}: wipe it on the host first if it is really free.` };
  if (!stableDiskPath(d)) return { ok: false, why: 'It has no stable name under /dev/disk/by-id.' };
  return { ok: true };
}

const SIGNATURES: Record<string, string> = {
  ceph: 'a Ceph OSD',
  lvm: 'LVM volumes',
  gpt: 'a GPT partition table',
  mbr: 'an MBR partition table',
  xfs: 'an XFS filesystem',
  ext: 'an ext filesystem',
  btrfs: 'a Btrfs filesystem',
  swap: 'swap',
  luks: 'an encrypted (LUKS) volume',
};

const BY_ID_ORDER = ['wwn-', 'nvme-eui.', 'nvme-', 'scsi-3', 'ata-', 'scsi-', 'virtio-', 'usb-'];

/** The by-id path that names this disk across reboots. */
export function stableDiskPath(d: HostDisk): string | null {
  const ids = d.byId.filter(x => !x.includes('-part'));
  for (const p of BY_ID_ORDER) {
    const hit = ids.find(x => x.startsWith(p));
    if (hit) return `/dev/disk/by-id/${hit}`;
  }
  return ids[0] ? `/dev/disk/by-id/${ids[0]}` : null;
}

/* ------------------------------------------------------------ mappings */

export const RESOURCE_PREFIX = 'hangar.magesgate.com/';
export const MAPPINGS_ANNOTATION = 'hangar.magesgate.com/device-mappings';

export type MappingKind = 'pci' | 'mdev' | 'usb';

export interface Mapping {
  resourceName: string;
  kind: MappingKind;
  /** PCI "vvvv:dddd", mdev type name, or USB "vvvv:pppp" (several joined by ", "). */
  selector: string;
  usb?: { vendor: string; product: string }[];
  /** A device plugin outside KubeVirt provides it (e.g. the NVIDIA operator). */
  external: boolean;
  /** The name Hangar shows. */
  label: string;
  /** Passed as a GPU (display) rather than a generic host device. */
  gpu: boolean;
  /** Created from Hangar (has a label entry). */
  hangar: boolean;
}

type Labels = Record<string, { label?: string; gpu?: boolean }>;

function labelsOf(kv: Obj | null): Labels {
  try {
    const v = JSON.parse(kv?.metadata?.annotations?.[MAPPINGS_ANNOTATION] ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The device mappings of the KubeVirt CR. */
export function mappingsOf(kv: Obj | null): Mapping[] {
  const hd = kv?.spec?.configuration?.permittedHostDevices ?? {};
  const labels = labelsOf(kv);
  const out: Mapping[] = [];
  const nice = (r: string) => labels[r]?.label ?? r.split('/').pop() ?? r;
  for (const p of hd.pciHostDevices ?? []) {
    out.push({
      resourceName: p.resourceName,
      kind: 'pci',
      selector: String(p.pciVendorSelector ?? '').toLowerCase(),
      external: !!p.externalResourceProvider,
      label: nice(p.resourceName),
      gpu: labels[p.resourceName]?.gpu ?? /gpu|vga|graphics|display/i.test(p.resourceName),
      hangar: !!labels[p.resourceName],
    });
  }
  for (const m of hd.mediatedDevices ?? []) {
    out.push({
      resourceName: m.resourceName,
      kind: 'mdev',
      selector: m.mdevNameSelector,
      external: !!m.externalResourceProvider,
      label: nice(m.resourceName),
      gpu: labels[m.resourceName]?.gpu ?? true,
      hangar: !!labels[m.resourceName],
    });
  }
  for (const u of hd.usb ?? []) {
    const sel = (u.selectors ?? []).map((s: any) => ({ vendor: String(s.vendor ?? '').toLowerCase(), product: String(s.product ?? '').toLowerCase() }));
    out.push({
      resourceName: u.resourceName,
      kind: 'usb',
      selector: sel.map((s: any) => `${s.vendor}:${s.product}`).join(', '),
      usb: sel,
      external: !!u.externalResourceProvider,
      label: nice(u.resourceName),
      gpu: false,
      hangar: !!labels[u.resourceName],
    });
  }
  return out;
}

/**
 * Mappings made outside Hangar carry no "GPU" flag: a PCI mapping counts as
 * a GPU when a matching device on any host is a display or accelerator.
 */
export function withDeviceKinds(mappings: Mapping[], inventories: Inventory[]): Mapping[] {
  return mappings.map(m => {
    if (m.hangar || m.kind !== 'pci' || m.gpu) return m;
    const hit = inventories.some(inv => inv.pci.some(p => pciId(p) === m.selector && ['gpu', 'accelerator'].includes(pciKind(p.class))));
    return hit ? { ...m, gpu: true } : m;
  });
}

export function mappingForPci(mappings: Mapping[], p: { vendor: string; device: string }): Mapping | undefined {
  return mappings.find(m => m.kind === 'pci' && m.selector === pciId(p));
}

export function mappingForUsb(mappings: Mapping[], u: { vendor: string; product: string }): Mapping | undefined {
  return mappings.find(m => m.kind === 'usb' && (m.usb ?? []).some(s => s.vendor === u.vendor.toLowerCase() && s.product === u.product.toLowerCase()));
}

export function mappingForMdev(mappings: Mapping[], typeName: string): Mapping | undefined {
  const n = (s: string) => s.replace(/\s+/g, '_').trim();
  return mappings.find(m => m.kind === 'mdev' && n(m.selector) === n(typeName));
}

/** A resource name for a new mapping, unique among the existing ones. */
export function newResourceName(label: string, mappings: Mapping[]): string {
  const base = slugify(label).slice(0, 50) || 'device';
  const taken = new Set(mappings.map(m => m.resourceName));
  let name = `${RESOURCE_PREFIX}${base}`;
  for (let i = 2; taken.has(name); i++) name = `${RESOURCE_PREFIX}${base}-${i}`;
  return name;
}

export interface NewMapping {
  kind: MappingKind;
  resourceName: string;
  label: string;
  gpu: boolean;
  /** pci: "vvvv:dddd"; mdev: the type name; usb: unused. */
  selector?: string;
  usb?: { vendor: string; product: string }[];
  /** mdev: the type id KubeVirt should create instances of (mediatedDevicesConfiguration). */
  mdevTypeId?: string;
}

function hostDevicesOf(kv: Obj): any {
  kv.spec ??= {};
  kv.spec.configuration ??= {};
  kv.spec.configuration.permittedHostDevices ??= {};
  return kv.spec.configuration.permittedHostDevices;
}

function setLabels(kv: Obj, labels: Labels) {
  kv.metadata.annotations = { ...(kv.metadata.annotations ?? {}) };
  if (Object.keys(labels).length) kv.metadata.annotations[MAPPINGS_ANNOTATION] = JSON.stringify(labels);
  else delete kv.metadata.annotations[MAPPINGS_ANNOTATION];
}

export const PASSTHROUGH_GATE = 'HostDevices';

export function passthroughEnabled(kv: Obj | null): boolean {
  const gates: string[] = kv?.spec?.configuration?.developerConfiguration?.featureGates ?? [];
  return gates.includes(PASSTHROUGH_GATE);
}

/** Turns on KubeVirt's host device passthrough (the HostDevices feature gate), keeping other gates. */
export function enablePassthrough(kv: Obj): Obj {
  const out = clone(kv);
  out.spec ??= {};
  out.spec.configuration ??= {};
  out.spec.configuration.developerConfiguration ??= {};
  const gates: string[] = out.spec.configuration.developerConfiguration.featureGates ?? [];
  if (!gates.includes(PASSTHROUGH_GATE)) out.spec.configuration.developerConfiguration.featureGates = [...gates, PASSTHROUGH_GATE];
  return out;
}

/** Adds a mapping (and the feature gate). Entries Hangar did not create stay as they are. */
export function addMapping(kv: Obj, m: NewMapping): Obj {
  const out = enablePassthrough(kv);
  const hd = hostDevicesOf(out);
  if (m.kind === 'pci') {
    const sel = (m.selector ?? '').toLowerCase();
    hd.pciHostDevices = [...(hd.pciHostDevices ?? []).filter((x: any) => String(x.pciVendorSelector).toLowerCase() !== sel), { pciVendorSelector: sel, resourceName: m.resourceName }];
  } else if (m.kind === 'mdev') {
    hd.mediatedDevices = [...(hd.mediatedDevices ?? []).filter((x: any) => x.resourceName !== m.resourceName), { mdevNameSelector: m.selector, resourceName: m.resourceName }];
    if (m.mdevTypeId) {
      out.spec.configuration.mediatedDevicesConfiguration ??= {};
      const types: string[] = out.spec.configuration.mediatedDevicesConfiguration.mediatedDeviceTypes ?? [];
      if (!types.includes(m.mdevTypeId)) out.spec.configuration.mediatedDevicesConfiguration.mediatedDeviceTypes = [...types, m.mdevTypeId];
    }
  } else {
    hd.usb = [
      ...(hd.usb ?? []).filter((x: any) => x.resourceName !== m.resourceName),
      { resourceName: m.resourceName, selectors: (m.usb ?? []).map(s => ({ vendor: s.vendor, product: s.product })) },
    ];
  }
  const labels = labelsOf(out);
  labels[m.resourceName] = { label: m.label, gpu: m.gpu };
  setLabels(out, labels);
  return out;
}

/** Removes a mapping by resource name. */
export function removeMapping(kv: Obj, resourceName: string): Obj {
  const out = clone(kv);
  const hd = hostDevicesOf(out);
  for (const k of ['pciHostDevices', 'mediatedDevices', 'usb']) {
    if (!Array.isArray(hd[k])) continue;
    hd[k] = hd[k].filter((x: any) => x.resourceName !== resourceName);
    if (!hd[k].length) delete hd[k];
  }
  const labels = labelsOf(out);
  delete labels[resourceName];
  setLabels(out, labels);
  return out;
}

export function renameMapping(kv: Obj, resourceName: string, label: string, gpu?: boolean): Obj {
  const out = clone(kv);
  const labels = labelsOf(out);
  labels[resourceName] = { ...(labels[resourceName] ?? {}), label, ...(gpu === undefined ? {} : { gpu }) };
  setLabels(out, labels);
  return out;
}

/* ------------------------------------------------------- availability */

export interface HostAvail {
  host: string;
  /** Devices the host reports (capacity) and the healthy ones (allocatable). */
  total: number;
  healthy: number;
  used: number;
  free: number;
  /** "namespace/name" of the VMs holding one. */
  vms: string[];
}

function podRequest(p: Obj, resource: string): number {
  return (p.spec?.containers ?? []).reduce((n: number, c: any) => n + parseQuantity(c.resources?.limits?.[resource] ?? c.resources?.requests?.[resource] ?? 0), 0);
}

/** Per host: how many devices of a mapping there are, in use and free. */
export function availability(resourceName: string, nodes: Obj[], launchers: Obj[]): HostAvail[] {
  const out: HostAvail[] = [];
  for (const n of nodes) {
    const total = parseQuantity(n.status?.capacity?.[resourceName] ?? 0) || 0;
    const healthy = parseQuantity(n.status?.allocatable?.[resourceName] ?? 0) || 0;
    const pods = launchers.filter(
      p => p.spec?.nodeName === n.metadata.name && !p.metadata.deletionTimestamp && ['Running', 'Pending'].includes(p.status?.phase) && podRequest(p, resourceName) > 0
    );
    const used = pods.reduce((s, p) => s + podRequest(p, resourceName), 0);
    const vms = pods.map(p => `${p.metadata.namespace}/${launcherVmName(p) ?? p.metadata.name}`);
    if (total || used) out.push({ host: n.metadata.name, total, healthy, used, free: Math.max(0, healthy - used), vms });
  }
  return out;
}

/* ----------------------------------------------------------- VM devices */

export interface VmDevice {
  name: string;
  deviceName: string;
  as: 'gpu' | 'host';
}

export function vmDevices(vm: VM): VmDevice[] {
  const d = vm.spec?.template?.spec?.domain?.devices ?? {};
  return [
    ...(d.gpus ?? []).map((g: any) => ({ name: g.name, deviceName: g.deviceName, as: 'gpu' as const })),
    ...(d.hostDevices ?? []).map((h: any) => ({ name: h.name, deviceName: h.deviceName, as: 'host' as const })),
  ];
}

/** VMs (by "namespace/name") whose spec asks for a resource. */
export function vmsUsingResource(vms: VM[], resourceName: string): string[] {
  return vms.filter(v => vmDevices(v).some(x => x.deviceName === resourceName)).map(v => `${v.metadata.namespace}/${v.metadata.name}`);
}

function devs(vm: VM): any {
  vm.spec ??= {};
  vm.spec.template ??= {};
  vm.spec.template.spec ??= {};
  vm.spec.template.spec.domain ??= {};
  vm.spec.template.spec.domain.devices ??= {};
  return vm.spec.template.spec.domain.devices;
}

/** Adds a host device to the VM: GPUs under `gpus`, the rest (PCI, USB) under `hostDevices`. */
export function addVmDevice(vm: VM, m: { resourceName: string; gpu: boolean; kind: MappingKind }): { vm: VM; name: string } {
  const out = clone(vm);
  const d = devs(out);
  const names = new Set(vmDevices(out).map(x => x.name));
  const base = m.kind === 'usb' ? 'usb' : m.gpu ? 'gpu' : 'pci';
  let name = base;
  for (let i = 1; names.has(name); i++) name = `${base}${i}`;
  const entry = { name, deviceName: m.resourceName };
  if (m.gpu && m.kind !== 'usb') d.gpus = [...(d.gpus ?? []), entry];
  else d.hostDevices = [...(d.hostDevices ?? []), entry];
  return { vm: out, name };
}

export function removeVmDevice(vm: VM, name: string): VM {
  const out = clone(vm);
  const d = devs(out);
  for (const k of ['gpus', 'hostDevices']) {
    if (!Array.isArray(d[k])) continue;
    d[k] = d[k].filter((x: any) => x.name !== name);
    if (!d[k].length) delete d[k];
  }
  return out;
}

/** Hosts that have every device the VM asks for (capacity), or null when it asks for none. */
export function hostsForVmDevices(vm: VM, nodes: Obj[]): string[] | null {
  const want = vmDevices(vm).map(x => x.deviceName);
  if (!want.length) return null;
  return nodes.filter(n => want.every(r => parseQuantity(n.status?.capacity?.[r] ?? 0) > 0)).map(n => n.metadata.name);
}

/* ------------------------------------------------------ host disk (PV) */

export const HOST_DISK_LABEL = 'hangar.magesgate.com/host-disk';
export const HOST_LABEL = 'hangar.magesgate.com/host';

/** The PV and PVC that give a whole host disk to VMs of a folder. */
export function hostDiskClaim(
  host: string,
  disk: HostDisk,
  namespace: string,
  claimName: string
): { pv: Obj; pvc: Obj } {
  const path = stableDiskPath(disk);
  if (!path) throw new Error(`${disk.name} has no stable name under /dev/disk/by-id`);
  const pvName = `hangar-${slugify(host.split('.')[0]).slice(0, 30)}-${slugify(path.split('/').pop() ?? disk.name).slice(0, 25)}`.replace(/-+$/, '').slice(0, 63);
  const size = String(disk.sizeBytes ?? 0);
  const label = [disk.vendor, disk.model, disk.serial].filter(Boolean).join(' ');
  return {
    pv: {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: {
        name: pvName,
        labels: { [HOST_DISK_LABEL]: 'true', [HOST_LABEL]: slugify(host).slice(0, 63) },
        annotations: { 'hangar.magesgate.com/host-name': host, 'hangar.magesgate.com/disk': label || disk.name, 'hangar.magesgate.com/device-path': path },
      },
      spec: {
        capacity: { storage: size },
        volumeMode: 'Block',
        accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: '',
        local: { path },
        claimRef: { namespace, name: claimName },
        nodeAffinity: {
          required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [host] }] }] },
        },
      },
    },
    pvc: {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: claimName, namespace, labels: { [HOST_DISK_LABEL]: 'true' }, annotations: { 'hangar.magesgate.com/host-name': host } },
      spec: {
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Block',
        storageClassName: '',
        volumeName: pvName,
        resources: { requests: { storage: size } },
      },
    },
  };
}

/** The host disk PV (if any) that points at this disk of this host. */
export function pvForDisk(pvs: Obj[], host: string, disk: HostDisk): Obj | undefined {
  const paths = new Set(disk.byId.map(x => `/dev/disk/by-id/${x}`));
  return pvs.find(pv => pv.metadata.annotations?.['hangar.magesgate.com/host-name'] === host && paths.has(pv.spec?.local?.path));
}

/* --------------------------------------------- "Add device" candidates */

/** What the Add device flow offers, in the user's words. */
export type AddKind = 'gpu' | 'storage' | 'network' | 'pci' | 'usb' | 'mdev' | 'disk';

/** The Add device kind of a PCI device (null for bridges and chipset). */
export function addKindOf(p: PciDevice): AddKind | null {
  const k = pciKind(p.class);
  if (k === 'bridge') return null;
  if (k === 'gpu' || k === 'accelerator') return 'gpu';
  if (k === 'storage' || k === 'network') return k;
  return 'pci';
}

export interface HostInventory {
  host: string;
  inv: Inventory;
}

export interface PciCandidate {
  host: string;
  inv: Inventory;
  p: PciDevice;
  /** It can be given to VMs now. */
  ok: boolean;
  why?: string;
  mapping?: Mapping;
}

/** Every PCI device of a kind on every host, and whether it can be given to VMs now (else why not). */
export function pciCandidates(hosts: HostInventory[], kind: AddKind, mappings: Mapping[]): PciCandidate[] {
  const out: PciCandidate[] = [];
  for (const { host, inv } of hosts) {
    for (const p of inv.pci) {
      if (addKindOf(p) !== kind) continue;
      const mapping = mappingForPci(mappings, p);
      const pass = canPassThrough(inv, p);
      let why: string | undefined;
      if (p.usedBy) why = `In use by ${p.usedBy}`;
      else if (p.driver === 'vfio-pci' && (p.managed || p.desired)) why = mapping ? `Already given to VMs (${mapping.label})` : 'Already given to VMs';
      else if (p.desired) why = 'Being prepared for VMs';
      else if (!pass.ok) why = pass.why;
      out.push({ host, inv, p, ok: !why, why, mapping });
    }
  }
  return out;
}

export const candidateKey = (c: { host: string; p: { address: string } }) => `${c.host}|${c.p.address}`;

/** One mapping matches one model: a candidate joins a selection only if it is the same vendor:device. */
export function canJoinSelection(selected: PciCandidate[], c: PciCandidate): { ok: boolean; why?: string } {
  if (!c.ok) return { ok: false, why: c.why };
  const first = selected.find(s => candidateKey(s) !== candidateKey(c));
  if (first && pciId(first.p) !== pciId(c.p))
    return { ok: false, why: `A mapping matches one model: these are ${pciId(c.p)}, the selected ones ${pciId(first.p)}.` };
  return { ok: true };
}

/**
 * The devices each host binds for a selection: the chosen ones and their
 * IOMMU group mates (a VM can only take a whole group), not already ready.
 */
export function selectionGroups(selected: PciCandidate[]): { host: string; devices: PciDevice[]; mates: PciDevice[] }[] {
  const byHost = new Map<string, { inv: Inventory; chosen: PciDevice[] }>();
  for (const c of selected) {
    const g = byHost.get(c.host) ?? { inv: c.inv, chosen: [] };
    g.chosen.push(c.p);
    byHost.set(c.host, g);
  }
  return [...byHost.entries()].map(([host, g]) => {
    const chosen = new Set(g.chosen.map(p => p.address));
    const mates: PciDevice[] = [];
    for (const p of g.chosen)
      for (const m of groupMates(g.inv, p))
        if (!chosen.has(m.address) && !mates.some(x => x.address === m.address) && !(m.driver === 'vfio-pci' && (m.managed || m.desired))) mates.push(m);
    return { host, devices: [...g.chosen, ...mates], mates };
  });
}
