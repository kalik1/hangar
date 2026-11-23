import {
  addKindOf,
  addMapping,
  addVmDevice,
  availability,
  canJoinSelection,
  canPassThrough,
  diskFree,
  enablePassthrough,
  hostDiskClaim,
  hostsForVmDevices,
  mappingForPci,
  mappingForUsb,
  mappingsOf,
  newResourceName,
  parseInventory,
  passthroughEnabled,
  pciCandidates,
  pciKind,
  pciKindLabel,
  pciState,
  removeMapping,
  removeVmDevice,
  renameMapping,
  selectionGroups,
  stableDiskPath,
  vmDevices,
  vmsUsingResource,
} from './hardware';
import fixture from './hardware.fixture';
import { Obj } from './types';

// A real inventory from a test node: two Iris Xe VFs, one in use by demo/gpu-vm-1.
const inv = parseInventory(JSON.stringify(fixture));
const pci = (a: string) => inv.pci.find(p => p.address === a)!;

const kv = (hd: any = {}, annotations: Record<string, string> = {}, gates = ['Snapshot']): Obj => ({
  metadata: { name: 'kubevirt', namespace: 'kubevirt', annotations },
  spec: { configuration: { developerConfiguration: { featureGates: gates }, permittedHostDevices: hd } },
});

describe('inventory', () => {
  it('parses the agent JSON and tolerates missing lists', () => {
    expect(inv.node).toBe('kube-node-1.example.com');
    expect(inv.iommuGroups).toBe(13);
    expect(pci('0000:02:00.0').usedBy).toBe('demo/gpu-vm-1');
    const empty = parseInventory('{"node":"x"}');
    expect(empty.pci).toEqual([]);
    expect(empty.iommuGroups).toBeNull();
  });

  it('classifies devices', () => {
    expect(pciKind(pci('0000:01:00.0').class)).toBe('gpu');
    expect(pciKind(pci('0000:09:01.0').class)).toBe('storage');
    expect(pciKind(pci('0000:06:12.0').class)).toBe('network');
    expect(pciKind(pci('0000:00:1e.0').class)).toBe('bridge');
    expect(pciKindLabel(pci('0000:00:1f.2'))).toBe('SATA controller');
    expect(pciKindLabel({ ...pci('0000:00:1f.2'), class: '010700' })).toBe('SAS controller');
    expect(pciKindLabel({ ...pci('0000:00:1f.2'), class: '010802' })).toBe('NVMe controller');
  });

  it('says where a device stands', () => {
    expect(pciState(pci('0000:02:00.0'))).toMatchObject({ kind: 'assigned', vm: 'demo/gpu-vm-1' });
    expect(pciState(pci('0000:01:00.0'))).toMatchObject({ kind: 'ready' });
    expect(pciState(pci('0000:09:01.0'))).toMatchObject({ kind: 'host', driver: 'virtio-pci' });
    expect(pciState({ ...pci('0000:09:01.0'), driver: null, desired: true })).toMatchObject({ kind: 'preparing' });
    expect(pciState({ ...pci('0000:01:00.0'), managed: true, desired: false })).toMatchObject({ kind: 'returning' });
    expect(pciState({ ...pci('0000:09:01.0'), binder: { state: 'refused', message: 'Kept for the host' } })).toMatchObject({ kind: 'failed' });
  });

  it('refuses what the host needs, bridges, PFs with VFs, and a host without IOMMU', () => {
    expect(canPassThrough(inv, pci('0000:01:00.0')).ok).toBe(true);
    expect(canPassThrough(inv, pci('0000:09:01.0'))).toMatchObject({ ok: false, why: expect.stringMatching(/disk sda/) });
    expect(canPassThrough(inv, pci('0000:00:1e.0')).ok).toBe(false);
    expect(canPassThrough(inv, { ...pci('0000:01:00.0'), sriovNumVfs: 7 }).why).toMatch(/virtual functions/);
    expect(canPassThrough({ ...inv, iommuGroups: 0 }, pci('0000:01:00.0')).why).toMatch(/IOMMU is off/);
  });

  it('only offers disks the host does not use, by a stable path', () => {
    const sda = inv.disks.find(x => x.name === 'sda')!;
    const sdb = inv.disks.find(x => x.name === 'sdb')!;
    const sr0 = inv.disks.find(x => x.name === 'sr0')!;
    expect(diskFree(sda).ok).toBe(false);
    expect(diskFree(sdb).ok).toBe(true);
    expect(diskFree(sr0).ok).toBe(false);
    expect(stableDiskPath(sdb)).toBe('/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi1');
    expect(stableDiskPath({ ...sdb, byId: ['ata-X', 'wwn-0x5000', 'wwn-0x5000-part1'] })).toBe('/dev/disk/by-id/wwn-0x5000');
    expect(diskFree({ ...sdb, byId: [] }).why).toMatch(/stable name/);
    expect(diskFree({ ...sdb, signatures: ['ceph'] }).why).toMatch(/Ceph OSD/);
    expect(diskFree({ ...sdb, openBy: ['ceph-osd'] }).why).toMatch(/Ceph OSD/);
  });
});

describe('device mappings', () => {
  const pciMap = { pciHostDevices: [{ pciVendorSelector: '8086:46A6', resourceName: 'hangar.magesgate.com/iris-xe-vf' }] };

  it('reads PCI, mdev and USB mappings with Hangar labels', () => {
    const k = kv(
      { ...pciMap, mediatedDevices: [{ mdevNameSelector: 'GRID T4-1Q', resourceName: 'nvidia.com/GRID_T4-1Q' }], usb: [{ resourceName: 'hangar.magesgate.com/key', selectors: [{ vendor: '0627', product: '0001' }] }] },
      { 'hangar.magesgate.com/device-mappings': JSON.stringify({ 'hangar.magesgate.com/iris-xe-vf': { label: 'Iris Xe VF', gpu: true } }) }
    );
    const ms = mappingsOf(k);
    expect(ms.map(m => [m.kind, m.label, m.selector])).toEqual([
      ['pci', 'Iris Xe VF', '8086:46a6'],
      ['mdev', 'GRID_T4-1Q', 'GRID T4-1Q'],
      ['usb', 'key', '0627:0001'],
    ]);
    expect(mappingForPci(ms, pci('0000:01:00.0'))?.resourceName).toBe('hangar.magesgate.com/iris-xe-vf');
    expect(mappingForUsb(ms, inv.usb[0])?.label).toBe('key');
    expect(mappingsOf(null)).toEqual([]);
  });

  it('adds a mapping with the feature gate, and keeps entries Hangar did not make', () => {
    const k = kv({ pciHostDevices: [{ pciVendorSelector: '10de:1eb8', resourceName: 'nvidia.com/TU104GL', externalResourceProvider: true }] });
    expect(passthroughEnabled(k)).toBe(false);
    const name = newResourceName('Iris Xe Graphics VF', mappingsOf(k));
    expect(name).toBe('hangar.magesgate.com/iris-xe-graphics-vf');
    const out = addMapping(k, { kind: 'pci', resourceName: name, label: 'Iris Xe Graphics VF', gpu: true, selector: '8086:46A6' });
    expect(passthroughEnabled(out)).toBe(true);
    expect(out.spec.configuration.developerConfiguration.featureGates).toEqual(['Snapshot', 'HostDevices']);
    expect(out.spec.configuration.permittedHostDevices.pciHostDevices).toEqual([
      { pciVendorSelector: '10de:1eb8', resourceName: 'nvidia.com/TU104GL', externalResourceProvider: true },
      { pciVendorSelector: '8086:46a6', resourceName: name },
    ]);
    expect(mappingsOf(out)[1]).toMatchObject({ label: 'Iris Xe Graphics VF', gpu: true, hangar: true });
    // the input is not changed
    expect(k.spec.configuration.permittedHostDevices.pciHostDevices).toHaveLength(1);
    // a second mapping with the same name gets a suffix
    expect(newResourceName('Iris Xe Graphics VF', mappingsOf(out))).toBe('hangar.magesgate.com/iris-xe-graphics-vf-2');
  });

  it('adds USB and vGPU mappings, renames and removes', () => {
    let k = addMapping(kv(), { kind: 'usb', resourceName: 'hangar.magesgate.com/tablet', label: 'Tablet', gpu: false, usb: [{ vendor: '0627', product: '0001' }] });
    k = addMapping(k, { kind: 'mdev', resourceName: 'hangar.magesgate.com/t4-1q', label: 'T4 1Q', gpu: true, selector: 'GRID T4-1Q', mdevTypeId: 'nvidia-222' });
    expect(k.spec.configuration.permittedHostDevices.usb).toEqual([{ resourceName: 'hangar.magesgate.com/tablet', selectors: [{ vendor: '0627', product: '0001' }] }]);
    expect(k.spec.configuration.mediatedDevicesConfiguration.mediatedDeviceTypes).toEqual(['nvidia-222']);
    k = renameMapping(k, 'hangar.magesgate.com/tablet', 'QEMU tablet');
    expect(mappingsOf(k).find(m => m.kind === 'usb')?.label).toBe('QEMU tablet');
    k = removeMapping(k, 'hangar.magesgate.com/tablet');
    expect(k.spec.configuration.permittedHostDevices.usb).toBeUndefined();
    expect(JSON.parse(k.metadata.annotations!['hangar.magesgate.com/device-mappings'])).toEqual({ 'hangar.magesgate.com/t4-1q': { label: 'T4 1Q', gpu: true } });
    expect(enablePassthrough(kv({}, {}, ['HostDevices'])).spec.configuration.developerConfiguration.featureGates).toEqual(['HostDevices']);
  });
});

describe('availability and VM devices', () => {
  const R = 'hangar.magesgate.com/iris-xe-vf';
  const nodes: Obj[] = [
    { metadata: { name: 'a' }, status: { capacity: { [R]: '2' }, allocatable: { [R]: '2' } } },
    { metadata: { name: 'b' }, status: { capacity: { [R]: '2' }, allocatable: { [R]: '1' } } },
    { metadata: { name: 'c' }, status: { capacity: {}, allocatable: {} } },
  ];
  const launcher = (node: string, vm: string, phase = 'Running', n = '1'): Obj => ({
    metadata: { name: `virt-launcher-${vm}`, namespace: 'demo', labels: { 'vm.kubevirt.io/name': vm } },
    spec: { nodeName: node, containers: [{ resources: { limits: { [R]: n } } }] },
    status: { phase },
  });

  it('counts free devices per host', () => {
    const a = availability(R, nodes, [launcher('a', 'gpu-vm-1'), launcher('a', 'gone', 'Succeeded'), launcher('b', 'gpu-vm-2')]);
    expect(a).toEqual([
      { host: 'a', total: 2, healthy: 2, used: 1, free: 1, vms: ['demo/gpu-vm-1'] },
      { host: 'b', total: 2, healthy: 1, used: 1, free: 0, vms: ['demo/gpu-vm-2'] },
    ]);
  });

  it('adds GPUs and USB devices to a VM and removes them', () => {
    const vm: Obj = { metadata: { name: 'v', namespace: 'demo' }, spec: { template: { spec: { domain: { devices: {} } } } } };
    const one = addVmDevice(vm, { resourceName: R, gpu: true, kind: 'pci' });
    const two = addVmDevice(one.vm, { resourceName: R, gpu: true, kind: 'pci' });
    const three = addVmDevice(two.vm, { resourceName: 'hangar.magesgate.com/tablet', gpu: false, kind: 'usb' });
    expect(vmDevices(three.vm)).toEqual([
      { name: 'gpu', deviceName: R, as: 'gpu' },
      { name: 'gpu1', deviceName: R, as: 'gpu' },
      { name: 'usb', deviceName: 'hangar.magesgate.com/tablet', as: 'host' },
    ]);
    expect(vmsUsingResource([three.vm], R)).toEqual(['demo/v']);
    expect(hostsForVmDevices(two.vm, nodes)).toEqual(['a', 'b']);
    expect(hostsForVmDevices(vm, nodes)).toBeNull();
    const back = removeVmDevice(removeVmDevice(three.vm, 'gpu'), 'gpu1');
    expect(back.spec.template.spec.domain.devices.gpus).toBeUndefined();
    expect(vmDevices(back)).toHaveLength(1);
    expect(vm.spec.template.spec.domain.devices).toEqual({});
  });

  it('builds the local block volume and claim for a host disk', () => {
    const sdb = inv.disks.find(x => x.name === 'sdb')!;
    const { pv, pvc } = hostDiskClaim('kube-worker-1.example.com', sdb, 'demo', 'db-sdb');
    expect(pv.spec.local.path).toBe('/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi1');
    expect(pv.spec.volumeMode).toBe('Block');
    expect(pv.spec.claimRef).toEqual({ namespace: 'demo', name: 'db-sdb' });
    expect(pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values).toEqual(['kube-worker-1.example.com']);
    expect(pv.metadata.name.length).toBeLessThanOrEqual(63);
    expect(pvc.spec).toMatchObject({ volumeName: pv.metadata.name, storageClassName: '', volumeMode: 'Block' });
    expect(pvc.spec.resources.requests.storage).toBe(String(sdb.sizeBytes));
  });
});

describe('add device candidates', () => {
  const hosts = [
    { host: 'a', inv },
    { host: 'b', inv: { ...inv, pci: inv.pci.map(p => (p.address === '0000:01:00.0' ? { ...p, driver: null, managed: false, desired: false, usedBy: null } : p.address === '0000:02:00.0' ? { ...p, driver: null, managed: false, desired: false, usedBy: null } : p)) } },
  ];
  const m = mappingsOf({ metadata: { name: 'kv' }, spec: { configuration: { permittedHostDevices: { pciHostDevices: [{ pciVendorSelector: '8086:46a6', resourceName: 'hangar.magesgate.com/iris' }] } } } });

  it('lists every device of a kind with why it cannot be given', () => {
    const gpus = pciCandidates(hosts, 'gpu', m);
    // the bochs VGA, two VFs per host
    expect(gpus.map(c => [c.host, c.p.address, c.ok])).toEqual([
      ['a', '0000:00:01.0', true],
      ['a', '0000:01:00.0', true],
      ['a', '0000:02:00.0', false],
      ['b', '0000:00:01.0', true],
      ['b', '0000:01:00.0', true],
      ['b', '0000:02:00.0', true],
    ]);
    expect(gpus.find(c => c.host === 'a' && c.p.address === '0000:02:00.0')?.why).toMatch(/In use by demo\/gpu-vm-1/);
    expect(gpus.find(c => c.host === 'a' && c.p.address === '0000:01:00.0')?.mapping?.resourceName).toBe('hangar.magesgate.com/iris');
    const storage = pciCandidates(hosts, 'storage', m);
    expect(storage.find(c => c.p.address === '0000:09:01.0')?.why).toMatch(/disk sda/);
    expect(pciCandidates(hosts, 'pci', m).every(c => addKindOf(c.p) === 'pci')).toBe(true);
  });

  it('keeps a selection to one model and adds IOMMU group mates per host', () => {
    const gpus = pciCandidates(hosts, 'gpu', m);
    const vfB1 = gpus.find(c => c.host === 'b' && c.p.address === '0000:01:00.0')!;
    const vfB2 = gpus.find(c => c.host === 'b' && c.p.address === '0000:02:00.0')!;
    const vfA1 = gpus.find(c => c.host === 'a' && c.p.address === '0000:01:00.0')!;
    const vga = gpus.find(c => c.host === 'b' && c.p.address === '0000:00:01.0')!;
    expect(canJoinSelection([vfB1], vfA1).ok).toBe(true);
    expect(canJoinSelection([vfB1], vga).why).toMatch(/one model/);
    expect(canJoinSelection([], gpus.find(c => !c.ok)!).ok).toBe(false);
    const groups = selectionGroups([vfB1, vfB2, vfA1]);
    expect(groups.map(g => [g.host, g.devices.map(d => d.address)])).toEqual([
      ['b', ['0000:01:00.0', '0000:02:00.0']],
      ['a', ['0000:01:00.0']],
    ]);
    // a device sharing its group with an endpoint the host does not need brings it along
    const sata = pci('0000:00:1f.2');
    const lonely = { ...inv, pci: [...inv.pci, { ...sata, address: '0000:00:1f.3', class: '0c0500', iommuGroup: sata.iommuGroup }] };
    const c = pciCandidates([{ host: 'a', inv: lonely }], 'storage', m).find(x => x.p.address === '0000:00:1f.2')!;
    expect(selectionGroups([c])[0].mates.map(x => x.address)).toEqual([]); // SMBus is a "bridge" kind: never moved
  });
});
