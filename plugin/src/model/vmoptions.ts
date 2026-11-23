/*
 * A VM's options and finer hardware, as pure reads and edits (like
 * model/edit.ts): what Proxmox calls the Options and Hardware tabs, mapped
 * to KubeVirt's VirtualMachine spec.
 *
 * Options: start paused, guest clock, pointer (USB tablet), ACPI, SMBIOS
 * (firmware UUID and serial, chassis), guest OS tuning (preference).
 * Devices: graphics (headless), video card, audio, random number
 * generator, watchdog, crash-report (panic) device, VSOCK, downward
 * metrics, disk and NIC multi-queue, I/O threads.
 * CPU: flags (cpu.features), reservation and limit (resources), hot-add
 * ceilings (maxSockets, maxGuest). Disks: cache, I/O mode, dedicated I/O
 * thread, serial, read-only, shareable, error policy, block size.
 * Shared folders (virtiofs), vGPU display, persistent UEFI variables/TPM.
 *
 * KubeVirt applies live only sockets, memory, hot-plug volumes, NIC link
 * state and placement; everything else here waits for a restart
 * (RestartRequired), which the VM page shows.
 */

import { clone } from './edit';
import { VM } from './types';
import { parseQuantity, toQuantity } from './units';

function tpl(vm: VM): any {
  vm.spec ??= {};
  vm.spec.template ??= {};
  vm.spec.template.spec ??= {};
  vm.spec.template.spec.domain ??= {};
  vm.spec.template.spec.domain.devices ??= {};
  return vm.spec.template.spec;
}

const domainOf = (vm: VM): any => vm.spec?.template?.spec?.domain ?? {};
const devicesOf = (vm: VM): any => domainOf(vm).devices ?? {};

/** Drops `key` from `o` and `o` from its parent when it ends up empty. */
function prune(parent: any, key: string) {
  const v = parent?.[key];
  if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) delete parent[key];
}

/* --------------------------------------------------------------- options */

export type ClockMode = 'default' | 'utc' | 'timezone' | 'offset';

export interface ClockSetting {
  mode: ClockMode;
  /** TZ database name, e.g. Europe/Rome (mode timezone). */
  timezone?: string;
  /** Seconds from UTC (mode offset); the guest keeps its own changes across reboots. */
  offsetSeconds?: number;
}

export function clockOf(vm: VM): ClockSetting {
  const c = domainOf(vm).clock;
  if (c?.timezone) return { mode: 'timezone', timezone: c.timezone };
  if (c?.utc) return c.utc.offsetSeconds !== undefined ? { mode: 'offset', offsetSeconds: c.utc.offsetSeconds } : { mode: 'utc' };
  return { mode: 'default' };
}

/** Sets the guest clock; timers stay as they are. */
export function setClock(vm: VM, c: ClockSetting): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  const timer = d.clock?.timer;
  if (c.mode === 'default') delete d.clock;
  else if (c.mode === 'timezone') d.clock = { timezone: c.timezone };
  else if (c.mode === 'offset') d.clock = { utc: { offsetSeconds: Math.round(c.offsetSeconds ?? 0) } };
  else d.clock = { utc: {} };
  if (timer) d.clock = { ...(d.clock ?? {}), timer };
  return out;
}

export function startPaused(vm: VM): boolean {
  return vm.spec?.template?.spec?.startStrategy === 'Paused';
}

/** Power-on leaves the VM suspended (startStrategy Paused): resume it from Hangar or the console. */
export function setStartPaused(vm: VM, on: boolean): VM {
  const out = clone(vm);
  const t = tpl(out);
  if (on) t.startStrategy = 'Paused';
  else delete t.startStrategy;
  return out;
}

/** The pointer is an absolute USB (or VirtIO) tablet, so the console cursor follows the mouse. */
export function tabletOf(vm: VM): boolean {
  const dv = devicesOf(vm);
  return (dv.inputs ?? []).some((i: any) => i.type === 'tablet') || (dv.autoattachInputDevice === true && !(dv.inputs ?? []).length);
}

export function setTablet(vm: VM, on: boolean, bus: 'usb' | 'virtio' = 'usb'): VM {
  const out = clone(vm);
  const dv = tpl(out).domain.devices;
  const others = (dv.inputs ?? []).filter((i: any) => i.type !== 'tablet');
  dv.inputs = on ? [...others, { name: 'tablet', type: 'tablet', bus }] : others;
  if (!dv.inputs.length) delete dv.inputs;
  if (!on && dv.autoattachInputDevice) dv.autoattachInputDevice = false;
  return out;
}

export function acpiOf(vm: VM): boolean {
  return domainOf(vm).features?.acpi?.enabled !== false;
}

/** ACPI off: no power button for the guest, so a guest shutdown from Hangar cannot work. */
export function setAcpi(vm: VM, on: boolean): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  if (on) {
    if (d.features?.acpi) delete d.features.acpi;
    prune(d, 'features');
  } else {
    d.features = { ...(d.features ?? {}), acpi: { enabled: false } };
  }
  return out;
}

export interface Smbios {
  uuid: string;
  serial: string;
  chassis: { manufacturer: string; version: string; serial: string; asset: string; sku: string };
}

export const CHASSIS_FIELDS: { key: keyof Smbios['chassis']; label: string }[] = [
  { key: 'manufacturer', label: 'Chassis manufacturer' },
  { key: 'version', label: 'Chassis version' },
  { key: 'serial', label: 'Chassis serial' },
  { key: 'asset', label: 'Asset tag' },
  { key: 'sku', label: 'Chassis SKU' },
];

export function smbiosOf(vm: VM): Smbios {
  const d = domainOf(vm);
  const ch = d.chassis ?? {};
  return {
    uuid: d.firmware?.uuid ?? '',
    serial: d.firmware?.serial ?? '',
    chassis: { manufacturer: ch.manufacturer ?? '', version: ch.version ?? '', serial: ch.serial ?? '', asset: ch.asset ?? '', sku: ch.sku ?? '' },
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This VM's SMBIOS: system UUID and serial (firmware) and chassis; empty values are dropped. */
export function setSmbios(vm: VM, s: Smbios): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  d.firmware ??= {};
  if (s.uuid.trim()) d.firmware.uuid = s.uuid.trim();
  else delete d.firmware.uuid;
  if (s.serial.trim()) d.firmware.serial = s.serial.trim();
  else delete d.firmware.serial;
  prune(d, 'firmware');
  const ch: Record<string, string> = {};
  for (const { key } of CHASSIS_FIELDS) if (s.chassis[key].trim()) ch[key] = s.chassis[key].trim();
  if (Object.keys(ch).length) d.chassis = ch;
  else delete d.chassis;
  return out;
}

/** Guest OS tuning (preference); KubeVirt picks the new revision. null drops it. */
export function setPreference(vm: VM, pref: { kind: string; name: string } | null): VM {
  const out = clone(vm);
  if (pref) out.spec.preference = { kind: pref.kind, name: pref.name };
  else delete out.spec.preference;
  return out;
}

/* --------------------------------------------------------------- devices */

export type SoundModel = '' | 'ich9' | 'ac97';
export type WatchdogAction = '' | 'poweroff' | 'reset' | 'shutdown';
export type PanicModel = '' | 'isa' | 'pvpanic' | 'hyperv';
export type VideoType = '' | 'virtio' | 'vga' | 'bochs' | 'ramfb' | 'cirrus';
export type IoThreadsPolicy = '' | 'shared' | 'auto' | 'supplementalPool';

export interface DeviceOptions {
  /** A graphics card and VNC console (false: headless). */
  graphics: boolean;
  /** '' : KubeVirt's default (VGA for BIOS, Bochs for UEFI). */
  video: VideoType;
  sound: SoundModel;
  rng: boolean;
  watchdog: WatchdogAction;
  panic: PanicModel;
  vsock: boolean;
  downwardMetrics: boolean;
  /** One queue per vCPU for disks (blockMultiQueue). */
  blockMultiQueue: boolean;
  /** One queue per vCPU for VirtIO network adapters. */
  nicMultiQueue: boolean;
  ioThreadsPolicy: IoThreadsPolicy;
  ioThreadsCount?: number;
}

export function deviceOptions(vm: VM): DeviceOptions {
  const d = domainOf(vm);
  const dv = d.devices ?? {};
  const panic = (dv.panicDevices ?? [])[0];
  return {
    graphics: dv.autoattachGraphicsDevice !== false,
    video: (dv.video?.type ?? '') as VideoType,
    sound: dv.sound ? ((dv.sound.model || 'ich9') as SoundModel) : '',
    rng: !!dv.rng,
    watchdog: dv.watchdog?.i6300esb ? ((dv.watchdog.i6300esb.action || 'reset') as WatchdogAction) : '',
    panic: panic ? ((panic.model || 'isa') as PanicModel) : '',
    vsock: dv.autoattachVSOCK === true,
    downwardMetrics: !!dv.downwardMetrics,
    blockMultiQueue: dv.blockMultiQueue === true,
    nicMultiQueue: dv.networkInterfaceMultiqueue === true,
    ioThreadsPolicy: (d.ioThreadsPolicy ?? '') as IoThreadsPolicy,
    ioThreadsCount: d.ioThreads?.supplementalPoolThreadCount,
  };
}

export function setDevices(vm: VM, p: Partial<DeviceOptions>): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  const dv = d.devices;
  const flag = (key: string, on: boolean | undefined) => {
    if (on === undefined) return;
    if (on) dv[key] = true;
    else delete dv[key];
  };
  if (p.graphics !== undefined) {
    if (p.graphics) delete dv.autoattachGraphicsDevice;
    else dv.autoattachGraphicsDevice = false;
  }
  if (p.video !== undefined) {
    if (p.video) dv.video = { type: p.video };
    else delete dv.video;
  }
  if (p.sound !== undefined) {
    if (p.sound) dv.sound = { name: dv.sound?.name || 'sound', model: p.sound };
    else delete dv.sound;
  }
  if (p.rng !== undefined) {
    if (p.rng) dv.rng = dv.rng ?? {};
    else delete dv.rng;
  }
  if (p.watchdog !== undefined) {
    if (p.watchdog) dv.watchdog = { name: dv.watchdog?.name || 'watchdog', i6300esb: { action: p.watchdog } };
    else delete dv.watchdog;
  }
  if (p.panic !== undefined) {
    if (p.panic) dv.panicDevices = [{ model: p.panic }];
    else delete dv.panicDevices;
  }
  flag('autoattachVSOCK', p.vsock);
  if (p.downwardMetrics !== undefined) {
    if (p.downwardMetrics) dv.downwardMetrics = dv.downwardMetrics ?? {};
    else delete dv.downwardMetrics;
  }
  flag('blockMultiQueue', p.blockMultiQueue);
  flag('networkInterfaceMultiqueue', p.nicMultiQueue);
  if (p.ioThreadsPolicy !== undefined) {
    if (p.ioThreadsPolicy) d.ioThreadsPolicy = p.ioThreadsPolicy;
    else delete d.ioThreadsPolicy;
    if (p.ioThreadsPolicy === 'supplementalPool') d.ioThreads = { supplementalPoolThreadCount: Math.max(1, p.ioThreadsCount ?? d.ioThreads?.supplementalPoolThreadCount ?? 2) };
    else delete d.ioThreads;
  }
  return out;
}

/* ------------------------------------------------------------- CPU flags */

export type FlagPolicy = 'require' | 'disable' | 'force' | 'optional' | 'forbid';

export interface CpuFlag {
  name: string;
  policy: FlagPolicy;
}

export function cpuFlagsOf(vm: VM): CpuFlag[] {
  return ((domainOf(vm).cpu?.features ?? []) as any[]).map(f => ({ name: f.name, policy: (f.policy || 'require') as FlagPolicy }));
}

export function setCpuFlags(vm: VM, flags: CpuFlag[]): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  const seen = new Set<string>();
  const list = flags.filter(f => f.name && !seen.has(f.name) && seen.add(f.name)).map(f => ({ name: f.name, policy: f.policy }));
  if (list.length) d.cpu = { ...(d.cpu ?? {}), features: list };
  else if (d.cpu) {
    delete d.cpu.features;
    prune(d, 'cpu');
  }
  return out;
}

/** Flags worth knowing, in words; the picker also lists what the hosts report. */
export const KNOWN_FLAGS: Record<string, string> = {
  vmx: 'Nested virtualization on Intel (run VMs inside the VM)',
  svm: 'Nested virtualization on AMD (run VMs inside the VM)',
  pcid: 'Faster context switches with Meltdown fixes',
  'spec-ctrl': 'Spectre v2 mitigation (IBRS)',
  ssbd: 'Speculative store bypass mitigation',
  'md-clear': 'MDS mitigation (VERW clears buffers)',
  'pdpe1gb': '1 GiB pages inside the guest',
  aes: 'AES instructions (encryption)',
  avx: 'AVX vector instructions',
  avx2: 'AVX2 vector instructions',
  avx512f: 'AVX-512 vector instructions',
  'x2apic': 'x2APIC interrupt controller',
  hypervisor: 'Tell the guest it runs in a VM',
  invtsc: 'Invariant TSC (stable clock; blocks live migration)',
  rdrand: 'Hardware random numbers (RDRAND)',
  rdseed: 'Hardware random seed (RDSEED)',
  sha_ni: 'SHA instructions',
  topoext: 'AMD topology extensions (SMT threads in the guest)',
  'arch-capabilities': 'Report CPU vulnerability status to the guest',
};

/** CPU flags each host offers (cpu-feature.node.kubevirt.io/<flag> labels): flag → hosts. */
export function hostFlags(nodes: { metadata: { name: string; labels?: Record<string, string> } }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.metadata.labels ?? {})) {
      const m = k.match(/^cpu-feature\.node\.kubevirt\.io\/(.+)$/);
      if (m && v === 'true') out.set(m[1], [...(out.get(m[1]) ?? []), n.metadata.name]);
    }
  }
  return out;
}

/* --------------------------------------------------- reservation and limit */

export interface Reservation {
  /** Kubernetes quantities ('' : not set). */
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
}

export function reservationOf(vm: VM): Reservation {
  const r = domainOf(vm).resources ?? {};
  const s = (x: unknown) => (x === undefined || x === null ? '' : String(x));
  return { cpuRequest: s(r.requests?.cpu), cpuLimit: s(r.limits?.cpu), memoryRequest: s(r.requests?.memory), memoryLimit: s(r.limits?.memory) };
}

export function setReservation(vm: VM, r: Reservation): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  const res = { requests: { ...(d.resources?.requests ?? {}) }, limits: { ...(d.resources?.limits ?? {}) }, ...Object.fromEntries(Object.entries(d.resources ?? {}).filter(([k]) => k !== 'requests' && k !== 'limits')) } as any;
  const put = (o: any, k: string, v: string) => {
    if (v.trim()) o[k] = v.trim();
    else delete o[k];
  };
  put(res.requests, 'cpu', r.cpuRequest);
  put(res.requests, 'memory', r.memoryRequest);
  put(res.limits, 'cpu', r.cpuLimit);
  put(res.limits, 'memory', r.memoryLimit);
  prune(res, 'requests');
  prune(res, 'limits');
  d.resources = res;
  return out;
}

/** CPU quantity → cores ("500m" → 0.5, "2" → 2); NaN when not set or invalid. */
export function cpuCores(q: string): number {
  const s = q.trim();
  if (!s) return NaN;
  if (s.endsWith('m')) return Number(s.slice(0, -1)) / 1000;
  return Number(s);
}

/** What is wrong with a reservation for a VM with `guestBytes` of memory, or null. */
export function reservationProblem(r: Reservation, guestBytes: number): string | null {
  const q = (s: string) => (s.trim() ? parseQuantity(s) : NaN);
  for (const [label, v] of [
    ['CPU reservation', r.cpuRequest],
    ['CPU limit', r.cpuLimit],
  ] as const)
    if (v.trim() && !(cpuCores(v) > 0)) return `${label}: use cores (2, 0.5) or millicores (500m).`;
  for (const [label, v] of [
    ['Memory reservation', r.memoryRequest],
    ['Memory limit', r.memoryLimit],
  ] as const)
    if (v.trim() && !(q(v) > 0)) return `${label}: use a size like 2Gi or 512Mi.`;
  if (r.cpuRequest.trim() && r.cpuLimit.trim() && cpuCores(r.cpuRequest) > cpuCores(r.cpuLimit)) return 'The CPU reservation is above the limit.';
  if (r.memoryRequest.trim() && q(r.memoryRequest) > guestBytes) return 'The memory reservation is above the VM memory.';
  if (r.memoryLimit.trim() && q(r.memoryLimit) < guestBytes) return 'The memory limit is below the VM memory: the guest would be killed when it uses it.';
  return null;
}

/* ------------------------------------------------- hot-add (level 2) */

export interface HotAddLimits {
  maxSockets?: number;
  maxGuest?: string;
}

export function hotAddLimitsOf(vm: VM): HotAddLimits {
  const d = domainOf(vm);
  return { maxSockets: d.cpu?.maxSockets, maxGuest: d.memory?.maxGuest };
}

/** Ceilings for CPUs and memory added while running; null = KubeVirt's default (ratio × size). */
export function setHotAddLimits(vm: VM, l: { maxSockets?: number | null; maxGuestBytes?: number | null }): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  if (l.maxSockets !== undefined) {
    if (l.maxSockets) d.cpu = { ...(d.cpu ?? {}), maxSockets: l.maxSockets };
    else if (d.cpu) {
      delete d.cpu.maxSockets;
      prune(d, 'cpu');
    }
  }
  if (l.maxGuestBytes !== undefined) {
    if (l.maxGuestBytes) d.memory = { ...(d.memory ?? {}), maxGuest: toQuantity(l.maxGuestBytes) };
    else if (d.memory) {
      delete d.memory.maxGuest;
      prune(d, 'memory');
    }
  }
  return out;
}

export interface LiveVerdict {
  /** 'same': unchanged; 'live': applied to the running VM; 'restart': at the next power-on. */
  cpu: 'same' | 'live' | 'restart';
  memory: 'same' | 'live' | 'restart';
  why: string[];
}

export interface LiveContext {
  /** KubeVirt rolls changes into running VMs (vmRolloutStrategy LiveUpdate, the default). */
  liveUpdate: boolean;
  /** The workload update methods include LiveMigrate (hot-add moves the VM within or across hosts). */
  liveMigrateUpdates: boolean;
  /** The running VM can move live, with the reason when not. */
  migratable: { ok: boolean; why?: string };
}

const GiBy = 2 ** 30;
const MEM_BLOCK = 2 * 2 ** 20;

/**
 * What KubeVirt does with new CPU/memory sizes on a running VM (its VM
 * controller, v1.7): more sockets up to maxSockets and memory between the
 * boot size and maxGuest go in live, through a live migration; the rest
 * waits for a restart.
 */
export function liveCompute(
  vmi: any,
  next: { sockets: number; cores: number; threads: number; memoryBytes: number },
  ctx: LiveContext
): LiveVerdict {
  const why: string[] = [];
  const cpu = vmi?.spec?.domain?.cpu ?? {};
  const cur = { sockets: cpu.sockets ?? 1, cores: cpu.cores ?? 1, threads: cpu.threads ?? 1 };
  const curMem = parseQuantity(vmi?.spec?.domain?.memory?.guest);
  const bootMem = parseQuantity(vmi?.status?.memory?.guestAtBoot ?? vmi?.spec?.domain?.memory?.guest);
  const maxGuest = parseQuantity(vmi?.spec?.domain?.memory?.maxGuest);
  const cpuChanged = next.sockets !== cur.sockets || next.cores !== cur.cores || next.threads !== cur.threads;
  const memChanged = isFinite(curMem) && Math.abs(next.memoryBytes - curMem) >= 1;
  const canMove = () => {
    if (!ctx.liveUpdate) {
      why.push('KubeVirt is set to apply changes at the next restart (vmRolloutStrategy Stage).');
      return false;
    }
    if (!ctx.liveMigrateUpdates) {
      why.push('Hot-add moves the VM live, and KubeVirt is not allowed to (LiveMigrate is not a workload update method).');
      return false;
    }
    if (!ctx.migratable.ok) {
      why.push(`Hot-add moves the VM live, and this one cannot move: ${ctx.migratable.why ?? 'not migratable'}.`);
      return false;
    }
    return true;
  };
  let cpuV: LiveVerdict['cpu'] = 'same';
  if (cpuChanged) {
    cpuV = 'restart';
    if (next.cores !== cur.cores || next.threads !== cur.threads) why.push('Only sockets can be added while running: cores and threads change at the next restart.');
    else if (next.sockets < cur.sockets) why.push('Removing CPUs needs a restart.');
    else if (cpu.maxSockets && next.sockets > cpu.maxSockets) why.push(`This VM can grow to ${cpu.maxSockets} sockets while running.`);
    else if (canMove()) cpuV = 'live';
  }
  let memV: LiveVerdict['memory'] = 'same';
  if (memChanged) {
    memV = 'restart';
    if (!isFinite(maxGuest)) why.push('Memory cannot be hot-added to this VM (no maxGuest: under 1 GiB, real-time, or encrypted).');
    else if (next.memoryBytes > maxGuest) why.push(`This VM can grow to ${maxGuest / GiBy} GiB of memory while running.`);
    else if (isFinite(bootMem) && next.memoryBytes < bootMem) why.push('Memory below what the VM started with needs a restart.');
    else if (next.memoryBytes % MEM_BLOCK !== 0) why.push('Memory added while running goes in 2 MiB blocks.');
    else if (canMove()) memV = 'live';
  }
  return { cpu: cpuV, memory: memV, why: [...new Set(why)] };
}

/* ------------------------------------------------------- disk settings */

export type DiskCache = '' | 'none' | 'writethrough' | 'writeback';
export type DiskIo = '' | 'native' | 'threads';
export type ErrorPolicy = '' | 'stop' | 'ignore' | 'report' | 'enospace';

export interface DiskSettings {
  cache: DiskCache;
  io: DiskIo;
  dedicatedIOThread: boolean;
  serial: string;
  readonly: boolean;
  shareable: boolean;
  errorPolicy: ErrorPolicy;
  blockSize: { mode: 'default' | 'match' | 'custom'; logical?: number; physical?: number };
}

export function diskSettingsOf(vm: VM, name: string): DiskSettings | null {
  const d = (devicesOf(vm).disks ?? []).find((x: any) => x.name === name);
  if (!d) return null;
  const bs = d.blockSize;
  return {
    cache: (d.cache ?? '') as DiskCache,
    io: (d.io ?? '') as DiskIo,
    dedicatedIOThread: d.dedicatedIOThread === true,
    serial: d.serial ?? '',
    readonly: !!d.disk?.readonly,
    shareable: d.shareable === true,
    errorPolicy: (d.errorPolicy ?? '') as ErrorPolicy,
    blockSize: bs?.custom
      ? { mode: 'custom', logical: bs.custom.logical, physical: bs.custom.physical }
      : bs?.matchVolume && bs.matchVolume.enabled !== false
      ? { mode: 'match' }
      : { mode: 'default' },
  };
}

const SERIAL_RE = /^[A-Za-z0-9_.+-]*$/;
const pow2 = (n: number) => n >= 512 && n <= 2097152 && (n & (n - 1)) === 0;

/** KubeVirt's rules for a disk's settings on its bus; null when fine. */
export function diskSettingsProblem(s: DiskSettings, bus: string): string | null {
  if (!SERIAL_RE.test(s.serial)) return 'The serial number takes letters, digits and _ . + - only.';
  if (s.serial.length > 256) return 'The serial number is too long.';
  if (s.dedicatedIOThread && bus !== 'virtio') return 'A dedicated I/O thread needs the VirtIO bus.';
  if (s.readonly && bus === 'sata') return 'SATA disks cannot be read-only: use VirtIO or SCSI.';
  if (s.shareable && s.cache && s.cache !== 'none') return 'A shared disk needs cache "none".';
  if (s.io === 'native' && s.cache && s.cache !== 'none') return 'Native I/O needs cache "none" (direct I/O).';
  if (s.blockSize.mode === 'custom') {
    const { logical = 0, physical = 0 } = s.blockSize;
    if (!pow2(logical) || !pow2(physical)) return 'Block sizes are powers of 2 from 512 bytes to 2 MiB.';
    if (logical > physical) return 'The logical block size cannot be above the physical one.';
    if (bus === 'sata' && logical !== 512) return 'SATA disks use 512-byte logical blocks.';
  }
  return null;
}

export function setDiskSettings(vm: VM, name: string, s: DiskSettings): VM {
  const out = clone(vm);
  const disks: any[] = tpl(out).domain.devices.disks ?? [];
  const d = disks.find(x => x.name === name);
  if (!d) return out;
  const put = (k: string, v: unknown) => {
    if (v === '' || v === false || v === undefined) delete d[k];
    else d[k] = v;
  };
  put('cache', s.cache);
  put('io', s.io);
  put('dedicatedIOThread', s.dedicatedIOThread);
  put('serial', s.serial.trim());
  put('shareable', s.shareable);
  put('errorPolicy', s.errorPolicy);
  if (d.disk) {
    if (s.readonly) d.disk.readonly = true;
    else delete d.disk.readonly;
  }
  if (s.blockSize.mode === 'custom') d.blockSize = { custom: { logical: s.blockSize.logical, physical: s.blockSize.physical } };
  else if (s.blockSize.mode === 'match') d.blockSize = { matchVolume: { enabled: true } };
  else delete d.blockSize;
  return out;
}

/* -------------------------------------------------- shared folders (virtiofs) */

export type ShareSource = { kind: 'pvc'; claimName: string } | { kind: 'configMap'; name: string } | { kind: 'secret'; name: string } | { kind: 'other'; what: string };

export interface Share {
  name: string;
  source: ShareSource;
}

export function sharesOf(vm: VM): Share[] {
  const t = vm.spec?.template?.spec ?? {};
  const vols: any[] = t.volumes ?? [];
  return ((t.domain?.devices?.filesystems ?? []) as any[]).map(f => {
    const v = vols.find(x => x.name === f.name) ?? {};
    const source: ShareSource = v.persistentVolumeClaim
      ? { kind: 'pvc', claimName: v.persistentVolumeClaim.claimName }
      : v.dataVolume
      ? { kind: 'pvc', claimName: v.dataVolume.name }
      : v.configMap
      ? { kind: 'configMap', name: v.configMap.name }
      : v.secret
      ? { kind: 'secret', name: v.secret.secretName }
      : { kind: 'other', what: Object.keys(v).find(k => k !== 'name') ?? 'unknown' };
    return { name: f.name, source };
  });
}

/** The gate a shared folder's source needs. */
export function shareGate(s: ShareSource): string {
  return s.kind === 'pvc' ? 'EnableVirtioFsStorageVolumes' : 'EnableVirtioFsConfigVolumes';
}

export const SHARE_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function addShare(vm: VM, name: string, source: Exclude<ShareSource, { kind: 'other' }>): VM {
  const out = clone(vm);
  const t = tpl(out);
  t.domain.devices.filesystems = [...(t.domain.devices.filesystems ?? []), { name, virtiofs: {} }];
  const vol =
    source.kind === 'pvc'
      ? { name, persistentVolumeClaim: { claimName: source.claimName } }
      : source.kind === 'configMap'
      ? { name, configMap: { name: source.name } }
      : { name, secret: { secretName: source.name } };
  t.volumes = [...(t.volumes ?? []), vol];
  return out;
}

export function removeShare(vm: VM, name: string): VM {
  const out = clone(vm);
  const t = tpl(out);
  t.domain.devices.filesystems = (t.domain.devices.filesystems ?? []).filter((f: any) => f.name !== name);
  if (!t.domain.devices.filesystems.length) delete t.domain.devices.filesystems;
  t.volumes = (t.volumes ?? []).filter((v: any) => v.name !== name);
  return out;
}

/** The command that mounts a shared folder in a Linux guest (the tag is the folder's name). */
export function mountCommand(name: string): string {
  return `sudo mkdir -p /mnt/${name} && sudo mount -t virtiofs ${name} /mnt/${name}`;
}

/* ------------------------------------------------------ GPUs and firmware */

export function setGpuDisplay(vm: VM, gpu: string, p: { display: boolean; ramFB: boolean }): VM {
  const out = clone(vm);
  const g = (tpl(out).domain.devices.gpus ?? []).find((x: any) => x.name === gpu);
  if (!g) return out;
  g.virtualGPUOptions = { ...(g.virtualGPUOptions ?? {}), display: { enabled: p.display, ...(p.display ? { ramFB: { enabled: p.ramFB } } : {}) } };
  return out;
}

export function gpuDisplayOf(g: any): { display: boolean; ramFB: boolean } {
  const d = g?.virtualGPUOptions?.display;
  return { display: !!d && d.enabled !== false, ramFB: !d?.ramFB || d.ramFB.enabled === true };
}

/** Persistent UEFI variables (efi.persistent) and TPM state (tpm.persistent), kept on a small disk by KubeVirt. */
export function persistenceOf(vm: VM): { efi: boolean; tpm: boolean } {
  const d = domainOf(vm);
  return { efi: d.firmware?.bootloader?.efi?.persistent === true, tpm: d.devices?.tpm?.persistent === true };
}

export function setPersistence(vm: VM, p: { efi?: boolean; tpm?: boolean }): VM {
  const out = clone(vm);
  const d = tpl(out).domain;
  const efi = d.firmware?.bootloader?.efi;
  if (p.efi !== undefined && efi) {
    if (p.efi) efi.persistent = true;
    else delete efi.persistent;
  }
  if (p.tpm !== undefined && d.devices.tpm) {
    if (p.tpm) d.devices.tpm.persistent = true;
    else delete d.devices.tpm.persistent;
  }
  return out;
}

