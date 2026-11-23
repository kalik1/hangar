/*
 * Networks as a virtualizer shows them: the pod network (NAT) and the
 * Multus NetworkAttachmentDefinitions, read from their CNI config (bridge,
 * VLAN, MTU), with the VMs on each. Host bridges come from nmstate's
 * NodeNetworkState and from the bridge markers' node resources.
 */

import { Obj } from './types';
import { key } from './vm';

export const A_RESOURCE = 'k8s.v1.cni.cncf.io/resourceName';
export const A_DESCRIPTION = 'description';
export const OVS_MARKER = 'ovs-cni.network.kubevirt.io/';
export const BRIDGE_MARKER = 'bridge.network.kubevirt.io/';

export type CniKind = 'linux-bridge' | 'ovs' | 'macvlan' | 'ipvlan' | 'sriov' | 'host-device' | 'ovn' | 'other' | 'host-file';

export interface CniInfo {
  kind: CniKind;
  /** Plain words: "Linux bridge". */
  label: string;
  /** The CNI plugin type ("bridge", "ovs"…). */
  type: string;
  bridge?: string;
  /** Host interface for macvlan, ipvlan, host-device. */
  master?: string;
  vlan?: number;
  trunk?: string;
  mtu?: number;
  /** IP addresses: "None (the guest's DHCP)", "Static", "DHCP", "Host-local pool"… */
  ipam?: string;
  mode?: string;
  /** Other plugins chained after the main one (tuning, firewall…). */
  chained: string[];
  /** Unparsable config. */
  error?: string;
}

const LABELS: Record<string, [CniKind, string]> = {
  bridge: ['linux-bridge', 'Linux bridge'],
  'cnv-bridge': ['linux-bridge', 'Linux bridge'],
  ovs: ['ovs', 'OVS bridge'],
  macvlan: ['macvlan', 'Macvlan'],
  ipvlan: ['ipvlan', 'IPvlan'],
  sriov: ['sriov', 'SR-IOV'],
  'host-device': ['host-device', 'Host device'],
  'ovn-k8s-cni-overlay': ['ovn', 'OVN'],
  'kube-ovn': ['ovn', 'Kube-OVN'],
};

function ipamLabel(ipam: any): string | undefined {
  if (!ipam || !ipam.type) return 'None (set in the guest)';
  switch (ipam.type) {
    case 'dhcp':
      return 'DHCP (from the network)';
    case 'static':
      return 'Static';
    case 'host-local':
      return `Host-local pool${ipam.subnet ? ` ${ipam.subnet}` : ipam.ranges?.[0]?.[0]?.subnet ? ` ${ipam.ranges[0][0].subnet}` : ''}`;
    case 'whereabouts':
      return `Whereabouts pool${ipam.range ? ` ${ipam.range}` : ''}`;
    default:
      return ipam.type;
  }
}

function trunkLabel(trunk: any): string | undefined {
  if (!Array.isArray(trunk) || !trunk.length) return undefined;
  return trunk
    .map((t: any) => (t.id !== undefined ? String(t.id) : `${t.minID}-${t.maxID}`))
    .join(', ');
}

/** Reads a NAD's CNI config (a plugin or a plugin list). */
export function parseCni(config: string | undefined | null): CniInfo {
  if (!config || !config.trim()) {
    return { kind: 'host-file', label: 'Defined on the hosts', type: '', chained: [] };
  }
  let j: any;
  try {
    j = JSON.parse(config);
  } catch (e) {
    return { kind: 'other', label: 'Unreadable', type: '', chained: [], error: `The CNI config is not valid JSON: ${(e as Error).message}` };
  }
  const plugins: any[] = Array.isArray(j.plugins) ? j.plugins : [j];
  const main = plugins.find(p => p?.type && LABELS[p.type]) ?? plugins[0] ?? {};
  const [kind, label] = LABELS[main.type] ?? ['other', main.type || 'Unknown'];
  const vlan = main.vlan !== undefined && main.vlan !== '' ? Number(main.vlan) : main.vlanId !== undefined ? Number(main.vlanId) : undefined;
  const mtu = main.mtu ?? plugins.find(p => p?.type === 'tuning')?.mtu;
  return {
    kind,
    label: kind === 'ovn' && main.topology ? `${label} ${main.topology === 'localnet' ? 'localnet' : main.topology === 'layer2' ? 'layer 2' : main.topology}` : label,
    type: main.type ?? '',
    bridge: main.bridge,
    master: main.master ?? main.device ?? main.pciBusID,
    vlan: vlan !== undefined && isFinite(vlan) && vlan > 0 ? vlan : undefined,
    trunk: trunkLabel(main.trunk),
    mtu: mtu !== undefined && isFinite(Number(mtu)) ? Number(mtu) : undefined,
    ipam: kind === 'host-file' ? undefined : ipamLabel(main.ipam),
    mode: main.mode,
    chained: plugins.filter(p => p !== main).map(p => p?.type).filter(Boolean),
  };
}

/** "name" or "ns/name" of a VM network → the NAD key "ns/name". */
export function nadRef(networkName: string, vmNamespace: string): string {
  return networkName.includes('/') ? networkName : `${vmNamespace}/${networkName}`;
}

export interface NetworkUse {
  vm: Obj;
  /** The adapter in the VM. */
  nic: string;
}

/** VMs per network: "pod" for the pod network, "ns/name" for attachments. */
export function networkUsers(vms: Obj[]): Map<string, NetworkUse[]> {
  const out = new Map<string, NetworkUse[]>();
  for (const vm of vms) {
    for (const n of vm.spec?.template?.spec?.networks ?? []) {
      const k = n.pod ? 'pod' : n.multus?.networkName ? nadRef(n.multus.networkName, vm.metadata.namespace as string) : null;
      if (!k) continue;
      out.set(k, [...(out.get(k) ?? []), { vm, nic: n.name }]);
    }
  }
  return out;
}

export interface NetworkRow {
  key: string;
  name: string;
  /** Namespace; undefined for the pod network. */
  namespace?: string;
  /** Usable from every folder (the pod network, or an attachment in "default"). */
  allFolders: boolean;
  cni: CniInfo;
  description?: string;
  uses: NetworkUse[];
  isPod: boolean;
  nad?: Obj;
  resourceName?: string;
}

export function networkRows(nads: Obj[], vms: Obj[]): NetworkRow[] {
  const users = networkUsers(vms);
  const pod: NetworkRow = {
    key: 'pod',
    name: 'Pod network',
    allFolders: true,
    cni: { kind: 'other', label: 'NAT, default', type: '', chained: [] },
    description: 'Every VM can use it: the VM reaches out through its host (NAT); services and routes bring traffic in.',
    uses: users.get('pod') ?? [],
    isPod: true,
  };
  const rows = nads.map(nad => ({
    key: key(nad),
    name: nad.metadata.name,
    namespace: nad.metadata.namespace,
    allFolders: nad.metadata.namespace === 'default',
    cni: parseCni(nad.spec?.config),
    description: nad.metadata.annotations?.[A_DESCRIPTION],
    uses: users.get(key(nad)) ?? [],
    isPod: false,
    nad,
    resourceName: nad.metadata.annotations?.[A_RESOURCE],
  }));
  return [pod, ...rows.sort((a, b) => a.key.localeCompare(b.key))];
}

/** "VLAN 100", "Untagged", "Trunk 10, 20-30". */
export function vlanLabel(c: CniInfo): string {
  if (c.vlan) return `VLAN ${c.vlan}`;
  if (c.trunk) return `Trunk ${c.trunk}`;
  if (c.kind === 'linux-bridge' || c.kind === 'ovs' || c.kind === 'sriov') return 'Untagged';
  return '—';
}

/* ---------------------------------------------------------------- hosts */

export interface HostBridge {
  name: string;
  kind: 'ovs' | 'linux-bridge';
  /** Hosts that have it. */
  hosts: string[];
  /** Physical ports (uplinks) seen in NodeNetworkState. */
  ports: string[];
  /** The bridge marker advertises it as a node resource (scheduling works). */
  marked: boolean;
}

function nodeName(nns: Obj): string {
  return nns.metadata.name;
}

/** Bridges on the hosts, from nmstate and from the markers' node resources. */
export function hostBridges(nns: Obj[], nodes: Obj[]): HostBridge[] {
  const out = new Map<string, HostBridge>();
  const get = (name: string, kind: HostBridge['kind']) => {
    const k = `${kind}/${name}`;
    let b = out.get(k);
    if (!b) {
      b = { name, kind, hosts: [], ports: [], marked: false };
      out.set(k, b);
    }
    return b;
  };
  for (const s of nns) {
    for (const i of s.status?.currentState?.interfaces ?? []) {
      const kind = i.type === 'ovs-bridge' ? 'ovs' : i.type === 'linux-bridge' ? 'linux-bridge' : null;
      if (!kind) continue;
      const b = get(i.name, kind);
      if (!b.hosts.includes(nodeName(s))) b.hosts.push(nodeName(s));
      for (const p of i.bridge?.port ?? []) {
        // OVS lists the bridge's own internal port too.
        if (p.name !== i.name && !b.ports.includes(p.name)) b.ports.push(p.name);
      }
    }
  }
  for (const n of nodes) {
    for (const r of Object.keys(n.status?.capacity ?? {})) {
      const kind = r.startsWith(OVS_MARKER) ? 'ovs' : r.startsWith(BRIDGE_MARKER) ? 'linux-bridge' : null;
      if (!kind) continue;
      const b = get(r.slice(r.indexOf('/') + 1), kind);
      b.marked = true;
      if (!b.hosts.includes(n.metadata.name)) b.hosts.push(n.metadata.name);
    }
  }
  return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export interface CniOffer {
  kind: 'ovs' | 'linux-bridge';
  label: string;
  available: boolean;
  /** Why not, or what to know. */
  note?: string;
  bridges: HostBridge[];
}

/**
 * Which bridge types Hangar offers. OVS needs the OVS CNI plugin, which
 * advertises every OVS bridge as a node resource; a Linux bridge needs the
 * bridge to exist (nmstate shows it). Without nmstate and markers Hangar
 * cannot see the hosts: it offers both and asks for the bridge name.
 */
export function cniOffers(nns: Obj[], nodes: Obj[], hasNmstate: boolean): CniOffer[] {
  const bridges = hostBridges(nns, nodes);
  const ovs = bridges.filter(b => b.kind === 'ovs');
  const linux = bridges.filter(b => b.kind === 'linux-bridge');
  const ovsPlugin = ovs.some(b => b.marked);
  const blind = !hasNmstate && !bridges.length;
  return [
    {
      kind: 'ovs',
      label: 'OVS bridge',
      available: ovsPlugin || blind,
      note: blind
        ? 'Hangar cannot see the host networks (no NMState): type the name of an OVS bridge that exists on every host.'
        : !ovsPlugin && ovs.length
        ? 'The hosts have OVS bridges, but the OVS CNI plugin is not installed: install ovs-cni to attach VMs to them.'
        : !ovsPlugin
        ? 'No host has an OVS bridge with the OVS CNI plugin.'
        : undefined,
      bridges: ovs.filter(b => b.marked),
    },
    {
      kind: 'linux-bridge',
      label: 'Linux bridge',
      available: linux.length > 0 || blind,
      note: blind
        ? 'Hangar cannot see the host networks (no NMState): type the name of a Linux bridge that exists on every host.'
        : linux.length
        ? undefined
        : 'No host has a Linux bridge. Create one on the hosts first (NMState policy or the host network settings).',
      bridges: linux,
    },
  ];
}

export interface NadInput {
  name: string;
  namespace: string;
  kind: 'ovs' | 'linux-bridge';
  bridge: string;
  vlan?: number;
  mtu?: number;
  description?: string;
  /** The bridge marker advertises the bridge: pin VMs to hosts that have it. */
  marked?: boolean;
}

/** The NetworkAttachmentDefinition for a bridge network. */
export function nadManifest(i: NadInput): Obj {
  const plugin: Record<string, unknown> =
    i.kind === 'ovs'
      ? { cniVersion: '0.4.0', name: i.name, type: 'ovs', bridge: i.bridge }
      : { cniVersion: '0.3.1', name: i.name, type: 'bridge', bridge: i.bridge, macspoofchk: true, ipam: {}, preserveDefaultVlan: false };
  if (i.vlan) plugin.vlan = i.vlan;
  if (i.mtu) plugin.mtu = i.mtu;
  const annotations: Record<string, string> = {};
  if (i.marked) annotations[A_RESOURCE] = `${i.kind === 'ovs' ? OVS_MARKER : BRIDGE_MARKER}${i.bridge}`;
  if (i.description?.trim()) annotations[A_DESCRIPTION] = i.description.trim();
  return {
    apiVersion: 'k8s.cni.cncf.io/v1',
    kind: 'NetworkAttachmentDefinition',
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { 'hangar.magesgate.com/managed': 'true' },
      ...(Object.keys(annotations).length ? { annotations } : {}),
    },
    spec: { config: JSON.stringify(plugin) },
  };
}

export function vlanProblem(v: string): string | null {
  if (!v.trim()) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 4094) return 'A VLAN ID is a whole number from 1 to 4094.';
  return null;
}

export function mtuProblem(v: string): string | null {
  if (!v.trim()) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 576 || n > 9216) return 'An MTU is a whole number from 576 to 9216.';
  return null;
}

/* --------------------------------------------------------- host panel */

export interface HostIface {
  name: string;
  type: string;
  /** Plain words: "Physical NIC", "OVS bridge", "Bond", "VLAN". */
  label: string;
  state: string;
  mtu?: number;
  mac?: string;
  ips: string[];
  /** Ports of a bridge or bond, base interface and ID of a VLAN, bond mode. */
  detail?: string;
}

const IFACE_LABELS: Record<string, string> = {
  ethernet: 'Physical NIC',
  'ovs-bridge': 'OVS bridge',
  'ovs-interface': 'OVS internal port',
  'linux-bridge': 'Linux bridge',
  bond: 'Bond',
  vlan: 'VLAN',
  vxlan: 'VXLAN',
  dummy: 'Dummy',
  'mac-vlan': 'Macvlan',
  infiniband: 'InfiniBand',
};

/** The interfaces of a host worth showing (no loopback, veths or overlay internals). */
export function hostInterfaces(nns: Obj): HostIface[] {
  const all: any[] = nns.status?.currentState?.interfaces ?? [];
  const ipsOf = (i: any) => [
    ...(i.ipv4?.address ?? []).map((a: any) => `${a.ip}/${a['prefix-length']}`),
    ...(i.ipv6?.address ?? []).filter((a: any) => !String(a.ip).startsWith('fe80')).map((a: any) => `${a.ip}/${a['prefix-length']}`),
  ];
  const ovsBridges = new Set(all.filter(i => i.type === 'ovs-bridge').map(i => i.name));
  const out: HostIface[] = [];
  for (const i of all) {
    if (!IFACE_LABELS[i.type]) continue;
    if (i.type === 'vxlan' && /^(cilium|flannel|vxlan_sys)/.test(i.name)) continue;
    // The OVS bridge's own internal port: its addresses go on the bridge row.
    if (i.type === 'ovs-interface' && ovsBridges.has(i.name)) continue;
    let detail: string | undefined;
    if (i.type === 'ovs-bridge' || i.type === 'linux-bridge')
      detail = `Ports: ${(i.bridge?.port ?? []).map((p: any) => p.name).filter((n: string) => n !== i.name).join(', ') || 'none'}`;
    if (i.type === 'bond') detail = `${i['link-aggregation']?.mode ?? 'bond'}: ${(i['link-aggregation']?.port ?? i['link-aggregation']?.slaves ?? []).join(', ')}`;
    if (i.type === 'vlan') detail = `VLAN ${i.vlan?.id} on ${i.vlan?.['base-iface']}`;
    const internal = i.type === 'ovs-bridge' ? all.find(x => x.type === 'ovs-interface' && x.name === i.name) : undefined;
    out.push({
      name: i.name,
      type: i.type,
      label: IFACE_LABELS[i.type],
      state: i.state,
      mtu: i.mtu ?? internal?.mtu ?? undefined,
      mac: i['mac-address'] ?? internal?.['mac-address'],
      ips: [...ipsOf(i), ...(internal ? ipsOf(internal) : [])],
      detail,
    });
  }
  const order = ['ethernet', 'bond', 'vlan', 'linux-bridge', 'ovs-bridge', 'ovs-interface'];
  return out.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
}
