import { describe, expect, it } from 'vitest';
import { advertisedFromNode, hostPools, poolLevel, worstLevel } from './hostPools';

const node = (name: string, annotations: Record<string, string> = {}) => ({ metadata: { name, annotations, labels: { 'kubernetes.io/hostname': name, 'topology.topolvm.io/node': name } } }) as any;
const GiB = 2 ** 30;

const pv = (name: string, host: string) =>
  ({
    metadata: { name },
    spec: {
      nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'topology.topolvm.io/node', operator: 'In', values: [host] }] }] } },
    },
  }) as any;

const row = (name: string, pvName: string, size: number, vm?: string): any => ({
  key: `demo/${name}`,
  namespace: 'demo',
  name,
  kind: vm ? 'vm' : 'unattached',
  pvc: { metadata: { name, namespace: 'demo' }, spec: { volumeName: pvName, accessModes: ['ReadWriteOnce'], storageClassName: 'topolvm' } },
  uses: vm ? [{ vm: { metadata: { name: vm, namespace: 'demo' } }, slot: 'rootdisk', device: 'disk' }] : [],
  sizeBytes: size,
  datastore: 'topolvm',
  state: { label: 'Ready', tone: 'on', ready: true },
  media: 'disk',
});

describe('poolLevel', () => {
  it('rates data and metadata', () => {
    expect(poolLevel(10, 10).level).toBe('ok');
    expect(poolLevel(82, 10).level).toBe('warn');
    expect(poolLevel(95, 10).level).toBe('fault');
    expect(poolLevel(10, 72)).toEqual({ level: 'warn', reason: 'metadata 72% full' });
    expect(poolLevel(10, 90).reason).toMatch(/read-only/);
  });
});

describe('advertisedFromNode', () => {
  it('reads the class annotation, else the default one', () => {
    const n = node('a', { 'capacity.topolvm.io/00default': '100', 'capacity.topolvm.io/ssd': '50' });
    expect(advertisedFromNode(n, 'ssd')).toBe(50);
    expect(advertisedFromNode(n, undefined)).toBe(100);
    expect(advertisedFromNode(node('b'), undefined)).toBeUndefined();
  });
});

describe('hostPools', () => {
  const nodes = [node('a', { 'capacity.topolvm.io/00default': String(500 * GiB) }), node('b', { 'capacity.topolvm.io/00default': String(300 * GiB) }), node('c')];
  const pvIdx = new Map([
    ['pv1', pv('pv1', 'a')],
    ['pv2', pv('pv2', 'a')],
    ['pv3', pv('pv3', 'b')],
  ]);
  const rows = [row('d1', 'pv1', 10 * GiB, 'web-01'), row('d2', 'pv2', 20 * GiB, 'web-01'), row('d3', 'pv3', 5 * GiB)];
  const samples = [
    { node: 'a', deviceClass: 'default', thinSize: 30 * GiB, thinDataPercent: 50, thinMetaPercent: 10 },
    { node: 'b', deviceClass: 'default', thinSize: 12 * GiB, thinDataPercent: 92, thinMetaPercent: 20 },
  ];
  it('gives each host its pool, disks and VMs', () => {
    const p = hostPools({ datastore: 'topolvm', samples, nodes, rows, pvIdx, topolvm: true });
    expect(p.map(x => x.host)).toEqual(['a', 'b']);
    const a = p[0];
    expect(a.measured).toBe(true);
    expect(a.thin).toBe(true);
    expect(a.sizeBytes).toBe(30 * GiB);
    expect(a.usedBytes).toBe(15 * GiB);
    expect(a.physFreeBytes).toBe(15 * GiB);
    expect(a.advertisedBytes).toBe(500 * GiB);
    expect(a.provisionedBytes).toBe(30 * GiB);
    expect(a.disks.length).toBe(2);
    expect(a.vms).toEqual([{ namespace: 'demo', name: 'web-01' }]);
    expect(a.level).toBe('ok');
    expect(p[1].level).toBe('fault');
    expect(worstLevel(p)).toBe('fault');
  });
  it('prefers the metric over the annotation for the advertised room', () => {
    const p = hostPools({ datastore: 'topolvm', samples: [{ ...samples[0], thinOverprovisionedAvailable: 7 }], nodes, rows, pvIdx, topolvm: true });
    expect(p.find(x => x.host === 'a')?.advertisedBytes).toBe(7);
  });
  it('still lists hosts with disks when the pools cannot be read', () => {
    const p = hostPools({ datastore: 'topolvm', samples: [], nodes, rows, pvIdx });
    expect(p.map(x => [x.host, x.measured, x.disks.length])).toEqual([
      ['a', false, 2],
      ['b', false, 1],
    ]);
    expect(p[0].advertisedBytes).toBeUndefined();
  });
  it('handles thick volume groups', () => {
    const p = hostPools({ datastore: 'x', samples: [{ node: 'c', deviceClass: 'thick', vgSize: 100, vgFree: 40 }], nodes, rows: [], pvIdx });
    expect(p[0]).toMatchObject({ thin: false, sizeBytes: 100, usedBytes: 60, dataPercent: 60, physFreeBytes: 40, advertisedBytes: 40 });
  });
});
