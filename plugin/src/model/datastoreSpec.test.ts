import { describe, expect, it } from 'vitest';
import {
  A_CLUSTER_DEFAULT,
  A_VIRT_DEFAULT,
  datastoreNameProblem,
  defaultPatches,
  deleteProblem,
  effectiveVmDefault,
  rbdImageOf,
  snapshotsByClaim,
  storageClassFrom,
  topolvmDeviceClasses,
} from './datastoreSpec';

const sc = (name: string, provisioner: string, annotations: Record<string, string> = {}, parameters: Record<string, string> = {}) =>
  ({ metadata: { name, annotations }, provisioner, parameters }) as any;

describe('storageClassFrom', () => {
  it('copies a Ceph RBD class and swaps the pool', () => {
    const base = sc('ceph-rbd', 'rook-ceph.rbd.csi.ceph.com', {}, { clusterID: 'rook-ceph', pool: 'vm-pool', 'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node' });
    const out: any = storageClassFrom({ name: 'ceph-fast', base, pool: 'fast-pool', reclaim: 'Retain', expansion: true, binding: 'Immediate', description: 'SSD pool' });
    expect(out.provisioner).toBe('rook-ceph.rbd.csi.ceph.com');
    expect(out.parameters).toEqual({ clusterID: 'rook-ceph', pool: 'fast-pool', 'csi.storage.k8s.io/node-stage-secret-name': 'rook-csi-rbd-node' });
    expect(out.reclaimPolicy).toBe('Retain');
    expect(out.allowVolumeExpansion).toBe(true);
    expect(out.metadata.annotations).toEqual({ description: 'SSD pool' });
    expect(base.parameters.pool).toBe('vm-pool');
  });
  it('sets or clears the TopoLVM device class', () => {
    const base = sc('topolvm-provisioner', 'topolvm.io', {}, { 'csi.storage.k8s.io/fstype': 'xfs', 'topolvm.io/device-class': 'ssd' });
    const a: any = storageClassFrom({ name: 'lvm-hdd', base, deviceClass: 'hdd', reclaim: 'Delete', expansion: true, binding: 'WaitForFirstConsumer' });
    expect(a.parameters['topolvm.io/device-class']).toBe('hdd');
    const b: any = storageClassFrom({ name: 'lvm-default', base, deviceClass: '', reclaim: 'Delete', expansion: true, binding: 'WaitForFirstConsumer' });
    expect(b.parameters['topolvm.io/device-class']).toBeUndefined();
    expect(b.volumeBindingMode).toBe('WaitForFirstConsumer');
  });
});

describe('defaults', () => {
  it('moves the VM default and sets the target first', () => {
    const scs = [sc('a', 'x', { [A_VIRT_DEFAULT]: 'true' }), sc('b', 'x'), sc('c', 'x', { [A_VIRT_DEFAULT]: 'false' })];
    const p = defaultPatches(scs, 'b');
    expect(p.map(x => x.name)).toEqual(['b', 'a', 'c']);
    expect((p[0].patch as any).metadata.annotations[A_VIRT_DEFAULT]).toBe('true');
    expect((p[1].patch as any).metadata.annotations[A_VIRT_DEFAULT]).toBeNull();
  });
  it('does nothing when the target is already the default', () => {
    expect(defaultPatches([sc('a', 'x', { [A_VIRT_DEFAULT]: 'true' })], 'a')).toEqual([]);
  });
  it('prefers the virt default over the cluster default', () => {
    expect(effectiveVmDefault([sc('a', 'x', { [A_CLUSTER_DEFAULT]: 'true' }), sc('b', 'x', { [A_VIRT_DEFAULT]: 'true' })])).toBe('b');
    expect(effectiveVmDefault([sc('a', 'x', { [A_CLUSTER_DEFAULT]: 'true' })])).toBe('a');
    expect(effectiveVmDefault([sc('a', 'x')])).toBeUndefined();
  });
});

describe('names and deletion', () => {
  it('checks names', () => {
    expect(datastoreNameProblem('ceph-fast', ['ceph-rbd'])).toBeNull();
    expect(datastoreNameProblem('Ceph', [])).toMatch(/Lowercase/);
    expect(datastoreNameProblem('ceph-rbd', ['ceph-rbd'])).toMatch(/exists/);
    expect(datastoreNameProblem('', [])).toMatch(/Enter/);
  });
  it('refuses to delete a datastore with disks', () => {
    const pvcs = [{ metadata: { name: 'd' }, spec: { storageClassName: 'x' } }] as any;
    expect(deleteProblem('x', pvcs)).toMatch(/1 disk is on it/);
    expect(deleteProblem('y', pvcs)).toBeNull();
  });
});

describe('helpers', () => {
  it('lists TopoLVM device classes', () => {
    const nodes = [
      { metadata: { name: 'a', annotations: { 'capacity.topolvm.io/00default': '1', 'capacity.topolvm.io/thin-pool': '1', other: 'x' } } },
      { metadata: { name: 'b', annotations: { 'capacity.topolvm.io/ssd': '1' } } },
    ] as any;
    expect(topolvmDeviceClasses(nodes)).toEqual(['ssd', 'thin-pool']);
  });
  it('groups VolumeSnapshots by claim', () => {
    const m = snapshotsByClaim([
      { metadata: { name: 's1', namespace: 'demo' }, spec: { source: { persistentVolumeClaimName: 'disk' } } },
      { metadata: { name: 's2', namespace: 'demo' }, spec: { source: { persistentVolumeClaimName: 'disk' } } },
      { metadata: { name: 's3', namespace: 'demo' }, spec: { source: { volumeSnapshotContentName: 'c' } } },
    ] as any);
    expect(m.get('demo/disk')?.length).toBe(2);
    expect(m.size).toBe(1);
  });
  it('finds the RBD image of a PV', () => {
    const pv = { spec: { csi: { driver: 'rook-ceph.rbd.csi.ceph.com', volumeAttributes: { pool: 'vm-pool', imageName: 'csi-vol-1' } } } } as any;
    expect(rbdImageOf(pv)).toEqual({ pool: 'vm-pool', image: 'csi-vol-1' });
    expect(rbdImageOf({ spec: { csi: { driver: 'topolvm.io', volumeAttributes: {} } } } as any)).toBeNull();
    expect(rbdImageOf(undefined)).toBeNull();
  });
});
