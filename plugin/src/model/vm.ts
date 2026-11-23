/*
 * The virtual machine as a virtualizer user sees it: power state, hardware,
 * disks, network adapters, guest OS, policies. Pure functions over the
 * VirtualMachine (VM) and its running instance (VMI).
 */

import { LedTone } from '../ui/tokens';
import { Condition, Obj, VM, VMDisk, VMI, VMInterface, VMNetwork, VMVolume } from './types';
import { parseQuantity } from './units';

export const HANGAR = 'hangar.magesgate.com';
export const L_TEMPLATE = `${HANGAR}/template`;
export const A_OS = `${HANGAR}/os`;
export const A_DISPLAY = `${HANGAR}/display-name`;
export const A_NOTES = 'description';

export function key(o: { metadata: { namespace?: string; name: string } }): string {
  return `${o.metadata.namespace ?? ''}/${o.metadata.name}`;
}

export function cond(o: Obj | null | undefined, type: string): Condition | undefined {
  return (o?.status?.conditions as Condition[] | undefined)?.find(c => c.type === type);
}

/* ---------------------------------------------------------------- power */

export type PowerKind =
  | 'on'
  | 'off'
  | 'paused'
  | 'starting'
  | 'stopping'
  | 'migrating'
  | 'provisioning'
  | 'deleting'
  | 'error';

export interface PowerState {
  kind: PowerKind;
  /** Short label, e.g. "Powered on". */
  label: string;
  tone: LedTone;
  /** Why, for errors and waits. */
  detail?: string;
  /** KubeVirt's printableStatus, for the Kubernetes view. */
  printable: string;
}

const ERRORS: Record<string, string> = {
  CrashLoopBackOff: 'The VM keeps crashing at start',
  ErrorUnschedulable: 'No host can run it',
  ErrImagePull: 'A disk image cannot be pulled',
  ImagePullBackOff: 'A disk image cannot be pulled',
  ErrorPvcNotFound: 'A disk is missing',
  ErrorDataVolumeNotFound: 'A disk is missing',
  DataVolumeError: 'A disk could not be prepared',
  Unknown: 'The host does not report this VM',
};

/** The power state from printableStatus, refined with the VMI and conditions. */
export function powerState(vm: VM, vmi?: VMI | null): PowerState {
  const printable: string = vm.status?.printableStatus ?? (vmi ? vmi.status?.phase ?? 'Unknown' : 'Stopped');
  const failure = cond(vm, 'Failure');
  const msg = failure?.status === 'True' ? failure.message : undefined;
  const mk = (kind: PowerKind, label: string, tone: LedTone, detail?: string): PowerState => ({
    kind,
    label,
    tone,
    detail,
    printable,
  });
  if (vm.metadata.deletionTimestamp) return mk('deleting', 'Deleting', 'busy');
  switch (printable) {
    case 'Running': {
      const ms = vmi?.status?.migrationState;
      if (ms && !ms.completed) {
        return mk('migrating', 'Migrating', 'busy', ms.targetNode ? `from ${ms.sourceNode} to ${ms.targetNode}` : undefined);
      }
      const paused = cond(vmi ?? vm, 'Paused');
      if (paused?.status === 'True') return mk('paused', 'Suspended', 'standby');
      return mk('on', 'Powered on', 'on');
    }
    case 'Paused':
      return mk('paused', 'Suspended', 'standby');
    case 'Stopped':
    case 'Halted':
      return mk('off', 'Powered off', 'off');
    case 'Starting':
      return mk('starting', 'Starting', 'busy');
    case 'Stopping':
      return mk('stopping', 'Shutting down', 'busy');
    case 'Terminating':
      return mk('stopping', 'Shutting down', 'busy');
    case 'Migrating':
      return mk('migrating', 'Migrating', 'busy');
    case 'Provisioning':
      return mk('provisioning', 'Preparing disks', 'busy', msg);
    case 'WaitingForVolumeBinding':
      return mk('provisioning', 'Waiting for storage', 'busy', msg);
    case 'WaitingForReceiver':
      return mk('provisioning', 'Waiting for a migration', 'busy', msg);
    default:
      if (printable in ERRORS) {
        // A DataVolumeError while the source image is still importing is a wait, not a failure.
        if (printable === 'DataVolumeError' && msg && /not.*ready|in progress|waiting/i.test(msg)) {
          return mk('provisioning', 'Preparing disks', 'busy', msg);
        }
        return mk('error', ERRORS[printable], 'fault', msg ?? printable);
      }
      return mk('error', printable || 'Unknown', 'fault', msg);
  }
}

export function runStrategy(vm: VM): string {
  if (vm.spec?.runStrategy) return vm.spec.runStrategy;
  if (vm.spec?.running === true) return 'Always';
  return 'Halted';
}

export const RUN_STRATEGIES: { value: string; label: string; help: string }[] = [
  { value: 'Always', label: 'Always on', help: 'Restarted whenever it stops, on any host.' },
  {
    value: 'RerunOnFailure',
    label: 'Restart after a failure',
    help: 'Restarted after a crash, stays off after a guest shutdown.',
  },
  { value: 'Manual', label: 'Manual', help: 'Only you power it on and off.' },
  { value: 'Halted', label: 'Off', help: 'Kept powered off.' },
  { value: 'Once', label: 'Run once', help: 'Runs until it stops, then stays off.' },
];

export function runStrategyLabel(rs: string): string {
  return RUN_STRATEGIES.find(r => r.value === rs)?.label ?? rs;
}

/** Which power actions make sense now. */
export function powerActions(p: PowerState, rs: string) {
  const on = p.kind === 'on' || p.kind === 'migrating';
  return {
    start: p.kind === 'off' || (p.kind === 'error' && rs !== 'Always'),
    shutdown: on || p.kind === 'paused' || p.kind === 'starting' || (p.kind === 'error' && rs !== 'Halted'),
    powerOff: p.kind !== 'off' && p.kind !== 'deleting',
    restart: on,
    reset: on,
    suspend: p.kind === 'on',
    resume: p.kind === 'paused',
    migrate: p.kind === 'on',
  };
}

export function isTemplate(vm: VM): boolean {
  return vm.metadata.labels?.[L_TEMPLATE] === 'true';
}

export function displayName(vm: Obj): string {
  return vm.metadata.annotations?.[A_DISPLAY] || vm.metadata.name;
}

export function notes(vm: VM): string {
  return vm.metadata.annotations?.[A_NOTES] ?? '';
}

/** User-facing tags: labels that are not system ones. */
export function tags(o: Obj): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(o.metadata.labels ?? {})) {
    if (/(^|\.)kubevirt\.io\/|^kubernetes\.io\/|^app\.kubernetes\.io\/managed-by|magesgate\.com\//.test(k)) continue;
    out.push([k, v]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/* ------------------------------------------------------------- hardware */

export interface Hardware {
  vcpus: number;
  sockets: number;
  cores: number;
  threads: number;
  memoryBytes: number;
  /** Where the sizing comes from: the VM itself or a size profile (instancetype). */
  instancetype?: { kind: string; name: string };
  preference?: { kind: string; name: string };
  firmware: 'UEFI' | 'UEFI (Secure Boot)' | 'BIOS';
  machine?: string;
  cpuModel?: string;
  dedicatedCpus: boolean;
  tpm: boolean;
  gpus: number;
  hostDevices: number;
}

/** Hardware of a VM. A running VMI carries the expanded spec (instancetype applied). */
export function hardware(vm: VM, vmi?: VMI | null, instancetypes: Obj[] = []): Hardware {
  const domain = (vmi?.spec?.domain ?? vm.spec?.template?.spec?.domain ?? {}) as any;
  const it = vm.spec?.instancetype as { kind?: string; name: string } | undefined;
  const itObj = it
    ? instancetypes.find(i => i.metadata.name === it.name && (!i.metadata.namespace || i.metadata.namespace === vm.metadata.namespace))
    : undefined;
  let sockets = domain.cpu?.sockets ?? 0;
  let cores = domain.cpu?.cores ?? 0;
  let threads = domain.cpu?.threads ?? 0;
  let vcpus = (sockets || 1) * (cores || 1) * (threads || 1);
  if (!domain.cpu?.sockets && !domain.cpu?.cores && !domain.cpu?.threads) {
    const guest = itObj?.spec?.cpu?.guest;
    vcpus = guest ?? 1;
    sockets = vcpus;
    cores = 1;
    threads = 1;
  } else {
    sockets ||= 1;
    cores ||= 1;
    threads ||= 1;
  }
  let memoryBytes = parseQuantity(domain.memory?.guest ?? domain.resources?.requests?.memory);
  if (!isFinite(memoryBytes)) memoryBytes = parseQuantity(itObj?.spec?.memory?.guest);
  const efi = domain.firmware?.bootloader?.efi;
  const gpus = (domain.devices?.gpus ?? []).length;
  const hostDevices = (domain.devices?.hostDevices ?? []).length;
  return {
    vcpus,
    sockets,
    cores,
    threads,
    memoryBytes: isFinite(memoryBytes) ? memoryBytes : 0,
    instancetype: it ? { kind: it.kind ?? 'VirtualMachineClusterInstancetype', name: it.name } : undefined,
    preference: vm.spec?.preference,
    firmware: efi ? (efi.secureBoot === false ? 'UEFI' : 'UEFI (Secure Boot)') : 'BIOS',
    machine: domain.machine?.type,
    cpuModel: domain.cpu?.model,
    dedicatedCpus: !!domain.cpu?.dedicatedCpuPlacement,
    tpm: !!domain.devices?.tpm,
    gpus,
    hostDevices,
  };
}

/* ---------------------------------------------------------------- disks */

export type DiskSourceKind =
  | 'dataVolume'
  | 'pvc'
  | 'containerDisk'
  | 'cloudInit'
  | 'configMap'
  | 'secret'
  | 'serviceAccount'
  | 'emptyDisk'
  | 'ephemeral'
  | 'hostDisk'
  | 'other';

export interface DiskRow {
  name: string;
  /** disk, cdrom or lun. */
  device: 'disk' | 'cdrom' | 'lun';
  bus: string;
  bootOrder?: number;
  sourceKind: DiskSourceKind;
  /** The PVC behind it, when it has one. */
  claimName?: string;
  image?: string;
  hotplug: boolean;
  readonly: boolean;
  /** Not a real disk (cloud-init, config, secret). */
  config: boolean;
}

function sourceOf(v: VMVolume | undefined): Pick<DiskRow, 'sourceKind' | 'claimName' | 'image' | 'hotplug' | 'config'> {
  if (!v) return { sourceKind: 'other', hotplug: false, config: false };
  if (v.dataVolume)
    return { sourceKind: 'dataVolume', claimName: v.dataVolume.name, hotplug: !!v.dataVolume.hotpluggable, config: false };
  if (v.persistentVolumeClaim)
    return {
      sourceKind: 'pvc',
      claimName: v.persistentVolumeClaim.claimName,
      hotplug: !!v.persistentVolumeClaim.hotpluggable,
      config: false,
    };
  if (v.containerDisk) return { sourceKind: 'containerDisk', image: v.containerDisk.image, hotplug: false, config: false };
  if (v.cloudInitNoCloud || v.cloudInitConfigDrive) return { sourceKind: 'cloudInit', hotplug: false, config: true };
  if (v.configMap) return { sourceKind: 'configMap', hotplug: false, config: true };
  if (v.secret) return { sourceKind: 'secret', hotplug: false, config: true };
  if (v.serviceAccount) return { sourceKind: 'serviceAccount', hotplug: false, config: true };
  if (v.emptyDisk) return { sourceKind: 'emptyDisk', hotplug: false, config: false };
  if (v.ephemeral)
    return { sourceKind: 'ephemeral', claimName: v.ephemeral.persistentVolumeClaim.claimName, hotplug: false, config: false };
  if (v.hostDisk) return { sourceKind: 'hostDisk', hotplug: false, config: false };
  return { sourceKind: 'other', hotplug: false, config: false };
}

/** Disks of the VM (its template spec), in boot order then declaration order. */
export function disks(vm: VM): DiskRow[] {
  const spec = vm.spec?.template?.spec ?? {};
  const declared: VMDisk[] = spec.domain?.devices?.disks ?? [];
  const volumes: VMVolume[] = spec.volumes ?? [];
  const byName = new Map(volumes.map(v => [v.name, v]));
  const rows: DiskRow[] = [];
  const seen = new Set<string>();
  for (const d of declared) {
    seen.add(d.name);
    const device = d.cdrom ? 'cdrom' : d.lun ? 'lun' : 'disk';
    const src = sourceOf(byName.get(d.name));
    rows.push({
      name: d.name,
      device,
      bus: (d.cdrom?.bus ?? d.disk?.bus ?? d.lun?.bus ?? 'virtio') as string,
      bootOrder: d.bootOrder,
      readonly: !!(d.cdrom ? d.cdrom.readonly ?? true : d.disk?.readonly),
      ...src,
    });
  }
  // KubeVirt adds a disk for every volume without one.
  for (const v of volumes) {
    if (seen.has(v.name)) continue;
    rows.push({ name: v.name, device: 'disk', bus: 'virtio', readonly: false, ...sourceOf(v) });
  }
  return rows.sort((a, b) => (a.bootOrder ?? 999) - (b.bootOrder ?? 999));
}

/** Names of the PVCs a VM owns or uses. */
export function claimNames(vm: VM): string[] {
  return disks(vm)
    .map(d => d.claimName)
    .filter((n): n is string => !!n);
}

/* -------------------------------------------------------------- network */

export interface NicRow {
  name: string;
  model: string;
  /** How it connects: NAT (masquerade), bridge, SR-IOV, or a binding plugin. */
  binding: 'NAT' | 'Bridge' | 'SR-IOV' | string;
  /** "Pod network" or the attachment (namespace/name). */
  network: string;
  isPodNetwork: boolean;
  mac?: string;
  ips: string[];
  guestIface?: string;
  linkState?: string;
}

export function nics(vm: VM, vmi?: VMI | null): NicRow[] {
  const spec = vm.spec?.template?.spec ?? {};
  const ifaces: VMInterface[] = spec.domain?.devices?.interfaces ?? [];
  const nets: VMNetwork[] = spec.networks ?? [];
  const status: any[] = vmi?.status?.interfaces ?? [];
  return ifaces.map(i => {
    const n = nets.find(x => x.name === i.name);
    const st = status.find(s => s.name === i.name);
    const binding = i.masquerade ? 'NAT' : i.bridge ? 'Bridge' : i.sriov ? 'SR-IOV' : i.binding?.name ?? 'NAT';
    const ips: string[] = st?.ipAddresses ?? (st?.ipAddress ? [st.ipAddress] : []);
    return {
      name: i.name,
      model: i.model ?? 'virtio',
      binding,
      network: n?.pod ? 'Pod network' : n?.multus?.networkName ?? '—',
      isPodNetwork: !!n?.pod,
      mac: st?.mac ?? i.macAddress,
      ips: ips.filter(ip => !ip.startsWith('fe80')),
      guestIface: st?.interfaceName,
      linkState: i.state,
    };
  });
}

/** The address to show first: the guest's, else the pod's. */
export function primaryIp(vmi?: VMI | null): string | undefined {
  const st: any[] = vmi?.status?.interfaces ?? [];
  for (const s of st) {
    const ip = s.ipAddress ?? s.ipAddresses?.[0];
    if (ip && !ip.startsWith('fe80')) return ip;
  }
  return undefined;
}

/* ------------------------------------------------------------- guest OS */

export interface GuestOs {
  /** Best name we have: guest agent, then preference, then annotation. */
  name: string;
  id: string;
  fromAgent: boolean;
  kernel?: string;
  hostname?: string;
  timezone?: string;
}

const OS_NAMES: Record<string, string> = {
  fedora: 'Fedora',
  rhel: 'Red Hat Enterprise Linux',
  centos: 'CentOS Stream',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  alpine: 'Alpine Linux',
  cirros: 'CirrOS',
  windows: 'Windows',
  sles: 'SUSE Linux Enterprise',
  opensuse: 'openSUSE',
  oraclelinux: 'Oracle Linux',
  linux: 'Linux',
  legacy: 'Other',
};

export function osIdFrom(s: string | undefined): string {
  if (!s) return '';
  const v = s.toLowerCase();
  for (const id of Object.keys(OS_NAMES)) if (v.startsWith(id) || v.includes(id)) return id;
  if (v.includes('red hat')) return 'rhel';
  if (v.includes('win')) return 'windows';
  return '';
}

/**
 * The OS of the library image a VM's disks were cloned from ("ns/name" of
 * the source PVC → its hangar os annotation), for VMs made outside Hangar.
 */
export function osFromSources(vm: VM, imageOs: Map<string, string>): string | undefined {
  for (const t of vm.spec?.dataVolumeTemplates ?? []) {
    const src = t.spec?.source?.pvc;
    if (src) {
      const os = imageOs.get(`${src.namespace ?? vm.metadata.namespace}/${src.name}`);
      if (os) return os;
    }
  }
  return undefined;
}

export function guestOs(vm: VM, vmi?: VMI | null, hint?: string): GuestOs {
  const info = vmi?.status?.guestOSInfo;
  if (info?.prettyName || info?.name) {
    const name = info.prettyName || `${info.name} ${info.version ?? ''}`.trim();
    return {
      name,
      id: osIdFrom(info.id || info.name),
      fromAgent: true,
      kernel: info.kernelRelease,
      hostname: vmi?.status?.guestOSInfo?.hostname,
      timezone: info.timezone,
    };
  }
  const pref = vm.spec?.preference?.name as string | undefined;
  const ann = vm.metadata.annotations?.[A_OS] || vm.metadata.annotations?.['vm.kubevirt.io/os'];
  const labelOs = Object.keys(vm.metadata.labels ?? {})
    .find(k => k.startsWith('os.template.kubevirt.io/'))
    ?.split('/')[1];
  const id = osIdFrom(ann || pref || labelOs || hint);
  return { name: id ? OS_NAMES[id] : 'Unknown OS', id, fromAgent: false };
}

export function osIcon(id: string): string {
  switch (id) {
    case 'fedora':
      return 'mdi:fedora';
    case 'ubuntu':
      return 'mdi:ubuntu';
    case 'debian':
      return 'mdi:debian';
    case 'centos':
      return 'mdi:centos';
    case 'rhel':
      return 'mdi:redhat';
    case 'windows':
      return 'mdi:microsoft-windows';
    default:
      return 'mdi:linux';
  }
}

/* ------------------------------------------------------- state & policy */

/** Changes saved on the VM that wait for a restart. */
export function pendingRestart(vm: VM): string | undefined {
  const c = cond(vm, 'RestartRequired');
  return c?.status === 'True' ? c.message || 'Restart the VM to apply the latest changes.' : undefined;
}

export function liveMigratable(vm: VM, vmi?: VMI | null): { ok: boolean; why?: string } {
  const c = cond(vmi ?? null, 'LiveMigratable');
  if (!vmi) return { ok: false, why: 'The VM is not running.' };
  if (!c) return { ok: false, why: 'The host has not reported it yet.' };
  if (c.status === 'True') return { ok: true };
  return { ok: false, why: c.message || c.reason };
}

export function guestAgent(vmi?: VMI | null): boolean {
  return cond(vmi ?? null, 'AgentConnected')?.status === 'True';
}

export function host(vmi?: VMI | null): string | undefined {
  return vmi?.status?.nodeName;
}

/** When the VMI started running, for uptime. */
export function runningSince(vmi?: VMI | null): string | undefined {
  const ts: { phase: string; phaseTransitionTimestamp: string }[] = vmi?.status?.phaseTransitionTimestamps ?? [];
  const run = [...ts].reverse().find(t => t.phase === 'Running');
  return run?.phaseTransitionTimestamp ?? (vmi ? vmi.metadata.creationTimestamp : undefined);
}

export function evictionStrategy(vm: VM, kubevirt?: Obj | null): string {
  return (
    vm.spec?.template?.spec?.evictionStrategy ??
    kubevirt?.spec?.configuration?.evictionStrategy ??
    'None'
  );
}

export const EVICTION_LABELS: Record<string, string> = {
  LiveMigrate: 'Move it to another host while running',
  LiveMigrateIfPossible: 'Move it while running if it can, else shut it down',
  External: 'Leave it to an external controller',
  None: 'Shut it down',
};
