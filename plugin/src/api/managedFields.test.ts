import { renderHook, waitFor } from '@testing-library/react';
import { Obj } from '../model/types';
import { useManagedFields } from './managedFields';

const api: { cluster: string; objects: Map<string, Obj | Error>; calls: string[] } = {
  cluster: 'main',
  objects: new Map(),
  calls: [],
};

vi.mock('./client', () => ({
  currentCluster: () => api.cluster,
  kreq: async (path: string) => {
    api.calls.push(`${api.cluster}${path}`);
    const o = api.objects.get(`${api.cluster}${path}`);
    if (!o) throw Object.assign(new Error('not found'), { status: 404 });
    if (o instanceof Error) throw o;
    return o;
  },
}));

const PATH = '/apis/kubevirt.io/v1/namespaces/kubevirt/kubevirts/kubevirt';
const OWNED = [
  {
    manager: 'k4all-operator',
    operation: 'Apply',
    fieldsType: 'FieldsV1',
    fieldsV1: { 'f:spec': { 'f:configuration': { 'f:vmStateStorageClass': {} } } },
  },
];

/** The KubeVirt CR as a GET returns it, and as Headlamp's list hands it out (managedFields deleted). */
const got = (rv: string): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'KubeVirt',
  metadata: { name: 'kubevirt', namespace: 'kubevirt', resourceVersion: rv, managedFields: OWNED },
});
const listed = (rv: string): Obj => {
  const o = got(rv);
  delete o.metadata.managedFields;
  return o;
};

describe('useManagedFields: ownership from a GET, as Headlamp lists drop managedFields', () => {
  beforeEach(() => {
    api.cluster = 'main';
    api.objects = new Map();
    api.calls = [];
  });

  it('returns the object as a GET of it returns it, managedFields included', async () => {
    api.objects.set(`main${PATH}`, got('10'));
    const { result } = renderHook(() => useManagedFields(listed('10'), PATH));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.metadata.managedFields).toEqual(OWNED));
    expect(api.calls).toEqual([`main${PATH}`]);
  });

  it('reads it again when the listed copy changes, not on every render', async () => {
    api.objects.set(`main${PATH}`, got('10'));
    const { result, rerender } = renderHook(({ o }) => useManagedFields(o, PATH), {
      initialProps: { o: listed('10') },
    });
    await waitFor(() => expect(result.current?.metadata.resourceVersion).toBe('10'));
    rerender({ o: listed('10') });
    expect(api.calls).toHaveLength(1);
    api.objects.set(`main${PATH}`, got('11'));
    rerender({ o: listed('11') });
    await waitFor(() => expect(result.current?.metadata.resourceVersion).toBe('11'));
    expect(api.calls).toHaveLength(2);
  });

  it('keeps the last copy when a new read fails, and has none when the first one fails', async () => {
    api.objects.set(`main${PATH}`, got('10'));
    const { result, rerender } = renderHook(({ o }) => useManagedFields(o, PATH), {
      initialProps: { o: listed('10') },
    });
    await waitFor(() => expect(result.current?.metadata.resourceVersion).toBe('10'));
    api.objects.set(`main${PATH}`, Object.assign(new Error('Forbidden'), { status: 403 }));
    rerender({ o: listed('11') });
    await waitFor(() => expect(api.calls).toHaveLength(2));
    expect(result.current?.metadata.resourceVersion).toBe('10');

    const other = renderHook(() => useManagedFields(listed('12'), PATH));
    await waitFor(() => expect(api.calls).toHaveLength(3));
    expect(other.result.current).toBeNull();
  });

  it('uses a listed copy that has managedFields as it is (one Hangar just wrote)', () => {
    const { result } = renderHook(() => useManagedFields(got('10'), PATH));
    expect(result.current?.metadata.resourceVersion).toBe('10');
    expect(api.calls).toEqual([]);
  });

  it('reads nothing when disabled (no k4all), without an object or without a path', () => {
    expect(renderHook(() => useManagedFields(listed('10'), PATH, false)).result.current).toBeNull();
    expect(renderHook(() => useManagedFields(null, PATH)).result.current).toBeNull();
    expect(renderHook(() => useManagedFields(listed('10'), null)).result.current).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('never hands out the copy of another cluster', async () => {
    api.objects.set(`main${PATH}`, got('10'));
    const { result, rerender } = renderHook(() => useManagedFields(listed('10'), PATH));
    await waitFor(() => expect(result.current).not.toBeNull());
    api.cluster = 'other';
    rerender();
    expect(result.current).toBeNull();
  });
});
