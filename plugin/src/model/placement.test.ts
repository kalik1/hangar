import { describe, expect, it } from 'vitest';
import {
  claimLocality,
  coldCpuModel,
  cpuCompatible,
  cpuNeed,
  deviceNeeds,
  evacuationPlan,
  liveGate,
  nodeDeviceFree,
  nodeMatchesTerms,
  nodeMemoryFree,
  pinnedHost,
  placement,
  podSum,
  pvHosts,
  untoleratedTaint,
} from './placement';
import { Obj } from './types';

const GiB = 2 ** 30;

function node(name: string, opts: { vendor?: string; model?: string; migrationModels?: string[]; features?: string[]; required?: string[]; mem?: number; ready?: boolean; cordon?: boolean; extra?: Record<string, string>; alloc?: Record<string, string> } = {}): Obj {
  const labels: Record<string, string> = { 'kubernetes.io/hostname': name, 'kubevirt.io/schedulable': 'true', ...(opts.extra ?? {}) };
  if (opts.vendor) labels[`cpu-vendor.node.kubevirt.io/${opts.vendor}`] = 'true';
  if (opts.model) labels[`host-model-cpu.node.kubevirt.io/${opts.model}`] = 'true';
  for (const m of opts.migrationModels ?? (opts.model ? [opts.model] : [])) labels[`cpu-model-migration.node.kubevirt.io/${m}`] = 'true';
  for (const f of opts.features ?? []) labels[`cpu-feature.node.kubevirt.io/${f}`] = 'true';
  for (const f of opts.required ?? []) labels[`host-model-required-features.node.kubevirt.io/${f}`] = 'true';
  return {
    metadata: { name, labels },
    spec: opts.cordon ? { unschedulable: true } : {},
    status: {
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
      allocatable: { memory: String(opts.mem ?? 16 * GiB), cpu: '8', ...(opts.alloc ?? {}) },
    },
  };
}

const intelA = node('a', { vendor: 'Intel', model: 'SierraForest', features: ['vmx', 'ss'], required: ['vmx', 'ss'] });
const intelB = node('b', { vendor: 'Intel', model: 'SierraForest', features: ['vmx', 'ss'], required: ['vmx', 'ss'] });
const amdC = node('c', { vendor: 'AMD', model: 'EPYC-Rome', features: ['svm'], migrationModels: ['EPYC-Rome', 'EPYC'] });

function vm(name: string, spec: any = {}, volumes: any[] = [{ name: 'rootdisk', dataVolume: { name: `${name}-rootdisk` } }]): Obj {
  return {
    metadata: { name, namespace: 'demo' },
    spec: {
      template: {
        spec: {
          domain: { cpu: { cores: 2 }, memory: { guest: '2Gi' }, devices: { disks: [{ name: 'rootdisk', disk: { bus: 'virtio' } }], ...(spec.devices ?? {}) } },
          volumes,
          ...(spec.tmpl ?? {}),
        },
      },
    },
  };
}

function vmi(name: string, nodeName: string, live: { status: string; reason?: string; message?: string } = { status: 'True' }, spec: any = {}): Obj {
  return {
    metadata: { name, namespace: 'demo' },
    spec: { domain: { cpu: { model: 'host-model', cores: 2 }, memory: { guest: '2Gi' } }, ...spec },
    status: {
      nodeName,
      conditions: [{ type: 'LiveMigratable', ...live }, { type: 'StorageLiveMigratable', status: 'True' }],
    },
  };
}

function launcher(vmName: string, nodeName: string, memGi: number, limits: Record<string, string> = {}): Obj {
  return {
    metadata: { name: `virt-launcher-${vmName}`, namespace: 'demo', labels: { 'vm.kubevirt.io/name': vmName } },
    spec: { nodeName, containers: [{ name: 'compute', resources: { requests: { memory: `${memGi}Gi` }, limits } }] },
    status: { phase: 'Running' },
  };
}

function claim(name: string, modes: string[], volumeName = `pv-${name}`): Obj {
  return { metadata: { name, namespace: 'demo' }, spec: { accessModes: modes, volumeName, storageClassName: 'x' }, status: { accessModes: modes } };
}

function pv(name: string, hostKey?: string, host?: string): Obj {
  return {
    metadata: { name },
    spec: hostKey ? { nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: hostKey, operator: 'In', values: [host] }] }] } } } : {},
  };
}

describe('node rules', () => {
  it('evaluates selector terms', () => {
    expect(nodeMatchesTerms(intelA, [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['a'] }] }])).toBe(true);
    expect(nodeMatchesTerms(intelB, [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['a'] }] }])).toBe(false);
    expect(nodeMatchesTerms(intelB, [{ matchExpressions: [{ key: 'gpu', operator: 'DoesNotExist' }] }])).toBe(true);
    expect(nodeMatchesTerms(intelB, undefined)).toBe(true);
  });
  it('finds untolerated taints', () => {
    const n = { ...intelA, spec: { taints: [{ key: 'dedicated', value: 'db', effect: 'NoSchedule' }] } };
    expect(untoleratedTaint(n, [])?.key).toBe('dedicated');
    expect(untoleratedTaint(n, [{ key: 'dedicated', operator: 'Equal', value: 'db', effect: 'NoSchedule' }])).toBeUndefined();
    expect(untoleratedTaint(n, [{ operator: 'Exists' }])).toBeUndefined();
  });
  it('reads a host pin', () => {
    expect(pinnedHost({ nodeSelector: { 'kubernetes.io/hostname': 'a' } })).toBe('a');
    expect(
      pinnedHost({ affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['b'] }] }] } } } })
    ).toBe('b');
    expect(pinnedHost({})).toBeUndefined();
  });
});

describe('disk locality', () => {
  const nodes = [intelA, intelB, amdC];
  it('ties a TopoLVM volume to its host', () => {
    expect(pvHosts(pv('p', 'topology.topolvm.io/node', 'a'), [...nodes, node('d', { extra: { 'topology.topolvm.io/node': 'd' } })])).toEqual([]);
    const a = { ...intelA, metadata: { ...intelA.metadata, labels: { ...intelA.metadata.labels, 'topology.topolvm.io/node': 'a' } } };
    expect(claimLocality(claim('d', ['ReadWriteOnce']), pv('p', 'topology.topolvm.io/node', 'a'), [a, intelB])).toEqual({ kind: 'local', hosts: ['a'] });
  });
  it('a static local RWX volume is still local', () => {
    expect(claimLocality(claim('d', ['ReadWriteMany']), pv('p', 'kubernetes.io/hostname', 'b'), nodes)).toEqual({ kind: 'local', hosts: ['b'] });
  });
  it('RWX without host affinity is shared, RWO is network', () => {
    expect(claimLocality(claim('d', ['ReadWriteMany']), pv('p'), nodes)).toEqual({ kind: 'shared' });
    expect(claimLocality(claim('d', ['ReadWriteOnce']), pv('p'), nodes)).toEqual({ kind: 'network' });
    expect(claimLocality(undefined, undefined, nodes)).toEqual({ kind: 'pending' });
  });
});

describe('CPU compatibility', () => {
  it('host-model needs the source model and its required features on the target', () => {
    const need = cpuNeed({ domain: { cpu: { model: 'host-model' } } }, intelA);
    expect(need).toMatchObject({ mode: 'host-model', model: 'SierraForest', vendor: 'Intel' });
    expect(need.features.sort()).toEqual(['ss', 'vmx']);
    expect(cpuCompatible(need, intelB)).toEqual({ ok: true });
    const r = cpuCompatible(need, amdC);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/Intel → AMD/);
  });
  it('a missing feature blocks', () => {
    const b = node('b2', { vendor: 'Intel', model: 'SierraForest', features: ['vmx'] });
    expect(cpuCompatible(cpuNeed({ domain: { cpu: {} } }, intelA), b).why).toMatch(/ss missing/);
  });
  it('a named model needs its label', () => {
    const need = cpuNeed({ domain: { cpu: { model: 'EPYC' } } }, amdC);
    expect(cpuCompatible(need, intelA).ok).toBe(false);
    const c2 = node('c2', { vendor: 'AMD', extra: { 'cpu-model.node.kubevirt.io/EPYC': 'true' } });
    expect(cpuCompatible({ ...need, vendor: undefined }, c2).ok).toBe(true);
  });
  it('a named model both makers offer moves live between Intel and AMD', () => {
    const sb = { 'cpu-model.node.kubevirt.io/SandyBridge': 'true' };
    const i1 = node('i1', { vendor: 'Intel', model: 'SierraForest', extra: sb });
    const a1 = node('a1', { vendor: 'AMD', model: 'EPYC-IBPB', extra: sb });
    const need = cpuNeed({ domain: { cpu: { model: 'SandyBridge' } } }, i1);
    expect(need).toMatchObject({ mode: 'named', model: 'SandyBridge', vendor: 'Intel' });
    expect(cpuCompatible(need, a1)).toEqual({ ok: true });
  });
});

describe('cold CPU model', () => {
  const vm = (spec: any, it?: any) => ({ metadata: { name: 'v', namespace: 'n' }, spec: { ...(it ? { instancetype: it } : {}), template: { spec } } }) as any;
  const flavors = [
    { metadata: { name: 'port.large' }, spec: { cpu: { guest: 2, model: 'SandyBridge' } } },
    { metadata: { name: 'port.large', namespace: 'n' }, spec: { cpu: { guest: 2, model: 'Westmere' } } },
  ] as any[];
  it('resolves own, then flavor, then cluster default', () => {
    expect(coldCpuModel(vm({ domain: { cpu: { model: 'Nehalem' } } }, { name: 'port.large' }), flavors, 'Penryn')).toBe('Nehalem');
    expect(coldCpuModel(vm({ domain: {} }, { kind: 'VirtualMachineClusterInstancetype', name: 'port.large' }), flavors, 'Penryn')).toBe('SandyBridge');
    expect(coldCpuModel(vm({ domain: {} }, { kind: 'VirtualMachineInstancetype', name: 'port.large' }), flavors)).toBe('Westmere');
    expect(coldCpuModel(vm({ domain: {} }), flavors, 'Penryn')).toBe('Penryn');
    expect(coldCpuModel(vm({ domain: {} }), flavors)).toBeUndefined();
  });
  it('a powered-off VM with a flavor model cannot start where the model is missing', () => {
    const sb = { 'cpu-model.node.kubevirt.io/SandyBridge': 'true' };
    const nodes = [node('i1', { vendor: 'Intel', extra: sb }), node('x1', { vendor: 'Intel' })];
    const p = placement({ vm: vm({ domain: {} }, { name: 'port.large' }), nodes, launchers: [], pvcs: new Map(), pvs: new Map(), instancetypes: flavors });
    expect(p.hosts.find(h => h.host === 'i1')?.cold.ok).toBe(true);
    expect(p.hosts.find(h => h.host === 'x1')?.cold.reasons).toContain('CPU model SandyBridge is not available here');
  });
});

describe('memory and devices', () => {
  const launchers = [launcher('x', 'a', 4), launcher('y', 'a', 2, { 'hangar.magesgate.com/iris-xe-vf': '1' })];
  it('subtracts VM pods, not its own', () => {
    expect(nodeMemoryFree(intelA, launchers)).toBe(10 * GiB);
    expect(nodeMemoryFree(intelA, launchers, 'demo/x')).toBe(14 * GiB);
    expect(nodeMemoryFree(intelA, launchers, undefined, 12 * GiB)).toBe(4 * GiB);
    // All pods' requests (Ceph and others) when known; its own pod still excluded.
    expect(nodeMemoryFree(intelA, launchers, 'demo/x', undefined, 15 * GiB)).toBe(5 * GiB);
  });
  it('counts devices held by VM pods', () => {
    const a = node('a', { alloc: { 'hangar.magesgate.com/iris-xe-vf': '2' } });
    expect(nodeDeviceFree(a, launchers, 'hangar.magesgate.com/iris-xe-vf')).toEqual({ total: 2, free: 1 });
    expect(nodeDeviceFree(intelB, launchers, 'hangar.magesgate.com/iris-xe-vf')).toEqual({ total: 0, free: 0 });
    expect([...deviceNeeds({ domain: { devices: { hostDevices: [{ name: 'g', deviceName: 'r' }], gpus: [{ name: 'h', deviceName: 'r' }] } } })]).toEqual([['r', 2]]);
  });
});

describe('pod requests', () => {
  it('counts sidecar init containers and overhead like the scheduler', () => {
    const pod = {
      metadata: { name: 'p' },
      spec: {
        containers: [{ resources: { requests: { memory: '1300Mi' } } }],
        initContainers: [
          { restartPolicy: 'Always', resources: { requests: { memory: '35Mi' } } },
          { resources: { requests: { memory: '2Gi' } } },
        ],
        overhead: { memory: '10Mi' },
      },
    };
    expect(podSum(pod, 'requests', 'memory')).toBe(2 * GiB + 10 * 2 ** 20);
    pod.spec.initContainers.pop();
    expect(podSum(pod, 'requests', 'memory')).toBe((1300 + 35 + 10) * 2 ** 20);
  });
});

describe('live gate', () => {
  it('explains KubeVirt refusals', () => {
    expect(liveGate(null).ok).toBe(false);
    expect(liveGate(vmi('v', 'a', { status: 'False', reason: 'HostDeviceNotLiveMigratable', message: 'VMI uses a PCI host devices' })).why).toMatch(/device of its host/);
    expect(
      liveGate(vmi('v', 'a', { status: 'False', reason: 'DisksNotLiveMigratable', message: 'cannot migrate VMI: PVC web-01-rootdisk is not shared, live migration requires…' })).why
    ).toBe('Disk web-01-rootdisk is stored on one host only (not shared storage).');
    expect(liveGate(vmi('v', 'a')).ok).toBe(true);
  });
});

describe('placement verdicts', () => {
  const nodes = [intelA, intelB, amdC];
  const pvs = new Map([['pv-ceph-root', pv('pv-ceph-root')]]);
  const pvcs = new Map([['demo/ceph-root', claim('ceph-root', ['ReadWriteMany'], 'pv-ceph-root')]]);
  const v = vm('ceph', {}, [{ name: 'rootdisk', persistentVolumeClaim: { claimName: 'ceph-root' } }]);

  it('a Ceph VM moves live between the Intel hosts, only powered off to the AMD one', () => {
    const p = placement({ vm: v, vmi: vmi('ceph', 'a'), nodes, launchers: [launcher('ceph', 'a', 2)], pvcs, pvs });
    const by = Object.fromEntries(p.hosts.map(h => [h.host, h]));
    expect(by.a.current).toBe(true);
    expect(by.b.live.ok).toBe(true);
    expect(by.c.live.ok).toBe(false);
    expect(by.c.live.reasons.join()).toMatch(/CPU maker/);
    expect(by.c.cold.ok).toBe(true);
  });

  it('a GPU VM cannot move live; powered off only where a device is free', () => {
    const gpuVm = vm('gpu', { devices: { hostDevices: [{ name: 'gpu1', deviceName: 'hangar.magesgate.com/iris-xe-vf' }] } }, [
      { name: 'rootdisk', persistentVolumeClaim: { claimName: 'ceph-root' } },
    ]);
    const a = node('a', { vendor: 'Intel', model: 'SierraForest', alloc: { 'hangar.magesgate.com/iris-xe-vf': '2' } });
    const b = node('b', { vendor: 'Intel', model: 'SierraForest', alloc: { 'hangar.magesgate.com/iris-xe-vf': '2' } });
    const launchers = [
      launcher('gpu', 'a', 2, { 'hangar.magesgate.com/iris-xe-vf': '1' }),
      launcher('o1', 'b', 1, { 'hangar.magesgate.com/iris-xe-vf': '1' }),
      launcher('o2', 'b', 1, { 'hangar.magesgate.com/iris-xe-vf': '1' }),
    ];
    const p = placement({
      vm: gpuVm,
      vmi: vmi('gpu', 'a', { status: 'False', reason: 'HostDeviceNotLiveMigratable' }),
      nodes: [a, b, amdC],
      launchers,
      pvcs,
      pvs,
    });
    const by = Object.fromEntries(p.hosts.map(h => [h.host, h]));
    expect(p.live.ok).toBe(false);
    expect(by.b.live.ok).toBe(false);
    expect(by.b.cold.ok).toBe(false);
    expect(by.b.cold.reasons[0]).toMatch(/No free iris-xe-vf \(0 of 2 free\)/);
    expect(by.c.cold.reasons[0]).toMatch(/No iris-xe-vf on this host/);
  });

  it('a VM on a local disk cannot leave its host either way', () => {
    const lpvs = new Map([['pv-l', pv('pv-l', 'kubernetes.io/hostname', 'a')]]);
    const lpvcs = new Map([['demo/l', claim('l', ['ReadWriteOnce'], 'pv-l')]]);
    const lv = vm('local', {}, [{ name: 'rootdisk', persistentVolumeClaim: { claimName: 'l' } }]);
    const p = placement({ vm: lv, vmi: vmi('local', 'a', { status: 'False', reason: 'DisksNotLiveMigratable', message: 'PVC l is not shared' }), nodes, launchers: [], pvcs: lpvcs, pvs: lpvs });
    const b = p.hosts.find(h => h.host === 'b')!;
    expect(b.live.ok).toBe(false);
    expect(b.cold.reasons).toContain('Disk l is stored on a');
    // A live disk move copies the disk: b can take the VM for that, the AMD host still cannot.
    expect(b.liveDiskMove).toEqual({ ok: true, reasons: [] });
    expect(p.hosts.find(h => h.host === 'c')!.liveDiskMove.reasons.join()).toMatch(/CPU maker/);
    expect(p.hosts.find(h => h.host === 'a')!.liveDiskMove.ok).toBe(false);
  });

  it('a single host can take no live disk move', () => {
    const lpvs = new Map([['pv-l', pv('pv-l', 'kubernetes.io/hostname', 'a')]]);
    const lpvcs = new Map([['demo/l', claim('l', ['ReadWriteOnce'], 'pv-l')]]);
    const lv = vm('local', {}, [{ name: 'rootdisk', persistentVolumeClaim: { claimName: 'l' } }]);
    const p = placement({ vm: lv, vmi: vmi('local', 'a', { status: 'False', reason: 'DisksNotLiveMigratable' }), nodes: [intelA], launchers: [], pvcs: lpvcs, pvs: lpvs });
    expect(p.hosts.filter(h => h.liveDiskMove.ok)).toEqual([]);
  });

  it('other refusals of KubeVirt hold for a live disk move too', () => {
    const p = placement({ vm: v, vmi: vmi('ceph', 'a', { status: 'False', reason: 'HostDeviceNotLiveMigratable' }), nodes, launchers: [], pvcs, pvs });
    expect(p.hosts.find(h => h.host === 'b')!.liveDiskMove.ok).toBe(false);
  });

  it('maintenance, memory and pins are reasons', () => {
    const small = node('b', { vendor: 'Intel', model: 'SierraForest', mem: 1 * GiB });
    const p = placement({ vm: v, vmi: vmi('ceph', 'a'), nodes: [intelA, small, node('d', { cordon: true })], launchers: [launcher('ceph', 'a', 2)], pvcs, pvs });
    const by = Object.fromEntries(p.hosts.map(h => [h.host, h]));
    expect(by.b.live.reasons.join()).toMatch(/Not enough free memory/);
    expect(by.d.cold.reasons[0]).toBe('In maintenance mode');
    const pinned = placement({
      vm: v,
      vmi: vmi('ceph', 'a', { status: 'True' }, { nodeSelector: { 'kubernetes.io/hostname': 'a' } }),
      nodes,
      launchers: [],
      pvcs,
      pvs,
    });
    expect(pinned.hosts.find(h => h.host === 'b')!.live.reasons).toContain('It is pinned to a');
  });

  it('a powered-off VM can only be placed', () => {
    const p = placement({ vm: v, vmi: null, nodes, launchers: [], pvcs, pvs });
    expect(p.running).toBe(false);
    expect(p.hosts.every(h => !h.live.ok)).toBe(true);
    expect(p.hosts.every(h => h.cold.ok)).toBe(true);
  });

  it('plans an evacuation', () => {
    const vmiIdx = new Map([
      ['demo/ceph', vmi('ceph', 'a')],
      ['demo/gpu', vmi('gpu', 'a', { status: 'False', reason: 'HostDeviceNotLiveMigratable' })],
    ]);
    const rows = evacuationPlan('a', [v, vm('gpu')], vmiIdx, { nodes, launchers: [], pvcs, pvs });
    expect(rows.find(r => r.vm.metadata.name === 'ceph')).toMatchObject({ live: true, targets: ['b'] });
    expect(rows.find(r => r.vm.metadata.name === 'gpu')!.why).toMatch(/device of its host/);
  });
});
