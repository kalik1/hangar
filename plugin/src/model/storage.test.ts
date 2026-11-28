import { describe, expect, it } from 'vitest';
import {
  classifyDisk,
  cloneLabel,
  diskInventory,
  diskState,
  expandProblem,
  isInternalClaim,
  parseTopolvmMetrics,
  poolSummary,
  storageKind,
  topolvmDeviceClass,
} from './storage';
import { Obj } from './types';

const pvc = (ns: string, name: string, extra: Partial<Obj['metadata']> = {}, spec: any = {}, status: any = { phase: 'Bound', capacity: { storage: '1Gi' } }): Obj => ({
  metadata: { namespace: ns, name, ...extra },
  spec: { storageClassName: 'topolvm-provisioner', resources: { requests: { storage: '1Gi' } }, ...spec },
  status,
});
const dv = (ns: string, name: string, status: any = { phase: 'Succeeded', progress: '100.0%' }, extra: Partial<Obj['metadata']> = {}): Obj => ({
  metadata: { namespace: ns, name, ...extra },
  spec: { storage: { resources: { requests: { storage: '1Gi' } } } },
  status,
});
const vm = (ns: string, name: string, volumes: any[], disks: any[] = []): Obj => ({
  metadata: { namespace: ns, name },
  spec: { template: { spec: { domain: { devices: { disks } }, volumes } } },
});

describe('storageKind', () => {
  it('names the drivers in plain words', () => {
    expect(storageKind('topolvm.io').label).toBe('Local LVM (TopoLVM)');
    expect(storageKind('openshift-storage.rbd.csi.ceph.com').label).toBe('Ceph RBD');
    expect(storageKind('rook-ceph.cephfs.csi.ceph.com').label).toBe('CephFS');
    expect(storageKind('nfs.csi.k8s.io').label).toBe('NFS');
    expect(storageKind('driver.longhorn.io').label).toBe('Longhorn');
    expect(storageKind('kubernetes.io/no-provisioner').family).toBe('local');
    expect(storageKind('example.com/thing')).toMatchObject({ label: 'example.com/thing', family: 'other' });
  });
  it('says how disks are copied', () => {
    expect(cloneLabel('csi-clone')).toBe('Instant (storage clone)');
    expect(cloneLabel(undefined)).toBe('Chosen by CDI');
  });
});

describe('TopoLVM metrics', () => {
  const text = [
    '# HELP topolvm_thinpool_data_percent x',
    'topolvm_thinpool_data_percent{device_class="default",node="n1"} 19.49',
    'topolvm_thinpool_metadata_percent{device_class="default",node="n1"} 7.06',
    'topolvm_thinpool_overprovisioned_available{device_class="default",node="n1"} 1.529008357376e+12',
    'topolvm_thinpool_size_bytes{device_class="default",node="n1"} 3.221225472e+10',
    'topolvm_volumegroup_available_bytes{device_class="default",node="n1"} 2.1403533312e+10',
    'topolvm_volumegroup_size_bytes{device_class="default",node="n1"} 6.4890077184e+10',
    'go_goroutines 12',
  ].join('\n');
  it('parses the samples of each host and class', () => {
    const s = parseTopolvmMetrics(text);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ node: 'n1', deviceClass: 'default', thinSize: 32212254720, thinDataPercent: 19.49 });
  });
  it('sums a thin pool honestly: physical size, written, overcommit', () => {
    const p = poolSummary(parseTopolvmMetrics(text), 'default', 75 * 2 ** 30)!;
    expect(p.thin).toBe(true);
    expect(p.sizeBytes).toBe(30 * 2 ** 30);
    expect(Math.round(p.usedBytes / 2 ** 20)).toBe(Math.round((30 * 1024 * 19.49) / 100));
    expect(p.overcommit).toBeCloseTo(2.5);
    expect(p.provisionableBytes).toBe(1.529008357376e12);
  });
  it('finds the default device class from the node annotations', () => {
    const node = { metadata: { name: 'n1', annotations: { 'capacity.topolvm.io/00default': '5', 'capacity.topolvm.io/ssd': '5', 'capacity.topolvm.io/hdd': '7' } } };
    expect(topolvmDeviceClass({ metadata: { name: 'sc' } }, [node])).toBe('ssd');
    expect(topolvmDeviceClass({ metadata: { name: 'sc' }, parameters: { 'topolvm.io/device-class': 'hdd' } }, [node])).toBe('hdd');
  });
});

describe('disk classification', () => {
  it('hides CDI internals', () => {
    expect(isInternalClaim(pvc('a', 'prime-00000000-0000-4000-8000-000000000001'))).toBe(true);
    expect(isInternalClaim(pvc('a', 'tmp-pvc-00000000-0000-4000-8000-000000000001'))).toBe(true);
    expect(isInternalClaim(pvc('a', 'disk-scratch', { labels: { app: 'containerized-data-importer' } }))).toBe(true);
    expect(isInternalClaim(pvc('a', 'x', { ownerReferences: [{ kind: 'PersistentVolumeClaim', name: 'y' }] }))).toBe(true);
    expect(isInternalClaim(pvc('a', 'my-scratch'))).toBe(false);
    expect(isInternalClaim(pvc('a', 'web-01-rootdisk'))).toBe(false);
  });
  it('tells VM disks, images, unattached disks and container volumes apart', () => {
    const use = [{ vm: vm('p', 'web', []), slot: 'rootdisk', device: 'disk' as const }];
    expect(classifyDisk(pvc('p', 'web-root'), dv('p', 'web-root'), use, 'lib')).toBe('vm');
    expect(classifyDisk(pvc('lib', 'cirros'), dv('lib', 'cirros'), [], 'lib')).toBe('image');
    expect(classifyDisk(pvc('x', 'img', { labels: { 'hangar.magesgate.com/image': 'true' } }), undefined, [], 'lib')).toBe('image');
    // Kept after "Delete VM, keep disks": the DataVolume stays, no VM uses it.
    expect(classifyDisk(pvc('p', 'old-root'), dv('p', 'old-root'), [], 'lib')).toBe('unattached');
    expect(classifyDisk(pvc('p', 'old', { labels: { 'kubevirt.io/created-by': 'uid' } }), undefined, [], 'lib')).toBe('unattached');
    expect(classifyDisk(pvc('apps', 'postgres-data'), undefined, [], 'lib')).toBe('container');
  });
  it('builds the inventory with users, sizes and states', () => {
    const vms = [vm('p', 'web', [{ name: 'rootdisk', dataVolume: { name: 'web-root' } }, { name: 'cd', persistentVolumeClaim: { claimName: 'iso' } }], [{ name: 'rootdisk', disk: {} }, { name: 'cd', cdrom: {} }])];
    const inv = diskInventory(
      [pvc('p', 'web-root'), pvc('p', 'iso'), pvc('p', 'prime-00000000-0000-4000-8000-000000000001'), pvc('p', 'left', {}, {}, { phase: 'Bound', capacity: { storage: '20Gi' } })],
      [dv('p', 'web-root'), dv('p', 'left'), dv('p', 'pending', { phase: 'ImportInProgress', progress: '42.5%' })],
      vms,
      new Map(),
      'lib'
    );
    expect(inv.hidden).toBe(1);
    const by = Object.fromEntries(inv.rows.map(r => [r.name, r]));
    expect(by['web-root'].kind).toBe('vm');
    expect(by['web-root'].uses[0].slot).toBe('rootdisk');
    expect(by.iso.media).toBe('iso');
    expect(by.left).toMatchObject({ kind: 'unattached', sizeBytes: 20 * 2 ** 30 });
    expect(by.pending.state).toMatchObject({ label: 'Importing 43%', progress: 42.5 });
  });
  it('attaches a VM state claim to its VM', () => {
    const inv = diskInventory([pvc('p', 'persistent-state-for-web-abcde', { labels: { 'persistent-state-for': 'web' } })], [], [vm('p', 'web', [])], new Map(), 'lib');
    expect(inv.rows[0]).toMatchObject({ kind: 'vm' });
    expect(inv.rows[0].uses[0].device).toBe('state');
  });
  it('never offers a VM state claim as a disk', () => {
    const state = pvc('p', 'persistent-state-for-web-abcde', { labels: { 'persistent-state-for': 'web' }, ownerReferences: [{ kind: 'VirtualMachine', name: 'web' }] });
    expect(classifyDisk(state, undefined, [], 'lib')).toBe('internal');
    // Attached by mistake by Hangar 0.1.x: still KubeVirt's.
    expect(classifyDisk(state, undefined, [{ vm: vm('p', 'web', []), slot: 'state-for-web-abcde', device: 'disk' }], 'lib')).toBe('internal');
    // Its VM is gone (or KubeVirt replaced the claim): hidden, not unattached.
    const inv = diskInventory([state], [], [vm('p', 'other', [])], new Map(), 'lib');
    expect(inv.rows).toEqual([]);
    expect(inv.hidden).toBe(1);
  });
});

describe('disk state', () => {
  it('reads DataVolume phases', () => {
    expect(diskState(undefined, dv('a', 'b', { phase: 'UploadReady' })).label).toBe('Waiting for the upload');
    expect(diskState(undefined, dv('a', 'b', { phase: 'CloneInProgress', progress: 'N/A' })).label).toBe('Copying');
    expect(diskState(undefined, dv('a', 'b', { phase: 'WaitForFirstConsumer' })).label).toBe('Waits for a VM');
    const f = diskState(undefined, dv('a', 'b', { phase: 'Failed', conditions: [{ type: 'Running', status: 'False', message: 'Unable to connect to http data source' }] }));
    expect(f).toMatchObject({ tone: 'fault', detail: 'Unable to connect to http data source' });
    expect(diskState(pvc('a', 'b'), dv('a', 'b')).label).toBe('Ready');
  });
  it('reads claim phases and resizes', () => {
    expect(diskState(pvc('a', 'b', {}, {}, { phase: 'Pending' }), undefined).label).toBe('Pending');
    expect(diskState(pvc('a', 'b', {}, {}, { phase: 'Bound', conditions: [{ type: 'FileSystemResizePending', status: 'True' }] }), undefined).label).toBe(
      'Expands at next power-on'
    );
  });
  it('says why a disk cannot grow', () => {
    const row = diskInventory([pvc('p', 'd')], [], [], new Map(), 'lib').rows[0];
    expect(expandProblem(row, { metadata: { name: 'topolvm-provisioner' }, allowVolumeExpansion: false })).toMatch(/does not allow/);
    expect(expandProblem(row, { metadata: { name: 'topolvm-provisioner' }, allowVolumeExpansion: true })).toBeNull();
  });
});
