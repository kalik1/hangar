import * as G from './gates';

const kv = (gates: string[], version = 'v1.7.0', extra: any = {}, disabled?: string[]): any => ({
  metadata: { name: 'kubevirt', namespace: 'kubevirt', resourceVersion: '5' },
  spec: { configuration: { developerConfiguration: { featureGates: gates, ...(disabled ? { disabledFeatureGates: disabled } : {}) }, ...extra.configuration }, ...extra.spec },
  status: { observedKubeVirtVersion: version },
});

describe('feature gates', () => {
  it('finds the table by minor version and says unknown otherwise', () => {
    expect(G.gateTable(kv([], 'v1.7.0'))?.version).toBe('v1.7');
    expect(G.gateTable(kv([], 'v1.7.3'))?.version).toBe('v1.7');
    expect(G.gateTable(kv([], 'v1.8.4'))?.version).toBe('v1.8');
    expect(G.gateTable(kv([], 'v1.9.1'))?.version).toBe('v1.9');
    expect(G.gateTable(kv([], 'v1.10.0'))?.version).toBe('v1.10');
    expect(G.gateTable(kv([], 'v1.11.0'))).toBeNull();
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
    const k = kv(['VSOCK'], 'v1.11.0');
    expect(G.gateState(k, 'VSOCK')).toMatchObject({ maturity: null, on: true });
    expect(G.gateState(k, 'VMLiveUpdateFeatures')).toMatchObject({ maturity: null, on: null });
  });
  it('treats declarative hot-plug as off while the old gate is listed', () => {
    const k = kv(['HotplugVolumes', 'DeclarativeHotplugVolumes']);
    expect(G.gateState(k, 'DeclarativeHotplugVolumes').on).toBe(false);
    expect(G.gateProblems(k)[0]).toMatch(/both on/);
  });
  it('never writes both hot-plug gates and keeps the others (v1.7: featureGates only)', () => {
    expect(G.nextGates(kv(['Snapshot', 'HotplugVolumes']), 'DeclarativeHotplugVolumes', true)).toEqual({
      featureGates: ['Snapshot', 'DeclarativeHotplugVolumes'],
      disabledFeatureGates: [],
      removed: ['HotplugVolumes'],
    });
    expect(G.nextGates(kv(['DeclarativeHotplugVolumes', 'Snapshot']), 'HotplugVolumes', true).featureGates).toEqual(['Snapshot', 'HotplugVolumes']);
    expect(G.nextGates(kv(['Snapshot', 'VSOCK']), 'VSOCK', true).featureGates).toEqual(['Snapshot', 'VSOCK']);
    expect(G.nextGates(kv(['Snapshot', 'VSOCK', 'Sidecar']), 'VSOCK', false).featureGates).toEqual(['Snapshot', 'Sidecar']);
  });
  it('lists Hangar gates, then unknown listed ones, then the rest', () => {
    const r = G.gateRows(kv(['Snapshot', 'MyOwnGate']));
    expect(r.hangar[0].name).toBe('DeclarativeHotplugVolumes');
    expect(r.listedOther.map(x => x.name)).toEqual(['MyOwnGate']);
    expect(r.listedOther[0]).toMatchObject({ maturity: null, on: false });
    expect(r.listedOther[0].note).toMatch(/does not know/);
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

describe('feature gates by KubeVirt minor', () => {
  it('takes the maturity from the running minor', () => {
    const m = (v: string, g: string) => G.gateState(kv([], v), g).maturity;
    expect([m('v1.7.0', 'ExpandDisks'), m('v1.8.4', 'ExpandDisks'), m('v1.9.1', 'ExpandDisks')]).toEqual(['Alpha', 'Alpha', 'GA']);
    expect([m('v1.7.0', 'EnableVirtioFsConfigVolumes'), m('v1.8.4', 'EnableVirtioFsConfigVolumes')]).toEqual(['Alpha', 'GA']);
    expect([m('v1.8.4', 'DeclarativeHotplugVolumes'), m('v1.9.1', 'DeclarativeHotplugVolumes')]).toEqual(['Alpha', 'Beta']);
    expect([m('v1.8.4', 'HotplugVolumes'), m('v1.9.1', 'HotplugVolumes')]).toEqual(['Alpha', 'Deprecated']);
    expect([m('v1.9.1', 'VSOCK'), m('v1.10.0', 'VSOCK')]).toEqual(['Alpha', 'Beta']);
    expect(m('v1.7.0', 'IOMMUFD')).toBeNull();
    expect(m('v1.9.1', 'IOMMUFD')).toBe('Alpha');
  });
  it('turns Beta on by default from v1.9, off through disabledFeatureGates', () => {
    // v1.8: Beta off unless listed.
    expect(G.gateState(kv([], 'v1.8.4'), 'Snapshot')).toMatchObject({ maturity: 'Beta', on: false, byDefault: false });
    // v1.9: Beta on unless disabled.
    expect(G.gateState(kv([], 'v1.9.1'), 'Snapshot')).toMatchObject({ maturity: 'Beta', on: true, byDefault: true });
    expect(G.gateState(kv([], 'v1.9.1', {}, ['Snapshot']), 'Snapshot')).toMatchObject({ on: false, disabled: true });
    // Listed wins over disabled, as in KubeVirt's IsEnabled (and is flagged).
    expect(G.gateState(kv(['Snapshot'], 'v1.9.1', {}, ['Snapshot']), 'Snapshot').on).toBe(true);
    expect(G.gateProblems(kv(['Snapshot'], 'v1.9.1', {}, ['Snapshot']))[0]).toMatch(/both featureGates and disabledFeatureGates/);
    // A gate a known version does not know does nothing.
    expect(G.gateState(kv(['MyGate'], 'v1.9.1'), 'MyGate')).toMatchObject({ maturity: null, on: false });
  });
  it('writes the right list per version', () => {
    // v1.9: turning a default-on Beta gate off goes to disabledFeatureGates, on again removes it.
    expect(G.nextGates(kv(['Sidecar'], 'v1.9.1'), 'Snapshot', false)).toEqual({ featureGates: ['Sidecar'], disabledFeatureGates: ['Snapshot'], removed: [] });
    expect(G.nextGates(kv(['Sidecar', 'Snapshot'], 'v1.9.1'), 'Snapshot', false)).toEqual({ featureGates: ['Sidecar'], disabledFeatureGates: ['Snapshot'], removed: [] });
    expect(G.nextGates(kv(['Sidecar'], 'v1.9.1', {}, ['Snapshot']), 'Snapshot', true)).toEqual({ featureGates: ['Sidecar'], disabledFeatureGates: [], removed: [] });
    // v1.8: Beta is off by default, so it goes in featureGates.
    expect(G.nextGates(kv([], 'v1.8.4'), 'Snapshot', true).featureGates).toEqual(['Snapshot']);
    // Alpha everywhere: featureGates.
    expect(G.nextGates(kv([], 'v1.10.0', {}, ['Sidecar']), 'Sidecar', true)).toEqual({ featureGates: ['Sidecar'], disabledFeatureGates: [], removed: [] });
    // v1.9: DeclarativeHotplugVolumes is on by default; turning the deprecated HotplugVolumes on disables it.
    expect(G.nextGates(kv([], 'v1.9.1'), 'HotplugVolumes', true)).toEqual({ featureGates: ['HotplugVolumes'], disabledFeatureGates: ['DeclarativeHotplugVolumes'], removed: ['DeclarativeHotplugVolumes'] });
    expect(G.nextGates(kv(['HotplugVolumes'], 'v1.9.1', {}, ['DeclarativeHotplugVolumes']), 'DeclarativeHotplugVolumes', true)).toEqual({
      featureGates: [],
      disabledFeatureGates: [],
      removed: ['HotplugVolumes'],
    });
    expect(G.gateState(kv(['HotplugVolumes'], 'v1.9.1'), 'DeclarativeHotplugVolumes').on).toBe(false);
  });
});
