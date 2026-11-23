import { describe, expect, it } from 'vitest';
import {
  cniOffers,
  hostBridges,
  hostInterfaces,
  mtuProblem,
  nadManifest,
  nadRef,
  networkRows,
  parseCni,
  vlanLabel,
  vlanProblem,
} from './networks';
import { Obj } from './types';

// A test host: two OVS bridges with an uplink each, the ovs-cni marker.
const nns: Obj = {
  metadata: { name: 'n1' },
  status: {
    currentState: {
      interfaces: [
        { name: 'cilium_vxlan', type: 'vxlan', state: 'ignore' },
        { name: 'ens18', type: 'ethernet', state: 'up', mtu: 1500, 'mac-address': 'BC:24:11:00:00:01' },
        { name: 'ens19', type: 'ethernet', state: 'up', mtu: 1500 },
        { name: 'lo', type: 'loopback', state: 'up' },
        { name: 'ovs-bridge', type: 'ovs-interface', state: 'up', mtu: 1500, ipv4: { address: [{ ip: '192.0.2.10', 'prefix-length': 24 }] } },
        { name: 'ovs-bridge', type: 'ovs-bridge', state: 'up', bridge: { port: [{ name: 'ens18' }, { name: 'ovs-bridge' }] } },
        { name: 'ovs-share', type: 'ovs-bridge', state: 'up', bridge: { port: [{ name: 'ens19' }, { name: 'ovs-share' }] } },
        { name: 'bond0', type: 'bond', state: 'up', 'link-aggregation': { mode: '802.3ad', port: ['ens20', 'ens21'] } },
        { name: 'bond0.10', type: 'vlan', state: 'up', vlan: { id: 10, 'base-iface': 'bond0' } },
      ],
    },
  },
};
const node: Obj = {
  metadata: { name: 'n1' },
  status: { capacity: { cpu: '8', 'ovs-cni.network.kubevirt.io/ovs-bridge': '1k', 'ovs-cni.network.kubevirt.io/ovs-share': '1k' } },
};

describe('parseCni', () => {
  it('reads a Linux bridge with a VLAN', () => {
    const c = parseCni(JSON.stringify({ cniVersion: '0.3.1', name: 'v6', type: 'bridge', bridge: 'br1', vlan: 100, ipam: {} }));
    expect(c).toMatchObject({ kind: 'linux-bridge', label: 'Linux bridge', bridge: 'br1', vlan: 100, ipam: 'None (set in the guest)' });
    expect(vlanLabel(c)).toBe('VLAN 100');
  });
  it('reads a plugin list: OVS with trunk, MTU from tuning', () => {
    const c = parseCni(
      JSON.stringify({ cniVersion: '0.4.0', name: 'x', plugins: [{ type: 'ovs', bridge: 'ovs-bridge', trunk: [{ id: 10 }, { minID: 20, maxID: 30 }] }, { type: 'tuning', mtu: 9000 }] })
    );
    expect(c).toMatchObject({ kind: 'ovs', label: 'OVS bridge', bridge: 'ovs-bridge', mtu: 9000, chained: ['tuning'] });
    expect(vlanLabel(c)).toBe('Trunk 10, 20-30');
  });
  it('reads macvlan, SR-IOV, OVN and odd configs', () => {
    expect(parseCni('{"type":"macvlan","master":"eth1","mode":"bridge","ipam":{"type":"dhcp"}}')).toMatchObject({
      kind: 'macvlan',
      master: 'eth1',
      ipam: 'DHCP (from the network)',
    });
    expect(parseCni('{"type":"sriov","vlan":0}')).toMatchObject({ kind: 'sriov', vlan: undefined });
    expect(parseCni('{"type":"ovn-k8s-cni-overlay","topology":"localnet"}').label).toBe('OVN localnet');
    expect(parseCni('').kind).toBe('host-file');
    expect(parseCni('{nope').error).toMatch(/not valid JSON/);
    expect(parseCni('{"type":"weird"}')).toMatchObject({ kind: 'other', label: 'weird' });
    expect(vlanLabel(parseCni('{"type":"bridge","bridge":"br0"}'))).toBe('Untagged');
  });
});

describe('networks and their VMs', () => {
  const vm = (ns: string, name: string, nets: any[]): Obj => ({ metadata: { namespace: ns, name }, spec: { template: { spec: { networks: nets } } } });
  it('resolves network references', () => {
    expect(nadRef('vlan100', 'prod')).toBe('prod/vlan100');
    expect(nadRef('default/vlan100', 'prod')).toBe('default/vlan100');
  });
  it('lists the pod network first, and who uses what', () => {
    const nads = [
      { metadata: { namespace: 'default', name: 'vlan100' }, spec: { config: '{"type":"ovs","bridge":"ovs-bridge","vlan":100}' } },
      { metadata: { namespace: 'prod', name: 'db' }, spec: { config: '{"type":"bridge","bridge":"br1"}' } },
    ];
    const vms = [
      vm('prod', 'web', [{ name: 'default', pod: {} }, { name: 'lan', multus: { networkName: 'default/vlan100' } }]),
      vm('prod', 'db', [{ name: 'db', multus: { networkName: 'db' } }]),
    ];
    const rows = networkRows(nads, vms);
    expect(rows.map(r => r.key)).toEqual(['pod', 'default/vlan100', 'prod/db']);
    expect(rows[0].uses.map(u => u.vm.metadata.name)).toEqual(['web']);
    expect(rows[1]).toMatchObject({ allFolders: true });
    expect(rows[1].uses[0].nic).toBe('lan');
    expect(rows[2]).toMatchObject({ allFolders: false });
    expect(rows[2].uses.map(u => u.vm.metadata.name)).toEqual(['db']);
  });
});

describe('host bridges', () => {
  it('finds OVS bridges with their uplinks and the marker', () => {
    const b = hostBridges([nns], [node]);
    expect(b.map(x => `${x.kind}:${x.name}`)).toEqual(['ovs:ovs-bridge', 'ovs:ovs-share']);
    expect(b[0]).toMatchObject({ hosts: ['n1'], ports: ['ens18'], marked: true });
  });
  it('offers only the bridge types the hosts have', () => {
    const [ovs, linux] = cniOffers([nns], [node], true);
    expect(ovs).toMatchObject({ available: true });
    expect(ovs.bridges.map(b => b.name)).toEqual(['ovs-bridge', 'ovs-share']);
    expect(linux.available).toBe(false);
    expect(linux.note).toMatch(/No host has a Linux bridge/);
  });
  it('says when OVS bridges exist without the OVS CNI plugin', () => {
    const [ovs] = cniOffers([nns], [{ metadata: { name: 'n1' }, status: { capacity: {} } }], true);
    expect(ovs.available).toBe(false);
    expect(ovs.note).toMatch(/OVS CNI plugin is not installed/);
  });
  it('offers both, with a typed bridge name, when it cannot see the hosts', () => {
    const offers = cniOffers([], [{ metadata: { name: 'n1' }, status: { capacity: {} } }], false);
    expect(offers.every(o => o.available && /cannot see/.test(o.note ?? ''))).toBe(true);
  });
  it('lists a host\'s interfaces in plain words', () => {
    const ifs = hostInterfaces(nns);
    expect(ifs.map(i => `${i.label}:${i.name}`)).toEqual([
      'Physical NIC:ens18',
      'Physical NIC:ens19',
      'Bond:bond0',
      'VLAN:bond0.10',
      'OVS bridge:ovs-bridge',
      'OVS bridge:ovs-share',
    ]);
    const br = ifs.find(i => i.name === 'ovs-bridge')!;
    expect(br.ips).toEqual(['192.0.2.10/24']);
    expect(br.detail).toBe('Ports: ens18');
    expect(ifs.find(i => i.name === 'bond0.10')!.detail).toBe('VLAN 10 on bond0');
  });
});

describe('nadManifest', () => {
  it('builds an OVS network on a VLAN, pinned to hosts with the bridge', () => {
    const m = nadManifest({ name: 'vlan100', namespace: 'default', kind: 'ovs', bridge: 'ovs-bridge', vlan: 100, marked: true, description: 'VM VLAN' });
    expect(JSON.parse(m.spec.config)).toEqual({ cniVersion: '0.4.0', name: 'vlan100', type: 'ovs', bridge: 'ovs-bridge', vlan: 100 });
    expect(m.metadata.annotations).toEqual({ 'k8s.v1.cni.cncf.io/resourceName': 'ovs-cni.network.kubevirt.io/ovs-bridge', description: 'VM VLAN' });
  });
  it('builds an untagged Linux bridge network without a marker', () => {
    const m = nadManifest({ name: 'lan', namespace: 'prod', kind: 'linux-bridge', bridge: 'br1', mtu: 9000 });
    expect(JSON.parse(m.spec.config)).toMatchObject({ type: 'bridge', bridge: 'br1', mtu: 9000, macspoofchk: true });
    expect(m.metadata.annotations).toBeUndefined();
  });
  it('validates VLAN and MTU', () => {
    expect(vlanProblem('')).toBeNull();
    expect(vlanProblem('4094')).toBeNull();
    expect(vlanProblem('4095')).toMatch(/1 to 4094/);
    expect(vlanProblem('1.5')).toMatch(/whole/);
    expect(mtuProblem('9000')).toBeNull();
    expect(mtuProblem('100')).toMatch(/576/);
  });
});
