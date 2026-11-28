import { DiskMoveUntil, StuckDiskMove } from '../model/move';
import { tasks, UntilWorld } from '../model/tasks';
import { Obj } from '../model/types';
import { advanceDiskMove, moveDisks, putOldDisksBack } from './move';

/** Every API call, in order; GETs answer from `objects`. */
const api: { calls: { method: string; path: string; body?: any }[]; objects: Map<string, Obj>; fail: Map<string, any> } = {
  calls: [],
  objects: new Map(),
  fail: new Map(),
};
const call = (method: string, path: string, body?: unknown) => {
  api.calls.push({ method, path, body });
  const f = api.fail.get(`${method} ${path}`);
  if (f) throw f;
};

// resources.ts needs Headlamp's runtime: the paths the calls use, as it writes them.
vi.mock('./resources', () => ({
  PATHS: {
    vm: (ns: string, name = '') => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines${name ? '/' + name : ''}`,
    vmSub: (ns: string, name: string, sub: string) => `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}/${sub}`,
    migrations: (ns: string, name = '') => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachineinstancemigrations${name ? '/' + name : ''}`,
    dv: (ns: string, name = '') => `/apis/cdi.kubevirt.io/v1beta1/namespaces/${ns}/datavolumes${name ? '/' + name : ''}`,
    pvc: (ns: string, name = '') => `/api/v1/namespaces/${ns}/persistentvolumeclaims${name ? '/' + name : ''}`,
  },
}));
vi.mock('./client', () => ({
  errorText: (e: any) => e?.message ?? String(e),
  kreq: async (path: string, init: any = {}) => {
    call(init.method ?? 'GET', path, init.body);
    return JSON.parse(JSON.stringify(api.objects.get(path) ?? {}));
  },
  kput: async (path: string, body: unknown) => call('PUT', path, body),
  kpost: async (path: string, body: unknown) => call('POST', path, body),
  kdelete: async (path: string) => call('DELETE', path),
  kmerge: async (path: string, body: unknown) => call('PATCH', path, body),
  kjsonpatch: async (path: string, body: unknown) => call('PATCH', path, body),
}));
vi.mock('./protection', () => ({ labelDisks: async () => undefined }));

const NS = 'production';
const VM_PATH = `/apis/kubevirt.io/v1/namespaces/${NS}/virtualmachines/web-01`;
const SUB = (s: string) => `/apis/subresources.kubevirt.io/v1/namespaces/${NS}/virtualmachines/web-01/${s}`;
const DVS = `/apis/cdi.kubevirt.io/v1beta1/namespaces/${NS}/datavolumes`;

const vm = (): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'VirtualMachine',
  metadata: { name: 'web-01', namespace: NS, uid: 'u1', resourceVersion: '9' },
  spec: {
    runStrategy: 'Always',
    dataVolumeTemplates: [{ metadata: { name: 'web-01-rootdisk' }, spec: { source: { blank: {} } } }],
    template: { spec: { domain: { devices: { disks: [{ name: 'rootdisk', bootOrder: 1 }] } }, volumes: [{ name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk' } }] } },
  },
});

const world = (over: Partial<UntilWorld> = {}): UntilWorld => ({
  vmPower: () => ({ kind: 'off', label: 'Powered off' }),
  migration: () => null,
  dataVolume: () => null,
  snapshot: () => null,
  restore: () => null,
  hostVmCount: () => 0,
  ...over,
});

/** The task of the last moveDisks, and its stage. */
const lastTask = () => tasks.running().find(t => t.until?.type === 'diskMove')!;

beforeEach(() => {
  api.calls = [];
  api.objects = new Map([[VM_PATH, vm()]]);
  api.fail = new Map();
  tasks.clearFinished();
  for (const t of tasks.running()) tasks.update(t.id, { status: 'done' });
  tasks.clearFinished();
});

describe('a disk move of a running VM that cannot move live', () => {
  const start = () =>
    moveDisks({
      vm: vm(),
      moves: [{ volume: 'rootdisk', claim: 'web-01-rootdisk', datastore: 'nfs', sizeBytes: 10 * 2 ** 30 }],
      live: false,
      restart: true,
      deleteOld: true,
      taken: new Set(['web-01-rootdisk']),
    });

  it('shuts the guest down first, and makes no copy of a disk in use', async () => {
    await start();
    expect(api.calls).toEqual([{ method: 'PUT', path: SUB('stop'), body: {} }]);
    expect(lastTask().until).toMatchObject({ stage: 'stop', restart: true, live: false });
  });

  it('copies once it is off, then swaps and starts it again on the copy', async () => {
    await start();
    const t = lastTask();
    api.calls = [];
    advanceDiskMove(t, world());
    await vi.waitFor(() => expect((lastTask().until as DiskMoveUntil).stage).toBe('copy'));
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual([`GET ${VM_PATH}`, `POST ${DVS}`]);
    expect(api.calls[1].body).toMatchObject({
      metadata: { name: 'web-01-rootdisk-nfs', annotations: { 'hangar.magesgate.com/moved-from': 'web-01-rootdisk' }, ownerReferences: [{ uid: 'u1' }] },
      spec: { source: { pvc: { namespace: NS, name: 'web-01-rootdisk' } } },
    });

    api.calls = [];
    advanceDiskMove(lastTask(), world({ dataVolume: () => ({ status: { phase: 'Succeeded' } }) }));
    await vi.waitFor(() => expect((lastTask().until as DiskMoveUntil).stage).toBe('cleanup'));
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual([`GET ${VM_PATH}`, `PUT ${VM_PATH}`, `PUT ${SUB('start')}`]);
    expect(api.calls[1].body.spec.template.spec.volumes).toEqual([{ name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk-nfs' } }]);
    expect(api.calls[1].body.spec.updateVolumesStrategy).toBeUndefined();
  });

  it('a failed copy starts the VM again on its old disk', async () => {
    await start();
    const t = lastTask();
    tasks.update(t.id, { until: { ...(t.until as DiskMoveUntil), stage: 'copy' } });
    api.calls = [];
    advanceDiskMove(lastTask(), world({ dataVolume: () => ({ metadata: { name: 'web-01-rootdisk-nfs' }, status: { phase: 'Failed' } }) }));
    await vi.waitFor(() => expect(api.calls).toEqual([{ method: 'PUT', path: SUB('start'), body: {} }]));
    await vi.waitFor(() => expect(tasks.running().some(x => x.id === t.id)).toBe(false));
  });
});

describe('putting the old disk back', () => {
  const stuck: StuckDiskMove = {
    volumes: [{ volume: 'rootdisk', oldClaim: 'web-01-rootdisk', newClaim: 'web-01-rootdisk-ceph' }],
    migrations: ['kubevirt-workload-update-abcde'],
  };
  const moved = (): Obj => {
    const v = vm();
    v.spec.updateVolumesStrategy = 'Migration';
    v.spec.dataVolumeTemplates = [{ metadata: { name: 'web-01-rootdisk-ceph' }, spec: { source: { blank: {} } } }];
    v.spec.template.spec.volumes = [{ name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk-ceph' } }];
    return v;
  };
  const oldDv: Obj = {
    metadata: { name: 'web-01-rootdisk', namespace: NS, ownerReferences: [{ kind: 'VirtualMachine', name: 'web-01', uid: 'u1' }] },
    spec: { source: { blank: {} }, storage: { resources: { requests: { storage: '10Gi' } } } },
  };

  it('reverts the VM, deletes the waiting migration and, if asked, the blank disk', async () => {
    api.objects.set(VM_PATH, moved());
    await putOldDisksBack(moved(), stuck, new Map([[`${NS}/web-01-rootdisk`, oldDv]]), { deleteNew: true });
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      `GET ${VM_PATH}`,
      `PUT ${VM_PATH}`,
      `DELETE /apis/kubevirt.io/v1/namespaces/${NS}/virtualmachineinstancemigrations/kubevirt-workload-update-abcde`,
      `DELETE ${DVS}/web-01-rootdisk-ceph`,
      `DELETE /api/v1/namespaces/${NS}/persistentvolumeclaims/web-01-rootdisk-ceph`,
    ]);
    const put = api.calls[1].body;
    expect(put.spec.template.spec.volumes).toEqual([{ name: 'rootdisk', dataVolume: { name: 'web-01-rootdisk' } }]);
    expect(put.spec.dataVolumeTemplates).toEqual([{ metadata: { name: 'web-01-rootdisk' }, spec: oldDv.spec }]);
    expect(put.metadata.resourceVersion).toBe('9');
    expect(put.status).toBeUndefined();
  });

  it('keeps the blank disk when asked', async () => {
    api.objects.set(VM_PATH, moved());
    await putOldDisksBack(moved(), stuck, new Map([[`${NS}/web-01-rootdisk`, oldDv]]), { deleteNew: false });
    expect(api.calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual([
      `/apis/kubevirt.io/v1/namespaces/${NS}/virtualmachineinstancemigrations/kubevirt-workload-update-abcde`,
    ]);
  });
});
