import { describe, expect, it } from 'vitest';
import {
  bestCommonModel,
  buildFlavor,
  cpuPresets,
  cpuVerdict,
  effectiveCpuModel,
  families,
  familyIdProblem,
  familyLadder,
  flavorFrom,
  flavorHosts,
  flavorRequirements,
  hostCpus,
  modelMatrix,
  nodeSettingsWords,
  setCpuModel,
  setFlavor,
  updatedFlavor,
  vmsUsing,
} from './flavors';

const node = (name: string, vendor: string, hostModel: string, models: string[], extra: Record<string, string> = {}, alloc: Record<string, string> = {}) => ({
  metadata: {
    name,
    labels: {
      [`cpu-vendor.node.kubevirt.io/${vendor}`]: 'true',
      [`host-model-cpu.node.kubevirt.io/${hostModel}`]: 'true',
      ...Object.fromEntries(models.map(m => [`cpu-model.node.kubevirt.io/${m}`, 'true'])),
      ...extra,
    },
  },
  status: { allocatable: alloc },
});

const intel = ['Penryn', 'Nehalem', 'Westmere', 'SandyBridge', 'SandyBridge-v1', 'IvyBridge', 'Haswell-noTSX', 'Broadwell-noTSX', 'Skylake-Client-v3', 'Skylake-Client-v4'];
const amd = ['Penryn', 'Nehalem', 'Westmere', 'SandyBridge', 'SandyBridge-v1', 'EPYC', 'EPYC-IBPB', 'Opteron_G3'];
const nodes = [
  node('intel-a', 'Intel', 'SierraForest', intel),
  node('intel-b', 'Intel', 'SierraForest', intel, { cpumanager: 'true' }, { 'hugepages-2Mi': '4Gi' }),
  node('amd-a', 'AMD', 'EPYC-IBPB', amd),
] as any[];

const it_ = (name: string, labels: Record<string, string>, spec: any, ns?: string) => ({
  metadata: { name, namespace: ns, labels, annotations: {} },
  spec,
});

const shipped = (name: string, cls: string, size: string, spec: any) =>
  it_(name, { 'instancetype.kubevirt.io/class': cls, 'instancetype.kubevirt.io/size': size, 'app.kubernetes.io/managed-by': 'virt-operator' }, spec);

describe('CPU models', () => {
  const cpus = hostCpus(nodes);
  it('reads vendor, host model and models per host', () => {
    expect(cpus.map(c => [c.host, c.vendor, c.hostModel])).toEqual([
      ['amd-a', 'AMD', 'EPYC-IBPB'],
      ['intel-a', 'Intel', 'SierraForest'],
      ['intel-b', 'Intel', 'SierraForest'],
    ]);
  });
  it('picks the newest model every host has, plain name first', () => {
    expect(bestCommonModel(cpus)).toBe('SandyBridge');
    expect(bestCommonModel(cpus.filter(c => c.vendor === 'Intel'))).toBe('Skylake-Client-v4');
  });
  it('puts models available everywhere first in the matrix', () => {
    const m = modelMatrix(cpus);
    expect(m[0]).toMatchObject({ model: 'SandyBridge', everywhere: true, isa: 'AVX' });
    expect(m.find(r => r.model === 'EPYC')).toMatchObject({ everywhere: false, hosts: ['amd-a'], vendor: 'AMD' });
  });
  it('offers portable presets per scope', () => {
    const p = cpuPresets(cpus);
    expect(p.map(x => [x.id, x.model])).toEqual([
      ['portable', 'SandyBridge'],
      ['portable-AMD', 'EPYC'],
      ['portable-Intel', 'Skylake-Client-v4'],
      ['host-model', 'host-model'],
      ['host-passthrough', 'host-passthrough'],
    ]);
  });
  it('gives verdicts in plain words', () => {
    expect(cpuVerdict('SandyBridge', cpus)).toMatchObject({ live: 'all', tone: 'ok', runsOn: ['amd-a', 'intel-a', 'intel-b'] });
    expect(cpuVerdict('SandyBridge', cpus).text).toMatch(/AMD and Intel/);
    expect(cpuVerdict('SandyBridge', cpus).text).not.toMatch(/tested here/);
    expect(cpuVerdict('Skylake-Client-v4', cpus)).toMatchObject({ live: 'all', runsOn: ['intel-a', 'intel-b'], tone: 'ok' });
    expect(cpuVerdict('host-model', cpus).live).toBe('vendor');
    expect(cpuVerdict('host-passthrough', cpus).live).toBe('same-cpu');
    expect(cpuVerdict('Icelake-Server', cpus)).toMatchObject({ live: 'none', tone: 'bad' });
  });
  it('resolves the effective model in KubeVirt order', () => {
    expect(effectiveCpuModel(undefined, undefined, undefined)).toBe('host-model');
    expect(effectiveCpuModel(undefined, undefined, 'Westmere')).toBe('Westmere');
    expect(effectiveCpuModel(undefined, 'SandyBridge', 'Westmere')).toBe('SandyBridge');
    expect(effectiveCpuModel('Nehalem', 'SandyBridge', 'Westmere')).toBe('Nehalem');
  });
});

describe('flavors and families', () => {
  const objs = [
    shipped('u1.large', 'general.purpose', 'large', { cpu: { guest: 2 }, memory: { guest: '8Gi' } }),
    shipped('u1.medium', 'general.purpose', 'medium', { cpu: { guest: 1 }, memory: { guest: '4Gi' } }),
    shipped('cx1.large', 'compute.exclusive', 'large', { cpu: { guest: 2, dedicatedCPUPlacement: true, numa: { guestMappingPassthrough: {} } }, memory: { guest: '4Gi', hugepages: { pageSize: '2Mi' } } }),
    buildFlavor({ name: 'port.large', familyId: 'port', familyLabel: 'Portable', size: 'large', vcpus: 2, memBytes: 8 * 2 ** 30, cpuModel: 'SandyBridge' }),
  ] as any[];
  it('groups by family, KubeVirt first, sizes in order', () => {
    const f = families(objs);
    expect(f.map(x => [x.id, x.label, x.flavors.map(y => y.name)])).toEqual([
      ['general.purpose', 'Balanced', ['u1.medium', 'u1.large']],
      ['compute.exclusive', 'CPU intensive', ['cx1.large']],
      ['port', 'Portable', ['port.large']],
    ]);
    expect(f[2].ours).toBe(true);
    expect(f[0].shipped).toBe(true);
  });
  it('lists host requirements and the hosts that meet them', () => {
    const cx = flavorFrom(objs[2]);
    const req = flavorRequirements(cx, nodes);
    expect(req.map(r => [r.what.split(' (')[0], r.hosts])).toEqual([
      ['Dedicated CPUs', ['intel-b']],
      ['Huge pages of 2Mi', ['intel-b']],
    ]);
    expect(req.map(r => r.nodeSetting)).toEqual(['cpuManager', 'hugepages']);
    expect(nodeSettingsWords(req)).toBe('the static CPU manager and huge pages');
    expect(nodeSettingsWords(req.slice(1))).toBe('huge pages');
    expect(nodeSettingsWords(flavorRequirements(flavorFrom(objs[3]), nodes))).toBeNull();
    expect(flavorHosts(cx, nodes)).toEqual(['intel-b']);
    expect(flavorHosts(flavorFrom(objs[3]), nodes)).toEqual(['intel-a', 'intel-b', 'amd-a']);
  });
  it('finds the VMs using a flavor', () => {
    const vms = [
      { metadata: { name: 'a', namespace: 'x' }, spec: { instancetype: { kind: 'VirtualMachineClusterInstancetype', name: 'u1.large' } } },
      { metadata: { name: 'b', namespace: 'x' }, spec: { instancetype: { name: 'u1.large', kind: 'VirtualMachineInstancetype' } } },
      { metadata: { name: 'c', namespace: 'x' }, spec: {} },
    ] as any[];
    expect(vmsUsing(flavorFrom(objs[0]), vms).map(v => v.metadata.name)).toEqual(['a']);
    const folder = flavorFrom({ ...objs[0], metadata: { ...objs[0].metadata, namespace: 'x' } });
    expect(vmsUsing(folder, vms).map(v => v.metadata.name)).toEqual(['b']);
  });
});

describe('building flavors', () => {
  it('builds a family ladder with KubeVirt size names', () => {
    const defs = familyLadder({ familyId: 'db', familyLabel: 'Databases' }, 8 * 2 ** 30, ['medium', 'large', 'xlarge']);
    expect(defs.map(d => [d.name, d.vcpus, d.memBytes / 2 ** 30])).toEqual([
      ['db.medium', 1, 8],
      ['db.large', 2, 16],
      ['db.xlarge', 4, 32],
    ]);
  });
  it('builds an instancetype with the knobs set', () => {
    const o = buildFlavor({
      name: 'db.large',
      namespace: 'prod',
      familyId: 'db',
      familyLabel: 'Databases',
      size: 'large',
      vcpus: 2,
      memBytes: 16 * 2 ** 30,
      cpuModel: 'SandyBridge',
      dedicated: true,
      isolateEmulatorThread: true,
      hugepages: '2Mi',
      overcommitPercent: 30,
      gpu: 'hangar.magesgate.com/iris-xe-vf',
    });
    expect(o.kind).toBe('VirtualMachineInstancetype');
    expect(o.metadata.labels).toMatchObject({ 'hangar.magesgate.com/flavor-family': 'db', 'instancetype.kubevirt.io/class': 'db', 'instancetype.kubevirt.io/size': 'large' });
    expect(o.spec).toEqual({
      cpu: { guest: 2, model: 'SandyBridge', dedicatedCPUPlacement: true, isolateEmulatorThread: true },
      memory: { guest: '16Gi', hugepages: { pageSize: '2Mi' }, overcommitPercent: 30 },
      gpus: [{ name: 'gpu1', deviceName: 'hangar.magesgate.com/iris-xe-vf' }],
    });
  });
  it('keeps what it does not edit on update', () => {
    const o = { ...buildFlavor({ name: 'db.large', familyId: 'db', familyLabel: 'DB', size: 'large', vcpus: 2, memBytes: 2 ** 31 }), metadata: { name: 'db.large', resourceVersion: '7', labels: { keep: 'x' } } } as any;
    o.spec.nodeSelector = { a: 'b' };
    const u = updatedFlavor(o, { name: 'db.large', familyId: 'db', familyLabel: 'DB', size: 'large', vcpus: 4, memBytes: 2 ** 32 });
    expect(u.metadata.resourceVersion).toBe('7');
    expect(u.metadata.labels.keep).toBe('x');
    expect(u.spec).toEqual({ cpu: { guest: 4 }, memory: { guest: '4Gi' }, nodeSelector: { a: 'b' } });
  });
  it('checks family ids', () => {
    expect(familyIdProblem('u1')).toMatch(/KubeVirt/);
    expect(familyIdProblem('Bad')).toMatch(/Lowercase/);
    expect(familyIdProblem('db', ['db'])).toMatch(/exists/);
    expect(familyIdProblem('db')).toBeNull();
  });
});

describe('VM edits', () => {
  const vm = { metadata: { name: 'v', namespace: 'n' }, spec: { template: { spec: { domain: { cpu: { cores: 2, model: 'host-model' }, memory: { guest: '2Gi' } } } } } } as any;
  it('sizes a VM with a flavor and drops its own CPU count and memory', () => {
    const out = setFlavor(vm, { kind: 'VirtualMachineInstancetype', name: 'db.large' });
    expect(out.spec.instancetype).toEqual({ kind: 'VirtualMachineInstancetype', name: 'db.large' });
    expect(out.spec.template.spec.domain).toEqual({ cpu: { model: 'host-model' } });
    expect(vm.spec.template.spec.domain.cpu.cores).toBe(2);
  });
  it('sets and clears the CPU model', () => {
    expect(setCpuModel(vm, 'SandyBridge').spec.template.spec.domain.cpu).toEqual({ cores: 2, model: 'SandyBridge' });
    const cleared = setCpuModel({ metadata: {}, spec: { template: { spec: { domain: { cpu: { model: 'X' } } } } } } as any, '');
    expect(cleared.spec.template.spec.domain.cpu).toBeUndefined();
  });
});
