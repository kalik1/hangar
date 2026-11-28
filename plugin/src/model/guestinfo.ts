/*
 * What a VM's QEMU guest agent reports, from two sources:
 * - KubeVirt's API: the VMI's status (guestOSInfo, interfaces, the
 *   AgentConnected condition) and its subresources guestosinfo, userlist and
 *   filesystemlist;
 * - Hangar's guest bridge: the subresource guestinfo of
 *   subresources.hangar.magesgate.com/v1alpha1, the agent's read-only
 *   commands (bridge/internal/apis/v1alpha1/guestinfo.go, mirrored below).
 *
 * Pure logic: the types, the state of each source, matching the guest's
 * disks and NICs to the VM's, and the guest-side lines that fix a blocked
 * command or install the agent.
 */

import yaml from 'js-yaml';
import type { VM, VMI } from './types';
import type { DiskRow, NicRow } from './vm';

/* ------------------------------------------- the bridge's API (v1alpha1) */

export const BRIDGE_GROUP = 'subresources.hangar.magesgate.com';
export const BRIDGE_VERSION = 'v1alpha1';
export const GUESTINFO = 'guestinfo';
/** The role that reads guestinfo (distribution/rbac.yaml). */
export const GUESTINFO_ROLE = 'hangar-viewer';

export type GuestSection = 'system' | 'cpu' | 'memory' | 'disks' | 'network' | 'users' | 'devices' | 'sshkeys' | 'time';

/** Every section, in the answer's order (v1alpha1.Sections). */
export const SECTIONS: GuestSection[] = ['system', 'cpu', 'memory', 'disks', 'network', 'users', 'devices', 'sshkeys', 'time'];

/** The agent commands behind each section (bridge/internal/guestinfo). */
export const SECTION_COMMANDS: Record<GuestSection, string[]> = {
  system: ['guest-info', 'guest-get-osinfo', 'guest-get-host-name', 'guest-get-timezone'],
  cpu: ['guest-get-vcpus', 'guest-get-cpustats', 'guest-get-load'],
  memory: ['guest-get-memory-blocks'],
  disks: ['guest-get-disks', 'guest-get-diskstats', 'guest-get-fsinfo'],
  network: ['guest-network-get-interfaces', 'guest-network-get-route'],
  users: ['guest-get-users'],
  devices: ['guest-get-devices'],
  sshkeys: ['guest-ssh-get-authorized-keys'],
  time: ['guest-get-time'],
};

/** The bridge's sshUsers parameter: at most 4 names, each a portable Linux user name. */
export const MAX_SSH_USERS = 4;
export const SSH_USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export type GuestInfoReason = 'Blocked' | 'NotSupported' | 'Timeout' | 'AgentError' | 'NotResponding';

export interface GuestAgentCommand {
  name: string;
  enabled: boolean;
}

/** The agent's state, from the bridge's own calls (never from AgentConnected). */
export interface GuestAgent {
  connected: boolean;
  healthy: boolean;
  version?: string;
  commands?: GuestAgentCommand[];
  /** Why the agent is not connected or not healthy. */
  message?: string;
}

export interface GuestInfoError {
  section: GuestSection;
  command?: string;
  reason: GuestInfoReason;
  message: string;
}

export interface GuestOSInfo {
  kernelRelease?: string;
  kernelVersion?: string;
  machine?: string;
  /** "mswindows" on Windows. */
  id?: string;
  name?: string;
  prettyName?: string;
  version?: string;
  versionId?: string;
  variant?: string;
  variantId?: string;
}

export interface GuestTimezone {
  zone?: string;
  /** Seconds east of UTC. */
  offset: number;
}

export interface GuestSystem {
  os?: GuestOSInfo;
  hostName?: string;
  timezone?: GuestTimezone;
}

export interface GuestLogicalProcessor {
  logicalId: number;
  online: boolean;
  canOffline?: boolean;
}

/** A CPU's times in USER_HZ ticks since the guest booted. */
export interface GuestCPUStats {
  type: string;
  cpu: number;
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait?: number;
  irq?: number;
  softirq?: number;
  steal?: number;
  guest?: number;
  guestnice?: number;
}

export interface GuestLoadAverage {
  load1: number;
  load5: number;
  load15: number;
}

export interface GuestCPU {
  vcpus?: GuestLogicalProcessor[];
  stats?: GuestCPUStats[];
  load?: GuestLoadAverage;
}

export interface GuestMemoryBlock {
  physIndex: number;
  online: boolean;
  canOffline?: boolean;
}

export interface GuestMemory {
  blocks?: GuestMemoryBlock[];
}

export interface GuestPCIAddress {
  domain: number;
  bus: number;
  slot: number;
  function: number;
}

export interface GuestDiskAddress {
  pciController: GuestPCIAddress;
  busType: string;
  bus: number;
  target: number;
  unit: number;
  serial?: string;
  dev?: string;
  ccwAddress?: { cssid: number; ssid: number; subchno: number; devno: number };
}

export interface GuestDiskInfo {
  name: string;
  partition: boolean;
  dependencies?: string[];
  address?: GuestDiskAddress;
  alias?: string;
}

/** /proc/diskstats counters; ticks are milliseconds. */
export interface GuestDiskStats {
  readSectors?: number;
  readIos?: number;
  readMerges?: number;
  writeSectors?: number;
  writeIos?: number;
  writeMerges?: number;
  discardSectors?: number;
  discardIos?: number;
  discardMerges?: number;
  flushIos?: number;
  readTicks?: number;
  writeTicks?: number;
  discardTicks?: number;
  flushTicks?: number;
  iosPending?: number;
  totalTicks?: number;
  weightTicks?: number;
}

export interface GuestDiskStatsInfo {
  name: string;
  major: number;
  minor: number;
  stats: GuestDiskStats;
}

export interface GuestFilesystemInfo {
  name: string;
  mountpoint: string;
  type: string;
  usedBytes?: number;
  totalBytes?: number;
  totalBytesPrivileged?: number;
  disk?: GuestDiskAddress[];
}

export interface GuestDisks {
  disks?: GuestDiskInfo[];
  stats?: GuestDiskStatsInfo[];
  filesystems?: GuestFilesystemInfo[];
}

export interface GuestIPAddress {
  ipAddress: string;
  ipAddressType: 'ipv4' | 'ipv6' | string;
  prefix: number;
}

export interface GuestNetworkInterfaceStat {
  rxBytes: number;
  rxPackets: number;
  rxErrs: number;
  rxDropped: number;
  txBytes: number;
  txPackets: number;
  txErrs: number;
  txDropped: number;
}

export interface GuestNetworkInterface {
  name: string;
  hardwareAddress?: string;
  ipAddresses?: GuestIPAddress[];
  statistics?: GuestNetworkInterfaceStat;
}

export interface GuestNetworkRoute {
  iface: string;
  destination: string;
  metric: number;
  version: number;
  gateway?: string;
  mask?: string;
  irtt?: number;
  flags?: number;
  refcnt?: number;
  use?: number;
  window?: number;
  mtu?: number;
  desprefixlen?: string;
  source?: string;
  srcprefixlen?: string;
  nexthop?: string;
}

export interface GuestNetwork {
  interfaces?: GuestNetworkInterface[];
  routes?: GuestNetworkRoute[];
}

/** A user logged in; loginTime in seconds since the epoch; domain on Windows. */
export interface GuestUser {
  user: string;
  domain?: string;
  loginTime: number;
}

/** A device and its driver (Windows); driverDate in nanoseconds since the epoch. */
export interface GuestDeviceInfo {
  driverName: string;
  driverDate?: number;
  driverVersion?: string;
  id?: { type: string; vendorId: number; deviceId: number };
}

export interface GuestUserSSHKeys {
  username: string;
  keys: string[];
  reason?: GuestInfoReason;
  message?: string;
}

export interface GuestTime {
  guestTime: string;
  hostTime: string;
  /** The guest's time minus the host's. */
  driftSeconds: number;
}

/** GET …/virtualmachineinstances/{name}/guestinfo. */
export interface GuestInfo {
  kind?: 'GuestInfo';
  apiVersion?: string;
  agent: GuestAgent;
  system?: GuestSystem;
  cpu?: GuestCPU;
  memory?: GuestMemory;
  disks?: GuestDisks;
  network?: GuestNetwork;
  users?: { items: GuestUser[] };
  devices?: { items: GuestDeviceInfo[] };
  sshkeys?: { users: GuestUserSSHKeys[] };
  time?: GuestTime;
  errors?: GuestInfoError[];
  readAt: string;
}

/* ------------------------------------------------ KubeVirt's subresources */

/** guestosinfo (VirtualMachineInstanceGuestAgentInfo). */
export interface KvGuestAgentInfo {
  guestAgentVersion?: string;
  supportedCommands?: GuestAgentCommand[];
  hostname?: string;
  os?: GuestOSInfo;
  /** "UTC, 0": the zone and its offset in seconds. */
  timezone?: string;
  userList?: KvUser[];
  fsInfo?: { disks?: KvFilesystem[] };
  fsFreezeStatus?: string;
}

export interface KvUser {
  userName: string;
  domain?: string;
  loginTime?: number;
}

export interface KvFilesystem {
  diskName: string;
  mountPoint: string;
  fileSystemType: string;
  usedBytes: number;
  totalBytes: number;
  disk?: { serial?: string; busType?: string }[];
}

/** What Hangar read from KubeVirt's three subresources, and when. */
export interface KubevirtGuest {
  info?: KvGuestAgentInfo;
  users?: KvUser[];
  filesystems?: KvFilesystem[];
  /** The first failure, for the source line. */
  error?: string;
  readAt: number;
}

/* -------------------------------------------------- the bridge's state */

export type BridgeState =
  | { kind: 'loading' }
  /** No VMI, or not running on a node: nothing to ask. */
  | { kind: 'not-running' }
  /** The APIService is not installed (another cluster, or k4all's guestBridge: false). */
  | { kind: 'absent' }
  /** Installed but not answering: the APIService is unavailable, or the bridge cannot reach the VM yet. */
  | { kind: 'unavailable'; message: string; apiService: boolean }
  /** The user's role does not grant guestinfo on this VM. */
  | { kind: 'forbidden'; role: string }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; info: GuestInfo };

export type Discovery = 'present' | 'absent' | 'unavailable' | 'unknown';

/** The state after a failed guestinfo call, from its status and the group's discovery. */
export function bridgeErrorState(status: number | undefined, message: string, discovery: Discovery): BridgeState {
  if (status === 403) return { kind: 'forbidden', role: GUESTINFO_ROLE };
  if (discovery === 'absent') return { kind: 'absent' };
  if (discovery === 'unavailable') return { kind: 'unavailable', apiService: true, message };
  if (status === 409) return { kind: 'not-running' };
  if (status === 503) return { kind: 'unavailable', apiService: false, message };
  return { kind: 'error', message };
}

/**
 * How long to wait before asking again after a 503. The bridge's answers
 * carry retryAfterSeconds (1 or 2), but Headlamp's request keeps only an
 * error's message: the bridge's longer value is used.
 */
export const RETRY_AFTER_503_MS = 2000;

/** The agent as the bridge sees it; else as KubeVirt says (AgentConnected). */
export type AgentHealth = 'connected' | 'not-connected' | 'not-responding' | 'unknown';

export function agentHealth(bridge: BridgeState, agentConnected: boolean): AgentHealth {
  if (bridge.kind === 'ok') {
    const a = bridge.info.agent;
    if (!a.connected) return 'not-connected';
    return a.healthy ? 'connected' : 'not-responding';
  }
  if (bridge.kind === 'loading') return agentConnected ? 'connected' : 'unknown';
  return agentConnected ? 'connected' : 'not-connected';
}

/* --------------------------------------------- errors, blocked commands */

/** The errors of one section, NotResponding left out (the agent's state says it once). */
export function sectionErrors(info: GuestInfo | undefined, section: GuestSection): GuestInfoError[] {
  return (info?.errors ?? []).filter(e => e.section === section && e.reason !== 'NotResponding');
}

/** Commands the guest's configuration blocks, among those the bridge asked for. */
export function blockedCommands(info: GuestInfo | undefined): string[] {
  const out: string[] = [];
  for (const e of info?.errors ?? []) if (e.reason === 'Blocked' && e.command && !out.includes(e.command)) out.push(e.command);
  return out;
}

/** The commands of guest-info the guest's configuration disables. */
export function disabledCommands(commands: GuestAgentCommand[] | undefined): string[] {
  return (commands ?? []).filter(c => !c.enabled).map(c => c.name);
}

const RHEL_FAMILY = new Set(['rhel', 'rocky', 'centos', 'almalinux', 'alma', 'ol', 'oraclelinux']);

/** RHEL, Rocky, CentOS, AlmaLinux, Oracle Linux: qemu-ga reads FILTER_RPC_ARGS from /etc/sysconfig/qemu-ga. */
export function rhelFamily(osId: string | undefined): boolean {
  return RHEL_FAMILY.has((osId ?? '').toLowerCase());
}

/**
 * The drop-in of hangar#6 (spec §8.11), without its SELinux module: an
 * EnvironmentFile read after the vendor's /etc/sysconfig/qemu-ga, with an
 * empty FILTER_RPC_ARGS, so every command is on. The same files as the New
 * VM wizard's "Let the guest agent reach the whole guest".
 */
export const DROPIN_ENABLE_ALL = [
  'sudo mkdir -p /etc/hangar /etc/systemd/system/qemu-guest-agent.service.d',
  "printf '[Service]\\nEnvironmentFile=-/etc/hangar/qemu-ga.env\\n' | sudo tee /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf >/dev/null",
  "echo 'FILTER_RPC_ARGS=' | sudo tee /etc/hangar/qemu-ga.env >/dev/null",
  'sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent',
];

export const DROPIN_REVERT = [
  'sudo rm -f /etc/hangar/qemu-ga.env /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf',
  'sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent',
];

/** Appends commands to Rocky's allow-list in place (tested with the file commands), then restarts the agent. */
export function allowListSed(commands: string[]): string[] {
  return [
    `sudo sed -i -E 's/^(FILTER_RPC_ARGS="--allow-rpcs=[^"]*)"/\\1,${commands.join(',')}"/' /etc/sysconfig/qemu-ga`,
    'sudo systemctl restart qemu-guest-agent',
  ];
}

export interface FixWay {
  title: string;
  note?: string;
  lines: string[];
  revert?: string[];
}

export interface BlockedFix {
  /** Where the guest's configuration blocks commands. */
  where: string;
  ways: FixWay[];
}

/** The guest-side change that enables blocked commands, for the guest's OS. */
export function blockedFix(osId: string | undefined, commands: string[]): BlockedFix | null {
  if (!commands.length) return null;
  if (rhelFamily(osId)) {
    return {
      where: 'This guest runs qemu-ga with an allow-list, FILTER_RPC_ARGS in /etc/sysconfig/qemu-ga. Run one of these in the guest, as a sudoer.',
      ways: [
        {
          title: 'Add these commands to the allow-list',
          note: 'Only the commands listed here are added. rpm -V then reports the file as changed; updates keep it (a noreplace config file).',
          lines: allowListSed(commands),
        },
        {
          title: 'Or turn the allow-list off with a systemd drop-in',
          note:
            'The vendor file stays untouched. Every agent command is then on, guest-exec and the file commands too: users with hangar-guest-admin on this VM can read and write its files through the guest bridge.',
          lines: DROPIN_ENABLE_ALL,
          revert: DROPIN_REVERT,
        },
      ],
    };
  }
  if ((osId ?? '').toLowerCase() === 'mswindows' || (osId ?? '').toLowerCase() === 'windows') {
    return {
      where:
        "This guest's agent was started with --block-rpcs or --allow-rpcs. Remove the commands from the QEMU-GA service's arguments (or from qemu-ga's configuration file), then restart the service: Restart-Service QEMU-GA.",
      ways: [],
    };
  }
  return {
    where:
      "This guest's agent runs with --block-rpcs or --allow-rpcs (on its command line, in its systemd unit or environment file, or in /etc/qemu/qemu-ga.conf). Remove the commands from the block list, or add them to the allow list, then restart the agent: sudo systemctl restart qemu-guest-agent.",
    ways: [],
  };
}

/* ------------------------------------------------- agent: install, restart */

export interface InstallHint {
  lines?: string[];
  text: string;
}

const DNF = new Set(['fedora', 'rhel', 'rocky', 'centos', 'almalinux', 'alma', 'ol', 'oraclelinux']);
const APT = new Set(['ubuntu', 'debian']);
const ZYPPER = new Set(['sles', 'opensuse', 'opensuse-leap', 'opensuse-tumbleweed']);

/** How to install the QEMU guest agent in a guest of this OS. */
export function installHint(osId: string | undefined): InstallHint {
  const id = (osId ?? '').toLowerCase();
  if (DNF.has(id)) return { text: 'In the guest:', lines: ['sudo dnf install -y qemu-guest-agent', 'sudo systemctl start qemu-guest-agent'] };
  if (APT.has(id)) return { text: 'In the guest:', lines: ['sudo apt install -y qemu-guest-agent', 'sudo systemctl start qemu-guest-agent'] };
  if (ZYPPER.has(id)) return { text: 'In the guest:', lines: ['sudo zypper install -y qemu-guest-agent', 'sudo systemctl start qemu-guest-agent'] };
  if (id === 'alpine') return { text: 'In the guest:', lines: ['apk add qemu-guest-agent', 'rc-update add qemu-guest-agent default', 'rc-service qemu-guest-agent start'] };
  if (id === 'windows' || id === 'mswindows')
    return { text: 'Install the virtio-win guest tools in the guest (virtio-win-guest-tools.exe on the virtio-win ISO): they include the QEMU guest agent.' };
  return { text: "Install the guest's qemu-guest-agent package and start its service." };
}

/** Why the agent matters, for the hint. */
export const AGENT_WHY = 'With it, Hangar shows the guest’s IP addresses, users and filesystems, snapshots freeze the filesystems first, shutdown is clean, and the Guest tab has the rest.';

/** The line that restarts the agent, which brings back one that does not respond. */
export function restartLine(osId: string | undefined): string {
  const id = (osId ?? '').toLowerCase();
  return id === 'windows' || id === 'mswindows' ? 'Restart-Service QEMU-GA' : 'sudo systemctl restart qemu-guest-agent';
}

/* ---------------------------------------------------------- the OS */

/** The guest's OS id: the bridge's osinfo, else KubeVirt's, else the VM's settings. */
export function guestOsId(info: GuestInfo | undefined, kv: KubevirtGuest | undefined | null, vmi: VMI | undefined | null, fallback?: string): string {
  return (info?.system?.os?.id || kv?.info?.os?.id || vmi?.status?.guestOSInfo?.id || fallback || '').toLowerCase();
}

export const isWindowsId = (id: string) => id === 'mswindows' || id === 'windows';

/** KubeVirt's "UTC, 0" as a zone and an offset. */
export function parseKvTimezone(tz: string | undefined): GuestTimezone | undefined {
  if (!tz) return undefined;
  const m = /^(.*),\s*(-?\d+)$/.exec(tz.trim());
  return m ? { zone: m[1].trim(), offset: Number(m[2]) } : { zone: tz, offset: NaN };
}

/** "UTC+02:00", "UTC−05:30". */
export function formatOffset(seconds: number): string {
  if (!isFinite(seconds)) return '';
  const sign = seconds < 0 ? '−' : '+';
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatTimezone(tz: GuestTimezone | undefined): string | undefined {
  if (!tz) return undefined;
  const off = formatOffset(tz.offset);
  if (!tz.zone) return off || undefined;
  return off && tz.zone !== 'UTC' ? `${tz.zone} (${off})` : tz.zone;
}

/** The guest's clock is off by more than this: the Summary says so. */
export const DRIFT_WARN_SECONDS = 5;

/* --------------------------------------------------------- filesystems */

/** A filesystem with its usage, from either source. */
export interface Filesystem {
  mountpoint: string;
  type: string;
  device: string;
  used: number;
  total: number;
  /** Serials of the disks under it. */
  serials: string[];
}

export function filesystemsFromBridge(list: GuestFilesystemInfo[] | undefined): Filesystem[] {
  return (list ?? [])
    .filter(f => (f.totalBytes ?? 0) > 0)
    .map(f => ({
      mountpoint: f.mountpoint,
      type: f.type,
      device: f.name,
      used: f.usedBytes ?? 0,
      total: f.totalBytes ?? 0,
      serials: (f.disk ?? []).map(d => d.serial).filter((s): s is string => !!s),
    }));
}

export function filesystemsFromKubevirt(list: KvFilesystem[] | undefined): Filesystem[] {
  return (list ?? [])
    .filter(f => f.totalBytes > 0)
    .map(f => ({
      mountpoint: f.mountPoint,
      type: f.fileSystemType,
      device: f.diskName,
      used: f.usedBytes,
      total: f.totalBytes,
      serials: (f.disk ?? []).map(d => d.serial).filter((s): s is string => !!s),
    }));
}

/** At or above this share of their size, filesystems are a warning. */
export const FS_WARN = 0.85;

export function fullFilesystems(list: Filesystem[]): Filesystem[] {
  return list.filter(f => f.total > 0 && f.used / f.total >= FS_WARN);
}

/* --------------------------------------------------------------- users */

export interface LoggedIn {
  name: string;
  domain?: string;
  /** ms since the epoch. */
  since?: number;
}

/** One entry per user and domain, with the earliest login (the agent lists each session). */
export function loggedIn(list: { name: string; domain?: string; loginTime?: number }[]): LoggedIn[] {
  const out = new Map<string, LoggedIn>();
  for (const u of list) {
    const k = `${u.domain ?? ''}\\${u.name}`;
    const since = u.loginTime ? u.loginTime * 1000 : undefined;
    const cur = out.get(k);
    if (!cur) out.set(k, { name: u.name, domain: u.domain, since });
    else if (since !== undefined && (cur.since === undefined || since < cur.since)) cur.since = since;
  }
  return [...out.values()];
}

export const usersFromBridge = (u: GuestUser[] | undefined) => loggedIn((u ?? []).map(x => ({ name: x.user, domain: x.domain, loginTime: x.loginTime })));
export const usersFromKubevirt = (u: KvUser[] | undefined) =>
  loggedIn((u ?? []).map(x => ({ name: x.userName, domain: x.domain, loginTime: x.loginTime })));

/* ---------------------------------------------------------------- CPU */

export interface CpuTimes {
  cpu: number;
  /** Shares of the time since boot, 0..1. */
  user: number;
  system: number;
  iowait: number;
  steal: number;
  idle: number;
}

/** Each CPU's times since boot as shares. */
export function cpuTimes(stats: GuestCPUStats[] | undefined): CpuTimes[] {
  return (stats ?? []).map(s => {
    const user = s.user + s.nice;
    const system = s.system + (s.irq ?? 0) + (s.softirq ?? 0);
    const iowait = s.iowait ?? 0;
    const steal = s.steal ?? 0;
    const total = user + system + iowait + steal + s.idle;
    const share = (n: number) => (total > 0 ? n / total : 0);
    return { cpu: s.cpu, user: share(user), system: share(system), iowait: share(iowait), steal: share(steal), idle: share(s.idle) };
  });
}

/* --------------------------------------------------------------- disks */

/** A VM disk with what the guest sees of it. */
export interface DiskMatch {
  vmDisk?: DiskRow & { serial?: string; target?: string; pciAddress?: string };
  guest?: GuestDiskInfo;
  partitions: GuestDiskInfo[];
  stats?: GuestDiskStatsInfo;
  /** How the two were matched: the disk serial, the PCI address, or the device name (may differ). */
  by?: 'serial' | 'pci' | 'name';
}

export function pciString(a: GuestPCIAddress | undefined): string | undefined {
  if (!a) return undefined;
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  return `${hex(a.domain, 4)}:${hex(a.bus, 2)}:${hex(a.slot, 2)}.${hex(a.function, 1)}`;
}

/** The device name without /dev/: "/dev/vda" → "vda". */
const devName = (s: string | undefined) => (s ?? '').replace(/^\/dev\//, '');

/** virtio-blk keeps 20 bytes of a serial. */
function serialMatches(vmSerial: string | undefined, guestSerial: string | undefined): boolean {
  if (!vmSerial || !guestSerial) return false;
  return vmSerial === guestSerial || (guestSerial.length === 20 && vmSerial.startsWith(guestSerial));
}

/**
 * Matches the guest's disks (guest-get-disks) to the VM's: by serial, then
 * by PCI address (a disk's pciAddress in the VM spec), then by the device
 * name libvirt gave it (the VMI's volumeStatus target, such as vda), which
 * the guest usually uses too. Partitions follow their disk. Guest disks
 * matched to no VM disk come last, without vmDisk.
 */
export function matchDisks(vm: VM, vmi: VMI | undefined | null, rows: DiskRow[], guest: GuestDisks | undefined): DiskMatch[] {
  const specDisks: any[] = vm.spec?.template?.spec?.domain?.devices?.disks ?? [];
  const targets = new Map<string, string>();
  for (const v of (vmi?.status?.volumeStatus ?? []) as any[]) if (v.name && v.target) targets.set(v.name, v.target);
  const all = guest?.disks ?? [];
  const whole = all.filter(d => !d.partition);
  const parts = all.filter(d => d.partition);
  const stats = guest?.stats ?? [];
  const used = new Set<GuestDiskInfo>();

  const out: DiskMatch[] = rows
    .filter(r => !r.config)
    .map(r => {
      const spec = specDisks.find(d => d.name === r.name) ?? {};
      const vmDisk = { ...r, serial: spec.serial as string | undefined, target: targets.get(r.name), pciAddress: spec.disk?.pciAddress as string | undefined };
      return { vmDisk, partitions: [] } as DiskMatch;
    });

  const pass = (by: DiskMatch['by'], same: (m: DiskMatch, g: GuestDiskInfo) => boolean) => {
    for (const m of out) {
      if (m.guest) continue;
      const g = whole.find(x => !used.has(x) && same(m, x));
      if (g) {
        m.guest = g;
        m.by = by;
        used.add(g);
      }
    }
  };
  pass('serial', (m, g) => serialMatches(m.vmDisk?.serial, g.address?.serial));
  pass('pci', (m, g) => !!m.vmDisk?.pciAddress && m.vmDisk.pciAddress.toLowerCase() === pciString(g.address?.pciController));
  pass('name', (m, g) => !!m.vmDisk?.target && (m.vmDisk.target === devName(g.address?.dev) || m.vmDisk.target === devName(g.name)));

  for (const g of whole) if (!used.has(g)) out.push({ guest: g, partitions: [] });
  for (const m of out) {
    if (!m.guest) continue;
    const name = m.guest.name;
    m.partitions = parts.filter(p => (p.dependencies ?? []).includes(name));
    m.stats = stats.find(s => s.name === devName(name) || s.name === devName(m.guest?.address?.dev));
  }
  return out;
}

/** The VM disk a filesystem lives on, by the serials guest-get-fsinfo gives. */
export function filesystemDisk(fs: Filesystem, matches: DiskMatch[]): DiskMatch | undefined {
  return matches.find(m => fs.serials.some(s => serialMatches(m.vmDisk?.serial, s) || (m.guest?.address?.serial && m.guest.address.serial === s)));
}

/* ---------------------------------------------------------------- NICs */

export interface NicMatch {
  nic?: NicRow;
  guest?: GuestNetworkInterface;
}

const normMac = (m: string | undefined) => (m ?? '').toLowerCase().replace(/-/g, ':');

/** Matches the guest's interfaces to the VM's NICs by MAC; the guest's others (loopback, bridges) come last. */
export function matchNics(rows: NicRow[], guest: GuestNetworkInterface[] | undefined): NicMatch[] {
  const list = guest ?? [];
  const used = new Set<GuestNetworkInterface>();
  const out: NicMatch[] = rows.map(nic => {
    const g = nic.mac ? list.find(x => !used.has(x) && normMac(x.hardwareAddress) === normMac(nic.mac)) : undefined;
    if (g) used.add(g);
    return { nic, guest: g };
  });
  for (const g of list) if (!used.has(g)) out.push({ guest: g });
  return out;
}

/** An address without its zone ("fe80::1%6" → "fe80::1"), with its prefix. */
export function formatIp(a: GuestIPAddress): string {
  return `${a.ipAddress.replace(/%.*$/, '')}/${a.prefix}`;
}

/** Loopback and link-local addresses, which the quick info leaves out. */
export function isLocalIp(ip: string): boolean {
  const v = ip.toLowerCase();
  return v.startsWith('127.') || v === '::1' || v.startsWith('fe80') || v.startsWith('169.254.');
}

/* ------------------------------------------------------------- devices */

/** Red Hat's PCI vendor ID, which virtio devices carry. */
export const VIRTIO_VENDOR = 0x1af4;

/** A virtio-win driver: a virtio device, or a driver named VirtIO. */
export function isVirtioDriver(d: GuestDeviceInfo): boolean {
  return d.id?.vendorId === VIRTIO_VENDOR || /virtio/i.test(d.driverName);
}

/** The driver's date (nanoseconds since the epoch) in ms. */
export const driverDateMs = (d: GuestDeviceInfo) => (d.driverDate === undefined ? undefined : d.driverDate / 1e6);

export const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/* ------------------------------------------------------------ SSH keys */

/** A key line in parts: its type, the start and end of its base64, its comment. */
export function keyParts(line: string): { type: string; short: string; comment: string } {
  const [type = '', body = '', ...rest] = line.trim().split(/\s+/);
  const short = body.length > 24 ? `${body.slice(0, 12)}…${body.slice(-8)}` : body;
  return { type, short, comment: rest.join(' ') };
}

/** A named user the guest does not have (qemu-ga's message). */
export const noSuchUser = (k: GuestUserSSHKeys) => k.reason === 'AgentError' && /failed to lookup user/.test(k.message ?? '');

/**
 * The users a VM's cloud-init creates, from its inline user data (the
 * users: list and the older user:), for the bridge's sshUsers: their keys
 * are read even when nobody is logged in. User data in a Secret is not read
 * (no Hangar role reads Secrets).
 */
export function cloudInitUsers(vm: VM): string[] {
  const out: string[] = [];
  const add = (n: unknown) => {
    if (typeof n === 'string' && n !== 'default' && SSH_USER_NAME.test(n) && !out.includes(n)) out.push(n);
  };
  for (const v of (vm.spec?.template?.spec?.volumes ?? []) as any[]) {
    const ci = v.cloudInitNoCloud ?? v.cloudInitConfigDrive;
    if (!ci) continue;
    let text: string | undefined = ci.userData;
    if (!text && ci.userDataBase64) {
      try {
        text = atob(ci.userDataBase64);
      } catch {
        text = undefined;
      }
    }
    if (!text || !/^#cloud-config/.test(text.trimStart())) continue;
    let doc: any;
    try {
      doc = yaml.load(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    if (typeof doc.user === 'string') add(doc.user);
    else if (doc.user && typeof doc.user === 'object') add(doc.user.name);
    const users = Array.isArray(doc.users) ? doc.users : typeof doc.users === 'string' ? doc.users.split(',').map((s: string) => s.trim()) : [];
    for (const u of users) add(typeof u === 'string' ? u : u?.name);
  }
  return out.slice(0, MAX_SSH_USERS);
}

/* ---------------------------------------------------------- quick info */

export interface IfaceIps {
  /** The guest's interface name, else the VM NIC's. */
  name: string;
  ips: string[];
  /** The guest agent reported them (infoSource), not only the network. */
  fromAgent: boolean;
}

/** What the Summary shows of the guest, from both sources. */
export interface QuickInfo {
  os?: string;
  version?: string;
  kernel?: string;
  arch?: string;
  hostName?: string;
  timezone?: string;
  agentVersion?: string;
  /** When AgentConnected last turned True (ISO). */
  connectedSince?: string;
  ips: IfaceIps[];
  users?: LoggedIn[];
  full: Filesystem[];
  load?: GuestLoadAverage;
  /** The guest's clock minus the host's, when it is off by more than DRIFT_WARN_SECONDS. */
  drift?: number;
}

/** The IPs of each interface from the VMI's status, without link-local ones. */
export function ipsFromStatus(vmi: VMI | undefined | null): IfaceIps[] {
  const out: IfaceIps[] = [];
  for (const s of (vmi?.status?.interfaces ?? []) as any[]) {
    const ips: string[] = (s.ipAddresses ?? (s.ipAddress ? [s.ipAddress] : [])).filter((ip: string) => !isLocalIp(ip));
    if (!ips.length) continue;
    out.push({ name: s.interfaceName || s.name || '?', ips, fromAgent: String(s.infoSource ?? '').includes('guest-agent') });
  }
  return out;
}

export function quickInfo(vmi: VMI | undefined | null, kv: KubevirtGuest | null | undefined, bridge: BridgeState): QuickInfo {
  const b = bridge.kind === 'ok' ? bridge.info : undefined;
  const os = b?.system?.os ?? kv?.info?.os ?? vmi?.status?.guestOSInfo;
  const cond = ((vmi?.status?.conditions ?? []) as any[]).find(c => c.type === 'AgentConnected' && c.status === 'True');
  const fs = b?.disks?.filesystems ? filesystemsFromBridge(b.disks.filesystems) : filesystemsFromKubevirt(kv?.filesystems ?? kv?.info?.fsInfo?.disks);
  const users = b?.users ? usersFromBridge(b.users.items) : kv?.users ? usersFromKubevirt(kv.users) : kv?.info?.userList ? usersFromKubevirt(kv.info.userList) : undefined;
  const drift = b?.time?.driftSeconds;
  return {
    os: os?.prettyName || [os?.name, os?.version].filter(Boolean).join(' ') || undefined,
    version: os?.version,
    kernel: os?.kernelRelease,
    arch: os?.machine,
    hostName: b?.system?.hostName ?? kv?.info?.hostname ?? vmi?.status?.guestOSInfo?.hostname,
    timezone: formatTimezone(b?.system?.timezone ?? parseKvTimezone(kv?.info?.timezone)),
    agentVersion: b?.agent.version ?? kv?.info?.guestAgentVersion,
    connectedSince: cond?.lastTransitionTime,
    ips: ipsFromStatus(vmi),
    users,
    full: fullFilesystems(fs),
    load: b?.cpu?.load,
    drift: drift !== undefined && Math.abs(drift) > DRIFT_WARN_SECONDS ? drift : undefined,
  };
}

/* -------------------------------------------------------------- routes */

/** /proc/net/ipv6_route's 32 hex digits as an IPv6 address, shortened. */
export function ipv6FromHex(hex: string): string {
  if (!/^[0-9a-f]{32}$/i.test(hex)) return hex;
  const groups = (hex.toLowerCase().match(/.{4}/g) ?? []).map(g => g.replace(/^0+(?=.)/, ''));
  // The longest run of zero groups (two or more) becomes "::".
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > len && j - i > 1) [best, len] = [i, j - i];
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + len).join(':')}`;
}

function maskBits(mask: string | undefined): number | undefined {
  if (!mask) return undefined;
  const parts = mask.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !(p >= 0 && p <= 255))) return undefined;
  return parts.reduce((n, p) => n + p.toString(2).replace(/0/g, '').length, 0);
}

export interface RouteRow {
  destination: string;
  /** The next hop; undefined on-link. */
  via?: string;
  iface: string;
  metric: number;
  version: number;
}

/** A guest-network-get-route entry as people read it: "10.0.2.0/24 on eth0", "default via 10.0.2.1". */
export function routeRow(r: GuestNetworkRoute): RouteRow {
  if (r.version === 6) {
    const dst = ipv6FromHex(r.destination);
    const len = r.desprefixlen !== undefined ? parseInt(r.desprefixlen, 16) : undefined;
    const hop = r.nexthop ? ipv6FromHex(r.nexthop) : undefined;
    return {
      destination: dst === '::' && len === 0 ? 'default' : `${dst}/${len ?? '?'}`,
      via: hop && hop !== '::' ? hop : undefined,
      iface: r.iface,
      metric: r.metric,
      version: 6,
    };
  }
  const bits = maskBits(r.mask);
  return {
    destination: r.destination === '0.0.0.0' && bits === 0 ? 'default' : `${r.destination}/${bits ?? '?'}`,
    via: r.gateway && r.gateway !== '0.0.0.0' ? r.gateway : undefined,
    iface: r.iface,
    metric: r.metric,
    version: 4,
  };
}
