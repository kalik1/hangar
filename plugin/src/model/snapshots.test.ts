import { describe, expect, it } from 'vitest';
import {
  consistencyOf,
  diskCoverage,
  exclusionReason,
  featureGate,
  restoreManifest,
  snapshotManifest,
  snapshotName,
  snapshotSupport,
  snapshotView,
  timeline,
} from './snapshots';
import { Obj } from './types';

const vm: Obj = {
  metadata: { namespace: 'demo', name: 'cirros-test' },
  spec: {
    template: {
      spec: {
        domain: { devices: { disks: [{ name: 'rootdisk', disk: {} }, { name: 'cloudinitdisk', disk: {} }] } },
        volumes: [
          { name: 'rootdisk', dataVolume: { name: 'cirros-test-rootdisk' } },
          { name: 'cloudinitdisk', cloudInitNoCloud: { userData: '#cloud-config' } },
        ],
      },
    },
  },
  status: {
    volumeSnapshotStatuses: [
      { name: 'rootdisk', enabled: true },
      { name: 'cloudinitdisk', enabled: false, reason: 'Snapshot is not supported for this volumeSource type [cloudinitdisk]' },
    ],
  },
};

// As KubeVirt 1.7 wrote it on a test cluster.
const snap: Obj = {
  metadata: { namespace: 'demo', name: 'cirros-test-probe', uid: '00000000-0000-4000-8000-000000000002', annotations: { description: 'CLI probe' } },
  spec: { source: { apiGroup: 'kubevirt.io', kind: 'VirtualMachine', name: 'cirros-test' } },
  status: {
    creationTime: '2026-11-22T18:37:56Z',
    indications: ['NoGuestAgent', 'Online'],
    phase: 'Succeeded',
    readyToUse: true,
    snapshotVolumes: { includedVolumes: ['rootdisk'] },
    virtualMachineSnapshotContentName: 'vmsnapshot-content-00000000-0000-4000-8000-000000000002',
  },
};
const vs: Obj = {
  metadata: { namespace: 'demo', name: 'vmsnapshot-00000000-0000-4000-8000-000000000002-volume-rootdisk' },
  status: { readyToUse: true, restoreSize: '1Gi' },
};

describe('snapshotView', () => {
  it('reads a snapshot taken while running without an agent', () => {
    const v = snapshotView(snap, [vs]);
    expect(v).toMatchObject({
      displayName: 'cirros-test-probe',
      description: 'CLI probe',
      ready: true,
      online: true,
      consistency: 'crash',
      included: ['rootdisk'],
      sizeBytes: 2 ** 30,
      state: { label: 'Ready' },
    });
    expect(v.volumeSnapshots).toHaveLength(1);
  });
  it('tells how consistent a snapshot is', () => {
    expect(consistencyOf(['Online', 'GuestAgent'])).toBe('quiesced');
    expect(consistencyOf(['Online', 'GuestAgent', 'QuiesceFailed'])).toBe('crash');
    expect(consistencyOf(['NoGuestAgent'])).toBe('offline');
    expect(consistencyOf(undefined)).toBe('unknown');
  });
  it('reports failures', () => {
    const v = snapshotView({ ...snap, status: { phase: 'Failed', error: { message: 'deadline exceeded' } } });
    expect(v).toMatchObject({ state: { label: 'Failed', tone: 'fault' }, error: 'deadline exceeded', ready: false });
  });
});

describe('coverage and support', () => {
  it('says which disks a snapshot holds', () => {
    expect(diskCoverage(vm)).toEqual([
      { disk: 'rootdisk', included: true, reason: undefined, config: false },
      { disk: 'cloudinitdisk', included: false, reason: 'Cloud-init settings: rebuilt from the VM settings', config: true },
    ]);
    expect(exclusionReason('No VolumeSnapshotClass: Volume snapshots are not configured for this StorageClass [x]')).toBe(
      'Its datastore has no snapshot support'
    );
  });
  it('reads the feature gate', () => {
    expect(featureGate({ metadata: { name: 'kv' }, spec: { configuration: { developerConfiguration: { featureGates: ['Snapshot'] } } } }, 'Snapshot')).toBe('on');
    expect(featureGate({ metadata: { name: 'kv' }, spec: { configuration: { developerConfiguration: {} } } }, 'Snapshot')).toBe('unknown');
  });
  const pvcs = new Map([['demo/cirros-test-rootdisk', { metadata: { namespace: 'demo', name: 'cirros-test-rootdisk' }, spec: { storageClassName: 'topolvm-provisioner' } }]]);
  const scs = [{ metadata: { name: 'topolvm-provisioner' }, provisioner: 'topolvm.io' }];
  it('says exactly what is missing', () => {
    const none = snapshotSupport({ vmSnapshotApi: true, volumeSnapshotApi: false, gate: 'unknown', vm, pvcs, storageClasses: scs, snapshotClasses: [] });
    expect(none.ok).toBe(false);
    expect(none.missing.map(m => m.title)).toEqual(['The cluster has no volume snapshots']);
    const gate = snapshotSupport({ vmSnapshotApi: true, volumeSnapshotApi: true, gate: 'off', vm, pvcs, storageClasses: scs, snapshotClasses: [{ metadata: { name: 'c' }, driver: 'topolvm.io' }] });
    expect(gate.ok).toBe(false);
    expect(gate.missing[0].title).toBe('Turn on the Snapshot feature of KubeVirt');
    const noClass = snapshotSupport({ vmSnapshotApi: true, volumeSnapshotApi: true, gate: 'on', vm, pvcs, storageClasses: scs, snapshotClasses: [] });
    expect(noClass.ok).toBe(false);
    expect(noClass.uncovered).toEqual(['rootdisk']);
    expect(noClass.missing[0].title).toBe('Datastore topolvm-provisioner has no snapshot class');
    const ok = snapshotSupport({ vmSnapshotApi: true, volumeSnapshotApi: true, gate: 'on', vm, pvcs, storageClasses: scs, snapshotClasses: [{ metadata: { name: 'c' }, driver: 'topolvm.io' }] });
    expect(ok).toEqual({ ok: true, missing: [], uncovered: [] });
  });
});

describe('manifests and timeline', () => {
  it('names snapshots after the VM and what the user typed', () => {
    expect(snapshotName('cirros-test', 'Before upgrade', new Set())).toBe('cirros-test-before-upgrade');
    expect(snapshotName('cirros-test', 'Before upgrade', new Set(['cirros-test-before-upgrade']))).toBe('cirros-test-before-upgrade-2');
    expect(snapshotName('a-very-long-virtual-machine-name-indeed', 'x'.repeat(80), new Set()).length).toBeLessThanOrEqual(63);
  });
  it('builds the snapshot and the restore', () => {
    const s = snapshotManifest(vm, 'cirros-test-before', 'Before', ' notes ');
    expect(s.spec).toEqual({ source: { apiGroup: 'kubevirt.io', kind: 'VirtualMachine', name: 'cirros-test' } });
    expect(s.metadata.annotations).toEqual({ 'hangar.magesgate.com/display-name': 'Before', description: 'notes' });
    const r = restoreManifest(vm, 'cirros-test-before', 'cirros-test-revert-x');
    expect(r.spec).toEqual({ target: { apiGroup: 'kubevirt.io', kind: 'VirtualMachine', name: 'cirros-test' }, virtualMachineSnapshotName: 'cirros-test-before' });
  });
  it('orders snapshots and reverts, newest first', () => {
    const restore = {
      metadata: { namespace: 'demo', name: 'r1', creationTimestamp: '2026-11-22T18:39:10Z' },
      spec: { target: { name: 'cirros-test' }, virtualMachineSnapshotName: 'cirros-test-probe' },
      status: { complete: true, restoreTime: '2026-11-22T18:39:16Z' },
    };
    const other = { ...snap, metadata: { ...snap.metadata, name: 'other' }, spec: { source: { name: 'web-01' } } };
    const t = timeline(vm, [snap, other], [restore]);
    expect(t.map(e => e.kind)).toEqual(['revert', 'snapshot']);
    expect(t[0]).toMatchObject({ snapshot: 'cirros-test-probe', complete: true });
  });
});
