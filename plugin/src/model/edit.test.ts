import * as E from './edit';

const vm = () => ({
  metadata: { name: 'db', namespace: 'prod', labels: { app: 'shop', 'kubevirt.io/x': 'y' }, resourceVersion: '7' },
  spec: {
    instancetype: { name: 'u1.small', revisionName: 'r1' },
    dataVolumeTemplates: [{ metadata: { name: 'db-root' }, spec: {} }],
    template: {
      spec: {
        domain: {
          memory: { guest: '2Gi' },
          devices: {
            disks: [{ name: 'root', disk: { bus: 'virtio' }, bootOrder: 1 }],
            interfaces: [{ name: 'default', masquerade: {} }],
          },
        },
        volumes: [
          { name: 'root', dataVolume: { name: 'db-root' } },
          { name: 'data', persistentVolumeClaim: { claimName: 'old-data' } },
        ],
        networks: [{ name: 'default', pod: {} }],
      },
    },
  },
});

describe('edits', () => {
  it('switches between custom sizing and a size profile', () => {
    const c = E.setCompute(vm(), { sockets: 1, cores: 4, threads: 1, memoryBytes: 8 * 2 ** 30 });
    expect(c.spec.instancetype).toBeUndefined();
    expect(c.spec.template.spec.domain.cpu).toEqual({ sockets: 1, cores: 4, threads: 1 });
    expect(c.spec.template.spec.domain.memory.guest).toBe('8Gi');
    const p = E.setInstancetype(c, 'u1.large');
    expect(p.spec.instancetype).toEqual({ kind: 'VirtualMachineClusterInstancetype', name: 'u1.large' });
    expect(p.spec.template.spec.domain.cpu).toBeUndefined();
    expect(p.spec.template.spec.domain.memory).toBeUndefined();
  });
  it('adds an empty disk the VM creates, and removes it with its template', () => {
    const { vm: v, name } = E.addBlankDisk(vm(), { sizeBytes: 5 * 2 ** 30, storageClass: 'fast', bus: 'scsi' });
    expect(name).toBe('disk');
    expect(v.spec.dataVolumeTemplates[1]).toMatchObject({ metadata: { name: 'db-disk' }, spec: { source: { blank: {} }, storage: { storageClassName: 'fast' } } });
    const r = E.removeDisk(v, 'disk');
    expect(r).toMatchObject({ claim: 'db-disk', owned: true });
    expect(r.vm.spec.dataVolumeTemplates).toHaveLength(1);
    const r2 = E.removeDisk(vm(), 'data');
    expect(r2).toMatchObject({ claim: 'old-data', owned: false });
  });
  it('inserts an ISO and boots from it first', () => {
    const v = E.insertIso(vm(), { namespace: 'lib', name: 'alpine', sizeBytes: 100 }, true);
    const d = v.spec.template.spec.domain.devices.disks;
    expect(d.find((x: any) => x.cdrom)).toMatchObject({ name: 'cdrom', bootOrder: 1 });
    expect(d.find((x: any) => x.name === 'root').bootOrder).toBe(2);
  });
  it('sets the boot order across disks and adapters', () => {
    const v = E.setBootOrder(vm(), ['default', 'root']);
    expect(v.spec.template.spec.domain.devices.interfaces[0].bootOrder).toBe(1);
    expect(v.spec.template.spec.domain.devices.disks[0].bootOrder).toBe(2);
  });
  it('adds, rewires and removes network adapters', () => {
    const { vm: a, name } = E.addNic(vm(), 'prod/vlan10', 'virtio');
    expect(name).toBe('nic');
    expect(a.spec.template.spec.networks[1]).toEqual({ name: 'nic', multus: { networkName: 'prod/vlan10' } });
    const b = E.setNic(a, 'nic', { network: '', linkDown: true });
    expect(b.spec.template.spec.networks[1]).toEqual({ name: 'nic', pod: {} });
    expect(b.spec.template.spec.domain.devices.interfaces[1]).toMatchObject({ masquerade: {}, state: 'down' });
    expect(E.removeNic(b, 'nic').spec.template.spec.networks).toHaveLength(1);
  });
  it('pins to a host and reads it back', () => {
    const v = E.setPolicies(vm(), { hostAffinity: { host: 'h1', required: true }, eviction: 'LiveMigrate', graceSeconds: 60, runStrategy: 'Manual' });
    expect(E.hostAffinity(v)).toEqual({ host: 'h1', required: true });
    expect(v.spec.template.spec.evictionStrategy).toBe('LiveMigrate');
    expect(v.spec.runStrategy).toBe('Manual');
    expect(E.hostAffinity(E.setPolicies(v, { hostAffinity: null }))).toBeNull();
  });
  it('replaces user tags and keeps system labels', () => {
    const v = E.setTags(vm(), { tier: 'db' }, k => k !== 'app');
    expect(v.metadata.labels).toEqual({ 'kubevirt.io/x': 'y', tier: 'db' });
  });
  it('edits cloud-init or adds it', () => {
    const v = E.setCloudInit(vm(), '#cloud-config\n');
    expect(E.cloudInitOf(v)).toBe('#cloud-config\n');
  });
  it('never mutates its input', () => {
    const a = vm();
    const before = JSON.stringify(a);
    E.addBlankDisk(a, { sizeBytes: 1, bus: 'virtio' });
    E.setFirmware(a, 'uefi-secure', true);
    expect(JSON.stringify(a)).toBe(before);
  });
});
