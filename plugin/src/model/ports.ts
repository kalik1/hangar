/*
 * Published ports: a VM's ports reachable inside the cluster (ClusterIP),
 * on every host's port (NodePort) or on an address of its own
 * (LoadBalancer), through Kubernetes Services that select the VM's
 * virt-launcher pod. Pure logic: which adapter can publish, the
 * masquerade/passt `ports` list, the Service Hangar writes, the address
 * pools (MetalLB, Cilium LB IPAM) and the live state of each published port.
 *
 * The selector (KubeVirt v1.9.1, checked in its source):
 * - `vmi.kubevirt.io/id` is set on every virt-launcher pod
 *   (pkg/virt-controller/services/template.go:1739), "a stable and unique
 *   identifier for a VMI, suitable for use in service selectors"
 *   (staging/src/kubevirt.io/api/core/v1/types.go:1385-1389): the VMI name,
 *   or for names over 63 characters its first 54, "-" and 8 hex of its SHA-1
 *   (pkg/apimachinery/labels.go:31-48). `virtctl expose` selects on it
 *   (pkg/virtctl/expose/expose.go:164,183). It exists from KubeVirt v1.7.
 * - `vm.kubevirt.io/name` is deprecated and holds the pod's hostname
 *   (template.go:1738), which is `spec.hostname` when the VM sets one
 *   (pkg/util/net/dns/sanitize.go:33-44): not the VM's name in every case.
 * - `kubevirt.io/domain` is a pod annotation (template.go:1545), not a label.
 * Before v1.7 Hangar falls back to its own template label, which reaches
 * the pod at the VM's next start.
 */

import { parseIp } from './podnet';
import { Obj, VM, VMI, VMInterface } from './types';

export const L_MANAGED_BY = 'app.kubernetes.io/managed-by';
export const L_VM = 'hangar.magesgate.com/vm';
/** How a Hangar Service publishes: cluster, host or address. */
export const L_PUBLISH = 'hangar.magesgate.com/publish';
export const ID_LABEL = 'vmi.kubevirt.io/id';
/** k4all's MetalLB pool for its ingress's dedicated address: never for VMs. */
export const INGRESS_POOL = 'k4all-ingress-pool';
/** At most this many ports in one change (a range is one entry per port). */
export const RANGE_LIMIT = 100;
export const NODEPORT_MIN = 30000;
export const NODEPORT_MAX = 32767;
/** Cilium's load balancer class for L2 announcements: MetalLB leaves such Services alone. */
export const CILIUM_L2_CLASS = 'io.cilium/l2-announcer';
export const A_METALLB_POOL = 'metallb.io/address-pool';
export const A_METALLB_IPS = 'metallb.io/loadBalancerIPs';
export const A_METALLB_FROM = 'metallb.io/ip-allocated-from-pool';
export const A_CILIUM_IPS = 'lbipam.cilium.io/ips';
export const CILIUM_SATISFIED = 'cilium.io/IPAMRequestSatisfied';

export type Mode = 'cluster' | 'host' | 'address';
export type Proto = 'TCP' | 'UDP';

export const MODES: { mode: Mode; type: string; suffix: string; label: string; short: string }[] = [
  { mode: 'cluster', type: 'ClusterIP', suffix: 'cluster', label: 'Inside the cluster', short: 'Cluster' },
  { mode: 'host', type: 'NodePort', suffix: 'nodeport', label: "On every host's port", short: 'Host port' },
  { mode: 'address', type: 'LoadBalancer', suffix: 'lb', label: 'On an address of its own', short: 'Own address' },
];

export const modeInfo = (m: Mode) => MODES.find(x => x.mode === m)!;

export function modeOfService(svc: Obj): Mode | null {
  switch (svc.spec?.type ?? 'ClusterIP') {
    case 'ClusterIP':
      return 'cluster';
    case 'NodePort':
      return 'host';
    case 'LoadBalancer':
      return 'address';
    default:
      return null;
  }
}

/* -------------------------------------------------------------- SHA-1 */

/** SHA-1 of a string (UTF-8), hex. Synchronous: crypto.subtle needs https and is async. */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const len = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(len);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(len - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(len - 4, bits >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = tmp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('');
}

/** KubeVirt's CalculateVirtualMachineInstanceID (pkg/apimachinery/labels.go). */
export function instanceId(vmiName: string): string {
  if (vmiName.length <= 63) return vmiName;
  return `${vmiName.slice(0, 54)}-${sha1Hex(vmiName).slice(0, 8)}`;
}

/* ----------------------------------------------------------- selector */

/** The KubeVirt version from its CR ("v1.9.1" → [1, 9]); null when unknown. */
export function kubevirtMinor(kubevirt: Obj | null | undefined): [number, number] | null {
  const v = String(kubevirt?.status?.observedKubeVirtVersion ?? kubevirt?.status?.operatorVersion ?? '');
  const m = v.match(/^v?(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export interface VmSelector {
  selector: Record<string, string>;
  /** Hangar's own template label: it reaches the pod at the VM's next start. */
  viaTemplate: boolean;
}

/** What a Service selects to reach the VM's pod. An unknown version counts as recent. */
export function vmSelector(vm: VM, kubevirt: Obj | null | undefined): VmSelector {
  const v = kubevirtMinor(kubevirt);
  if (v && (v[0] < 1 || (v[0] === 1 && v[1] < 7))) return { selector: { [L_VM]: vm.metadata.name }, viaTemplate: true };
  return { selector: { [ID_LABEL]: instanceId(vm.metadata.name) }, viaTemplate: false };
}

/** The template label of the fallback selector is missing from the VM. */
export function needsTemplateLabel(vm: VM, sel: VmSelector): boolean {
  return sel.viaTemplate && vm.spec?.template?.metadata?.labels?.[L_VM] !== vm.metadata.name;
}

export function withTemplateLabel(vm: VM): VM {
  const next: VM = JSON.parse(JSON.stringify(vm));
  next.spec.template.metadata = next.spec.template.metadata ?? {};
  next.spec.template.metadata.labels = { ...(next.spec.template.metadata.labels ?? {}), [L_VM]: vm.metadata.name };
  return next;
}

/**
 * The labels the VM's pod has: the running launcher's, else what KubeVirt
 * will set (the template's labels, then its own).
 */
export function podLabels(vm: VM, launcher?: Obj | null): Record<string, string> {
  if (launcher?.metadata?.labels) return launcher.metadata.labels;
  const name = vm.metadata.name;
  const host = vm.spec?.template?.spec?.hostname || name.split('.')[0].slice(0, 63);
  return {
    ...(vm.spec?.template?.metadata?.labels ?? {}),
    'kubevirt.io': 'virt-launcher',
    'vm.kubevirt.io/name': host,
    [ID_LABEL]: instanceId(name),
  };
}

type Expr = { key: string; operator: string; values?: string[] };

/** A Kubernetes label selector ({matchLabels, matchExpressions}) against labels; an empty selector matches all. */
export function selectorMatches(sel: { matchLabels?: Record<string, string>; matchExpressions?: Expr[] } | null | undefined, labels: Record<string, string>): boolean {
  if (!sel) return true;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    const vals = e.values ?? [];
    switch (e.operator) {
      case 'In':
        if (!has || !vals.includes(labels[e.key])) return false;
        break;
      case 'NotIn':
        if (has && vals.includes(labels[e.key])) return false;
        break;
      case 'Exists':
        if (!has) return false;
        break;
      case 'DoesNotExist':
        if (has) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** A Service's plain selector picks these pod labels (an empty selector picks no pod). */
export function serviceSelects(svc: Obj, labels: Record<string, string>): boolean {
  const sel: Record<string, string> = svc.spec?.selector ?? {};
  const keys = Object.keys(sel);
  return keys.length > 0 && keys.every(k => labels[k] === sel[k]);
}

export function isHangarService(svc: Obj, vmName?: string): boolean {
  const l = svc.metadata.labels ?? {};
  return l[L_MANAGED_BY] === 'hangar' && !!l[L_VM] && (vmName === undefined || l[L_VM] === vmName);
}

/** The Services that reach a VM: Hangar's for it, and others whose selector picks its pod (shown read-only). */
export function vmServices(services: Obj[], vm: VM, launcher?: Obj | null): Obj[] {
  const labels = podLabels(vm, launcher);
  return services.filter(
    s =>
      s.metadata.namespace === vm.metadata.namespace &&
      modeOfService(s) !== null &&
      (isHangarService(s, vm.metadata.name) || (!isHangarService(s) && serviceSelects(s, labels)))
  );
}

/* ------------------------------------------------------ the adapter */

export type Binding = 'masquerade' | 'passt' | 'bridge' | 'sriov' | 'plugin';

export function bindingOf(i: VMInterface & Record<string, any>, kubevirt?: Obj | null): Binding {
  if (i.masquerade) return 'masquerade';
  if (i.passtBinding || i.passt || i.binding?.name === 'passt') return 'passt';
  if (i.bridge) return 'bridge';
  if (i.sriov) return 'sriov';
  if (i.binding) return 'plugin';
  // No binding written: KubeVirt applies its default (bridge unless the KubeVirt CR says otherwise).
  const def = kubevirt?.spec?.configuration?.network?.defaultNetworkInterface;
  return def === 'masquerade' ? 'masquerade' : def === 'passt' ? 'passt' : 'bridge';
}

export type PortsList =
  | { kind: 'all' }
  | { kind: 'ports'; ports: { name?: string; port: number; protocol?: string }[] }
  | { kind: 'ranges'; ranges: { protocol: string; start: number; end: number }[] };

export function portsListOf(i: Record<string, any> | undefined): PortsList {
  if (i?.ports?.length) return { kind: 'ports', ports: i.ports };
  if (i?.portRanges?.length) return { kind: 'ranges', ranges: i.portRanges };
  return { kind: 'all' };
}

export interface SecondaryAddress {
  nic: string;
  network: string;
  ips: string[];
}

export interface PublishAccess {
  /**
   * ok: a pod-network adapter with masquerade or passt; pod-bridge: the pod
   * adapter uses bridge (or another binding); secondary-only: only Multus
   * adapters; none: no adapter.
   */
  state: 'ok' | 'pod-bridge' | 'secondary-only' | 'none';
  /** The pod-network adapter. */
  nic?: string;
  binding?: Binding;
  list: PortsList;
  /** Addresses on secondary networks (bridge, OVS, SR-IOV): reachable directly. */
  secondary: SecondaryAddress[];
  /** The guest has an IPv6 address on the pod network. */
  ipv6: boolean;
}

const notLinkLocal = (ip: string) => !ip.toLowerCase().startsWith('fe80');

/** Whether the VM can publish ports, through which adapter, and where else it answers. */
export function publishAccess(vm: VM, vmi?: VMI | null, kubevirt?: Obj | null): PublishAccess {
  const vmSpec = vm.spec?.template?.spec ?? {};
  // The running instance has KubeVirt's defaults filled in (an auto-attached pod adapter, the default binding).
  const ifaces: any[] = vmSpec.domain?.devices?.interfaces?.length ? vmSpec.domain.devices.interfaces : vmi?.spec?.domain?.devices?.interfaces ?? [];
  const nets: any[] = vmSpec.networks?.length ? vmSpec.networks : vmi?.spec?.networks ?? [];
  const live: any[] = vmi?.status?.interfaces ?? [];
  const runIface = (name: string) => (vmi?.spec?.domain?.devices?.interfaces ?? []).find((x: any) => x.name === name);
  const secondary: SecondaryAddress[] = [];
  let pod: { nic: string; binding: Binding; list: PortsList } | undefined;
  for (const i of ifaces) {
    const n = nets.find(x => x.name === i.name);
    if (!n) continue;
    if (n.pod) {
      pod = { nic: i.name, binding: bindingOf({ ...(runIface(i.name) ?? {}), ...i }, kubevirt), list: portsListOf(i) };
    } else if (n.multus) {
      const st = live.find(s => s.name === i.name);
      const ips: string[] = (st?.ipAddresses ?? (st?.ipAddress ? [st.ipAddress] : [])).filter(notLinkLocal);
      secondary.push({ nic: i.name, network: n.multus.networkName, ips });
    }
  }
  // No adapter written at all: KubeVirt attaches one to the pod network, named "default", unless told not to.
  if (!ifaces.length && !nets.length && vmSpec.domain?.devices?.autoattachPodInterface !== false)
    pod = { nic: 'default', binding: bindingOf({ name: 'default' }, kubevirt), list: { kind: 'all' } };
  const podLive = pod ? live.find(s => s.name === pod!.nic) : undefined;
  const ipv6 = ((podLive?.ipAddresses ?? []) as string[]).some(ip => ip.includes(':') && notLinkLocal(ip));
  if (pod && (pod.binding === 'masquerade' || pod.binding === 'passt'))
    return { state: 'ok', nic: pod.nic, binding: pod.binding, list: pod.list, secondary, ipv6 };
  if (pod) return { state: 'pod-bridge', nic: pod.nic, binding: pod.binding, list: { kind: 'all' }, secondary, ipv6 };
  return { state: secondary.length ? 'secondary-only' : 'none', list: { kind: 'all' }, secondary, ipv6 };
}

/** Why the VM cannot publish, in words; null when it can. */
export function accessProblem(a: PublishAccess): string | null {
  switch (a.state) {
    case 'ok':
      return null;
    case 'pod-bridge':
      return a.binding === 'bridge'
        ? `${a.nic} joins the pod network as a bridge: the pod has no address of its own for a Service to reach (and the VM cannot move live). Ports can be published from a NAT (masquerade) or passt adapter.`
        : `${a.nic} joins the pod network through the ${a.binding === 'sriov' ? 'SR-IOV' : 'binding plugin'} binding: Services reach NAT (masquerade) and passt adapters only.`;
    case 'secondary-only':
      return 'The VM is only on its own networks: Services do not reach those adapters, and the VM has its own address there instead.';
    default:
      return 'The VM has no network adapter.';
  }
}

export interface PortSpec {
  port: number;
  protocol: Proto;
}

const covered = (list: PortsList, p: PortSpec) =>
  list.kind === 'all' ||
  (list.kind === 'ports'
    ? list.ports.some(x => x.port === p.port && (x.protocol ?? 'TCP').toUpperCase() === p.protocol)
    : list.ranges.some(r => r.protocol.toUpperCase() === p.protocol && r.start <= p.port && p.port <= r.end));

/** The guest ports the adapter's list does not forward yet ([] when it forwards everything). */
export function missingFromList(list: PortsList, wants: PortSpec[]): PortSpec[] {
  const out: PortSpec[] = [];
  for (const p of wants) if (!covered(list, p) && !out.some(x => x.port === p.port && x.protocol === p.protocol)) out.push(p);
  return out;
}

/**
 * The VM with these guest ports added to its pod adapter's list (`ports`,
 * or `portRanges` when the adapter uses those; the two are exclusive).
 * Applied at the next restart.
 */
export function withListedPorts(vm: VM, nic: string, add: PortSpec[]): VM {
  const next: VM = JSON.parse(JSON.stringify(vm));
  const i = (next.spec?.template?.spec?.domain?.devices?.interfaces ?? []).find((x: any) => x.name === nic);
  if (!i || !add.length) return next;
  if (i.portRanges?.length && !i.ports?.length) {
    i.portRanges = [...i.portRanges, ...compress(add)];
  } else {
    // No names: they would become the pod's container port names, unique per pod.
    i.ports = [...(i.ports ?? []), ...add.map(p => ({ port: p.port, protocol: p.protocol }))];
  }
  return next;
}

/** Consecutive ports of one protocol as ranges. */
function compress(ports: PortSpec[]): { protocol: Proto; start: number; end: number }[] {
  const out: { protocol: Proto; start: number; end: number }[] = [];
  for (const p of [...ports].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.port - b.port)) {
    const last = out[out.length - 1];
    if (last && last.protocol === p.protocol && last.end + 1 === p.port) last.end = p.port;
    else out.push({ protocol: p.protocol, start: p.port, end: p.port });
  }
  return out;
}

/* ------------------------------------------------------------ choosing */

export interface Preset {
  id: string;
  label: string;
  ports: { port: number; name: string }[];
  /** Offered first for this kind of guest. */
  os?: 'linux' | 'windows';
}

export const PRESETS: Preset[] = [
  { id: 'ssh', label: 'SSH', ports: [{ port: 22, name: 'ssh' }], os: 'linux' },
  { id: 'rdp', label: 'RDP', ports: [{ port: 3389, name: 'rdp' }], os: 'windows' },
  { id: 'http', label: 'HTTP', ports: [{ port: 80, name: 'http' }] },
  { id: 'https', label: 'HTTPS', ports: [{ port: 443, name: 'https' }] },
  { id: 'vnc', label: 'VNC', ports: [{ port: 5900, name: 'vnc' }] },
  {
    id: 'winrm',
    label: 'WinRM',
    ports: [
      { port: 5985, name: 'winrm-http' },
      { port: 5986, name: 'winrm-https' },
    ],
    os: 'windows',
  },
  { id: 'postgresql', label: 'PostgreSQL', ports: [{ port: 5432, name: 'postgresql' }] },
  { id: 'mysql', label: 'MySQL', ports: [{ port: 3306, name: 'mysql' }] },
];

/** Presets in the order that suits the guest: SSH first for Linux, RDP and WinRM for Windows. */
export function presetsFor(osId: string): Preset[] {
  const kind = osId === 'windows' ? 'windows' : osId ? 'linux' : null;
  if (!kind) return PRESETS;
  return [...PRESETS.filter(p => p.os === kind), ...PRESETS.filter(p => p.os !== kind)];
}

export interface ParsedPorts {
  ports: PortSpec[];
  error?: string;
}

/**
 * Ports as typed: "22", "80, 443", "10000-10050", "53/udp",
 * "10000-10050/udp". A Service has no ranges, so a range becomes one entry
 * per port, at most RANGE_LIMIT in all.
 */
export function parsePorts(text: string, protocol: Proto = 'TCP'): ParsedPorts {
  const parts = text
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return { ports: [], error: 'Type a port, a list or a range' };
  const out: PortSpec[] = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?(?:\/(tcp|udp))?$/i);
    if (!m) return { ports: [], error: `"${part}" is not a port: use 22, 80,443 or 10000-10050/udp` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    const proto = (m[3]?.toUpperCase() as Proto | undefined) ?? protocol;
    if (from < 1 || to > 65535 || from > 65535) return { ports: [], error: 'Ports go from 1 to 65535' };
    if (to < from) return { ports: [], error: `${part}: a range goes from the lower port to the higher` };
    if (out.length + (to - from + 1) > RANGE_LIMIT)
      return { ports: [], error: `That is ${countOf(parts)} ports: Hangar publishes at most ${RANGE_LIMIT} at once (a Service has one entry per port)` };
    for (let p = from; p <= to; p++) if (!out.some(x => x.port === p && x.protocol === proto)) out.push({ port: p, protocol: proto });
  }
  return { ports: out };
}

function countOf(parts: string[]): number {
  let n = 0;
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?/);
    if (m) n += Math.max(1, (m[2] === undefined ? Number(m[1]) : Number(m[2])) - Number(m[1]) + 1);
  }
  return n;
}

/** A Service port name (IANA_SVC_NAME: at most 15 of a-z, 0-9 and "-", with a letter). */
export function portName(p: PortSpec, preferred?: string): string {
  const ok = (s: string) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s) && /[a-z]/.test(s) && !s.includes('--') && s.length <= 15;
  const want = preferred?.toLowerCase();
  if (want && ok(want)) return p.protocol === 'TCP' ? want : ok(`${want}-udp`) ? `${want}-udp` : `udp-${p.port}`;
  return `${p.protocol.toLowerCase()}-${p.port}`;
}

/** The preset a port belongs to, for its name. */
export function presetName(port: number): string | undefined {
  for (const pr of PRESETS) for (const x of pr.ports) if (x.port === port) return x.name;
  return undefined;
}

/* ------------------------------------------------------------ Service */

/** Hangar's Service for a VM and a way of publishing: `<vm>-cluster`, `<vm>-nodeport`, `<vm>-lb` (a DNS-1035 label). */
export function serviceName(vmName: string, mode: Mode): string {
  const suffix = `-${modeInfo(mode).suffix}`;
  let base = vmName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z]/.test(base)) base = `vm-${base}`;
  if (base.length + suffix.length <= 63) return `${base}${suffix}`;
  return `${base.slice(0, 63 - suffix.length - 6).replace(/-+$/, '')}-${sha1Hex(vmName).slice(0, 5)}${suffix}`;
}

export interface ServicePortIn {
  name: string;
  /** The port on the cluster address or the own address. */
  port: number;
  /** The guest's port. */
  targetPort: number;
  protocol: Proto;
  /** NodePort: chosen; omitted for automatic. */
  nodePort?: number;
}

export type LbController = 'metallb' | 'cilium';

export interface LbChoice {
  controller?: LbController;
  /** MetalLB: the pool Hangar names (it never leaves the choice to MetalLB: k4all's ingress pool could match). */
  pool?: string;
  /** A chosen address; omitted for automatic. */
  ip?: string;
  /** Cilium with MetalLB also running: Cilium's class keeps MetalLB away. */
  ciliumClass?: boolean;
}

export interface ServiceInput {
  vm: VM;
  mode: Mode;
  ports: ServicePortIn[];
  selector: Record<string, string>;
  lb?: LbChoice;
  /** NodePort and LoadBalancer: keep the client's source address (externalTrafficPolicy Local). */
  keepSourceIp?: boolean;
}

/** The Service Hangar creates. It is owned by the VM, as `virtctl expose` does, so it goes with the VM. */
export function serviceManifest(i: ServiceInput): Obj {
  const name = serviceName(i.vm.metadata.name, i.mode);
  const annotations: Record<string, string> = {};
  const spec: any = {
    type: modeInfo(i.mode).type,
    selector: i.selector,
    ports: i.ports.map(p => ({ name: p.name, port: p.port, targetPort: p.targetPort, protocol: p.protocol, ...(i.mode === 'host' && p.nodePort ? { nodePort: p.nodePort } : {}) })),
  };
  if (i.mode !== 'cluster' && i.keepSourceIp) spec.externalTrafficPolicy = 'Local';
  if (i.mode === 'address') {
    // MetalLB and Cilium's L2 announcements need no host ports: keep the 30000-32767 range for NodePorts.
    spec.allocateLoadBalancerNodePorts = false;
    const ctl = i.lb?.controller;
    if (ctl === 'metallb' && i.lb?.pool) annotations[A_METALLB_POOL] = i.lb.pool;
    // A chosen address: each controller reads its own annotation (both when Hangar cannot tell which one runs).
    if (i.lb?.ip && ctl !== 'cilium') annotations[A_METALLB_IPS] = i.lb.ip;
    if (i.lb?.ip && ctl !== 'metallb') annotations[A_CILIUM_IPS] = i.lb.ip;
    if (ctl === 'cilium' && i.lb?.ciliumClass) spec.loadBalancerClass = CILIUM_L2_CLASS;
  }
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: i.vm.metadata.namespace,
      labels: { [L_MANAGED_BY]: 'hangar', [L_VM]: i.vm.metadata.name, [L_PUBLISH]: i.mode },
      ...(Object.keys(annotations).length ? { annotations } : {}),
      ownerReferences: [
        { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: i.vm.metadata.name, uid: i.vm.metadata.uid, controller: true, blockOwnerDeletion: false },
      ],
    },
    spec,
  };
}

/** Hangar's ports added to an existing Service of the VM (its list, then the new ones). */
export function mergedPorts(svc: Obj, add: ServicePortIn[], mode: Mode): any[] {
  const out = [...(svc.spec?.ports ?? [])];
  for (const p of add) out.push({ name: p.name, port: p.port, targetPort: p.targetPort, protocol: p.protocol, ...(mode === 'host' && p.nodePort ? { nodePort: p.nodePort } : {}) });
  return out;
}

/** Why these ports cannot be added: a duplicate outside port or name in the Service, or a guest port this VM already publishes that way. */
export function conflictOf(add: ServicePortIn[], mode: Mode, existing: Obj[], vmName: string): string | null {
  const svcName = serviceName(vmName, mode);
  const mine = existing.find(s => s.metadata.name === svcName);
  if (mine && !isHangarService(mine, vmName)) return `A Service named ${svcName} already exists and Hangar did not make it for this VM`;
  for (const p of add) {
    if (add.filter(x => x.port === p.port && x.protocol === p.protocol).length > 1) return `Port ${p.port}/${p.protocol} is listed twice`;
    for (const s of existing) {
      if (modeOfService(s) !== mode) continue;
      for (const sp of s.spec?.ports ?? []) {
        const proto = (sp.protocol ?? 'TCP').toUpperCase();
        if (proto !== p.protocol) continue;
        if (s.metadata.name === svcName && sp.port === p.port) return `Port ${p.port}/${p.protocol} is already published ${modeInfo(mode).label.toLowerCase()}`;
        if (s.metadata.name === svcName && sp.name === p.name) return `A port named ${p.name} is already published ${modeInfo(mode).label.toLowerCase()}`;
        if (Number(sp.targetPort ?? sp.port) === p.targetPort)
          return `Guest port ${p.targetPort}/${p.protocol} is already published ${modeInfo(mode).label.toLowerCase()} by ${s.metadata.name}`;
      }
    }
  }
  return null;
}

/* ----------------------------------------------------------- the rows */

export interface PortRow {
  key: string;
  service: Obj;
  mode: Mode;
  /** Hangar made the Service for this VM (others are read-only). */
  managed: boolean;
  name?: string;
  protocol: string;
  /** The Service port (cluster address, own address). */
  port: number;
  /** The guest's port (a number, or a name for Services made elsewhere). */
  guest: number | string;
  nodePort?: number;
}

export function portRows(services: Obj[], vmName?: string): PortRow[] {
  const rows: PortRow[] = [];
  for (const s of services) {
    const mode = modeOfService(s);
    if (!mode) continue;
    for (const p of s.spec?.ports ?? []) {
      const protocol = (p.protocol ?? 'TCP').toUpperCase();
      rows.push({
        key: `${s.metadata.namespace}/${s.metadata.name}/${p.port}/${protocol}`,
        service: s,
        mode,
        managed: isHangarService(s, vmName ?? s.metadata.labels?.[L_VM]),
        name: p.name,
        protocol,
        port: p.port,
        guest: p.targetPort ?? p.port,
        nodePort: p.nodePort,
      });
    }
  }
  const order: Record<Mode, number> = { cluster: 0, host: 1, address: 2 };
  return rows.sort((a, b) => Number(a.guest) - Number(b.guest) || order[a.mode] - order[b.mode] || a.protocol.localeCompare(b.protocol));
}

/** The guest ports of the VM's published ports, for the adapter's list. */
export function guestPortsOf(rows: PortRow[]): PortSpec[] {
  return rows.filter(r => typeof r.guest === 'number' && (r.protocol === 'TCP' || r.protocol === 'UDP')).map(r => ({ port: r.guest as number, protocol: r.protocol as Proto }));
}

/* ---------------------------------------------------- the VM behind it */

export type Behind = 'ready' | 'not-ready' | 'off' | 'not-selected';

/** Whether the VM's pod is behind a Service, from its EndpointSlices. */
export function behindState(svc: Obj, slices: Obj[], vmOn: boolean): Behind {
  const mine = slices.filter(s => s.metadata.namespace === svc.metadata.namespace && s.metadata.labels?.['kubernetes.io/service-name'] === svc.metadata.name);
  const eps = mine.flatMap(s => (s.endpoints ?? []) as any[]).filter(e => !e.conditions?.terminating);
  if (eps.some(e => e.conditions?.ready !== false)) return 'ready';
  if (eps.length) return 'not-ready';
  return vmOn ? 'not-selected' : 'off';
}

export const BEHIND_TEXT: Record<Behind, { tone: 'on' | 'busy' | 'off' | 'standby'; text: string }> = {
  ready: { tone: 'on', text: 'The VM is behind it' },
  'not-ready': { tone: 'busy', text: 'The VM is not ready yet' },
  off: { tone: 'off', text: 'The VM is off' },
  'not-selected': { tone: 'standby', text: "The VM's pod is not selected yet" },
};

/* ---------------------------------------------------------- the pools */

export interface LbPool {
  kind: LbController;
  name: string;
  namespace?: string;
  /** As written in the pool. */
  addresses: string[];
  /** IPv4 ranges, inclusive. */
  ranges: [number, number][];
  /** Has IPv6 addresses (counted as plenty). */
  v6: boolean;
  total: number | null;
  /** Free IPv4 addresses: the controller's count, else counted from the Services Hangar sees. */
  free: number | null;
  autoAssign: boolean;
  disabled: boolean;
  /** k4all's ingress pool. */
  ingress: boolean;
  obj: Obj;
}

/** An IPv4 address, CIDR or "a-b" range as [first, last]; null for IPv6 or garbage. */
export function ipv4Range(s: string): [number, number] | null {
  const t = s.trim();
  if (t.includes('-')) {
    const [a, b] = t.split('-').map(x => parseIp(x.trim()));
    return a !== null && b !== null && a <= b ? [a, b] : null;
  }
  const [ip, len] = t.split('/');
  const base = parseIp(ip);
  const bits = len === undefined ? 32 : Number(len);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return [start, start + size - 1];
}

const inRanges = (ip: string, ranges: [number, number][]) => {
  const n = parseIp(ip);
  return n !== null && ranges.some(([a, b]) => a <= n && n <= b);
};

/** The LoadBalancer addresses Services hold (status), for counting what a pool has left. */
function heldIps(services: Obj[]): string[] {
  return services.flatMap(s => ((s.status?.loadBalancer?.ingress ?? []) as any[]).map(i => i.ip).filter(Boolean));
}

const condNum = (o: Obj, type: string): number | null => {
  const c = (o.status?.conditions ?? []).find((x: any) => x.type === type);
  const n = c ? Number(c.message) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parsePools(metallb: Obj[], cilium: Obj[], services: Obj[]): LbPool[] {
  const held = heldIps(services);
  const pool = (kind: LbController, o: Obj, addresses: string[], fromStatus: { total: number | null; free: number | null }, extra: Partial<LbPool>): LbPool => {
    const ranges = addresses.map(ipv4Range).filter((r): r is [number, number] => !!r);
    const v6 = addresses.some(a => a.includes(':'));
    const size = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
    const used = held.filter(ip => inRanges(ip, ranges)).length;
    return {
      kind,
      name: o.metadata.name,
      namespace: o.metadata.namespace,
      addresses,
      ranges,
      v6,
      total: fromStatus.total ?? (ranges.length ? size : null),
      free: fromStatus.free ?? (ranges.length ? Math.max(0, size - used) : null),
      autoAssign: true,
      disabled: false,
      ingress: false,
      obj: o,
      ...extra,
    };
  };
  return [
    ...metallb.map(o => {
      const st = o.status;
      const hasStatus = st && typeof st.availableIPv4 === 'number';
      return pool(
        'metallb',
        o,
        (o.spec?.addresses ?? []) as string[],
        { total: hasStatus ? st.availableIPv4 + (st.assignedIPv4 ?? 0) : null, free: hasStatus ? st.availableIPv4 : null },
        { autoAssign: o.spec?.autoAssign !== false, ingress: o.metadata.name === INGRESS_POOL }
      );
    }),
    ...cilium.map(o =>
      pool(
        'cilium',
        o,
        ((o.spec?.blocks ?? o.spec?.cidrs ?? []) as any[]).map(b => (b.cidr ? b.cidr : `${b.start}-${b.stop ?? b.start}`)),
        { total: condNum(o, 'cilium.io/IPsTotal'), free: condNum(o, 'cilium.io/IPsAvailable') },
        { disabled: !!o.spec?.disabled }
      )
    ),
  ];
}

export interface PoolUse {
  pool: LbPool;
  ok: boolean;
  why?: string;
}

/** Which pools can give an address to this VM's LoadBalancer Service, and why the others cannot. */
export function poolUses(pools: LbPool[], vm: VM, nsLabels: Record<string, string>): PoolUse[] {
  const ns = vm.metadata.namespace as string;
  const svcName = serviceName(vm.metadata.name, 'address');
  const svcLabels = { [L_MANAGED_BY]: 'hangar', [L_VM]: vm.metadata.name, [L_PUBLISH]: 'address' };
  return pools.map(pool => {
    if (pool.ingress) return { pool, ok: false, why: "k4all's ingress address: only the ingress uses it" };
    if (pool.disabled) return { pool, ok: false, why: 'Turned off' };
    if (pool.kind === 'metallb') {
      const a = pool.obj.spec?.serviceAllocation;
      if (a?.namespaces?.length && !a.namespaces.includes(ns)) return { pool, ok: false, why: `Only for ${a.namespaces.join(', ')}` };
      if (a?.namespaceSelectors?.length && !a.namespaceSelectors.some((s: any) => selectorMatches(s, nsLabels))) return { pool, ok: false, why: 'Not for this folder' };
      if (a?.serviceSelectors?.length && !a.serviceSelectors.some((s: any) => selectorMatches(s, svcLabels))) return { pool, ok: false, why: 'Selects other Services' };
    } else {
      const labels = { ...svcLabels, 'io.kubernetes.service.namespace': ns, 'io.kubernetes.service.name': svcName };
      if (!selectorMatches(pool.obj.spec?.serviceSelector, labels)) return { pool, ok: false, why: 'Selects other Services' };
    }
    if (pool.free === 0 && !pool.v6) return { pool, ok: false, why: 'No free address' };
    return { pool, ok: true };
  });
}

/** The pool Hangar names when the user leaves it to Hangar: the usable one with the most free addresses, MetalLB's or Cilium's. */
export function autoPool(uses: PoolUse[]): LbPool | null {
  const ok = uses.filter(u => u.ok).map(u => u.pool);
  return ok.sort((a, b) => (b.free ?? 0) - (a.free ?? 0))[0] ?? null;
}

/** Whether a chosen address belongs to the pool and is free. */
export function ipProblem(ip: string, pool: LbPool | null, services: Obj[]): string | null {
  if (parseIp(ip) === null) return 'Type an IPv4 address, such as 192.0.2.10';
  if (pool && pool.ranges.length && !inRanges(ip, pool.ranges)) return `${ip} is not in ${pool.name} (${pool.addresses.join(', ')})`;
  if (heldIps(services).includes(ip)) return `${ip} is taken by another Service`;
  return null;
}

/** What the cluster offers for LoadBalancer, and what an admin must create when no pool serves VMs. */
export function noPoolHelp(cni: { cilium: boolean; metallb: boolean; k4all: boolean }): string {
  if (cni.cilium)
    return `No address pool for VMs. An admin creates a CiliumLoadBalancerIPPool with the addresses VMs may take, a CiliumL2AnnouncementPolicy that announces them on the LAN, and turns on Cilium's L2 announcements${
      cni.k4all ? ' (networking.cni.cilium.l2announcements in k4all\'s ClusterConfig)' : ''
    }. Hangar never creates a pool.`;
  if (cni.metallb)
    return `No address pool for VMs. An admin creates a MetalLB IPAddressPool with the addresses VMs may take and an L2Advertisement for it (namespace metallb-system)${
      cni.k4all ? `; k4all's ${INGRESS_POOL} holds only the ingress's own address` : ''
    }. Hangar never creates a pool.`;
  return 'No load balancer runs on this cluster: an admin installs MetalLB or turns on Cilium\'s LB IPAM, with an address pool for VMs.';
}

/* --------------------------------------------------- LoadBalancer state */

export interface LbState {
  phase: 'waiting' | 'assigned' | 'announced' | 'failed';
  address?: string;
  pool?: string;
  controller?: LbController;
  /** The host that answers for the address. */
  node?: string;
  /** Why it failed, in words. */
  reason?: string;
}

const evTime = (e: Obj) => e.lastTimestamp || e.eventTime || e.series?.lastObservedTime || e.metadata?.creationTimestamp || '';

const CILIUM_REASONS: Record<string, string> = {
  no_pool: 'No CiliumLoadBalancerIPPool selects this Service',
  out_of_ips: 'The pools that select this Service have no free address',
  already_allocated: 'The address asked for is taken by another Service',
  already_allocated_incompatible_service: 'The address asked for is shared with a Service that cannot share it',
  pool_selector_mismatch: 'The pool with that address does not select this Service',
};

/**
 * Where a LoadBalancer Service stands: waiting (no address yet), assigned
 * (the address and its pool), announced (the host that answers for it),
 * failed (why). MetalLB tells through the Service's Events and
 * ServiceL2Status, Cilium through the Service's condition and its L2 lease.
 */
export function lbState(
  svc: Obj,
  opts: { events?: Obj[]; pools?: LbPool[]; ciliumLeaseHolder?: string | null; metallbNode?: string | null } = {}
): LbState {
  const uid = svc.metadata.uid;
  const evs = (opts.events ?? [])
    .filter(e => e.involvedObject?.kind === 'Service' && e.involvedObject?.name === svc.metadata.name && (!uid || !e.involvedObject?.uid || e.involvedObject.uid === uid))
    .sort((a, b) => evTime(b).localeCompare(evTime(a)));
  const ingress = ((svc.status?.loadBalancer?.ingress ?? []) as any[]).map(i => i.ip || i.hostname).filter(Boolean) as string[];
  const cil = ((svc.status?.conditions ?? []) as any[]).find(c => c.type === CILIUM_SATISFIED);
  const ann = svc.metadata.annotations ?? {};
  const address = ingress[0];
  const controller: LbController | undefined =
    cil || svc.spec?.loadBalancerClass === CILIUM_L2_CLASS
      ? 'cilium'
      : ann[A_METALLB_FROM] || ann[A_METALLB_POOL]
      ? 'metallb'
      : address
      ? (opts.pools ?? []).find(p => inRanges(address, p.ranges))?.kind
      : undefined;
  const pool = ann[A_METALLB_FROM] ?? (address ? (opts.pools ?? []).find(p => (!controller || p.kind === controller) && inRanges(address, p.ranges))?.name : undefined);
  if (!address) {
    if (cil?.status === 'False') return { phase: 'failed', controller: 'cilium', reason: CILIUM_REASONS[cil.reason] ?? cil.message ?? cil.reason };
    const fail = evs.find(e => e.reason === 'AllocationFailed' || e.reason === 'LoadBalancerFailed');
    const ok = evs.find(e => e.reason === 'IPAllocated');
    if (fail && (!ok || evTime(fail) >= evTime(ok))) {
      const msg = String(fail.message ?? '');
      return {
        phase: 'failed',
        controller: 'metallb',
        reason: fail.reason === 'AllocationFailed' ? `No free address in the pool${/no available IPs/i.test(msg) ? 's' : ''}: ${msg}` : msg,
      };
    }
    return { phase: 'waiting', controller };
  }
  let node: string | undefined;
  if (controller === 'cilium') node = opts.ciliumLeaseHolder ?? undefined;
  else {
    node = opts.metallbNode ?? undefined;
    if (!node) {
      const m = String(evs.find(e => e.reason === 'nodeAssigned')?.message ?? '').match(/node "([^"]+)"/);
      node = m?.[1];
    }
  }
  return { phase: node ? 'announced' : 'assigned', address, pool, controller, node };
}

/* --------------------------------------------------------- addresses */

/** The hosts' addresses for NodePorts: InternalIP, then ExternalIP; IPv6 only when asked. */
export function hostAddresses(nodes: Obj[], ipv6 = false): { host: string; ip: string }[] {
  const out: { host: string; ip: string }[] = [];
  for (const n of nodes) {
    const addrs = ((n.status?.addresses ?? []) as any[]).filter(a => a.type === 'InternalIP' || a.type === 'ExternalIP');
    for (const a of addrs) if (ipv6 || !String(a.address).includes(':')) out.push({ host: n.metadata.name, ip: a.address });
  }
  return out;
}

/** The first user cloud-init creates (`user:` or the first `users:` entry), for an ssh line. */
export function cloudInitUser(userData: string | undefined): string | undefined {
  if (!userData) return undefined;
  const single = userData.match(/^user:\s*(?:\n\s+name:\s*)?["']?([a-z_][a-z0-9_-]*)/m);
  if (single) return single[1];
  const list = userData.match(/^users:\s*\n(?:\s*-\s*default\s*\n)?\s*-\s*(?:name:\s*)?["']?([a-z_][a-z0-9_-]*)/m);
  return list?.[1];
}

/** A copyable line for a published port: ssh for 22, rdp for 3389, a URL for 80 and 443, else host:port. */
export function connectLine(guest: number | string, host: string, port: number, user?: string): string {
  const h = host.includes(':') ? `[${host}]` : host;
  switch (Number(guest)) {
    case 22:
      return port === 22 ? `ssh ${user ?? 'user'}@${host}` : `ssh -p ${port} ${user ?? 'user'}@${host}`;
    case 80:
      return port === 80 ? `http://${h}/` : `http://${h}:${port}/`;
    case 443:
      return port === 443 ? `https://${h}/` : `https://${h}:${port}/`;
    default:
      return `${h}:${port}`;
  }
}

/* ---------------------------------------------------------- datacenter */

export interface DcRow extends PortRow {
  vm?: VM;
  conflict?: string;
}

/** Every published port across the VMs, with the conflicts: the same guest port published twice the same way, an address and port two Services claim, a Service whose VM is gone. */
export function datacenterRows(services: Obj[], vms: VM[], launchers: Map<string, Obj>): DcRow[] {
  const rows: DcRow[] = [];
  const byNs = new Map<string, { vm: VM; labels: Record<string, string> }[]>();
  for (const v of vms) {
    const n = v.metadata.namespace as string;
    byNs.set(n, [...(byNs.get(n) ?? []), { vm: v, labels: podLabels(v, launchers.get(`${n}/${v.metadata.name}`)) }]);
  }
  for (const s of services) {
    const here = byNs.get(s.metadata.namespace as string) ?? [];
    const vm = isHangarService(s) ? here.find(x => x.vm.metadata.name === s.metadata.labels![L_VM])?.vm : here.find(x => serviceSelects(s, x.labels))?.vm;
    if (!vm && !isHangarService(s)) continue;
    for (const r of portRows([s], vm?.metadata.name)) rows.push({ ...r, vm, conflict: vm ? undefined : 'Its VM is gone' });
  }
  const groups = new Map<string, DcRow[]>();
  const add = (k: string, r: DcRow) => groups.set(k, [...(groups.get(k) ?? []), r]);
  for (const r of rows) {
    if (r.vm) add(`g|${r.vm.metadata.namespace}/${r.vm.metadata.name}|${r.mode}|${r.guest}|${r.protocol}`, r);
    if (r.mode === 'address') for (const ing of (r.service.status?.loadBalancer?.ingress ?? []) as any[]) if (ing.ip) add(`a|${ing.ip}|${r.port}|${r.protocol}`, r);
  }
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    for (const r of list)
      r.conflict ??= k.startsWith('g|')
        ? `Published twice: ${list.map(x => x.service.metadata.name).join(', ')}`
        : `Another Service uses ${k.split('|')[1]}:${r.port}/${r.protocol}`;
  }
  return rows;
}

/** Why a chosen host port cannot be used: outside 30000-32767, or held by a Service Hangar can see. */
export function nodePortProblem(port: number, services: Obj[]): string | null {
  if (!Number.isInteger(port) || port < NODEPORT_MIN || port > NODEPORT_MAX) return `Host ports go from ${NODEPORT_MIN} to ${NODEPORT_MAX}`;
  const holder = services.find(s => ((s.spec?.ports ?? []) as any[]).some(p => p.nodePort === port));
  return holder ? `Port ${port} is taken by ${holder.metadata.namespace}/${holder.metadata.name}` : null;
}
