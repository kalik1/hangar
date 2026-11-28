import * as P from './ports';
import { Obj } from './types';

const vmWith = (ifaces: any[], networks: any[], extra: any = {}): Obj => ({
  metadata: { name: 'web1', namespace: 'lab', uid: 'uid-web1' },
  spec: { template: { metadata: { labels: { app: 'web' } }, spec: { domain: { devices: { interfaces: ifaces } }, networks, ...extra } } },
});
const pod = { name: 'default', pod: {} };
const lan = { name: 'lan', multus: { networkName: 'lab/vlan10' } };

describe('SHA-1 and KubeVirt instance id', () => {
  it('hashes like sha1sum', () => {
    expect(P.sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(P.sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    // 56 bytes: the padding spills into a second block.
    expect(P.sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  });
  it('keeps names up to 63 characters and hashes longer ones (pkg/apimachinery/labels.go)', () => {
    expect(P.instanceId('web1')).toBe('web1');
    const long = 'a-very-long-virtual-machine-name-that-goes-well-beyond-sixty-three-chars';
    // printf %s "$long" | sha1sum → b7b7da69…
    expect(P.instanceId(long)).toBe(`${long.slice(0, 54)}-b7b7da69`);
    expect(P.instanceId(long)).toHaveLength(63);
  });
});

describe('selector', () => {
  it("selects KubeVirt's vmi.kubevirt.io/id from v1.7, and when the version is unknown", () => {
    const vm = vmWith([], []);
    expect(P.vmSelector(vm, { metadata: { name: 'kubevirt' }, status: { observedKubeVirtVersion: 'v1.9.1' } })).toEqual({ selector: { 'vmi.kubevirt.io/id': 'web1' }, viaTemplate: false });
    expect(P.vmSelector(vm, null).viaTemplate).toBe(false);
  });
  it("falls back to Hangar's template label before v1.7, which reaches the pod at the next start", () => {
    const vm = vmWith([], []);
    const sel = P.vmSelector(vm, { metadata: { name: 'kubevirt' }, status: { observedKubeVirtVersion: 'v1.6.3' } });
    expect(sel).toEqual({ selector: { 'hangar.magesgate.com/vm': 'web1' }, viaTemplate: true });
    expect(P.needsTemplateLabel(vm, sel)).toBe(true);
    expect(P.needsTemplateLabel(P.withTemplateLabel(vm), sel)).toBe(false);
    expect(P.withTemplateLabel(vm).spec.template.metadata.labels).toEqual({ app: 'web', 'hangar.magesgate.com/vm': 'web1' });
  });
  it('predicts the pod labels of a VM that is off, and reads the running pod', () => {
    const vm = vmWith([], [], { hostname: 'www' });
    expect(P.podLabels(vm)).toMatchObject({ app: 'web', 'vmi.kubevirt.io/id': 'web1', 'vm.kubevirt.io/name': 'www', 'kubevirt.io': 'virt-launcher' });
    expect(P.podLabels(vm, { metadata: { name: 'virt-launcher-web1-x', labels: { a: 'b' } } })).toEqual({ a: 'b' });
  });
  it("finds Hangar's Services for the VM and others that select its pod", () => {
    const vm = vmWith([], []);
    const svc = (name: string, labels: any, selector: any, type = 'ClusterIP'): Obj => ({ metadata: { name, namespace: 'lab', labels }, spec: { type, selector } });
    const mine = svc('web1-cluster', { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' }, { 'vmi.kubevirt.io/id': 'web1' });
    const theirs = svc('web', {}, { app: 'web' }, 'NodePort');
    const other = svc('db', {}, { app: 'db' });
    const empty = svc('ext', {}, undefined);
    const external = svc('alias', {}, { app: 'web' }, 'ExternalName');
    const elsewhere = { ...theirs, metadata: { ...theirs.metadata, namespace: 'prod' } };
    expect(P.vmServices([mine, theirs, other, empty, external, elsewhere], vm).map(s => s.metadata.name)).toEqual(['web1-cluster', 'web']);
  });
  it('matches label selectors with expressions', () => {
    const l = { a: '1', b: '2' };
    expect(P.selectorMatches(undefined, l)).toBe(true);
    expect(P.selectorMatches({ matchLabels: { a: '1' }, matchExpressions: [{ key: 'b', operator: 'In', values: ['2', '3'] }] }, l)).toBe(true);
    expect(P.selectorMatches({ matchExpressions: [{ key: 'c', operator: 'Exists' }] }, l)).toBe(false);
    expect(P.selectorMatches({ matchExpressions: [{ key: 'a', operator: 'NotIn', values: ['1'] }] }, l)).toBe(false);
    expect(P.selectorMatches({ matchExpressions: [{ key: 'c', operator: 'DoesNotExist' }] }, l)).toBe(true);
  });
});

describe('when a VM can publish ports, per interface type', () => {
  it('masquerade on the pod network: yes', () => {
    const a = P.publishAccess(vmWith([{ name: 'default', masquerade: {} }], [pod]));
    expect(a).toMatchObject({ state: 'ok', nic: 'default', binding: 'masquerade', list: { kind: 'all' } });
    expect(P.accessProblem(a)).toBeNull();
  });
  it('passt on the pod network: yes (the core binding and the plugin)', () => {
    expect(P.publishAccess(vmWith([{ name: 'default', passtBinding: {} }], [pod])).binding).toBe('passt');
    expect(P.publishAccess(vmWith([{ name: 'default', binding: { name: 'passt' } }], [pod])).state).toBe('ok');
  });
  it('bridge on the pod network: no, and Hangar says why', () => {
    const a = P.publishAccess(vmWith([{ name: 'default', bridge: {} }], [pod]));
    expect(a.state).toBe('pod-bridge');
    expect(P.accessProblem(a)).toMatch(/bridge: the pod has no address/);
  });
  it("no binding written: KubeVirt's default, bridge unless the KubeVirt CR says masquerade", () => {
    const vm = vmWith([{ name: 'default' }], [pod]);
    expect(P.publishAccess(vm).state).toBe('pod-bridge');
    expect(P.publishAccess(vm, null, { metadata: { name: 'kv' }, spec: { configuration: { network: { defaultNetworkInterface: 'masquerade' } } } }).state).toBe('ok');
    // The running instance has the default filled in.
    expect(P.publishAccess(vm, { metadata: { name: 'web1' }, spec: { domain: { devices: { interfaces: [{ name: 'default', masquerade: {} }] } } } }).state).toBe('ok');
  });
  it('secondary networks only: not needed, the VM has its own address there', () => {
    const vmi = { metadata: { name: 'web1' }, status: { interfaces: [{ name: 'lan', ipAddresses: ['192.0.2.50', 'fe80::1'] }] } };
    const a = P.publishAccess(vmWith([{ name: 'lan', bridge: {} }], [lan]), vmi);
    expect(a.state).toBe('secondary-only');
    expect(a.secondary).toEqual([{ nic: 'lan', network: 'lab/vlan10', ips: ['192.0.2.50'] }]);
    expect(P.accessProblem(a)).toMatch(/own address there/);
  });
  it('mixed: publishes through the pod adapter and lists the secondary address', () => {
    const vmi = { metadata: { name: 'web1' }, status: { interfaces: [{ name: 'default', ipAddresses: ['10.0.2.2', 'fd10::2'] }, { name: 'lan', ipAddress: '192.0.2.50' }] } };
    const a = P.publishAccess(vmWith([{ name: 'default', masquerade: {} }, { name: 'lan', bridge: {} }], [pod, lan]), vmi);
    expect(a).toMatchObject({ state: 'ok', nic: 'default', ipv6: true, secondary: [{ nic: 'lan', ips: ['192.0.2.50'] }] });
  });
  it("no adapter written: KubeVirt's auto-attached pod adapter, unless turned off", () => {
    expect(P.publishAccess(vmWith([], [])).state).toBe('pod-bridge');
    const kv = { metadata: { name: 'kv' }, spec: { configuration: { network: { defaultNetworkInterface: 'masquerade' } } } };
    expect(P.publishAccess(vmWith([], []), null, kv)).toMatchObject({ state: 'ok', nic: 'default' });
    const none = vmWith([], []);
    none.spec.template.spec.domain.devices.autoattachPodInterface = false;
    expect(P.publishAccess(none).state).toBe('none');
  });
});

describe("the adapter's ports list", () => {
  const ssh = { port: 22, protocol: 'TCP' as const };
  const dns = { port: 53, protocol: 'UDP' as const };
  it('a missing list forwards everything: nothing to add, no restart', () => {
    const a = P.publishAccess(vmWith([{ name: 'default', masquerade: {} }], [pod]));
    expect(P.missingFromList(a.list, [ssh, dns])).toEqual([]);
  });
  it('a set list forwards only its ports: the published ones are added (applies at the next restart)', () => {
    const vm = vmWith([{ name: 'default', masquerade: {}, ports: [{ name: 'http', port: 80 }] }], [pod]);
    const a = P.publishAccess(vm);
    expect(a.list.kind).toBe('ports');
    expect(P.missingFromList(a.list, [ssh, { port: 80, protocol: 'TCP' }, dns, ssh])).toEqual([ssh, dns]);
    const next = P.withListedPorts(vm, 'default', [ssh, dns]);
    expect(next.spec.template.spec.domain.devices.interfaces[0].ports).toEqual([{ name: 'http', port: 80 }, { port: 22, protocol: 'TCP' }, { port: 53, protocol: 'UDP' }]);
    // The VM itself is not changed.
    expect(vm.spec.template.spec.domain.devices.interfaces[0].ports).toHaveLength(1);
  });
  it('an adapter with portRanges gets ranges (the two lists are exclusive)', () => {
    const vm = vmWith([{ name: 'default', masquerade: {}, portRanges: [{ protocol: 'TCP', start: 8000, end: 8010 }] }], [pod]);
    const a = P.publishAccess(vm);
    expect(P.missingFromList(a.list, [{ port: 8005, protocol: 'TCP' }])).toEqual([]);
    const add = [22, 23, 24, 30].map(port => ({ port, protocol: 'TCP' as const }));
    const next = P.withListedPorts(vm, 'default', add);
    expect(next.spec.template.spec.domain.devices.interfaces[0].portRanges).toEqual([
      { protocol: 'TCP', start: 8000, end: 8010 },
      { protocol: 'TCP', start: 22, end: 24 },
      { protocol: 'TCP', start: 30, end: 30 },
    ]);
    expect(next.spec.template.spec.domain.devices.interfaces[0].ports).toBeUndefined();
  });
});

describe('choosing ports', () => {
  it('expands ranges and lists, with per-entry protocols', () => {
    expect(P.parsePorts('22').ports).toEqual([{ port: 22, protocol: 'TCP' }]);
    expect(P.parsePorts('80, 443 53/udp').ports.map(p => `${p.port}/${p.protocol}`)).toEqual(['80/TCP', '443/TCP', '53/UDP']);
    const r = P.parsePorts('10000-10050/udp');
    expect(r.ports).toHaveLength(51);
    expect(r.ports[0]).toEqual({ port: 10000, protocol: 'UDP' });
    expect(P.parsePorts('5000-5009', 'UDP').ports.every(p => p.protocol === 'UDP')).toBe(true);
  });
  it('refuses more than 100 ports at once, and says how many', () => {
    expect(P.parsePorts('10000-10099').ports).toHaveLength(100);
    const r = P.parsePorts('10000-10100');
    expect(r.ports).toEqual([]);
    expect(r.error).toMatch(/101 ports: Hangar publishes at most 100/);
  });
  it('refuses what is not a port', () => {
    expect(P.parsePorts('').error).toBeDefined();
    expect(P.parsePorts('0').error).toMatch(/1 to 65535/);
    expect(P.parsePorts('70000').error).toMatch(/1 to 65535/);
    expect(P.parsePorts('90-80').error).toMatch(/lower port/);
    expect(P.parsePorts('ssh').error).toMatch(/not a port/);
  });
  it('orders presets by guest OS', () => {
    expect(P.presetsFor('ubuntu')[0].id).toBe('ssh');
    expect(P.presetsFor('windows').slice(0, 2).map(p => p.id)).toEqual(['rdp', 'winrm']);
    expect(P.presetsFor('')[0].id).toBe('ssh');
    expect(P.presetsFor('windows')).toHaveLength(P.PRESETS.length);
  });
  it('names ports as Services want them', () => {
    expect(P.portName({ port: 22, protocol: 'TCP' }, 'ssh')).toBe('ssh');
    expect(P.portName({ port: 53, protocol: 'UDP' }, 'dns')).toBe('dns-udp');
    expect(P.portName({ port: 10000, protocol: 'UDP' })).toBe('udp-10000');
    expect(P.portName({ port: 8080, protocol: 'TCP' }, 'Not A Name!')).toBe('tcp-8080');
    expect(P.portName({ port: 8080, protocol: 'TCP' }, 'a-very-long-port-name')).toBe('tcp-8080');
  });
});

describe("Hangar's Service", () => {
  const vm = vmWith([{ name: 'default', masquerade: {} }], [pod]);
  it('is named after the VM and the way it publishes, as a DNS-1035 label', () => {
    expect(P.serviceName('web1', 'cluster')).toBe('web1-cluster');
    expect(P.serviceName('web1', 'host')).toBe('web1-nodeport');
    expect(P.serviceName('web1', 'address')).toBe('web1-lb');
    expect(P.serviceName('1st.vm', 'cluster')).toBe('vm-1st-vm-cluster');
    const long = P.serviceName('x'.repeat(70), 'host');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^x+-[0-9a-f]{5}-nodeport$/);
  });
  it('is owned by the VM (as virtctl expose does) and selects its pod', () => {
    const s = P.serviceManifest({ vm, mode: 'cluster', selector: { 'vmi.kubevirt.io/id': 'web1' }, ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' }] });
    expect(s.metadata).toMatchObject({
      name: 'web1-cluster',
      namespace: 'lab',
      labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1', 'hangar.magesgate.com/publish': 'cluster' },
      ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'web1', uid: 'uid-web1', controller: true, blockOwnerDeletion: false }],
    });
    expect(s.spec).toEqual({ type: 'ClusterIP', selector: { 'vmi.kubevirt.io/id': 'web1' }, ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' }] });
  });
  it('NodePort: a chosen host port, and the client source address on request', () => {
    const s = P.serviceManifest({ vm, mode: 'host', selector: {}, keepSourceIp: true, ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP', nodePort: 30022 }, { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }] });
    expect(s.spec.type).toBe('NodePort');
    expect(s.spec.externalTrafficPolicy).toBe('Local');
    expect(s.spec.ports.map((p: any) => p.nodePort)).toEqual([30022, undefined]);
  });
  it('LoadBalancer on MetalLB: names the pool, and the address when chosen; no host ports', () => {
    const s = P.serviceManifest({ vm, mode: 'address', selector: {}, lb: { controller: 'metallb', pool: 'vms', ip: '192.0.2.40' }, ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' }] });
    expect(s.metadata.annotations).toEqual({ 'metallb.io/address-pool': 'vms', 'metallb.io/loadBalancerIPs': '192.0.2.40' });
    expect(s.spec.allocateLoadBalancerNodePorts).toBe(false);
    expect(s.spec.loadBalancerClass).toBeUndefined();
  });
  it("LoadBalancer on Cilium: the address annotation, and Cilium's class when MetalLB also runs", () => {
    const s = P.serviceManifest({ vm, mode: 'address', selector: {}, lb: { controller: 'cilium', ip: '192.0.2.70', ciliumClass: true }, ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' }] });
    expect(s.metadata.annotations).toEqual({ 'lbipam.cilium.io/ips': '192.0.2.70' });
    expect(s.spec.loadBalancerClass).toBe('io.cilium/l2-announcer');
    // The pools cannot be read: an address chosen for whichever controller runs.
    const unknown = P.serviceManifest({ vm, mode: 'address', selector: {}, lb: { ip: '192.0.2.70' }, ports: [] });
    expect(unknown.metadata.annotations).toEqual({ 'metallb.io/loadBalancerIPs': '192.0.2.70', 'lbipam.cilium.io/ips': '192.0.2.70' });
    const plain = P.serviceManifest({ vm, mode: 'address', selector: {}, lb: { controller: 'cilium' }, ports: [] });
    expect(plain.metadata.annotations).toBeUndefined();
    expect(plain.spec.loadBalancerClass).toBeUndefined();
  });
  it('refuses duplicates in the Service and guest ports the VM already publishes that way', () => {
    const existing: Obj[] = [
      { metadata: { name: 'web1-nodeport', namespace: 'lab', labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' } }, spec: { type: 'NodePort', ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' }] } },
      { metadata: { name: 'theirs', namespace: 'lab' }, spec: { type: 'ClusterIP', ports: [{ port: 8080, targetPort: 80 }] } },
    ];
    const p = (port: number, targetPort = port, name = `tcp-${port}`) => ({ name, port, targetPort, protocol: 'TCP' as const });
    expect(P.conflictOf([p(22)], 'host', existing, 'web1')).toMatch(/already published on every host's port/);
    expect(P.conflictOf([p(2222, 2222, 'ssh')], 'host', existing, 'web1')).toMatch(/named ssh/);
    expect(P.conflictOf([p(81, 80)], 'cluster', existing, 'web1')).toMatch(/Guest port 80\/TCP is already published inside the cluster by theirs/);
    expect(P.conflictOf([p(22)], 'cluster', existing, 'web1')).toBeNull();
    expect(P.conflictOf([p(23), p(23)], 'host', existing, 'web1')).toMatch(/twice/);
    const squatter = [{ metadata: { name: 'web1-lb', namespace: 'lab' }, spec: { type: 'LoadBalancer', ports: [] } }];
    expect(P.conflictOf([p(22)], 'address', squatter, 'web1')).toMatch(/Hangar did not make it/);
  });
  it('checks a chosen host port', () => {
    const taken = [{ metadata: { name: 'db-nodeport', namespace: 'prod' }, spec: { type: 'NodePort', ports: [{ port: 5432, nodePort: 30432 }] } }];
    expect(P.nodePortProblem(30022, taken)).toBeNull();
    expect(P.nodePortProblem(30432, taken)).toBe('Port 30432 is taken by prod/db-nodeport');
    expect(P.nodePortProblem(8080, taken)).toMatch(/30000 to 32767/);
  });
  it('adds ports to the existing Service', () => {
    const svc = { metadata: { name: 'web1-nodeport' }, spec: { ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP', nodePort: 30022 }] } };
    expect(P.mergedPorts(svc, [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP', nodePort: 30080 }], 'host')).toEqual([
      { name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP', nodePort: 30022 },
      { name: 'http', port: 80, targetPort: 80, protocol: 'TCP', nodePort: 30080 },
    ]);
  });
});

describe('feedback rows', () => {
  const svc: Obj = { metadata: { name: 'web1-nodeport', namespace: 'lab', uid: 's1', labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' } }, spec: { type: 'NodePort', ports: [{ name: 'ssh', port: 22, targetPort: 22, nodePort: 30022 }, { name: 'dns', port: 53, targetPort: 53, protocol: 'UDP', nodePort: 31053 }] } };
  const slice = (endpoints: any[]): Obj => ({ metadata: { name: 'web1-nodeport-abc', namespace: 'lab', labels: { 'kubernetes.io/service-name': 'web1-nodeport' } }, endpoints });
  it('lists one row per Service port, with the allocated host port', () => {
    const rows = P.portRows([svc], 'web1');
    expect(rows.map(r => [r.name, r.protocol, r.guest, r.nodePort, r.managed])).toEqual([
      ['ssh', 'TCP', 22, 30022, true],
      ['dns', 'UDP', 53, 31053, true],
    ]);
    expect(P.guestPortsOf(rows)).toEqual([{ port: 22, protocol: 'TCP' }, { port: 53, protocol: 'UDP' }]);
  });
  it("the VM behind it: ready, not ready yet, off, and its pod not selected are separate states", () => {
    expect(P.behindState(svc, [slice([{ conditions: { ready: true }, targetRef: { kind: 'Pod', name: 'virt-launcher-web1-x' } }])], true)).toBe('ready');
    expect(P.behindState(svc, [slice([{ conditions: { ready: false } }])], true)).toBe('not-ready');
    expect(P.behindState(svc, [slice([])], false)).toBe('off');
    expect(P.behindState(svc, [], true)).toBe('not-selected');
    // A live migration: the old pod terminates, the new one is ready.
    expect(P.behindState(svc, [slice([{ conditions: { ready: false, terminating: true } }, { conditions: { ready: true } }])], true)).toBe('ready');
    // Another Service's slice does not count.
    expect(P.behindState(svc, [{ ...slice([{ conditions: { ready: true } }]), metadata: { name: 'x', namespace: 'lab', labels: { 'kubernetes.io/service-name': 'other' } } }], true)).toBe('not-selected');
  });
  it('host addresses: IPv4 unless the VM has IPv6', () => {
    const nodes = [{ metadata: { name: 'h1' }, status: { addresses: [{ type: 'InternalIP', address: '192.0.2.10' }, { type: 'InternalIP', address: '2001:db8::10' }, { type: 'Hostname', address: 'h1' }] } }];
    expect(P.hostAddresses(nodes)).toEqual([{ host: 'h1', ip: '192.0.2.10' }]);
    expect(P.hostAddresses(nodes, true)).toHaveLength(2);
  });
  it('connect lines: ssh with the cloud-init user, URLs for web ports', () => {
    expect(P.connectLine(22, '192.0.2.10', 30022, 'k4all')).toBe('ssh -p 30022 k4all@192.0.2.10');
    expect(P.connectLine(22, '192.0.2.40', 22)).toBe('ssh user@192.0.2.40');
    expect(P.connectLine(80, '192.0.2.40', 80)).toBe('http://192.0.2.40/');
    expect(P.connectLine(443, '192.0.2.10', 30443)).toBe('https://192.0.2.10:30443/');
    expect(P.connectLine(5432, 'db.lab.svc', 5432)).toBe('db.lab.svc:5432');
    expect(P.cloudInitUser('#cloud-config\nuser: k4all\npassword: x\n')).toBe('k4all');
    expect(P.cloudInitUser('#cloud-config\nusers:\n  - default\n  - name: ops\n    sudo: ALL\n')).toBe('ops');
    expect(P.cloudInitUser('#cloud-config\nusers:\n  - name: "admin"\n')).toBe('admin');
    expect(P.cloudInitUser('#cloud-config\npackages: [nginx]\n')).toBeUndefined();
  });
});

describe('address pools', () => {
  const mlb = (name: string, addresses: string[], extra: any = {}, status?: any): Obj => ({ metadata: { name, namespace: 'metallb-system' }, spec: { addresses, ...extra }, ...(status ? { status } : {}) });
  const cpool = (name: string, blocks: any[], extra: any = {}, conditions?: any[]): Obj => ({ metadata: { name }, spec: { blocks, ...extra }, ...(conditions ? { status: { conditions } } : {}) });
  const held = (ip: string): Obj => ({ metadata: { name: 'x', namespace: 'lab' }, spec: { type: 'LoadBalancer' }, status: { loadBalancer: { ingress: [{ ip }] } } });
  const vm = vmWith([], []);

  it('counts free addresses: the controller first, else from the Services', () => {
    const pools = P.parsePools(
      [mlb('vms', ['192.0.2.32/29', '192.0.2.100-192.0.2.101']), mlb('counted', ['198.51.100.0/30'], {}, { availableIPv4: 3, assignedIPv4: 1, availableIPv6: 0, assignedIPv6: 0 })],
      [cpool('cil', [{ cidr: '203.0.113.0/28' }, { start: '203.0.113.100', stop: '203.0.113.101' }], {}, [{ type: 'cilium.io/IPsTotal', message: '18' }, { type: 'cilium.io/IPsAvailable', message: '17' }])],
      [held('192.0.2.33')]
    );
    expect(pools.map(p => [p.kind, p.name, p.total, p.free])).toEqual([
      ['metallb', 'vms', 10, 9],
      ['metallb', 'counted', 4, 3],
      ['cilium', 'cil', 18, 17],
    ]);
    expect(pools[2].addresses).toEqual(['203.0.113.0/28', '203.0.113.100-203.0.113.101']);
  });

  it("never offers k4all's ingress pool", () => {
    const uses = P.poolUses(P.parsePools([mlb('k4all-ingress-pool', ['192.0.2.5/32'])], [], []), vm, {});
    expect(uses).toEqual([expect.objectContaining({ ok: false, why: expect.stringMatching(/ingress/) })]);
    expect(P.autoPool(uses)).toBeNull();
  });

  it("MetalLB: honours the pool's serviceAllocation", () => {
    const pools = P.parsePools(
      [
        mlb('other-ns', ['192.0.2.40/30'], { serviceAllocation: { namespaces: ['prod'] } }),
        mlb('by-label', ['192.0.2.44/30'], { serviceAllocation: { namespaceSelectors: [{ matchLabels: { team: 'lab' } }] } }),
        mlb('svc-sel', ['192.0.2.48/30'], { serviceAllocation: { serviceSelectors: [{ matchLabels: { tier: 'db' } }] } }),
        mlb('full', ['192.0.2.52/32']),
        mlb('ok', ['192.0.2.56/29'], { autoAssign: false }),
      ],
      [],
      [held('192.0.2.52')]
    );
    const uses = P.poolUses(pools, vm, { team: 'lab' });
    expect(uses.map(u => [u.pool.name, u.ok, u.why])).toEqual([
      ['other-ns', false, 'Only for prod'],
      ['by-label', true, undefined],
      ['svc-sel', false, 'Selects other Services'],
      ['full', false, 'No free address'],
      ['ok', true, undefined],
    ]);
    // Hangar names the pool, so one that does not auto-assign is fine.
    expect(P.autoPool(uses)?.name).toBe('ok');
  });

  it("Cilium: the pool's serviceSelector, and turned-off pools", () => {
    const pools = P.parsePools(
      [],
      [
        cpool('any', [{ cidr: '203.0.113.0/29' }]),
        cpool('ns-only', [{ cidr: '203.0.113.8/29' }], { serviceSelector: { matchLabels: { 'io.kubernetes.service.namespace': 'prod' } } }),
        cpool('vms', [{ cidr: '203.0.113.16/29' }], { serviceSelector: { matchLabels: { 'app.kubernetes.io/managed-by': 'hangar' } } }),
        cpool('off', [{ cidr: '203.0.113.24/29' }], { disabled: true }),
      ],
      []
    );
    expect(P.poolUses(pools, vm, {}).map(u => [u.pool.name, u.ok])).toEqual([
      ['any', true],
      ['ns-only', false],
      ['vms', true],
      ['off', false],
    ]);
  });

  it('checks a chosen address against the pool and the Services', () => {
    const [pool] = P.parsePools([mlb('vms', ['192.0.2.32/29'])], [], []);
    expect(P.ipProblem('192.0.2.33', pool, [])).toBeNull();
    expect(P.ipProblem('192.0.2.99', pool, [])).toMatch(/not in vms/);
    expect(P.ipProblem('192.0.2.33', pool, [held('192.0.2.33')])).toMatch(/taken/);
    expect(P.ipProblem('nope', pool, [])).toMatch(/IPv4/);
  });

  it('says what the admin must create when no pool serves VMs, per CNI', () => {
    expect(P.noPoolHelp({ cilium: true, metallb: false, k4all: true })).toMatch(/CiliumLoadBalancerIPPool.*CiliumL2AnnouncementPolicy.*l2announcements in k4all's ClusterConfig/);
    expect(P.noPoolHelp({ cilium: false, metallb: true, k4all: true })).toMatch(/IPAddressPool.*L2Advertisement.*k4all-ingress-pool holds only/);
    expect(P.noPoolHelp({ cilium: false, metallb: false, k4all: false })).toMatch(/No load balancer/);
  });
});

describe('LoadBalancer feedback', () => {
  const pools = P.parsePools([{ metadata: { name: 'vms', namespace: 'metallb-system' }, spec: { addresses: ['192.0.2.32/29'] } }], [{ metadata: { name: 'cil' }, spec: { blocks: [{ cidr: '203.0.113.0/28' }] } }], []);
  const svc = (extra: any = {}, status: any = {}): Obj => ({
    metadata: { name: 'web1-lb', namespace: 'lab', uid: 'lb1', annotations: extra.annotations },
    spec: { type: 'LoadBalancer', ...(extra.spec ?? {}) },
    status,
  });
  const ev = (reason: string, message: string, at: string, uid = 'lb1'): Obj => ({ metadata: { name: `e-${reason}` }, involvedObject: { kind: 'Service', name: 'web1-lb', uid }, reason, message, lastTimestamp: at });

  describe('MetalLB', () => {
    const m = { annotations: { 'metallb.io/address-pool': 'vms' } };
    it('waiting: no address yet', () => {
      expect(P.lbState(svc(m), { pools })).toEqual({ phase: 'waiting', controller: 'metallb' });
    });
    it('assigned: the address and the pool', () => {
      const s = svc({ annotations: { ...m.annotations, 'metallb.io/ip-allocated-from-pool': 'vms' } }, { loadBalancer: { ingress: [{ ip: '192.0.2.33' }] } });
      expect(P.lbState(s, { pools, events: [ev('IPAllocated', 'Assigned IP ["192.0.2.33"]', '2026-11-28T10:00:00Z')] })).toEqual({
        phase: 'assigned',
        address: '192.0.2.33',
        pool: 'vms',
        controller: 'metallb',
        node: undefined,
      });
    });
    it("announced: the host from the speaker's event, or from ServiceL2Status", () => {
      const s = svc(m, { loadBalancer: { ingress: [{ ip: '192.0.2.33' }] } });
      const events = [ev('IPAllocated', 'Assigned IP ["192.0.2.33"]', '2026-11-28T10:00:00Z'), ev('nodeAssigned', 'announcing from node "host-b" with protocol "layer2"', '2026-11-28T10:00:01Z')];
      expect(P.lbState(s, { pools, events })).toMatchObject({ phase: 'announced', node: 'host-b', pool: 'vms' });
      expect(P.lbState(s, { pools, metallbNode: 'host-c' })).toMatchObject({ phase: 'announced', node: 'host-c' });
    });
    it('failed: no free address, in words', () => {
      const events = [ev('AllocationFailed', 'Failed to allocate IP for "lab/web1-lb": no available IPs', '2026-11-28T10:00:00Z')];
      expect(P.lbState(svc(m), { pools, events })).toMatchObject({ phase: 'failed', controller: 'metallb', reason: expect.stringMatching(/^No free address in the pools: /) });
    });
    it('a failure older than the allocation, or of an earlier Service with the same name, does not count', () => {
      const events = [ev('AllocationFailed', 'x', '2026-11-28T09:00:00Z'), ev('IPAllocated', 'y', '2026-11-28T10:00:00Z')];
      expect(P.lbState(svc(m), { pools, events }).phase).toBe('waiting');
      expect(P.lbState(svc(m), { pools, events: [ev('AllocationFailed', 'x', '2026-11-28T09:00:00Z', 'older-uid')] }).phase).toBe('waiting');
    });
  });

  describe('Cilium LB IPAM + L2', () => {
    const c = { spec: { loadBalancerClass: 'io.cilium/l2-announcer' } };
    it('waiting', () => {
      expect(P.lbState(svc(c), { pools })).toEqual({ phase: 'waiting', controller: 'cilium' });
    });
    it('assigned: the address and the pool that holds it', () => {
      const s = svc(c, { loadBalancer: { ingress: [{ ip: '203.0.113.5' }] }, conditions: [{ type: 'cilium.io/IPAMRequestSatisfied', status: 'True', reason: 'satisfied' }] });
      expect(P.lbState(s, { pools })).toEqual({ phase: 'assigned', address: '203.0.113.5', pool: 'cil', controller: 'cilium', node: undefined });
    });
    it('announced: the holder of the L2 announcement lease', () => {
      const s = svc({}, { loadBalancer: { ingress: [{ ip: '203.0.113.5' }] }, conditions: [{ type: 'cilium.io/IPAMRequestSatisfied', status: 'True', reason: 'satisfied' }] });
      expect(P.lbState(s, { pools, ciliumLeaseHolder: 'host-a' })).toMatchObject({ phase: 'announced', node: 'host-a', controller: 'cilium' });
    });
    it("failed: the condition's reason, in words", () => {
      const s = svc(c, { conditions: [{ type: 'cilium.io/IPAMRequestSatisfied', status: 'False', reason: 'no_pool', message: 'There are no enabled CiliumLoadBalancerIPPools that match this service' }] });
      expect(P.lbState(s, { pools })).toEqual({ phase: 'failed', controller: 'cilium', reason: 'No CiliumLoadBalancerIPPool selects this Service' });
      const odd = svc(c, { conditions: [{ type: 'cilium.io/IPAMRequestSatisfied', status: 'False', reason: 'new_reason', message: 'Something new' }] });
      expect(P.lbState(odd, { pools }).reason).toBe('Something new');
    });
  });
});

describe('datacenter view', () => {
  const vm = (name: string, ns = 'lab'): Obj => ({ metadata: { name, namespace: ns }, spec: { template: { metadata: { labels: { app: name } } } } });
  const hsvc = (vmName: string, type: string, ports: any[], status?: any, name = `${vmName}-${type === 'NodePort' ? 'nodeport' : type === 'LoadBalancer' ? 'lb' : 'cluster'}`): Obj => ({
    metadata: { name, namespace: 'lab', labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': vmName } },
    spec: { type, selector: { 'vmi.kubevirt.io/id': vmName }, ports },
    ...(status ? { status } : {}),
  });
  it('lists every published port with its VM, and flags conflicts', () => {
    const vms = [vm('a'), vm('b')];
    const services: Obj[] = [
      hsvc('a', 'NodePort', [{ name: 'ssh', port: 22, targetPort: 22, nodePort: 30022 }]),
      { metadata: { name: 'a-extra', namespace: 'lab' }, spec: { type: 'NodePort', selector: { app: 'a' }, ports: [{ port: 22, targetPort: 22, nodePort: 30023 }] } },
      hsvc('b', 'LoadBalancer', [{ name: 'http', port: 80, targetPort: 80 }], { loadBalancer: { ingress: [{ ip: '192.0.2.40' }] } }),
      { metadata: { name: 'shared', namespace: 'lab' }, spec: { type: 'LoadBalancer', selector: { app: 'b' }, ports: [{ port: 80, targetPort: 8080 }] }, status: { loadBalancer: { ingress: [{ ip: '192.0.2.40' }] } } },
      hsvc('gone', 'ClusterIP', [{ name: 'ssh', port: 22, targetPort: 22 }]),
      { metadata: { name: 'unrelated', namespace: 'lab' }, spec: { type: 'ClusterIP', selector: { app: 'other' }, ports: [{ port: 1 }] } },
    ];
    const rows = P.datacenterRows(services, vms, new Map());
    const by = (svc: string) => rows.find(r => r.service.metadata.name === svc)!;
    expect(rows).toHaveLength(5);
    expect(by('a-nodeport').conflict).toMatch(/Published twice: a-nodeport, a-extra/);
    expect(by('a-extra').managed).toBe(false);
    expect(by('b-lb').conflict).toMatch(/Another Service uses 192.0.2.40:80\/TCP/);
    expect(by('gone-cluster').conflict).toBe('Its VM is gone');
    expect(by('gone-cluster').vm).toBeUndefined();
  });
});
