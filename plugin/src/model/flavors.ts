/*
 * Flavors: VM sizes grouped in families (KubeVirt instancetypes) and the CPU
 * models the hosts can give a VM. Pure functions: the views and the wizard
 * read flavors, families, host requirements and portability verdicts here.
 */

import { Obj, VM } from './types';
import { parseQuantity, toQuantity } from './units';

/* -------------------------------------------------------------- labels */

export const L_CLASS = 'instancetype.kubevirt.io/class';
export const L_SIZE = 'instancetype.kubevirt.io/size';
export const A_DISPLAY = 'instancetype.kubevirt.io/displayName';
export const A_DESCRIPTION = 'instancetype.kubevirt.io/description';
/** Hangar's own flavors carry this label (value: the family id). */
export const L_FAMILY = 'hangar.magesgate.com/flavor-family';
/** Purpose preset the family was created from (balanced, cpu, memory…). */
export const A_PURPOSE = 'hangar.magesgate.com/flavor-purpose';
export const MANAGED_BY_KUBEVIRT = 'virt-operator';

export const KIND_CLUSTER = 'VirtualMachineClusterInstancetype';
export const KIND_NS = 'VirtualMachineInstancetype';

/* ------------------------------------------------------------ families */

export interface FamilyInfo {
  label: string;
  purpose: string;
  icon: string;
  order: number;
}

/** KubeVirt's common-instancetypes classes, in plain words. */
export const SHIPPED_FAMILIES: Record<string, FamilyInfo> = {
  'general.purpose': { label: 'Balanced', purpose: 'General purpose: 4 GiB per vCPU, shared CPUs. Most workloads.', icon: 'mdi:scale-balance', order: 1 },
  overcommitted: { label: 'Burstable', purpose: 'Memory overcommitted by the host: many light VMs on little memory.', icon: 'mdi:weather-windy', order: 2 },
  'compute.exclusive': { label: 'CPU intensive', purpose: 'Dedicated physical CPUs, NUMA and huge pages: steady compute.', icon: 'mdi:cpu-64-bit', order: 3 },
  'memory.intensive': { label: 'Memory intensive', purpose: '8 GiB per vCPU with huge pages: databases and caches.', icon: 'mdi:memory', order: 4 },
  network: { label: 'Network functions', purpose: 'Dedicated CPUs and huge pages for DPDK packet processing.', icon: 'mdi:lan', order: 5 },
  realtime: { label: 'Real time', purpose: 'Dedicated, isolated CPUs with real-time scheduling.', icon: 'mdi:timer-outline', order: 6 },
  'gpu.nvidia': { label: 'GPU', purpose: 'With an NVIDIA GPU.', icon: 'mdi:expansion-card', order: 7 },
};

/** Purposes offered when creating a family: they prefill its knobs. */
export interface Purpose {
  id: string;
  label: string;
  help: string;
  memPerVcpuGiB: number;
  dedicated?: boolean;
  overcommitPercent?: number;
  hugepages?: string;
  portable?: boolean;
}

export const PURPOSES: Purpose[] = [
  { id: 'balanced', label: 'Balanced', help: '4 GiB per vCPU, shared CPUs.', memPerVcpuGiB: 4 },
  { id: 'cpu', label: 'CPU intensive', help: '2 GiB per vCPU. Dedicated CPUs need the CPU manager on the hosts.', memPerVcpuGiB: 2 },
  { id: 'memory', label: 'Memory intensive', help: '8 GiB per vCPU.', memPerVcpuGiB: 8 },
  { id: 'burstable', label: 'Burstable', help: '4 GiB per vCPU, half of it overcommitted.', memPerVcpuGiB: 4, overcommitPercent: 50 },
  { id: 'portable', label: 'Portable', help: '4 GiB per vCPU with a CPU model every host has: moves between all hosts.', memPerVcpuGiB: 4, portable: true },
  { id: 'custom', label: 'Custom', help: 'Start from scratch.', memPerVcpuGiB: 4 },
];

/** KubeVirt's naming: the size tells the vCPUs. */
export const SIZE_LADDER: { size: string; vcpus: number }[] = [
  { size: 'small', vcpus: 1 },
  { size: 'medium', vcpus: 1 },
  { size: 'large', vcpus: 2 },
  { size: 'xlarge', vcpus: 4 },
  { size: '2xlarge', vcpus: 8 },
  { size: '4xlarge', vcpus: 16 },
  { size: '8xlarge', vcpus: 32 },
];

const SIZE_ORDER = ['nano', 'micro', 'small', 'medium', '2xmedium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge'];

export interface Flavor {
  name: string;
  kind: typeof KIND_CLUSTER | typeof KIND_NS;
  /** Set for folder flavors. */
  namespace?: string;
  family: string;
  familyLabel: string;
  size: string;
  vcpus: number;
  memBytes: number;
  cpuModel?: string;
  dedicated: boolean;
  isolateEmulatorThread: boolean;
  hugepages?: string;
  numa: boolean;
  realtime: boolean;
  overcommitPercent?: number;
  ioThreadsPolicy?: string;
  /** Device resource names (GPUs and host devices). */
  devices: string[];
  /** Made by Hangar (editable); KubeVirt's own are read-only. */
  ours: boolean;
  shipped: boolean;
  description?: string;
  obj: Obj;
}

function sizeOf(o: Obj): string {
  return o.metadata.labels?.[L_SIZE] ?? o.metadata.name.split('.').slice(1).join('.') ?? o.metadata.name;
}

export function familyId(o: Obj): string {
  return o.metadata.labels?.[L_FAMILY] ?? o.metadata.labels?.[L_CLASS] ?? o.metadata.name.split('.')[0];
}

export function flavorFrom(o: Obj): Flavor {
  const s = o.spec ?? {};
  const fam = familyId(o);
  const shipped = o.metadata.labels?.['app.kubernetes.io/managed-by'] === MANAGED_BY_KUBEVIRT;
  const display = o.metadata.annotations?.[A_DISPLAY];
  return {
    name: o.metadata.name,
    kind: o.metadata.namespace ? KIND_NS : KIND_CLUSTER,
    namespace: o.metadata.namespace,
    family: fam,
    familyLabel: SHIPPED_FAMILIES[fam]?.label ?? display ?? fam,
    size: sizeOf(o),
    vcpus: Number(s.cpu?.guest ?? 0),
    memBytes: parseQuantity(s.memory?.guest),
    cpuModel: s.cpu?.model || undefined,
    dedicated: !!s.cpu?.dedicatedCPUPlacement,
    isolateEmulatorThread: !!s.cpu?.isolateEmulatorThread,
    hugepages: s.memory?.hugepages?.pageSize,
    numa: !!s.cpu?.numa?.guestMappingPassthrough,
    realtime: !!s.cpu?.realtime,
    overcommitPercent: s.memory?.overcommitPercent || undefined,
    ioThreadsPolicy: s.ioThreadsPolicy,
    devices: [...(s.gpus ?? []), ...(s.hostDevices ?? [])].map((d: any) => d.deviceName).filter(Boolean),
    ours: !!o.metadata.labels?.[L_FAMILY],
    shipped,
    description: o.metadata.annotations?.[A_DESCRIPTION],
    obj: o,
  };
}

export interface Family {
  id: string;
  label: string;
  purpose: string;
  icon: string;
  ours: boolean;
  shipped: boolean;
  /** "" for cluster-wide, else the folder. */
  namespace: string;
  flavors: Flavor[];
}

function sizeRank(size: string): number {
  const i = SIZE_ORDER.indexOf(size.replace(/1gi$/, ''));
  return i < 0 ? 99 : i;
}

export function sortFlavors(a: Flavor, b: Flavor): number {
  return a.vcpus - b.vcpus || a.memBytes - b.memBytes || sizeRank(a.size) - sizeRank(b.size) || a.name.localeCompare(b.name);
}

/** Flavors grouped in families: KubeVirt's first, in their order, then Hangar's, then others. */
export function families(objs: Obj[]): Family[] {
  const map = new Map<string, Family>();
  for (const o of objs) {
    const f = flavorFrom(o);
    const id = `${f.namespace ?? ''}/${f.family}`;
    let fam = map.get(id);
    if (!fam) {
      const info = SHIPPED_FAMILIES[f.family];
      fam = {
        id: f.family,
        label: f.familyLabel,
        purpose: info?.purpose ?? (f.description?.split('\n')[0] || ''),
        icon: info?.icon ?? (f.cpuModel ? 'mdi:swap-horizontal' : 'mdi:shape-outline'),
        ours: f.ours,
        shipped: f.shipped,
        namespace: f.namespace ?? '',
        flavors: [],
      };
      map.set(id, fam);
    }
    fam.flavors.push(f);
  }
  const rank = (f: Family) => (SHIPPED_FAMILIES[f.id] && f.shipped ? SHIPPED_FAMILIES[f.id].order : f.ours ? 50 : 80);
  return [...map.values()]
    .map(f => ({ ...f, flavors: f.flavors.sort(sortFlavors) }))
    .sort((a, b) => rank(a) - rank(b) || a.namespace.localeCompare(b.namespace) || a.label.localeCompare(b.label));
}

/** The flavor a VM points to (spec.instancetype), if any. */
export function vmFlavorRef(vm: VM): { kind: string; name: string } | undefined {
  const it = vm.spec?.instancetype;
  return it?.name ? { kind: it.kind ?? KIND_CLUSTER, name: it.name } : undefined;
}

export function flavorMatches(f: Flavor, vm: VM): boolean {
  const ref = vmFlavorRef(vm);
  if (!ref || ref.name !== f.name) return false;
  if (f.kind === KIND_NS) return ref.kind === KIND_NS && vm.metadata.namespace === f.namespace;
  return ref.kind !== KIND_NS;
}

export function vmsUsing(f: Flavor, vms: VM[]): VM[] {
  return vms.filter(v => flavorMatches(f, v));
}

/** Find the flavor object a VM uses. */
export function flavorOfVm(vm: VM, objs: Obj[]): Obj | undefined {
  const ref = vmFlavorRef(vm);
  if (!ref) return undefined;
  return objs.find(o => o.metadata.name === ref.name && (ref.kind === KIND_NS ? o.metadata.namespace === vm.metadata.namespace : !o.metadata.namespace));
}

/* -------------------------------------------------- host requirements */

export interface Requirement {
  /** Hosts that satisfy it. */
  hosts: string[];
  what: string;
  /** A host setting (k4all sets it from its addon's node settings). */
  nodeSetting?: 'cpuManager' | 'hugepages';
}

function hostNames(nodes: Obj[]): string[] {
  return nodes.map(n => n.metadata.name);
}

/** What a flavor needs from a host, with the hosts that have it. */
export function flavorRequirements(f: Flavor, nodes: Obj[]): Requirement[] {
  const out: Requirement[] = [];
  if (f.dedicated || f.realtime || f.numa) {
    out.push({
      what: 'Dedicated CPUs (the kubelet\'s CPU manager, static policy)',
      hosts: nodes.filter(n => n.metadata.labels?.cpumanager === 'true').map(n => n.metadata.name),
      nodeSetting: 'cpuManager',
    });
  }
  if (f.hugepages) {
    const key = `hugepages-${f.hugepages}`;
    out.push({
      what: `Huge pages of ${f.hugepages}`,
      hosts: nodes.filter(n => parseQuantity(n.status?.allocatable?.[key] ?? '0') >= f.memBytes).map(n => n.metadata.name),
      nodeSetting: 'hugepages',
    });
  }
  if (f.cpuModel && !['host-model', 'host-passthrough'].includes(f.cpuModel)) {
    out.push({ what: `CPU model ${f.cpuModel}`, hosts: nodes.filter(n => n.metadata.labels?.[L_MODEL + f.cpuModel] === 'true').map(n => n.metadata.name) });
  }
  for (const dev of f.devices) {
    out.push({ what: `Device ${dev}`, hosts: nodes.filter(n => parseQuantity(n.status?.allocatable?.[dev] ?? '0') > 0).map(n => n.metadata.name) });
  }
  return out;
}

/**
 * The host settings among these requirements, in words ("the static CPU
 * manager and huge pages"), or null: on k4all they are set from its addon's
 * node settings.
 */
export function nodeSettingsWords(reqs: Requirement[]): string | null {
  const words = { cpuManager: 'the static CPU manager', hugepages: 'huge pages' } as const;
  const kinds = [...new Set(reqs.map(r => r.nodeSetting).filter((x): x is 'cpuManager' | 'hugepages' => !!x))];
  return kinds.length ? kinds.map(k => words[k]).join(' and ') : null;
}

/** Hosts where every requirement holds. */
export function flavorHosts(f: Flavor, nodes: Obj[]): string[] {
  let hosts = hostNames(nodes);
  for (const r of flavorRequirements(f, nodes)) hosts = hosts.filter(h => r.hosts.includes(h));
  return hosts;
}

/* -------------------------------------------- building flavor objects */

export interface FlavorDef {
  name: string;
  /** Cluster-wide when empty. */
  namespace?: string;
  familyId: string;
  familyLabel: string;
  description?: string;
  purpose?: string;
  size: string;
  vcpus: number;
  memBytes: number;
  cpuModel?: string;
  dedicated?: boolean;
  isolateEmulatorThread?: boolean;
  hugepages?: string;
  numa?: boolean;
  overcommitPercent?: number;
  ioThreadsPolicy?: string;
  gpu?: string;
}

/** Families Hangar must not reuse: KubeVirt's own prefixes. */
export const RESERVED_PREFIXES = ['u1', 'o1', 'cx1', 'm1', 'n1', 'rt1', 'gn1', 'd1'];

export function familyIdProblem(id: string, existing: string[] = []): string | null {
  if (!id) return 'Give the family a short id, e.g. bal or db.';
  if (!/^[a-z][a-z0-9-]{0,9}$/.test(id)) return 'Lowercase letters, digits and dashes, 10 characters at most, starting with a letter.';
  if (RESERVED_PREFIXES.includes(id)) return `${id} is KubeVirt's own family: pick another id.`;
  if (existing.includes(id)) return `A family ${id} already exists.`;
  return null;
}

export function buildFlavor(def: FlavorDef): Obj {
  const cpu: any = { guest: def.vcpus };
  if (def.cpuModel) cpu.model = def.cpuModel;
  if (def.dedicated) {
    cpu.dedicatedCPUPlacement = true;
    if (def.isolateEmulatorThread) cpu.isolateEmulatorThread = true;
  }
  if (def.numa) cpu.numa = { guestMappingPassthrough: {} };
  const memory: any = { guest: toQuantity(def.memBytes) };
  if (def.hugepages) memory.hugepages = { pageSize: def.hugepages };
  if (def.overcommitPercent && def.overcommitPercent > 0) memory.overcommitPercent = Math.min(100, Math.round(def.overcommitPercent));
  const spec: any = { cpu, memory };
  if (def.ioThreadsPolicy) spec.ioThreadsPolicy = def.ioThreadsPolicy;
  if (def.gpu) spec.gpus = [{ name: 'gpu1', deviceName: def.gpu }];
  const annotations: Record<string, string> = { [A_DISPLAY]: def.familyLabel };
  if (def.description) annotations[A_DESCRIPTION] = def.description;
  if (def.purpose) annotations[A_PURPOSE] = def.purpose;
  return {
    apiVersion: 'instancetype.kubevirt.io/v1beta1',
    kind: def.namespace ? KIND_NS : KIND_CLUSTER,
    metadata: {
      name: def.name,
      ...(def.namespace ? { namespace: def.namespace } : {}),
      labels: { [L_FAMILY]: def.familyId, [L_CLASS]: def.familyId, [L_SIZE]: def.size },
      annotations,
    },
    spec,
  };
}

/** The sizes of a new family, KubeVirt's naming (medium = 1 vCPU, large = 2…). */
export function familyLadder(
  base: Omit<FlavorDef, 'name' | 'size' | 'vcpus' | 'memBytes'>,
  memPerVcpuBytes: number,
  sizes: string[]
): FlavorDef[] {
  return SIZE_LADDER.filter(s => sizes.includes(s.size)).map(s => ({
    ...base,
    name: `${base.familyId}.${s.size}`,
    size: s.size,
    vcpus: s.vcpus,
    // small: half the memory of medium
    memBytes: s.size === 'small' ? memPerVcpuBytes / 2 : memPerVcpuBytes * s.vcpus,
  }));
}

/** The same flavor with new values, keeping what Hangar does not edit. */
export function updatedFlavor(obj: Obj, def: FlavorDef): Obj {
  const built = buildFlavor(def);
  const out = JSON.parse(JSON.stringify(obj));
  out.metadata.labels = { ...(out.metadata.labels ?? {}), ...built.metadata.labels };
  out.metadata.annotations = { ...(out.metadata.annotations ?? {}), ...built.metadata.annotations };
  const spec = { ...(out.spec ?? {}) };
  spec.cpu = built.spec.cpu;
  spec.memory = built.spec.memory;
  if (built.spec.ioThreadsPolicy) spec.ioThreadsPolicy = built.spec.ioThreadsPolicy;
  else delete spec.ioThreadsPolicy;
  if (built.spec.gpus) spec.gpus = built.spec.gpus;
  else delete spec.gpus;
  out.spec = spec;
  return out;
}

export function defFromFlavor(f: Flavor): FlavorDef {
  return {
    name: f.name,
    namespace: f.namespace,
    familyId: f.family,
    familyLabel: f.familyLabel,
    description: f.description,
    size: f.size,
    vcpus: f.vcpus,
    memBytes: f.memBytes,
    cpuModel: f.cpuModel,
    dedicated: f.dedicated,
    isolateEmulatorThread: f.isolateEmulatorThread,
    hugepages: f.hugepages,
    numa: f.numa,
    overcommitPercent: f.overcommitPercent,
    ioThreadsPolicy: f.ioThreadsPolicy,
    gpu: f.devices[0],
  };
}

/* ------------------------------------------------------- VM edits */

function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

/** Size a VM with a flavor (cluster-wide or of its folder). */
export function setFlavor(vm: VM, ref: { kind: string; name: string }): VM {
  const out = clone(vm);
  out.spec = out.spec ?? {};
  const t = (out.spec.template ??= {}).spec ?? (out.spec.template.spec = {});
  out.spec.instancetype = { kind: ref.kind, name: ref.name };
  const cpu = t.domain?.cpu;
  if (cpu) {
    delete cpu.sockets;
    delete cpu.cores;
    delete cpu.threads;
    if (!Object.keys(cpu).length) delete t.domain.cpu;
  }
  if (t.domain?.memory) {
    delete t.domain.memory.guest;
    if (!Object.keys(t.domain.memory).length) delete t.domain.memory;
  }
  return out;
}

/** The VM's own CPU model; '' clears it (the flavor's or the cluster default applies). */
export function setCpuModel(vm: VM, model: string): VM {
  const out = clone(vm);
  out.spec = out.spec ?? {};
  const t = (out.spec.template ??= {}).spec ?? (out.spec.template.spec = {});
  t.domain = t.domain ?? {};
  if (model) t.domain.cpu = { ...(t.domain.cpu ?? {}), model };
  else if (t.domain.cpu) {
    delete t.domain.cpu.model;
    if (!Object.keys(t.domain.cpu).length) delete t.domain.cpu;
  }
  return out;
}

/* ------------------------------------------------------- CPU models */

export const L_MODEL = 'cpu-model.node.kubevirt.io/';
export const L_VENDOR = 'cpu-vendor.node.kubevirt.io/';
export const L_HOST_MODEL = 'host-model-cpu.node.kubevirt.io/';

export interface HostCpu {
  host: string;
  vendor?: string;
  hostModel?: string;
  models: Set<string>;
}

function suffixes(node: Obj, prefix: string): string[] {
  return Object.entries(node.metadata.labels ?? {})
    .filter(([k, v]) => k.startsWith(prefix) && v === 'true')
    .map(([k]) => k.slice(prefix.length));
}

export function hostCpus(nodes: Obj[]): HostCpu[] {
  return nodes
    .map(n => ({ host: n.metadata.name, vendor: suffixes(n, L_VENDOR)[0], hostModel: suffixes(n, L_HOST_MODEL)[0], models: new Set(suffixes(n, L_MODEL)) }))
    .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

/** Generations: higher is newer (more instructions). Used to pick the best common model. */
const GENERATIONS: [RegExp, number, string][] = [
  [/^GraniteRapids/, 13, 'AVX-512, AMX'],
  [/^SapphireRapids/, 12, 'AVX-512, AMX'],
  [/^Icelake/, 11, 'AVX-512'],
  [/^Cooperlake/, 10.5, 'AVX-512'],
  [/^Cascadelake/, 10, 'AVX-512'],
  [/^Skylake-Server/, 9.5, 'AVX-512'],
  [/^SierraForest/, 9.2, 'AVX2, AVX-VNNI'],
  [/^Skylake-Client/, 9, 'AVX2'],
  [/^Broadwell/, 8, 'AVX2'],
  [/^Haswell/, 7, 'AVX2, FMA'],
  [/^Snowridge/, 6.5, 'SSE4.2, AES'],
  [/^IvyBridge/, 6, 'AVX'],
  [/^SandyBridge/, 5, 'AVX'],
  [/^Westmere/, 4, 'AES-NI'],
  [/^Denverton/, 4, 'SSE4.2, AES'],
  [/^Nehalem/, 3, 'SSE4.2'],
  [/^Penryn/, 2, 'SSE4.1'],
  [/^Conroe/, 1, 'SSSE3'],
  [/^EPYC-Turin/, 13, 'AVX-512'],
  [/^EPYC-Genoa/, 12, 'AVX-512'],
  [/^EPYC-Milan/, 10, 'AVX2'],
  [/^EPYC-Rome/, 9, 'AVX2'],
  [/^EPYC/, 8, 'AVX2'],
  [/^Dhyana/, 8, 'AVX2'],
  [/^Opteron_G5/, 5.5, 'AVX, FMA'],
  [/^Opteron_G4/, 5, 'AVX'],
  [/^Opteron_G3/, 2, 'SSE4a'],
  [/^Opteron_G2/, 1.5, 'SSE3'],
  [/^Opteron_G1/, 1, 'SSE2'],
  [/^x86-64-v4/, 10, 'AVX-512'],
  [/^x86-64-v3/, 7, 'AVX2'],
  [/^x86-64-v2/, 3, 'SSE4.2'],
];

export function modelGeneration(model: string): { rank: number; isa?: string } {
  const g = GENERATIONS.find(([re]) => re.test(model));
  return g ? { rank: g[1], isa: g[2] } : { rank: 0 };
}

export function modelVendor(model: string): 'Intel' | 'AMD' | 'Hygon' | 'Generic' {
  if (/^(EPYC|Opteron)/.test(model)) return 'AMD';
  if (/^Dhyana/.test(model)) return 'Hygon';
  if (/^(x86-64|qemu|kvm)/.test(model)) return 'Generic';
  return 'Intel';
}

/** Variants (-v1, -IBRS…) rank a hair below the plain name, so the plain name wins ties. */
function modelScore(model: string): number {
  const { rank } = modelGeneration(model);
  const plain = !/-(v\d+|IBRS|IBPB|noTSX|noTSX-IBRS)$/.test(model) && !/-noTSX/.test(model);
  return rank + (plain ? 0.01 : 0);
}

export interface ModelRow {
  model: string;
  vendor: string;
  isa?: string;
  rank: number;
  /** Hosts that offer it. */
  hosts: string[];
  /** Every host offers it. */
  everywhere: boolean;
}

export function modelMatrix(cpus: HostCpu[]): ModelRow[] {
  const all = new Set<string>();
  cpus.forEach(c => c.models.forEach(m => all.add(m)));
  return [...all]
    .map(model => {
      const hosts = cpus.filter(c => c.models.has(model)).map(c => c.host);
      const g = modelGeneration(model);
      return { model, vendor: modelVendor(model), isa: g.isa, rank: g.rank, hosts, everywhere: cpus.length > 0 && hosts.length === cpus.length };
    })
    .sort((a, b) => Number(b.everywhere) - Number(a.everywhere) || b.rank - a.rank || a.model.localeCompare(b.model));
}

/** The newest model every listed host offers (plain names preferred). */
export function bestCommonModel(cpus: HostCpu[]): string | undefined {
  if (!cpus.length) return undefined;
  const common = [...cpus[0].models].filter(m => cpus.every(c => c.models.has(m)));
  const version = (m: string) => Number(/-v(\d+)$/.exec(m)?.[1] ?? 0);
  return common.sort((a, b) => modelScore(b) - modelScore(a) || version(b) - version(a) || a.length - b.length)[0];
}

export function vendors(cpus: HostCpu[]): string[] {
  return [...new Set(cpus.map(c => c.vendor ?? 'Unknown'))].sort();
}

/**
 * Whether a running VM with a named CPU model may move live between hosts
 * of different makers. KubeVirt allows it when both hosts offer the model.
 * Verified on a mixed test cluster (KubeVirt 1.7): a Fedora VM with
 * SandyBridge moved live Intel → AMD → Intel and kept running (uptime,
 * AES-NI). QEMU does not officially support it and the guest keeps the CPU
 * maker it booted with, so Hangar allows it and says so.
 * On 2026-11-23 one Fedora 45 VM booted on AMD (SandyBridge) froze after a
 * live move to Intel (a CPU hot-add move): vCPUs idle, guest agent silent.
 * Four more AMD → Intel moves (plain, hot-add, with the same devices, with
 * VSOCK) kept running, so the verdict stays; the hot-add dialog still warns.
 */
export const CROSS_VENDOR_LIVE = true;

export type CpuChoice = '' | 'host-model' | 'host-passthrough' | string;

export interface CpuVerdict {
  /** What the guest gets, in words. */
  title: string;
  /** Hosts it can start on. */
  runsOn: string[];
  /** Where it can move while running. */
  live: 'all' | 'vendor' | 'same-cpu' | 'none';
  text: string;
  tone: 'good' | 'ok' | 'warn' | 'bad';
}

/** The model a VM ends up with: its own, its flavor's, the cluster default, or host-model. */
export function effectiveCpuModel(vmModel: string | undefined, flavorModel: string | undefined, clusterDefault: string | undefined): string {
  return vmModel || flavorModel || clusterDefault || 'host-model';
}

export function cpuVerdict(model: string, cpus: HostCpu[]): CpuVerdict {
  const all = cpus.map(c => c.host);
  const vs = vendors(cpus);
  const mixed = vs.length > 1;
  if (!model || model === 'host-model') {
    return {
      title: 'Host model',
      runsOn: all,
      live: mixed ? 'vendor' : 'all',
      text: mixed
        ? 'Starts on any host with a CPU like that host\'s. Moves while running only to hosts of the same maker and generation (or newer).'
        : 'Starts on any host. Moves while running to hosts with the same or a newer CPU.',
      tone: mixed ? 'ok' : 'good',
    };
  }
  if (model === 'host-passthrough') {
    return {
      title: 'Host passthrough',
      runsOn: all,
      live: 'same-cpu',
      text: 'The host\'s exact CPU: fastest, but it moves while running only between identical hosts.',
      tone: 'warn',
    };
  }
  const runsOn = cpus.filter(c => c.models.has(model)).map(c => c.host);
  if (!runsOn.length) return { title: model, runsOn, live: 'none', text: `No host offers ${model}: the VM would not start.`, tone: 'bad' };
  const runVendors = new Set(cpus.filter(c => c.models.has(model)).map(c => c.vendor));
  const everywhere = runsOn.length === all.length;
  const makers = [...runVendors].map(v => v ?? 'unknown maker').sort().join(' and ');
  if (runVendors.size > 1 && CROSS_VENDOR_LIVE) {
    return {
      title: model,
      runsOn,
      live: 'all',
      text: `${everywhere ? 'Starts and moves while running on every host' : `Starts and moves while running on ${runsOn.length} of ${all.length} hosts`}, ${makers}. Between makers the guest keeps the CPU maker it booted with, and QEMU does not officially support the move: try it with your guests before relying on it.`,
      tone: 'ok',
    };
  }
  if (runVendors.size > 1) {
    return {
      title: model,
      runsOn,
      live: 'vendor',
      text: `${everywhere ? 'Starts on every host' : `Starts on ${runsOn.length} of ${all.length} hosts`}, ${makers}. Moves while running between hosts of the same maker; between makers it moves powered off.`,
      tone: everywhere ? 'good' : 'ok',
    };
  }
  return {
    title: model,
    runsOn,
    live: 'all',
    text: everywhere ? 'Starts and moves while running on every host.' : `Starts and moves while running on ${runsOn.length} of ${all.length} hosts (${runsOn.join(', ')}).`,
    tone: everywhere ? 'good' : 'ok',
  };
}

export interface CpuPreset {
  id: string;
  label: string;
  model: string;
  help: string;
}

/** Ready-made choices: portable everywhere, portable per maker, host model, host passthrough. */
export function cpuPresets(cpus: HostCpu[]): CpuPreset[] {
  const out: CpuPreset[] = [];
  const all = bestCommonModel(cpus);
  const vs = vendors(cpus);
  if (all) out.push({ id: 'portable', label: vs.length > 1 ? 'Portable — every host' : 'Portable', model: all, help: `${all}: the newest model all ${cpus.length} hosts have.` });
  if (vs.length > 1) {
    for (const v of vs) {
      const hosts = cpus.filter(c => (c.vendor ?? 'Unknown') === v);
      const best = bestCommonModel(hosts);
      if (best && best !== all)
        out.push({
          id: `portable-${v}`,
          label: `Portable — ${v} hosts`,
          model: best,
          help: hosts.length === 1 ? `${best}: the newest model the ${v} host has.` : `${best}: the newest model the ${hosts.length} ${v} hosts have.`,
        });
    }
  }
  out.push({ id: 'host-model', label: 'Host model', model: 'host-model', help: 'A copy of the starting host\'s CPU. KubeVirt\'s default.' });
  out.push({ id: 'host-passthrough', label: 'Host passthrough', model: 'host-passthrough', help: 'The host\'s exact CPU, every feature. Fastest, least mobile.' });
  return out;
}
