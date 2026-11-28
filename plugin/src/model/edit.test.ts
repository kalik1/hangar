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
    const { vm: v, dropped } = E.setBootOrder(vm(), ['default', 'root']);
    expect(v.spec.template.spec.domain.devices.interfaces[0].bootOrder).toBe(1);
    expect(v.spec.template.spec.domain.devices.disks[0].bootOrder).toBe(2);
    expect(dropped).toEqual([]);
  });
  it('says which devices a new boot order leaves out', () => {
    const { vm: v, dropped } = E.setBootOrder(vm(), ['default']);
    expect(dropped).toEqual(['root']);
    expect(v.spec.template.spec.domain.devices.disks[0].bootOrder).toBeUndefined();
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

/** A wizard VM: UEFI, a TPM, the root disk from a template with boot order 1, the cloud-init disk. */
const efiVm = () => ({
  metadata: { name: 'web', namespace: 'prod', resourceVersion: '3' },
  spec: {
    dataVolumeTemplates: [{ metadata: { name: 'web-rootdisk' }, spec: {} }],
    template: {
      spec: {
        domain: {
          firmware: { bootloader: { efi: { secureBoot: false } } },
          devices: {
            tpm: { persistent: true },
            disks: [
              { name: 'cloudinitdisk', disk: { bus: 'virtio' } },
              { name: 'rootdisk', disk: { bus: 'virtio' }, bootOrder: 1 },
            ],
            interfaces: [{ name: 'default', masquerade: {} }],
          },
        },
        volumes: [
          { name: 'cloudinitdisk', cloudInitNoCloud: { userData: '#cloud-config\n' } },
          { name: 'rootdisk', dataVolume: { name: 'web-rootdisk' } },
        ],
      },
    },
  },
});
const devs = (v: any) => v.spec.template.spec.domain.devices;
const bootOf = (v: any, name: string) => devs(v).disks.find((d: any) => d.name === name)?.bootOrder;

describe('boot order through disk edits', () => {
  it('keeps the boot disk first when disks are added, attached and removed', () => {
    const a = E.addBlankDisk(efiVm(), { sizeBytes: 2 ** 30, bus: 'virtio' });
    const b = E.attachDisk(a.vm, 'web-spare', 'virtio');
    const c = E.removeDisk(b.vm, a.name);
    for (const v of [a.vm, b.vm, c.vm]) expect(bootOf(v, 'rootdisk')).toBe(1);
    expect(b.bootOrder).toBeUndefined();
    expect(bootOf(b.vm, b.name)).toBeUndefined();
    expect(E.bootOrderWarning(efiVm(), c.vm)).toBeUndefined();
  });

  it('gives the former boot disk its boot order back when it is attached again', () => {
    const removed = E.removeDisk(efiVm(), 'rootdisk');
    expect(removed).toMatchObject({ claim: 'web-rootdisk', owned: true });
    expect(E.hasBootOrder(removed.vm)).toBe(false);
    expect(E.isFormerBootDisk(removed.vm, 'web-rootdisk')).toBe(true);
    // Saving that asks first: a UEFI VM with no boot order may stop at the cloud-init disk.
    expect(E.bootOrderWarning(efiVm(), removed.vm)).toMatch(/boot order/);

    const back = E.attachDisk(removed.vm, 'web-rootdisk', 'virtio');
    expect(back.bootOrder).toBe(1);
    expect(bootOf(back.vm, back.name)).toBe(1);
    expect(back.vm.metadata.annotations?.[E.A_FORMER_BOOT_DISK]).toBeUndefined();
    expect(E.bootOrderWarning(removed.vm, back.vm)).toBeUndefined();
  });

  it('attaches the former boot disk of a running VM for the next power-on, after the devices that boot now', () => {
    const removed = E.removeDisk(efiVm(), 'rootdisk');
    const withIso = E.insertIso(removed.vm, { namespace: 'lib', name: 'rescue', sizeBytes: 100 }, true);
    const back = E.attachDisk(withIso, 'web-rootdisk', 'virtio', true);
    expect(back.bootOrder).toBe(2);
    expect(back.vm.spec.template.spec.volumes.find((v: any) => v.name === back.name).persistentVolumeClaim).toEqual({ claimName: 'web-rootdisk' });
  });

  it('remembers only the boot disk, and another disk attached gets no boot order', () => {
    const a = E.addBlankDisk(efiVm(), { sizeBytes: 2 ** 30, bus: 'virtio', name: 'data' });
    const r = E.removeDisk(a.vm, 'data');
    expect(r.vm.metadata.annotations?.[E.A_FORMER_BOOT_DISK]).toBeUndefined();
    const removed = E.removeDisk(efiVm(), 'rootdisk');
    const other = E.attachDisk(removed.vm, 'web-data', 'virtio');
    expect(other.bootOrder).toBeUndefined();
    expect(E.isFormerBootDisk(other.vm, 'web-rootdisk')).toBe(true);
  });

  it('warns on a UEFI VM left with no boot order, not on BIOS or an unrelated edit', () => {
    const none = E.setBootOrder(efiVm(), []).vm;
    expect(E.bootOrderWarning(efiVm(), none)).toMatch(/UEFI/);
    // Already without one, and the disks did not change: no warning on every save.
    expect(E.bootOrderWarning(none, E.setTags(none, { tier: 'web' }, () => true))).toBeUndefined();
    // Already without one, and a disk is attached: say so.
    expect(E.bootOrderWarning(none, E.attachDisk(none, 'web-data', 'virtio').vm)).toMatch(/boot order/);
    const bios = E.setFirmware(efiVm(), 'bios', false);
    expect(E.bootOrderWarning(bios, E.setBootOrder(bios, []).vm)).toBeUndefined();
  });
});
