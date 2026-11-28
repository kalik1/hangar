import { describe, expect, it } from 'vitest';
import { diskMoveMode, DiskMoveModeInput, diskMoveStep, newDiskFromSpec, newDiskName, newDiskObject, newDiskSpec, revertDiskMove, stuckDiskMove, swapDisks } from './move';
import { HostVerdict } from './placement';
import { checkUntil, UntilWorld } from './tasks';

const vm = {
  metadata: { name: 'web-01', namespace: 'production', uid: 'u1' },
  spec: {
    dataVolumeTemplates: [{ metadata: { name: 'web-01-rootdisk' }, spec: { source: { pvc: { namespace: 'demo', name: 'tpl' } } } }],
    template: {
      spec: {
        domain: { devices: { disks: [{ name: 'rootdisk' }, { name: 'data' }] } },
        volumes: [
          { name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk' } },
          { name: 'data', persistentVolumeClaim: { claimName: 'web-01-data', hotpluggable: true } },
        ],
      },
    },
  },
};

describe('disk moves', () => {
  it('names the new disk after its first name and the datastore', () => {
    expect(newDiskName('web-01-rootdisk', 'web-01-rootdisk', 'rook-ceph-block', new Set())).toBe('web-01-rootdisk-rook-ceph-block');
    expect(newDiskName('web-01-rootdisk', 'x', 'rook-ceph-block', new Set(['web-01-rootdisk-rook-ceph-block']))).toBe('web-01-rootdisk-rook-ceph-block-2');
    expect(newDiskName('a'.repeat(70), 'x', 'b', new Set()).length).toBeLessThanOrEqual(63);
  });

  it('builds blank (live) or clone (powered off) disks owned by the VM', () => {
    const m = { volume: 'rootdisk', claim: 'web-01-rootdisk', datastore: 'ceph', sizeBytes: 10.2 * 2 ** 30 };
    expect(newDiskSpec(m, 'production', true)).toEqual({ source: { blank: {} }, storage: { storageClassName: 'ceph', resources: { requests: { storage: '11Gi' } } } });
    expect(newDiskSpec(m, 'production', false).source).toEqual({ pvc: { namespace: 'production', name: 'web-01-rootdisk' } });
    const o = newDiskObject(vm, m, 'new', true);
    expect(o.metadata.ownerReferences?.[0]).toMatchObject({ kind: 'VirtualMachine', name: 'web-01', uid: 'u1', controller: true });
    expect(o.metadata.annotations?.['hangar.magesgate.com/moved-from']).toBe('web-01-rootdisk');
  });

  it('swaps volumes and templates, live with the Migration strategy', () => {
    const out = swapDisks(
      vm,
      [
        { move: { volume: 'rootdisk', claim: 'web-01-rootdisk', datastore: 'ceph', sizeBytes: 1 }, newName: 'r2', spec: { source: { blank: {} } } },
        { move: { volume: 'data', claim: 'web-01-data', datastore: 'ceph', sizeBytes: 1 }, newName: 'd2', spec: { source: { blank: {} } } },
      ],
      true
    );
    expect(out.spec.updateVolumesStrategy).toBe('Migration');
    expect(out.spec.template.spec.volumes).toEqual([
      { name: 'rootdisk', dataVolume: { name: 'r2' } },
      { name: 'data', dataVolume: { name: 'd2', hotpluggable: true } },
    ]);
    expect(out.spec.dataVolumeTemplates.map((t: any) => t.metadata.name)).toEqual(['r2', 'd2']);
    expect(vm.spec.template.spec.volumes[0].dataVolume?.name).toBe('web-01-rootdisk');
    const off = swapDisks(vm, [{ move: { volume: 'rootdisk', claim: 'web-01-rootdisk', datastore: 'c', sizeBytes: 1 }, newName: 'r3', spec: {} }], false);
    expect(off.spec.updateVolumesStrategy).toBeUndefined();
    expect(() => swapDisks(vm, [{ move: { volume: 'nope', claim: 'x', datastore: 'c', sizeBytes: 1 }, newName: 'z', spec: {} }], false)).toThrow();
  });
});

const world = (over: Partial<UntilWorld> = {}): UntilWorld => ({
  vmPower: () => ({ kind: 'on', label: 'Powered on' }),
  migration: () => null,
  dataVolume: () => null,
  snapshot: () => null,
  restore: () => null,
  hostVmCount: () => 0,
  ...over,
});

describe('move tasks', () => {
  it('vmOnHost waits for the VM on the target host', () => {
    const u = { type: 'vmOnHost' as const, namespace: 'n', name: 'v', host: 'b' };
    expect(checkUntil(u, world({ vmi: () => ({ status: { phase: 'Running', nodeName: 'a' } }) }), 1000)).toEqual({ status: 'running', message: 'Shutting down' });
    expect(checkUntil(u, world({ vmi: () => null, vmPower: () => ({ kind: 'off', label: 'Powered off' }) }), 1000)?.message).toMatch(/starting on the new host/);
    expect(checkUntil(u, world({ vmi: () => ({ status: { phase: 'Running', nodeName: 'b' } }) }), 1000)?.status).toBe('done');
    expect(checkUntil(u, world({ vmi: () => ({ status: { phase: 'Running', nodeName: 'a' } }) }), 200000)?.status).toBe('warning');
  });
  it('volumesMoved waits for the instance to use the new claims', () => {
    const u = { type: 'volumesMoved' as const, namespace: 'n', name: 'v', volumes: [{ volume: 'rootdisk', claim: 'new' }] };
    const vmiOld = { status: { volumeStatus: [{ name: 'rootdisk', persistentVolumeClaimInfo: { claimName: 'old' } }] } };
    const vmiNew = { status: { volumeStatus: [{ name: 'rootdisk', persistentVolumeClaimInfo: { claimName: 'new' } }] } };
    const vm = { status: {} };
    expect(checkUntil(u, world({ vm: () => vm, vmi: () => vmiOld, vmMigration: () => ({ status: { phase: 'Running' } }) }), 1)).toEqual({
      status: 'running',
      message: 'Copying memory to the target host',
    });
    expect(checkUntil(u, world({ vm: () => vm, vmi: () => vmiNew, vmMigration: () => ({ status: { phase: 'Succeeded' } }) }), 1)?.status).toBe('done');
    expect(
      checkUntil(u, world({ vm: () => ({ status: { conditions: [{ type: 'ManualRecoveryRequired', status: 'True', message: 'm' }] } }), vmi: () => vmiOld }), 1)
    ).toEqual({ status: 'failed', message: 'm' });
  });
});

describe('staged disk move', () => {
  const base = { type: 'diskMove' as const, namespace: 'n', name: 'v', live: true, deleteOld: true, moves: [{ volume: 'rootdisk', claim: 'old', newName: 'new', spec: {} }] };
  it('waits for the new disk, then swaps', () => {
    expect(diskMoveStep({ ...base, stage: 'copy' }, world({ dataVolume: () => ({ status: { phase: 'ImportInProgress', progress: '40%' } }) }))).toEqual({
      kind: 'wait',
      progress: 40,
      message: 'Preparing the new disk',
    });
    expect(diskMoveStep({ ...base, stage: 'copy' }, world({ dataVolume: () => ({ status: { phase: 'Succeeded' } }) }))).toEqual({ kind: 'swap' });
    expect(diskMoveStep({ ...base, stage: 'copy' }, world({ dataVolume: () => ({ metadata: { name: 'new' }, status: { phase: 'Failed' } }) })).kind).toBe('failed');
  });
  it('after the switch, cleans up or finishes', () => {
    const w = world({
      vm: () => ({ status: {} }),
      vmi: () => ({ status: { volumeStatus: [{ name: 'rootdisk', persistentVolumeClaimInfo: { claimName: 'new' } }] } }),
      vmMigration: () => ({ status: { phase: 'Succeeded' } }),
    });
    expect(diskMoveStep({ ...base, stage: 'switch' }, w)).toEqual({ kind: 'cleanup' });
    expect(diskMoveStep({ ...base, deleteOld: false, stage: 'switch' }, w)).toEqual({ kind: 'done' });
    expect(diskMoveStep({ ...base, stage: 'switch' }, world({ vm: () => ({ status: {} }), vmi: () => null })).kind).toBe('wait');
    // KubeVirt keeps migratedVolumes after the end: VolumesChange says whether it is still going.
    const after = { volumeUpdateState: { volumeMigrationState: { migratedVolumes: [{ volumeName: 'rootdisk' }] } } };
    const vmi = () => ({ status: { volumeStatus: [{ name: 'rootdisk', persistentVolumeClaimInfo: { claimName: 'new' } }] } });
    expect(diskMoveStep({ ...base, stage: 'switch' }, world({ vm: () => ({ status: after }), vmi, vmMigration: () => ({ status: { phase: 'Succeeded' } }) }))).toEqual({ kind: 'cleanup' });
    const changing = { ...after, conditions: [{ type: 'VolumesChange', status: 'True' }] };
    expect(diskMoveStep({ ...base, stage: 'switch' }, world({ vm: () => ({ status: changing }), vmi, vmMigration: () => ({ status: { phase: 'Succeeded' } }) })).kind).toBe('wait');
  });
});

describe('staged disk move, powered off for it', () => {
  const base = { type: 'diskMove' as const, namespace: 'n', name: 'v', live: false, deleteOld: true, restart: true, moves: [{ volume: 'rootdisk', claim: 'old', newName: 'new', spec: {}, root: 'first' }] };
  it('waits for the guest to shut down, then makes the copies', () => {
    expect(diskMoveStep({ ...base, stage: 'stop' }, world({ vmPower: () => ({ kind: 'stopping', label: 'Stopping' }) }))).toEqual({ kind: 'wait', message: 'Shutting down the guest' });
    expect(diskMoveStep({ ...base, stage: 'stop' }, world({ vmPower: () => ({ kind: 'off', label: 'Powered off' }) }))).toEqual({ kind: 'create' });
    expect(diskMoveStep({ ...base, stage: 'stop' }, world({ vmPower: () => null })).kind).toBe('failed');
  });
  it('the copy carries the first name of the disk and the VM as owner', () => {
    const o = newDiskFromSpec(vm, 'first', 'new', { source: { pvc: { namespace: 'production', name: 'old' } } });
    expect(o.metadata.annotations?.['hangar.magesgate.com/moved-from']).toBe('first');
    expect(o.metadata.ownerReferences?.[0]).toMatchObject({ kind: 'VirtualMachine', uid: 'u1' });
    expect(o.spec.source.pvc.name).toBe('old');
  });
});

const verdict = (host: string, over: Partial<HostVerdict> = {}): HostVerdict =>
  ({
    host,
    node: { metadata: { name: host } },
    current: false,
    live: { ok: false, reasons: ['Disk web-01-rootdisk is stored on a'] },
    cold: { ok: true, reasons: [] },
    liveDiskMove: { ok: true, reasons: [] },
    memFree: 8 * 2 ** 30,
    devices: [],
    ...over,
  } as HostVerdict);
const here = verdict('a', { current: true, liveDiskMove: { ok: false, reasons: ['It runs here now'] } });
const modeIn = (over: Partial<DiskMoveModeInput> = {}): DiskMoveModeInput => ({
  power: 'on',
  powerLabel: 'Powered on',
  storageLive: true,
  liveReason: 'DisksNotLiveMigratable',
  kubevirtMissing: [],
  hosts: [here, verdict('b')],
  ...over,
});

describe('how a disk move goes', () => {
  it('on one host there is no live move: powered off, Hangar shuts it down and starts it again', () => {
    const m = diskMoveMode(modeIn({ hosts: [here] }));
    expect(m).toMatchObject({ mode: 'offline', restart: true });
    expect(m.mode === 'offline' && m.why).toMatch(/one host/);
  });
  it('live where another host can take it, even with its disks on this host', () => {
    expect(diskMoveMode(modeIn())).toEqual({ mode: 'live', targets: ['b'] });
  });
  it('powered off when no other host can take it, with the hosts’ reasons', () => {
    const m = diskMoveMode(modeIn({ hosts: [here, verdict('b', { liveDiskMove: { ok: false, reasons: ['In maintenance mode'] } })] }));
    expect(m).toMatchObject({ mode: 'offline', restart: true });
    expect(m.mode === 'offline' && m.why).toBe('No other host can take it while it runs (b: in maintenance mode).');
  });
  it('powered off when KubeVirt cannot copy while it runs', () => {
    expect(diskMoveMode(modeIn({ kubevirtMissing: ['workloadUpdateStrategy.workloadUpdateMethods: [LiveMigrate]'] }))).toMatchObject({ mode: 'offline', restart: true });
    expect(diskMoveMode(modeIn({ liveReason: 'HostDeviceNotLiveMigratable' }))).toMatchObject({ mode: 'offline', restart: true, why: expect.stringMatching(/device of its host/) });
    expect(diskMoveMode(modeIn({ storageLive: false }))).toMatchObject({ mode: 'offline', restart: true });
  });
  it('a powered-off VM is copied as it is; other states wait', () => {
    expect(diskMoveMode(modeIn({ power: 'off', powerLabel: 'Powered off', hosts: [verdict('a')] }))).toEqual({ mode: 'offline', restart: false });
    expect(diskMoveMode(modeIn({ power: 'migrating', powerLabel: 'Migrating' }))).toEqual({ mode: 'blocked', why: 'The VM is migrating: wait until it is powered off or running.' });
  });
});

describe('a live disk move that cannot end (left by Hangar 0.1.x)', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const moved = {
    metadata: { name: 'web-01', namespace: 'production', uid: 'u1' },
    spec: {
      updateVolumesStrategy: 'Migration',
      dataVolumeTemplates: [{ metadata: { name: 'web-01-rootdisk-ceph' }, spec: { source: { blank: {} } } }],
      template: {
        spec: {
          domain: { devices: { disks: [{ name: 'rootdisk', bootOrder: 1 }, { name: 'data' }] } },
          volumes: [
            { name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk-ceph' } },
            { name: 'data', persistentVolumeClaim: { claimName: 'web-01-data', hotpluggable: true } },
          ],
        },
      },
    },
    status: { conditions: [{ type: 'VolumesChange', status: 'True', lastTransitionTime: '2026-01-01T10:00:00Z' }] },
  };
  const vmi = { metadata: { name: 'web-01', namespace: 'production' }, status: { migratedVolumes: [{ volumeName: 'rootdisk', sourcePVCInfo: { claimName: 'web-01-rootdisk' }, destinationPVCInfo: { claimName: 'web-01-rootdisk-ceph' } }] } };
  const mig = (name: string, phase: string) => ({ metadata: { name, namespace: 'production' }, spec: { vmiName: 'web-01' }, status: { phase } });
  const oldDv = {
    metadata: { name: 'web-01-rootdisk', namespace: 'production', ownerReferences: [{ kind: 'VirtualMachine', name: 'web-01', uid: 'u1' }] },
    spec: { source: { pvc: { namespace: 'demo', name: 'tpl' } }, storage: { resources: { requests: { storage: '10Gi' } } } },
  };

  it('is found from VolumesChange, the migrated volumes and the Pending workload-update migration', () => {
    const migrations = [mig('kubevirt-workload-update-abcde', 'Pending'), mig('kubevirt-workload-update-fghij', 'Failed'), mig('web-01-move-x', 'Succeeded')];
    expect(stuckDiskMove(moved, vmi, migrations, now)).toEqual({
      volumes: [{ volume: 'rootdisk', oldClaim: 'web-01-rootdisk', newClaim: 'web-01-rootdisk-ceph' }],
      migrations: ['kubevirt-workload-update-abcde'],
    });
    // The VM lists them too, when the instance does not.
    const onVm = { ...moved, status: { ...moved.status, volumeUpdateState: { volumeMigrationState: { migratedVolumes: vmi.status.migratedVolumes } } } };
    expect(stuckDiskMove(onVm, { metadata: { name: 'web-01' }, status: {} }, [], now)?.volumes).toHaveLength(1);
  });

  it('is not a copy under way, nor a move that just started, nor a finished one', () => {
    expect(stuckDiskMove(moved, vmi, [mig('kubevirt-workload-update-abcde', 'Running')], now)).toBeNull();
    expect(stuckDiskMove(moved, vmi, [], Date.parse('2026-01-01T10:01:00Z'))).toBeNull();
    expect(stuckDiskMove({ ...moved, status: { conditions: [{ type: 'VolumesChange', status: 'False' }] } }, vmi, [], now)).toBeNull();
    const back = { ...moved, spec: { ...moved.spec, template: { spec: { ...moved.spec.template.spec, volumes: [{ name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk' } }] } } } };
    expect(stuckDiskMove(back, vmi, [], now)).toBeNull();
  });

  it('puts the old disk and its template back, and drops the new one', () => {
    const stuck = stuckDiskMove(moved, vmi, [], now)!;
    const out = revertDiskMove(moved, stuck, new Map([['production/web-01-rootdisk', oldDv]]));
    expect(out.spec.template.spec.volumes).toEqual([
      { name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk' } },
      { name: 'data', persistentVolumeClaim: { claimName: 'web-01-data', hotpluggable: true } },
    ]);
    expect(out.spec.dataVolumeTemplates).toEqual([{ metadata: { name: 'web-01-rootdisk' }, spec: oldDv.spec }]);
    expect(out.spec.template.spec.domain.devices.disks[0].bootOrder).toBe(1);
    expect(moved.spec.template.spec.volumes[0].dataVolume?.name).toBe('web-01-rootdisk-ceph');
    // A plain claim (no DataVolume) comes back as a claim, with no template.
    const plain = revertDiskMove(moved, stuck, new Map());
    expect(plain.spec.template.spec.volumes[0]).toEqual({ name: 'rootdisk', persistentVolumeClaim: { claimName: 'web-01-rootdisk' } });
    expect(plain.spec.dataVolumeTemplates).toEqual([]);
  });
});
