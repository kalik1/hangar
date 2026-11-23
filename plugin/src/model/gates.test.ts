import * as G from './gates';

const kv = (gates: string[], version = 'v1.7.0', extra: any = {}) => ({
  metadata: { name: 'kubevirt', namespace: 'kubevirt', resourceVersion: '5' },
  spec: { configuration: { developerConfiguration: { featureGates: gates }, ...extra.configuration }, ...extra.spec },
  status: { observedKubeVirtVersion: version },
});

describe('feature gates', () => {
  it('finds the table by minor version and says unknown otherwise', () => {
    expect(G.gateTable(kv([], 'v1.7.0'))?.version).toBe('v1.7');
    expect(G.gateTable(kv([], 'v1.7.3'))?.version).toBe('v1.7');
    expect(G.gateTable(kv([], 'v1.8.0'))).toBeNull();
    expect(G.gateTable(null)).toBeNull();
  });
  it('knows GA gates are always on and Alpha/Beta only when listed', () => {
    const k = kv(['VideoConfig', 'NUMA', 'Passt']);
    expect(G.gateState(k, 'VMLiveUpdateFeatures')).toMatchObject({ maturity: 'GA', on: true, listed: false });
    expect(G.gateState(k, 'NUMA')).toMatchObject({ maturity: 'GA', on: true, listed: true });
    expect(G.gateState(k, 'NUMA').note).toMatch(/always on/);
    expect(G.gateState(k, 'VideoConfig')).toMatchObject({ maturity: 'Beta', on: true });
    expect(G.gateState(k, 'VSOCK')).toMatchObject({ maturity: 'Alpha', on: false });
    expect(G.gateState(k, 'Passt')).toMatchObject({ maturity: 'Discontinued', on: false });
  });
  it('does not guess on an unknown version', () => {
    const k = kv(['VSOCK'], 'v1.9.0');
    expect(G.gateState(k, 'VSOCK')).toMatchObject({ maturity: null, on: true });
    expect(G.gateState(k, 'VMLiveUpdateFeatures')).toMatchObject({ maturity: null, on: null });
  });
  it('treats declarative hot-plug as off while the old gate is listed', () => {
    const k = kv(['HotplugVolumes', 'DeclarativeHotplugVolumes']);
    expect(G.gateState(k, 'DeclarativeHotplugVolumes').on).toBe(false);
    expect(G.gateProblems(k)[0]).toMatch(/both on/);
  });
  it('never writes both hot-plug gates and keeps the others', () => {
    expect(G.nextGates(['Snapshot', 'HotplugVolumes'], 'DeclarativeHotplugVolumes', true)).toEqual({
      gates: ['Snapshot', 'DeclarativeHotplugVolumes'],
      removed: ['HotplugVolumes'],
    });
    expect(G.nextGates(['DeclarativeHotplugVolumes', 'Snapshot'], 'HotplugVolumes', true).gates).toEqual(['Snapshot', 'HotplugVolumes']);
    expect(G.nextGates(['Snapshot', 'VSOCK'], 'VSOCK', true).gates).toEqual(['Snapshot', 'VSOCK']);
    expect(G.nextGates(['Snapshot', 'VSOCK', 'Sidecar'], 'VSOCK', false).gates).toEqual(['Snapshot', 'Sidecar']);
  });
  it('lists Hangar gates, then unknown listed ones, then the rest', () => {
    const r = G.gateRows(kv(['Snapshot', 'MyOwnGate']));
    expect(r.hangar[0].name).toBe('DeclarativeHotplugVolumes');
    expect(r.listedOther.map(x => x.name)).toEqual(['MyOwnGate']);
    expect(r.listedOther[0]).toMatchObject({ maturity: null, on: true });
    expect(r.other.some(x => x.name === 'ImageVolume')).toBe(true);
    expect(r.other.some(x => x.name === 'Snapshot')).toBe(false);
  });
  it('finds the VMs that use a gated feature', () => {
    const vm = (devices: any, volumes: any[] = []) => ({ metadata: { name: 'x' }, spec: { template: { spec: { domain: { devices }, volumes } } } });
    const vms = [vm({ video: { type: 'virtio' } }), vm({ autoattachVSOCK: true }), vm({ disks: [{ name: 'cd', cdrom: { bus: 'sata' } }] })];
    expect(G.vmsUsingGate(vms, 'VideoConfig')).toHaveLength(1);
    expect(G.vmsUsingGate(vms, 'VSOCK')).toHaveLength(1);
    expect(G.vmsUsingGate(vms, 'DeclarativeHotplugVolumes')).toHaveLength(1);
    const fs = vm({ filesystems: [{ name: 'share', virtiofs: {} }] }, [{ name: 'share', configMap: { name: 'c' } }]);
    expect(G.vmsUsingGate([fs], 'EnableVirtioFsConfigVolumes')).toHaveLength(1);
    expect(G.vmsUsingGate([fs], 'EnableVirtioFsStorageVolumes')).toHaveLength(0);
  });
  it('reads the cluster settings that go with the gates', () => {
    const k = kv([], 'v1.7.0', { spec: { workloadUpdateStrategy: { workloadUpdateMethods: ['LiveMigrate'] } }, configuration: { vmStateStorageClass: 'ceph-rbd' } });
    expect(G.clusterSettings(k)).toMatchObject({ liveMigrateUpdates: true, rollout: 'LiveUpdate', maxHotplugRatio: 4, vmStateStorageClass: 'ceph-rbd' });
    expect(G.clusterSettings(kv([])).liveMigrateUpdates).toBe(false);
  });
  it('picks the VM state datastore like KubeVirt', () => {
    const sc = (name: string, ann: Record<string, string> = {}) => ({ metadata: { name, annotations: ann } });
    const scs = [sc('topolvm', { 'storageclass.kubernetes.io/is-default-class': 'true' }), sc('ceph')];
    expect(G.vmStateDatastore(kv([]), scs)).toEqual({ name: 'topolvm', how: 'default' });
    scs[1].metadata.annotations = { 'storageclass.kubevirt.io/is-default-virt-class': 'true' };
    expect(G.vmStateDatastore(kv([]), scs)).toEqual({ name: 'ceph', how: 'virt-default' });
    expect(G.vmStateDatastore(kv([], 'v1.7.0', { configuration: { vmStateStorageClass: 'x' } }), scs)).toEqual({ name: 'x', how: 'set' });
  });
});

describe('VM state access mode', () => {
  const sp = (name: string, sets: any[]) => ({ metadata: { name }, status: { claimPropertySets: sets } });
  it('follows the storage profile like KubeVirt', () => {
    const profiles = [
      sp('ceph-rbd', [{ accessModes: ['ReadWriteMany'], volumeMode: 'Block' }, { accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem' }]),
      sp('cephfs', [{ accessModes: ['ReadWriteMany'], volumeMode: 'Filesystem' }]),
    ];
    expect(G.vmStateAccess(null, profiles, 'ceph-rbd')).toBe('RWO');
    expect(G.vmStateAccess(null, profiles, 'cephfs')).toBe('RWX');
    expect(G.vmStateAccess(null, profiles, 'none')).toBe('RWO');
    const set = { metadata: { name: 'kv' }, spec: { configuration: { vmStateStorageClass: 'none' } } } as any;
    expect(G.vmStateAccess(set, profiles, 'none')).toBe('RWX');
  });
});
