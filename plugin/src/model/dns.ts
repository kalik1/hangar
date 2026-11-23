/*
 * DNS of a VM on the pod network. KubeVirt copies the VM's dnsPolicy and
 * dnsConfig to its pod; the kubelet writes the pod's resolv.conf from them and
 * KubeVirt's DHCP server hands the servers and search domains to the guest.
 * Resolver options (ndots…) stay in the pod: DHCP does not carry them.
 */

import { Obj } from './types';

export type DnsPolicy = 'ClusterFirst' | 'Default' | 'None';

export interface DnsSettings {
  policy: DnsPolicy;
  /** Extra servers (ClusterFirst/Default) or the only ones (None). */
  nameservers: string[];
  searches: string[];
}

export const DNS_POLICIES: { value: DnsPolicy; label: string; help: string }[] = [
  {
    value: 'ClusterFirst',
    label: 'Cluster DNS, then the internet',
    help: 'The cluster DNS answers for services and VMs of the cluster and forwards the rest. Recommended.',
  },
  {
    value: 'Default',
    label: "The host's DNS servers",
    help: "The servers of the host the VM runs on. Cluster names (…svc.cluster.local) do not resolve.",
  },
  {
    value: 'None',
    label: 'Only the servers below',
    help: 'Nothing from the cluster or the host: the VM gets exactly what you list.',
  },
];

/** Limits the kubelet enforces on a pod's resolv.conf. */
export const MAX_NAMESERVERS = 3;
export const MAX_SEARCHES = 32;

export function dnsOf(vm: Obj): DnsSettings {
  const spec = vm.spec?.template?.spec ?? {};
  const p = spec.dnsPolicy;
  return {
    policy: p === 'Default' || p === 'None' ? p : 'ClusterFirst',
    nameservers: [...(spec.dnsConfig?.nameservers ?? [])],
    searches: [...(spec.dnsConfig?.searches ?? [])],
  };
}

/** True when the VM uses the defaults (nothing set). */
export function isDefaultDns(s: DnsSettings): boolean {
  return s.policy === 'ClusterFirst' && !s.nameservers.length && !s.searches.length;
}

/** Writes the settings into a VM (or template) spec in place; keeps dnsConfig.options. */
export function applyDns(templateSpec: any, s: DnsSettings): void {
  if (s.policy === 'ClusterFirst') delete templateSpec.dnsPolicy;
  else templateSpec.dnsPolicy = s.policy;
  const options = templateSpec.dnsConfig?.options;
  const cfg: any = {};
  if (s.nameservers.length) cfg.nameservers = s.nameservers;
  if (s.searches.length) cfg.searches = s.searches;
  if (options?.length) cfg.options = options;
  if (Object.keys(cfg).length) templateSpec.dnsConfig = cfg;
  else delete templateSpec.dnsConfig;
}

export function setDns(vm: Obj, s: DnsSettings): Obj {
  const next = JSON.parse(JSON.stringify(vm));
  next.spec = next.spec ?? {};
  next.spec.template = next.spec.template ?? {};
  next.spec.template.spec = next.spec.template.spec ?? {};
  applyDns(next.spec.template.spec, s);
  return next;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+(%\w+)?$/;
const DOMAIN = /^(?=.{1,253}$)([a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?)*\.?$/;

export function isIp(s: string): boolean {
  return IPV4.test(s) || (s.includes(':') && IPV6.test(s));
}

/** Splits "a, b c" into ["a", "b", "c"], without duplicates. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean))];
}

/** What is wrong with the settings, in plain words (empty = fine). */
export function dnsProblems(s: DnsSettings, clusterServers = 1): string[] {
  const out: string[] = [];
  const bad = s.nameservers.filter(x => !isIp(x));
  if (bad.length) out.push(`Not an IP address: ${bad.join(', ')}. DNS servers are given by address.`);
  const badDomains = s.searches.filter(x => !DOMAIN.test(x));
  if (badDomains.length) out.push(`Not a domain name: ${badDomains.join(', ')}.`);
  if (s.policy === 'None' && !s.nameservers.length) out.push('Add at least one DNS server: with "Only the servers below" the VM gets no other.');
  const total = s.nameservers.length + (s.policy === 'ClusterFirst' ? clusterServers : 0);
  if (total > MAX_NAMESERVERS)
    out.push(
      s.policy === 'ClusterFirst'
        ? `At most ${MAX_NAMESERVERS - clusterServers} extra servers: the cluster DNS counts as one of the ${MAX_NAMESERVERS} a guest can get.`
        : `At most ${MAX_NAMESERVERS} DNS servers.`
    );
  if (s.searches.length > MAX_SEARCHES) out.push(`At most ${MAX_SEARCHES} search domains.`);
  return out;
}

export interface ClusterDns {
  /** Cluster DNS service addresses (kubelet clusterDNS). */
  servers: string[];
  /** Cluster domain, usually cluster.local. */
  domain: string;
}

export interface EffectiveDns {
  servers: { address: string; from: 'cluster' | 'host' | 'vm' }[];
  searches: { domain: string; from: 'cluster' | 'host' | 'vm' }[];
  /** True when the host's resolver contributes entries Hangar cannot list. */
  hostPart: boolean;
  /** Servers past the limit, dropped by the kubelet. */
  dropped: string[];
}

/** What the guest receives, following the kubelet's rules for a pod's resolv.conf. */
export function effectiveDns(s: DnsSettings, namespace: string, cluster: ClusterDns, hostSearches: string[] = []): EffectiveDns {
  const servers: EffectiveDns['servers'] = [];
  const searches: EffectiveDns['searches'] = [];
  const addServer = (address: string, from: 'cluster' | 'host' | 'vm') => {
    if (!servers.some(x => x.address === address)) servers.push({ address, from });
  };
  const addSearch = (domain: string, from: 'cluster' | 'host' | 'vm') => {
    const d = domain.replace(/\.$/, '');
    if (d && !searches.some(x => x.domain === d)) searches.push({ domain: d, from });
  };
  if (s.policy === 'ClusterFirst') {
    cluster.servers.forEach(a => addServer(a, 'cluster'));
    [`${namespace}.svc.${cluster.domain}`, `svc.${cluster.domain}`, cluster.domain].forEach(x => addSearch(x, 'cluster'));
    hostSearches.forEach(x => addSearch(x, 'host'));
  } else if (s.policy === 'Default') {
    hostSearches.forEach(x => addSearch(x, 'host'));
  }
  s.nameservers.forEach(a => addServer(a, 'vm'));
  s.searches.forEach(x => addSearch(x, 'vm'));
  const dropped = servers.slice(MAX_NAMESERVERS).map(x => x.address);
  return { servers: servers.slice(0, MAX_NAMESERVERS), searches: searches.slice(0, MAX_SEARCHES), hostPart: s.policy !== 'None', dropped };
}

/** The search domains the hosts likely add: the DNS domain all node names share (example.com). */
export function hostSearchHint(nodes: Obj[]): string[] {
  const domains = nodes.map(n => (n.metadata?.name ?? '').split('.').slice(1).join('.')).filter(Boolean);
  return domains.length && domains.length === nodes.length && domains.every(x => x === domains[0]) ? [domains[0]] : [];
}

/** True when the VM has an adapter on the pod network (the only one DNS settings reach). */
export function usesPodNetwork(vm: Obj): boolean {
  return (vm.spec?.template?.spec?.networks ?? []).some((n: any) => n.pod);
}

/** clusterDNS and clusterDomain from the kubelet-config ConfigMap's YAML (a KubeletConfiguration). */
export function parseKubeletDns(text: string): ClusterDns | null {
  const domain = /^clusterDomain:\s*"?([^"\s]+)"?\s*$/m.exec(text)?.[1];
  const block = /^clusterDNS:\s*\n((?:[ \t]*-[ \t]*\S+[ \t]*\n?)+)/m.exec(text)?.[1] ?? '';
  const inline = /^clusterDNS:\s*\[([^\]]*)\]/m.exec(text)?.[1];
  const servers = (inline !== undefined ? inline.split(',') : block.split('\n').map(l => l.replace(/^\s*-\s*/, '')))
    .map(x => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  if (!domain && !servers.length) return null;
  return { servers, domain: domain ?? 'cluster.local' };
}
