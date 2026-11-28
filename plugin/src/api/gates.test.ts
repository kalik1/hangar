import { act, renderHook } from '@testing-library/react';
import { Obj } from '../model/types';
import { K4allGateError, setFeatureGate } from './gates';
import { forgetWritten, useKubevirt } from './kubevirtCopy';

const api: { kv: Obj; patches: unknown[]; fail: unknown[]; k4all: boolean } = { kv: {} as Obj, patches: [], fail: [], k4all: false };

vi.mock('./client', () => ({
  currentCluster: () => 'main',
  kreq: async () => structuredClone(api.kv),
  kmerge: async (_path: string, patch: any) => {
    api.patches.push(patch);
    const e = api.fail.shift();
    if (e) throw e;
    const out = structuredClone(api.kv);
    out.metadata.resourceVersion = String(Number(out.metadata.resourceVersion) + 1);
    out.spec.configuration.developerConfiguration.featureGates = patch.spec.configuration.developerConfiguration.featureGates;
    return out;
  },
}));
vi.mock('./actions', () => ({ runTask: (_o: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('./data', () => ({ useHangar: () => ({}) }));
vi.mock('./k4all', () => ({ isK4all: async () => api.k4all }));

/** KubeVirt v1.9.1 with VSOCK on; on k4all its ClusterConfig lists HostDevices. */
function kubevirt(): Obj {
  return {
    apiVersion: 'kubevirt.io/v1',
    kind: 'KubeVirt',
    metadata: {
      name: 'kubevirt',
      namespace: 'kubevirt',
      resourceVersion: '10',
      generation: 3,
      annotations: { 'k4all.magesgate.com/feature-gates': 'HostDevices' },
    },
    spec: { configuration: { developerConfiguration: { featureGates: ['VSOCK'] } } },
    status: { observedKubeVirtVersion: 'v1.9.1' },
  };
}

describe('setFeatureGate keeps what it wrote (hangar#2)', () => {
  beforeEach(() => {
    api.kv = kubevirt();
    api.patches = [];
    api.fail = [];
    api.k4all = false;
    forgetWritten();
  });

  it('resolves with the PATCH answer, and the views show it while the list is old', async () => {
    const listed = kubevirt();
    const { result } = renderHook(() => useKubevirt(listed));
    expect(result.current).toBe(listed);
    let out!: Obj;
    await act(async () => {
      out = await setFeatureGate(listed, 'HostDevices', true);
    });
    expect(out.metadata.resourceVersion).toBe('11');
    expect(out.spec.configuration.developerConfiguration.featureGates).toEqual(['VSOCK', 'HostDevices']);
    expect(result.current).toEqual(out);
  });

  it('retries on a conflict and keeps the answer of the write that went through', async () => {
    api.fail = [Object.assign(new Error('Conflict'), { status: 409 })];
    const out = await setFeatureGate(kubevirt(), 'HostDevices', true);
    expect(api.patches).toHaveLength(2);
    const { result } = renderHook(() => useKubevirt(kubevirt()));
    expect(result.current).toEqual(out);
  });

  it('a failed write keeps nothing and rejects with the API error', async () => {
    const denied = Object.assign(new Error('Forbidden - no'), { status: 403 });
    api.fail = [denied];
    await expect(setFeatureGate(kubevirt(), 'HostDevices', true)).rejects.toBe(denied);
    const listed = kubevirt();
    const { result } = renderHook(() => useKubevirt(listed));
    expect(result.current).toBe(listed);
  });

  it('refuses a gate k4all lists with K4allGateError, before any write', async () => {
    api.k4all = true;
    const e = await setFeatureGate(kubevirt(), 'HostDevices', false).catch(x => x);
    expect(e).toBeInstanceOf(K4allGateError);
    expect(e.gate).toBe('HostDevices');
    expect(e.message).toBe('HostDevices is set by k4all: change it in the k4all addon (Settings → Virtualization).');
    expect(api.patches).toEqual([]);
  });
});
