import { act, renderHook } from '@testing-library/react';
import { Obj } from '../model/types';
import { forgetWritten, freshestKubevirt, keepWritten, useKubevirt } from './kubevirtCopy';

const api = { cluster: 'main' };
vi.mock('./client', () => ({ currentCluster: () => api.cluster }));

const kv = (rv: string, generation?: number, name = 'kubevirt'): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'KubeVirt',
  metadata: { name, namespace: 'kubevirt', resourceVersion: rv, ...(generation !== undefined ? { generation } : {}) },
});

describe('the KubeVirt copy Hangar wrote', () => {
  beforeEach(() => {
    api.cluster = 'main';
    forgetWritten();
  });

  it('shows until the list has the same resourceVersion', () => {
    const w = kv('11', 4);
    keepWritten(w);
    expect(freshestKubevirt(kv('10', 3), 'main')).toBe(w);
    const caught = kv('11', 4);
    expect(freshestKubevirt(caught, 'main')).toBe(caught);
  });

  it('gives way to a newer generation in the list (a change made after the write)', () => {
    keepWritten(kv('11', 4));
    const newer = kv('15', 5);
    expect(freshestKubevirt(newer, 'main')).toBe(newer);
  });

  it('stays while only the status moved on (same generation, newer resourceVersion)', () => {
    const w = kv('11', 4);
    keepWritten(w);
    expect(freshestKubevirt(kv('12', 4), 'main')).toBe(w);
  });

  it('is never shown for another cluster, another object, or after two minutes', () => {
    const w = kv('11', 4);
    keepWritten(w);
    const other = kv('10', 3);
    expect(freshestKubevirt(other, 'second')).toBe(other);
    expect(freshestKubevirt(kv('10', 3, 'other'), 'main')?.metadata.name).toBe('other');
    expect(freshestKubevirt(other, 'main', Date.now() + 120000)).toBe(other);
    expect(freshestKubevirt(null, 'main')).toBe(w);
  });

  it('ignores an answer without a resourceVersion', () => {
    keepWritten({ metadata: { name: 'kubevirt' } } as Obj);
    const listed = kv('10', 3);
    expect(freshestKubevirt(listed, 'main')).toBe(listed);
  });

  it('useKubevirt re-renders when a write is kept', () => {
    const listed = kv('10', 3);
    const { result } = renderHook(() => useKubevirt(listed));
    expect(result.current).toBe(listed);
    const w = kv('11', 4);
    act(() => keepWritten(w));
    expect(result.current).toBe(w);
  });
});
