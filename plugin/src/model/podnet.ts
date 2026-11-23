/*
 * The NAT network inside a VM's pod (KubeVirt masquerade binding).
 *
 * KubeVirt gives a VM on the pod network a private network between the
 * guest and its pod, 10.0.2.0/24 unless networks[].pod.vmNetworkCIDR says
 * otherwise. When that range is also a range of the cluster (a host's pod
 * network, the service network, the hosts' own addresses), traffic to it
 * stays inside the pod: on k4all with Cilium the third host's pods are in
 * 10.0.2.0/24, so a VM there cannot reach pods of its own host (k4all
 * issue #72). Hangar picks a /24 that overlaps nothing: 10.0.2.0/24 when it
 * is free, else one of a reserved range.
 */

import { clone } from './edit';
import { VM } from './types';

export const DEFAULT_VM_CIDR = '10.0.2.0/24';
/** Where Hangar takes a VM network from when the default is taken: 172.31.254.0/24 downwards. */
export const RESERVED_VM_CIDRS = Array.from({ length: 16 }, (_, i) => `172.31.${254 - i}.0/24`);

export interface Cidr {
  base: number;
  bits: number;
}

export function parseIp(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** An IPv4 CIDR (a bare address is a /32); null for IPv6 or garbage. */
export function parseCidr(s: string): Cidr | null {
  const [ip, len] = s.trim().split('/');
  const base = parseIp(ip ?? '');
  const bits = len === undefined ? 32 : Number(len);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, bits };
}

/** Two ranges share an address. */
export function overlaps(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y) return false;
  const bits = Math.min(x.bits, y.bits);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((x.base & mask) >>> 0) === ((y.base & mask) >>> 0);
}

/** What the cluster's addresses are, as far as Hangar can read them. */
export interface NetFacts {
  /** Each host's pod ranges (CiliumNode spec.ipam.podCIDRs or Node spec.podCIDRs). */
  podCidrs: { host: string; cidr: string }[];
  /** Pod addresses per host, when the ranges are not readable. */
  podIps: { host: string; ip: string }[];
  /** The service network (ServiceCIDR objects, else around the kubernetes Service). */
  serviceCidrs: string[];
  /** The hosts' own addresses (InternalIP, ExternalIP). */
  hostIps: { host: string; ip: string }[];
}

/** Why a range cannot be the VM network, in words; empty when it is free. */
export function cidrConflicts(cidr: string, f: NetFacts): string[] {
  const out: string[] = [];
  const short = (h: string) => h.split('.')[0];
  for (const p of f.podCidrs) if (overlaps(cidr, p.cidr)) out.push(`the pod network of ${short(p.host)} (${p.cidr})`);
  if (!f.podCidrs.length) {
    const hosts = [...new Set(f.podIps.filter(p => overlaps(cidr, p.ip)).map(p => short(p.host)))];
    if (hosts.length) out.push(`pod addresses of ${hosts.join(', ')}`);
  }
  for (const s of f.serviceCidrs) if (overlaps(cidr, s)) out.push(`the service network (${s})`);
  const hosts = [...new Set(f.hostIps.filter(h => overlaps(cidr, h.ip)).map(h => `${short(h.host)} (${h.ip})`))];
  if (hosts.length) out.push(`the address of ${hosts.join(', ')}`);
  return out;
}

/** The VM network to use: the default when it is free, else the first free reserved /24 (null if none is). */
export function freeVmCidr(f: NetFacts): string | null {
  if (!cidrConflicts(DEFAULT_VM_CIDR, f).length) return DEFAULT_VM_CIDR;
  return RESERVED_VM_CIDRS.find(c => !cidrConflicts(c, f).length) ?? null;
}

export interface PodNetIssue {
  /** The adapter (network) name. */
  nic: string;
  cidr: string;
  /** It is KubeVirt's default (no vmNetworkCIDR on the VM). */
  isDefault: boolean;
  conflicts: string[];
}

/** The VM's pod-network adapters whose NAT network overlaps the cluster's ranges. */
export function podNetIssues(vm: VM, f: NetFacts): PodNetIssue[] {
  const t = vm.spec?.template?.spec ?? {};
  const ifaces: any[] = t.domain?.devices?.interfaces ?? [];
  const out: PodNetIssue[] = [];
  for (const n of (t.networks ?? []) as any[]) {
    if (!n.pod) continue;
    const i = ifaces.find(x => x.name === n.name);
    if (i && !i.masquerade) continue;
    const cidr = n.pod.vmNetworkCIDR || DEFAULT_VM_CIDR;
    const conflicts = cidrConflicts(cidr, f);
    if (conflicts.length) out.push({ nic: n.name, cidr, isDefault: !n.pod.vmNetworkCIDR, conflicts });
  }
  return out;
}

/** Sets the NAT network of the VM's pod-network adapters (all of them, or `nic`). Applies at the next power-on. */
export function setVmNetworkCidr(vm: VM, cidr: string, nic?: string): VM {
  const out = clone(vm);
  for (const n of (out.spec?.template?.spec?.networks ?? []) as any[]) {
    if (!n.pod || (nic && n.name !== nic)) continue;
    n.pod = { ...n.pod, vmNetworkCIDR: cidr };
  }
  return out;
}

export function vmNetworkCidrOf(vm: VM, nic: string): string {
  const n = (vm.spec?.template?.spec?.networks ?? []).find((x: any) => x.name === nic);
  return n?.pod?.vmNetworkCIDR || DEFAULT_VM_CIDR;
}

/** Facts from what the cluster answered (each part may be missing). */
export function netFacts(p: {
  nodes: { metadata: { name: string }; spec?: any; status?: any }[];
  ciliumNodes?: { metadata: { name: string }; spec?: any }[] | null;
  serviceCidrs?: { spec?: any }[] | null;
  kubernetesServiceIp?: string | null;
  pods?: { spec?: any; status?: any }[] | null;
}): NetFacts {
  const podCidrs: NetFacts['podCidrs'] = [];
  for (const c of p.ciliumNodes ?? []) for (const cidr of (c.spec?.ipam?.podCIDRs ?? []) as string[]) if (parseCidr(cidr)) podCidrs.push({ host: c.metadata.name, cidr });
  if (!podCidrs.length)
    for (const n of p.nodes) for (const cidr of (n.spec?.podCIDRs ?? (n.spec?.podCIDR ? [n.spec.podCIDR] : [])) as string[]) if (parseCidr(cidr)) podCidrs.push({ host: n.metadata.name, cidr });
  const podIps: NetFacts['podIps'] = [];
  if (!podCidrs.length)
    for (const pod of p.pods ?? []) {
      if (pod.spec?.hostNetwork || !pod.status?.podIP || !pod.spec?.nodeName) continue;
      if (parseIp(pod.status.podIP) !== null) podIps.push({ host: pod.spec.nodeName, ip: pod.status.podIP });
    }
  const serviceCidrs = (p.serviceCidrs ?? []).flatMap(s => ((s.spec?.cidrs ?? []) as string[]).filter(c => parseCidr(c)));
  // Without ServiceCIDRs, assume a /16 around the kubernetes Service (the usual /12 or /16 service networks start there).
  if (!serviceCidrs.length && p.kubernetesServiceIp && parseIp(p.kubernetesServiceIp) !== null) serviceCidrs.push(`${p.kubernetesServiceIp}/16`);
  const hostIps: NetFacts['hostIps'] = [];
  for (const n of p.nodes)
    for (const a of (n.status?.addresses ?? []) as any[])
      if ((a.type === 'InternalIP' || a.type === 'ExternalIP') && parseIp(a.address) !== null) hostIps.push({ host: n.metadata.name, ip: a.address });
  return { podCidrs, podIps, serviceCidrs: serviceCidrs.map(c => {
    const x = parseCidr(c)!;
    const ip = [24, 16, 8, 0].map(s => (x.base >>> s) & 255).join('.');
    return `${ip}/${x.bits}`;
  }), hostIps };
}
