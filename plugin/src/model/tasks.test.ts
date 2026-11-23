import { checkUntil, TaskStore, UntilWorld } from './tasks';

const world = (over: Partial<UntilWorld> = {}): UntilWorld => ({
  vmPower: () => null,
  migration: () => null,
  dataVolume: () => null,
  snapshot: () => null,
  restore: () => null,
  hostVmCount: () => 0,
  ...over,
});

describe('task store', () => {
  it('keeps tasks per cluster and finishes them', () => {
    const mem = new Map<string, string>();
    const s = new TaskStore({ getItem: k => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
    s.useCluster('a');
    const t = s.add({ title: 'Power on' });
    expect(s.running()).toHaveLength(1);
    s.update(t.id, { status: 'done' });
    expect(s.getSnapshot()[0].finished).toBeDefined();
    s.useCluster('b');
    expect(s.getSnapshot()).toHaveLength(0);
    s.useCluster('a');
    expect(s.getSnapshot()).toHaveLength(1);
  });
  it('marks tasks a closed page left running, unless the cluster can confirm them', () => {
    const mem = new Map<string, string>();
    const io = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = new TaskStore(io);
    s.useCluster('a');
    s.add({ title: 'Give a device to VMs' });
    s.add({ title: 'Power on', until: { type: 'vmPower', namespace: 'n', name: 'v', kinds: ['on'] } });
    const again = new TaskStore(io);
    again.useCluster('a');
    const [on, give] = again.getSnapshot();
    expect(on.status).toBe('running');
    expect(give.status).toBe('warning');
    expect(give.message).toMatch(/Interrupted/);
  });
});

describe('until', () => {
  it('waits for the power state', () => {
    const u = { type: 'vmPower' as const, namespace: 'n', name: 'v', kinds: ['on'] };
    expect(checkUntil(u, world({ vmPower: () => ({ kind: 'starting', label: 'Starting' }) }), 1000)).toBeNull();
    expect(checkUntil(u, world({ vmPower: () => ({ kind: 'on', label: 'On' }) }), 1000)).toEqual({ status: 'done' });
    expect(checkUntil(u, world({ vmPower: () => ({ kind: 'error', label: 'x', detail: 'boom' }) }), 1000)).toBeNull();
    expect(checkUntil(u, world({ vmPower: () => ({ kind: 'error', label: 'x', detail: 'boom' }) }), 90000)).toEqual({ status: 'failed', message: 'boom' });
  });
  it('follows migrations and imports', () => {
    expect(checkUntil({ type: 'migration', namespace: 'n', name: 'm' }, world({ migration: () => ({ status: { phase: 'Succeeded' } }) }), 1)).toEqual({ status: 'done' });
    expect(checkUntil({ type: 'dataVolume', namespace: 'n', name: 'd' }, world({ dataVolume: () => ({ status: { phase: 'ImportInProgress', progress: '42.5%' } }) }), 1)).toEqual({
      status: 'running',
      progress: 42.5,
    });
  });
});
