import { alarms } from './alarms';

describe('alarms', () => {
  it('reports hosts down, VMs in error and failed imports, worst first', () => {
    const a = alarms({
      vms: [{ metadata: { name: 'web', namespace: 'p' }, status: { printableStatus: 'ErrorUnschedulable' } }],
      vmiIdx: new Map(),
      nodes: [
        { metadata: { name: 'h1' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } },
        { metadata: { name: 'h2' }, spec: { unschedulable: true }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      ],
      dvs: [{ metadata: { name: 'img', namespace: 'lib' }, status: { phase: 'Failed' } }],
      pvcs: [],
      migrations: [],
      kubevirt: null,
    });
    expect(a.map(x => x.severity)).toEqual(['critical', 'critical', 'warning', 'info']);
    expect(a[0].title).toMatch(/h1 is not responding|web: No host can run it/);
  });
});
