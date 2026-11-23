import * as P from './podnet';

const nodes = [
  { metadata: { name: 'kube-bootstrap.lab' }, status: { addresses: [{ type: 'InternalIP', address: '192.168.6.202' }, { type: 'Hostname', address: 'x' }] } },
  { metadata: { name: 'kube-worker-a.lab' }, status: { addresses: [{ type: 'InternalIP', address: '192.168.6.142' }] } },
  { metadata: { name: 'kube-worker-b.lab' }, status: { addresses: [{ type: 'InternalIP', address: '192.168.6.143' }] } },
];
const cilium = [
  { metadata: { name: 'kube-bootstrap.lab' }, spec: { ipam: { podCIDRs: ['10.0.0.0/24'] } } },
  { metadata: { name: 'kube-worker-a.lab' }, spec: { ipam: { podCIDRs: ['10.0.1.0/24'] } } },
  { metadata: { name: 'kube-worker-b.lab' }, spec: { ipam: { podCIDRs: ['10.0.2.0/24'] } } },
];
const vm = (networks: any[], ifaces: any[] = networks.map(n => ({ name: n.name, ...(n.pod ? { masquerade: {} } : { bridge: {} }) }))): any => ({
  metadata: { name: 'v', namespace: 'lab' },
  spec: { template: { spec: { domain: { devices: { interfaces: ifaces } }, networks } } },
});

describe('pod network NAT range', () => {
  it('parses and compares IPv4 ranges', () => {
    expect(P.parseCidr('10.0.2.7/24')).toEqual({ base: P.parseIp('10.0.2.0'), bits: 24 });
    expect(P.parseCidr('fd00::/64')).toBeNull();
    expect(P.overlaps('10.0.2.0/24', '10.0.0.0/16')).toBe(true);
    expect(P.overlaps('10.0.2.0/24', '10.0.3.0/24')).toBe(false);
    expect(P.overlaps('172.31.254.0/24', '172.31.254.9')).toBe(true);
    expect(P.overlaps('10.0.2.0/24', '10.96.0.0/16')).toBe(false);
  });
  it('reads the cluster ranges: Cilium first, else Node podCIDRs, else pod addresses', () => {
    const f = P.netFacts({ nodes, ciliumNodes: cilium, serviceCidrs: [{ spec: { cidrs: ['10.96.0.0/16', 'fd00:10:96::/112'] } }] });
    expect(f.podCidrs.map(p => p.cidr)).toEqual(['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24']);
    expect(f.serviceCidrs).toEqual(['10.96.0.0/16']);
    expect(f.hostIps).toHaveLength(3);
    const k8s = P.netFacts({ nodes: [{ ...nodes[0], spec: { podCIDRs: ['10.244.0.0/24'] } }], kubernetesServiceIp: '10.96.0.1' });
    expect(k8s.podCidrs).toEqual([{ host: 'kube-bootstrap.lab', cidr: '10.244.0.0/24' }]);
    expect(k8s.serviceCidrs).toEqual(['10.96.0.0/16']);
    const ips = P.netFacts({ nodes, pods: [{ spec: { nodeName: 'kube-worker-b.lab' }, status: { podIP: '10.0.2.8' } }, { spec: { nodeName: 'x', hostNetwork: true }, status: { podIP: '192.168.6.142' } }] });
    expect(ips.podIps).toEqual([{ host: 'kube-worker-b.lab', ip: '10.0.2.8' }]);
  });
  it('keeps 10.0.2.0/24 when it is free, else takes a reserved /24', () => {
    const free = P.netFacts({ nodes, ciliumNodes: cilium.slice(0, 2) });
    expect(P.freeVmCidr(free)).toBe('10.0.2.0/24');
    const taken = P.netFacts({ nodes, ciliumNodes: cilium });
    expect(P.cidrConflicts('10.0.2.0/24', taken)).toEqual(['the pod network of kube-worker-b (10.0.2.0/24)']);
    expect(P.freeVmCidr(taken)).toBe('172.31.254.0/24');
    const crowded = { ...taken, hostIps: [{ host: 'h', ip: '172.31.254.10' }] };
    expect(P.freeVmCidr(crowded)).toBe('172.31.253.0/24');
    const ips = P.netFacts({ nodes, pods: [{ spec: { nodeName: 'kube-worker-b.lab' }, status: { podIP: '10.0.2.8' } }] });
    expect(P.cidrConflicts('10.0.2.0/24', ips)).toEqual(['pod addresses of kube-worker-b']);
  });
  it('finds pod-network adapters whose NAT range overlaps, and fixes them', () => {
    const f = P.netFacts({ nodes, ciliumNodes: cilium });
    const v = vm([{ name: 'default', pod: {} }, { name: 'lan', multus: { networkName: 'lab/vlan' } }]);
    expect(P.podNetIssues(v, f)).toEqual([{ nic: 'default', cidr: '10.0.2.0/24', isDefault: true, conflicts: ['the pod network of kube-worker-b (10.0.2.0/24)'] }]);
    const fixed = P.setVmNetworkCidr(v, '172.31.254.0/24');
    expect(fixed.spec.template.spec.networks[0]).toEqual({ name: 'default', pod: { vmNetworkCIDR: '172.31.254.0/24' } });
    expect(fixed.spec.template.spec.networks[1]).toEqual({ name: 'lan', multus: { networkName: 'lab/vlan' } });
    expect(P.podNetIssues(fixed, f)).toEqual([]);
    expect(P.vmNetworkCidrOf(fixed, 'default')).toBe('172.31.254.0/24');
    // Not masquerade (e.g. passt binding): no NAT range to worry about.
    expect(P.podNetIssues(vm([{ name: 'default', pod: {} }], [{ name: 'default', binding: { name: 'passt' } }]), f)).toEqual([]);
  });
});
