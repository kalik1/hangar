/*
 * Where a VM can run, host by host: can it move there while running (live
 * migration), only powered off (cold migration), or not at all, and why.
 * Pure functions over the nodes, the VM and its running instance, its
 * disks (PVC → PV) and the pods of the running VMs.
 *
 * The cluster keeps the last word: the VMI's LiveMigratable condition says
 * whether KubeVirt will move it live at all, the scheduler picks the pod's
 * node. This module explains both before the user asks, in a virtualizer's
 * words: CPU compatibility, maintenance, free memory, devices, where the
 * disks are.
 */

import { Datastore } from './capacity';
import { storageKind } from './storage';
import { Obj } from './types';
import { formatBytes, parseQuantity } from './units';
import { cond, disks, hardware, key } from './vm';

/* ------------------------------------------------------------ node rules */

interface Requirement {
  key: string;
  operator: string;
  values?: string[];
}

function matchReq(value: string | undefined, r: Requirement): boolean {
  const vals = r.values ?? [];
  switch (r.operator) {
    case 'In':
      return value !== undefined && vals.includes(value);
    case 'NotIn':
      return value === undefined || !vals.includes(value);
    case 'Exists':
      return value !== undefined;
    case 'DoesNotExist':
      return value === undefined;
    case 'Gt':
      return value !== undefined && Number(value) > Number(vals[0]);
    case 'Lt':
      return value !== undefined && Number(value) < Number(vals[0]);
    default:
      return false;
  }
}

/** A node selector term: every expression must hold. An empty term matches nothing (Kubernetes' rule). */
export function nodeMatchesTerm(node: Obj, term: { matchExpressions?: Requirement[]; matchFields?: Requirement[] }): boolean {
  const exprs = term.matchExpressions ?? [];
  const fields = term.matchFields ?? [];
  if (!exprs.length && !fields.length) return false;
  const labels = node.metadata.labels ?? {};
  return (
    exprs.every(r => matchReq(labels[r.key], r)) &&
    fields.every(r => matchReq(r.key === 'metadata.name' ? node.metadata.name : undefined, r))
  );
}

/** Terms are ORed. No terms: no restriction. */
export function nodeMatchesTerms(node: Obj, terms: any[] | undefined): boolean {
  if (!terms || !terms.length) return true;
  return terms.some(t => nodeMatchesTerm(node, t));
}

export function nodeMatchesSelector(node: Obj, selector: Record<string, string> | undefined): boolean {
  const labels = node.metadata.labels ?? {};
  return Object.entries(selector ?? {}).every(([k, v]) => labels[k] === v);
}

/** The first NoSchedule/NoExecute taint the tolerations do not cover. */
export function untoleratedTaint(node: Obj, tolerations: any[] | undefined): any | undefined {
  const tol = tolerations ?? [];
  return (node.spec?.taints ?? []).find((taint: any) => {
    if (taint.effect !== 'NoSchedule' && taint.effect !== 'NoExecute') return false;
    return !tol.some((t: any) => {
      if (t.effect && t.effect !== taint.effect) return false;
      if (t.operator === 'Exists') return !t.key || t.key === taint.key;
      return t.key === taint.key && (t.value ?? '') === (taint.value ?? '');
    });
  });
}

const HOSTNAME = 'kubernetes.io/hostname';

/** The host a spec is pinned to (required node affinity on the hostname, or a hostname node selector). */
export function pinnedHost(spec: any): string | undefined {
  const sel = spec?.nodeSelector?.[HOSTNAME];
  if (sel) return sel;
  const terms = spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  if (terms.length !== 1) return undefined;
  const e = (terms[0].matchExpressions ?? []).find((x: Requirement) => x.key === HOSTNAME && x.operator === 'In');
  return e?.values?.length === 1 ? e.values[0] : undefined;
}

/** Required node affinity terms without the hostname pin (a cold move replaces the pin). */
function termsWithoutPin(spec: any): any[] | undefined {
  const terms = spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (!terms) return undefined;
  const out = terms
    .map((t: any) => ({ ...t, matchExpressions: (t.matchExpressions ?? []).filter((e: Requirement) => e.key !== HOSTNAME) }))
    .filter((t: any) => (t.matchExpressions?.length ?? 0) + (t.matchFields?.length ?? 0) > 0);
  return out.length ? out : undefined;
}

/* ----------------------------------------------------------------- disks */

export type DiskLocality =
  /** Several hosts can use it at once (ReadWriteMany): moves with a running VM. */
  | { kind: 'shared' }
  /** One host at a time, but any host (network storage): moves with a powered-off VM. */
  | { kind: 'network' }
  /** Stored on these hosts only (local disks: usually one). */
  | { kind: 'local'; hosts: string[] }
  /** Not created yet: the storage places it when the VM starts. */
  | { kind: 'pending' }
  /** Not a disk on a datastore (container image, cloud-init, ...): it goes wherever the VM goes. */
  | { kind: 'none' };

export interface DiskPlace {
  /** The VM's volume name. */
  name: string;
  claim?: string;
  datastore?: string;
  locality: DiskLocality;
}

/** The hosts a PV can be used from, or null when it is not tied to hosts. */
export function pvHosts(pv: Obj | undefined, nodes: Obj[]): string[] | null {
  const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms;
  if (!terms || !terms.length) return null;
  return nodes.filter(n => nodeMatchesTerms(n, terms)).map(n => n.metadata.name);
}

export function claimLocality(pvc: Obj | undefined, pv: Obj | undefined, nodes: Obj[]): DiskLocality {
  if (!pvc) return { kind: 'pending' };
  if (!pv) return { kind: 'pending' };
  const hosts = pvHosts(pv, nodes);
  // A local volume can be RWX on paper (a static local PV): the host wins.
  if (hosts && hosts.length < nodes.length) return { kind: 'local', hosts };
  const modes: string[] = pvc.status?.accessModes ?? pvc.spec?.accessModes ?? [];
  if (modes.includes('ReadWriteMany')) return { kind: 'shared' };
  return { kind: 'network' };
}

/** Where each disk of the VM lives. */
export function vmDiskPlaces(vm: Obj, pvcIdx: Map<string, Obj>, pvIdx: Map<string, Obj>, nodes: Obj[]): DiskPlace[] {
  const ns = vm.metadata.namespace ?? '';
  return disks(vm as any).map(d => {
    if (!d.claimName) {
      if (d.sourceKind === 'hostDisk') return { name: d.name, locality: { kind: 'local', hosts: [] } as DiskLocality };
      return { name: d.name, locality: { kind: 'none' } as DiskLocality };
    }
    const pvc = pvcIdx.get(`${ns}/${d.claimName}`);
    const pv = pvc?.spec?.volumeName ? pvIdx.get(pvc.spec.volumeName) : undefined;
    return { name: d.name, claim: d.claimName, datastore: pvc?.spec?.storageClassName, locality: claimLocality(pvc, pv, nodes) };
  });
}

/** Plain words for a disk's place. */
export function localityLabel(l: DiskLocality, nodes = 0): string {
  switch (l.kind) {
    case 'shared':
      return nodes > 1 ? 'Shared by the hosts' : 'Shared storage';
    case 'network':
      return 'Network storage, one host at a time';
    case 'local':
      return l.hosts.length === 1 ? `Stored on ${l.hosts[0]}` : l.hosts.length ? `Stored on ${l.hosts.join(', ')}` : 'A file on its host';
    case 'pending':
      return 'Created when the VM starts';
    default:
      return 'Goes with the VM';
  }
}

/* ------------------------------------------------------------------- CPU */

export const L_HOST_MODEL = 'host-model-cpu.node.kubevirt.io/';
export const L_HOST_MODEL_FEATURE = 'host-model-required-features.node.kubevirt.io/';
export const L_MIGRATION_MODEL = 'cpu-model-migration.node.kubevirt.io/';
export const L_MODEL = 'cpu-model.node.kubevirt.io/';
export const L_FEATURE = 'cpu-feature.node.kubevirt.io/';
export const L_VENDOR = 'cpu-vendor.node.kubevirt.io/';

function labelSuffix(node: Obj | undefined, prefix: string): string[] {
  return Object.entries(node?.metadata.labels ?? {})
    .filter(([k, v]) => k.startsWith(prefix) && v === 'true')
    .map(([k]) => k.slice(prefix.length));
}

export function cpuVendor(node: Obj | undefined): string | undefined {
  return labelSuffix(node, L_VENDOR)[0];
}

export function hostModel(node: Obj | undefined): string | undefined {
  return labelSuffix(node, L_HOST_MODEL)[0];
}

export interface CpuNeed {
  mode: 'host-model' | 'host-passthrough' | 'named';
  model?: string;
  /** Features the guest CPU requires. */
  features: string[];
  /** The host it runs on now (for host-model: its model and features). */
  source?: string;
  vendor?: string;
}

/** What a target host must offer to take the running VM, as KubeVirt checks it. */
export function cpuNeed(spec: any, source: Obj | undefined): CpuNeed {
  const cpu = spec?.domain?.cpu ?? {};
  const model: string = cpu.model || 'host-model';
  const required: string[] = (cpu.features ?? [])
    .filter((f: any) => !f.policy || f.policy === 'require' || f.policy === 'force')
    .map((f: any) => f.name);
  if (model === 'host-model') {
    return {
      mode: 'host-model',
      model: hostModel(source),
      features: [...new Set([...labelSuffix(source, L_HOST_MODEL_FEATURE), ...required])],
      source: source?.metadata.name,
      vendor: cpuVendor(source),
    };
  }
  if (model === 'host-passthrough')
    return { mode: 'host-passthrough', model: hostModel(source), features: required, source: source?.metadata.name, vendor: cpuVendor(source) };
  return { mode: 'named', model, features: required, source: source?.metadata.name, vendor: cpuVendor(source) };
}

/** Can a VM with this CPU need move to the target while running. */
export function cpuCompatible(need: CpuNeed, target: Obj): { ok: boolean; why?: string } {
  const labels = target.metadata.labels ?? {};
  const tv = cpuVendor(target);
  const vendorChange = need.vendor && tv && need.vendor !== tv ? `${need.vendor} → ${tv}` : '';
  if (need.mode === 'host-model') {
    if (!need.model) return { ok: true };
    if (labels[L_MIGRATION_MODEL + need.model] !== 'true') {
      return {
        ok: false,
        why: vendorChange
          ? `Different CPU maker (${vendorChange}): a running VM cannot change CPU`
          : `Its CPU (${need.model}, from ${need.source ?? 'its host'}) is not available here`,
      };
    }
  } else if (need.mode === 'host-passthrough') {
    const tm = hostModel(target);
    if (vendorChange) return { ok: false, why: `Different CPU maker (${vendorChange})` };
    if (need.model && tm && tm !== need.model) return { ok: false, why: `It uses the host's exact CPU (${need.model}); this host has ${tm}` };
  } else if (need.model && labels[L_MODEL + need.model] !== 'true') {
    return { ok: false, why: vendorChange ? `Different CPU maker (${vendorChange})` : `CPU model ${need.model} is not available here` };
  }
  const missing = need.features.filter(f => labels[L_FEATURE + f] !== 'true');
  if (missing.length) return { ok: false, why: `CPU feature${missing.length === 1 ? '' : 's'} ${missing.slice(0, 3).join(', ')} missing` };
  return { ok: true };
}

/* ------------------------------------------------- memory and devices */

function isVmPodActive(p: Obj): boolean {
  return !p.metadata.deletionTimestamp && (p.status?.phase === 'Running' || p.status?.phase === 'Pending');
}

function podVmKey(p: Obj): string | undefined {
  const n = p.metadata.labels?.['vm.kubevirt.io/name'] ?? p.metadata.labels?.['kubevirt.io/domain'];
  return n ? `${p.metadata.namespace}/${n}` : undefined;
}

/**
 * A pod's request (or limit) of a resource as the scheduler counts it: the
 * containers plus sidecar init containers (restartPolicy Always, like
 * KubeVirt's guest-console-log), at least the largest plain init container,
 * plus the pod overhead.
 */
export function podSum(p: Obj, field: 'requests' | 'limits', resource: string): number {
  const q = (c: any) => {
    const v = parseQuantity(c.resources?.[field]?.[resource]);
    return isFinite(v) ? v : 0;
  };
  const inits: any[] = p.spec?.initContainers ?? [];
  const sidecars = inits.filter(c => c.restartPolicy === 'Always').reduce((s, c) => s + q(c), 0);
  const plainInit = inits.filter(c => c.restartPolicy !== 'Always').reduce((m, c) => Math.max(m, q(c)), 0);
  const main = (p.spec?.containers ?? []).reduce((s: number, c: any) => s + q(c), 0) + sidecars;
  const overhead = field === 'requests' ? parseQuantity(p.spec?.overhead?.[resource]) : NaN;
  return Math.max(main, plainInit) + (isFinite(overhead) ? overhead : 0);
}

/** Memory still free on a host for VMs: allocatable minus what the VM pods there request (and minus real use when known). */
export function nodeMemoryFree(node: Obj, launchers: Obj[], excludeVm?: string, usedBytes?: number, allRequests?: number): number {
  const alloc = parseQuantity(node.status?.allocatable?.memory) || 0;
  const vmPods = launchers.filter(p => p.spec?.nodeName === node.metadata.name && isVmPodActive(p));
  const own = vmPods.filter(p => podVmKey(p) === excludeVm).reduce((s, p) => s + podSum(p, 'requests', 'memory'), 0);
  // Every pod's requests (Ceph, ingress, ... too) when known, else the VM pods only.
  const requested =
    allRequests !== undefined ? allRequests - own : vmPods.filter(p => podVmKey(p) !== excludeVm).reduce((s, p) => s + podSum(p, 'requests', 'memory'), 0);
  const byRequests = alloc - requested;
  return usedBytes !== undefined && isFinite(usedBytes) ? Math.min(byRequests, alloc - usedBytes) : byRequests;
}

/** Devices (PCI, GPU, USB) the VM asks for: resource name → count. */
export function deviceNeeds(spec: any): Map<string, number> {
  const out = new Map<string, number>();
  const devs = spec?.domain?.devices ?? {};
  for (const d of [...(devs.hostDevices ?? []), ...(devs.gpus ?? [])]) {
    if (!d?.deviceName) continue;
    out.set(d.deviceName, (out.get(d.deviceName) ?? 0) + 1);
  }
  return out;
}

/** Free units of a device resource on a host (allocatable minus what VM pods there hold). */
export function nodeDeviceFree(node: Obj, launchers: Obj[], resource: string, excludeVm?: string): { total: number; free: number } {
  const total = parseQuantity(node.status?.allocatable?.[resource]);
  if (!isFinite(total)) return { total: 0, free: 0 };
  const held = launchers
    .filter(p => p.spec?.nodeName === node.metadata.name && isVmPodActive(p) && podVmKey(p) !== excludeVm)
    .reduce((s, p) => s + podSum(p, 'limits', resource), 0);
  return { total, free: Math.max(0, total - held) };
}

/** A readable name for a device resource ("hangar.magesgate.com/iris-xe-vf" → "iris-xe-vf"). */
export function deviceLabel(resource: string): string {
  return resource.split('/').pop() || resource;
}

/* --------------------------------------------- live migration gate */

const LIVE_REASONS: Record<string, string> = {
  HostDeviceNotLiveMigratable: 'It uses a device of its host (PCI passthrough, GPU or USB): a running VM cannot take it along.',
  DisksNotLiveMigratable: 'A disk is stored on one host only.',
  InterfaceNotLiveMigratable: 'A network adapter is bridged on the pod network, which cannot move.',
  HotplugNotLiveMigratable: 'A disk was hot-plugged in a way that cannot move.',
  SEVNotLiveMigratable: 'Its memory is encrypted (SEV).',
  SecureExecutionNotLiveMigratable: 'It runs in secure execution mode.',
  HypervPassthroughNotLiveMigratable: 'It passes the host\'s Hyper-V features through.',
  PersistentReservationNotLiveMigratable: 'A disk uses SCSI persistent reservations.',
  CPUModeLiveMigratable: 'It uses the host\'s exact CPU (host-passthrough).',
  VMIIsPaused: 'It is paused.',
  FilesystemsNotLiveMigratable: 'It shares a host folder (virtiofs).',
};

/** Why KubeVirt refuses to move the running VM, in plain words (null: it can). */
export function liveGate(vmi: Obj | null | undefined): { ok: boolean; reason?: string; why?: string } {
  if (!vmi) return { ok: false, reason: 'NotRunning', why: 'The VM is not running.' };
  const c = cond(vmi, 'LiveMigratable');
  if (!c) return { ok: false, reason: 'Unknown', why: 'Its host has not said yet whether it can move.' };
  if (c.status === 'True') return { ok: true };
  let why = (c.reason && LIVE_REASONS[c.reason]) || c.message || 'KubeVirt cannot move it while running.';
  if (c.reason === 'DisksNotLiveMigratable') {
    const m = (c.message ?? '').match(/PVC (\S+) is not shared/);
    if (m) why = `Disk ${m[1]} is stored on one host only (not shared storage).`;
  }
  return { ok: false, reason: c.reason, why };
}

/** KubeVirt can copy its disks while it runs (storage migration). */
export function storageLiveMigratable(vmi: Obj | null | undefined): boolean {
  return cond(vmi ?? null, 'StorageLiveMigratable')?.status === 'True';
}

/* -------------------------------------------------------- verdicts */

export interface Check {
  ok: boolean;
  /** Why not, most important first. */
  reasons: string[];
}

export interface HostVerdict {
  host: string;
  node: Obj;
  /** The VM runs here now. */
  current: boolean;
  live: Check;
  cold: Check;
  /**
   * It can take the VM for a live disk move (storage migration): KubeVirt
   * copies the disks during a migration to another host, so the live
   * checks hold here, except where the disks are stored.
   */
  liveDiskMove: Check;
  memFree: number;
  /** Device resource → free/total on this host. */
  devices: { resource: string; free: number; total: number; need: number }[];
}

export interface PlacementInput {
  vm: Obj;
  vmi?: Obj | null;
  nodes: Obj[];
  launchers: Obj[];
  pvcs: Map<string, Obj>;
  pvs: Map<string, Obj>;
  instancetypes?: Obj[];
  /** Host name → memory in use now (metrics), when known. */
  memUsed?: Map<string, number>;
  /** Host name → memory requested by all its pods (not only VMs), when known. */
  podMemRequests?: Map<string, number>;
  /** Readable device names (resource → label). */
  deviceName?: (resource: string) => string;
  /** The KubeVirt CR's default CPU model (spec.configuration.cpuModel), when set. */
  clusterCpuModel?: string;
}

/**
 * The CPU model a powered-off VM gets when it starts, as KubeVirt resolves
 * it: its own, else its flavor's (cluster or folder instancetype), else the
 * cluster default, else host-model.
 */
export function coldCpuModel(vm: Obj, instancetypes: Obj[] = [], clusterCpuModel?: string): string | undefined {
  const own = vm.spec?.template?.spec?.domain?.cpu?.model;
  if (own) return own;
  const it = vm.spec?.instancetype;
  const flavor = it?.name
    ? instancetypes.find(o => o.metadata.name === it.name && (it.kind === 'VirtualMachineInstancetype' ? o.metadata.namespace === vm.metadata.namespace : !o.metadata.namespace))
    : undefined;
  return flavor?.spec?.cpu?.model || clusterCpuModel || undefined;
}

export interface Placement {
  running: boolean;
  source?: string;
  live: { ok: boolean; reason?: string; why?: string };
  storageLive: boolean;
  disks: DiskPlace[];
  /** Memory the VM needs on a host (its pod's request when running). */
  needMem: number;
  devices: [string, number][];
  cpu?: CpuNeed;
  hosts: HostVerdict[];
}

/** Memory a VM's pod asks for: the running pod's request, else the guest memory plus a typical overhead. */
export function memoryNeed(vm: Obj, vmi: Obj | null | undefined, launchers: Obj[], instancetypes: Obj[] = []): number {
  const pod = launchers.find(p => podVmKey(p) === key(vm) && isVmPodActive(p) && p.spec?.nodeName === vmi?.status?.nodeName);
  const req = pod ? podSum(pod, 'requests', 'memory') : 0;
  if (req > 0) return req;
  return hardware(vm as any, vmi as any, instancetypes).memoryBytes + 256 * 2 ** 20;
}

export function placement(i: PlacementInput): Placement {
  const { vm, vmi, nodes, launchers } = i;
  const running = !!vmi && !!vmi.status?.nodeName;
  const source = vmi?.status?.nodeName as string | undefined;
  const sourceNode = nodes.find(n => n.metadata.name === source);
  const vmSpec = vm.spec?.template?.spec ?? {};
  const liveSpec = vmi?.spec ?? vmSpec;
  const live = liveGate(vmi);
  const placesOfDisks = vmDiskPlaces(vm, i.pvcs, i.pvs, nodes);
  const needMem = memoryNeed(vm, vmi, launchers, i.instancetypes);
  const devs = deviceNeeds(vmSpec);
  const cpu = running ? cpuNeed(liveSpec, sourceNode) : undefined;
  const coldModel = coldCpuModel(vm, i.instancetypes, i.clusterCpuModel);
  const coldCpu = cpuNeed(coldModel ? { ...vmSpec, domain: { ...(vmSpec.domain ?? {}), cpu: { ...(vmSpec.domain?.cpu ?? {}), model: coldModel } } } : vmSpec, undefined);
  const vmKey = key(vm);
  const label = i.deviceName ?? deviceLabel;
  const pin = pinnedHost(liveSpec);
  const hosts: HostVerdict[] = nodes.map(node => {
    const host = node.metadata.name;
    const current = host === source;
    const ready = (node.status?.conditions ?? []).find((c: any) => c.type === 'Ready')?.status === 'True';
    const base: string[] = [];
    if (!ready) base.push('Not responding');
    else if (node.spec?.unschedulable) base.push('In maintenance mode');
    else if (node.metadata.labels?.['kubevirt.io/schedulable'] !== 'true') base.push('Cannot run VMs (virtualization is not ready here)');
    const memFree = nodeMemoryFree(node, launchers, vmKey, i.memUsed?.get(host), i.podMemRequests?.get(host));
    const memShort = memFree < needMem ? `Not enough free memory: it needs ${formatBytes(needMem)}, ${formatBytes(Math.max(0, memFree))} free` : '';
    const devices = [...devs.entries()].map(([resource, need]) => ({ resource, need, ...nodeDeviceFree(node, launchers, resource, vmKey) }));
    const devShort = devices
      .filter(d => d.free < d.need)
      .map(d => (d.total === 0 ? `No ${label(d.resource)} on this host` : `No free ${label(d.resource)} (${d.free} of ${d.total} free)`));
    const diskShort = placesOfDisks
      .filter(p => p.locality.kind === 'local' && !p.locality.hosts.includes(host))
      .map(p =>
        p.locality.kind === 'local' && p.locality.hosts.length
          ? `Disk ${p.claim ?? p.name} is stored on ${p.locality.hosts.join(', ')}`
          : `Disk ${p.name} is a file on its current host`
      );

    // Powered off: its own scheduling rules, except the pin a move replaces.
    const coldRules: string[] = [];
    if (!nodeMatchesSelector(node, Object.fromEntries(Object.entries(vmSpec.nodeSelector ?? {}).filter(([k]) => k !== HOSTNAME)) as Record<string, string>))
      coldRules.push("Its placement rules (node selector) exclude this host");
    if (!nodeMatchesTerms(node, termsWithoutPin(vmSpec))) coldRules.push('Its placement rules (affinity) exclude this host');
    const taint = untoleratedTaint(node, vmSpec.tolerations);
    if (taint) coldRules.push(`Reserved: taint ${taint.key}${taint.value ? `=${taint.value}` : ''}`);
    if (coldCpu.mode === 'named' && coldCpu.model && node.metadata.labels?.[L_MODEL + coldCpu.model] !== 'true')
      coldRules.push(`CPU model ${coldCpu.model} is not available here`);
    const coldFeat = coldCpu.features.filter(f => node.metadata.labels?.[L_FEATURE + f] !== 'true');
    if (coldFeat.length) coldRules.push(`CPU feature ${coldFeat.slice(0, 3).join(', ')} missing`);

    const coldReasons = current ? ['It runs here now'] : [...base, ...coldRules, ...diskShort, ...devShort, ...(memShort ? [memShort] : [])];

    const liveReasons: string[] = [];
    const diskMoveReasons: string[] = [];
    if (current) liveReasons.push('It runs here now');
    else if (!running) liveReasons.push('The VM is not running');
    else {
      const rules: string[] = [...base];
      if (pin && pin !== host) rules.push(`It is pinned to ${pin}`);
      if (!nodeMatchesSelector(node, liveSpec.nodeSelector)) rules.push('Its placement rules (node selector) exclude this host');
      else if (!nodeMatchesTerms(node, liveSpec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms))
        rules.push('Its placement rules (affinity) exclude this host');
      const lt = untoleratedTaint(node, liveSpec.tolerations);
      if (lt) rules.push(`Reserved: taint ${lt.key}`);
      if (cpu) {
        const c = cpuCompatible(cpu, node);
        if (!c.ok && c.why) rules.push(c.why);
      }
      liveReasons.push(...rules, ...diskShort);
      if (memShort) liveReasons.push(memShort);
      if (!live.ok && live.why) liveReasons.push(live.why);
      // A disk move copies the disks: where they are stored now does not keep it here.
      diskMoveReasons.push(...rules);
      if (memShort) diskMoveReasons.push(memShort);
      if (!live.ok && live.why && live.reason !== 'DisksNotLiveMigratable') diskMoveReasons.push(live.why);
    }
    if (current || !running) diskMoveReasons.push(...liveReasons);
    return {
      host,
      node,
      current,
      live: { ok: liveReasons.length === 0, reasons: liveReasons },
      cold: { ok: coldReasons.length === 0, reasons: coldReasons },
      liveDiskMove: { ok: diskMoveReasons.length === 0, reasons: diskMoveReasons },
      memFree,
      devices,
    };
  });
  return {
    running,
    source,
    live,
    storageLive: storageLiveMigratable(vmi),
    disks: placesOfDisks,
    needMem,
    devices: [...devs.entries()],
    cpu,
    hosts: hosts.sort((a, b) => Number(b.current) - Number(a.current) || a.host.localeCompare(b.host, undefined, { numeric: true })),
  };
}

/* ---------------------------------------------------- evacuation plan */

export interface EvacuationRow {
  vm: Obj;
  /** Moves live to some other host. */
  live: boolean;
  /** Why it cannot move live (when !live). */
  why?: string;
  /** Hosts that can take it live. */
  targets: string[];
  /** Hosts that can take it powered off (shut down, start there). */
  coldTargets: string[];
}

/** For maintenance mode: which running VMs on a host can leave while running, and why the others cannot. */
export function evacuationPlan(host: string, vms: Obj[], vmiIdx: Map<string, Obj>, base: Omit<PlacementInput, 'vm' | 'vmi'>): EvacuationRow[] {
  return vms
    .filter(vm => vmiIdx.get(key(vm))?.status?.nodeName === host)
    .map(vm => {
      const p = placement({ ...base, vm, vmi: vmiIdx.get(key(vm)) });
      const targets = p.hosts.filter(h => h.live.ok).map(h => h.host);
      const coldTargets = p.hosts.filter(h => h.cold.ok).map(h => h.host);
      if (targets.length) return { vm, live: true, targets, coldTargets };
      const why = !p.live.ok
        ? p.live.why
        : p.hosts
            .filter(h => !h.current)
            .map(h => `${h.host}: ${h.live.reasons[0]}`)
            .join('; ') || 'There is no other host';
      return { vm, live: false, why, targets, coldTargets };
    });
}

/* ------------------------------------------------- datastore reach */

export type Reach = 'shared' | 'network' | 'local';

/** How far a datastore's disks reach: every host at once, any host one at a time, or the host that made them. */
export function datastoreReach(ds: Pick<Datastore, 'shared' | 'provisioner'>): Reach {
  if (ds.shared) return 'shared';
  return storageKind(ds.provisioner).family === 'local' ? 'local' : 'network';
}

/** Plain words for a datastore's reach, for pickers and the Storage view. */
export function reachLabel(r: Reach, hosts: number): { short: string; long: string } {
  if (r === 'shared')
    return { short: 'Shared', long: hosts > 1 ? 'Shared — VMs can move between hosts while running' : 'Shared — VMs will move between hosts while running' };
  if (r === 'network') return { short: 'Network', long: 'Any host, one at a time — VMs move between hosts powered off' };
  return { short: 'Local', long: hosts > 1 ? 'Local to each host — a VM stays with the host of its disks' : 'Local to the host' };
}

/** The datastore to offer first: with more than one host a shared one (the default if it is shared), else the default. */
export function preferredDatastore<T extends Pick<Datastore, 'name' | 'shared' | 'isDefault' | 'provisioner'>>(ds: T[], hosts: number): T | undefined {
  const def = ds.find(x => x.isDefault);
  if (hosts > 1 && !(def && def.shared)) {
    const shared = ds.filter(x => x.shared);
    if (shared.length) return shared.find(x => x.isDefault) ?? shared[0];
  }
  return def ?? ds[0];
}
