import { describe, expect, it } from 'vitest';
import { diskMoveStep, newDiskName, newDiskObject, newDiskSpec, swapDisks } from './move';
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
