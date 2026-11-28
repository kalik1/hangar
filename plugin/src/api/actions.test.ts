import { Obj } from '../model/types';
import { deleteVm, deletionStuckOrphaning, vmOwnedDisks } from './actions';

/** Every API call, in order, and what the namespace lists answer. */
const api: { calls: { method: string; path: string; body?: any; contentType?: string }[]; lists: Map<string, Obj[] | Error> } = {
  calls: [],
  lists: new Map(),
};

// resources.ts needs Headlamp's runtime: the paths the calls use, as it writes them.
vi.mock('./resources', () => ({
  PATHS: {
    vm: (ns: string, name = '') => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines${name ? '/' + name : ''}`,
    dv: (ns: string, name = '') => `/apis/cdi.kubevirt.io/v1beta1/namespaces/${ns}/datavolumes${name ? '/' + name : ''}`,
    pvc: (ns: string, name = '') => `/api/v1/namespaces/${ns}/persistentvolumeclaims${name ? '/' + name : ''}`,
  },
}));
vi.mock('./client', () => ({
  errorText: (e: any) => e?.message ?? String(e),
  kreq: async (path: string, init: any = {}) => {
    api.calls.push({ method: init.method ?? 'GET', path, body: init.body, contentType: init.contentType });
    const l = api.lists.get(path);
    if (l instanceof Error) throw l;
    return { items: l ?? [] };
  },
  kmerge: async (path: string, body: unknown) => {
    api.calls.push({ method: 'PATCH', path, body, contentType: 'merge' });
  },
  kjsonpatch: async (path: string, body: unknown) => {
    api.calls.push({ method: 'PATCH', path, body, contentType: 'json' });
  },
  kdelete: async (path: string, body?: unknown) => {
    api.calls.push({ method: 'DELETE', path, body });
  },
  kpost: async () => undefined,
  kput: async () => undefined,
}));

const UID = 'vm-uid-1';
const VM_PATH = '/apis/kubevirt.io/v1/namespaces/default/virtualmachines/web';
const DVS = '/apis/cdi.kubevirt.io/v1beta1/namespaces/default/datavolumes';
const PVCS = '/api/v1/namespaces/default/persistentvolumeclaims';

const vmRef = { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'web', uid: UID, controller: true };
const dvRef = (name: string) => ({ apiVersion: 'cdi.kubevirt.io/v1beta1', kind: 'DataVolume', name, uid: `dv-${name}`, controller: true });

const vm = (extra: Partial<Obj['metadata']> = {}, templates = ['web-root']): Obj => ({
  metadata: { namespace: 'default', name: 'web', uid: UID, ...extra },
  spec: {
    instancetype: { kind: 'VirtualMachineClusterInstancetype', name: 'u1.medium' },
    dataVolumeTemplates: templates.map(name => ({ metadata: { name } })),
    template: { spec: { volumes: templates.map(name => ({ name, dataVolume: { name } })) } },
  },
});
const obj = (name: string, ownerReferences: any[] = [], labels?: Record<string, string>): Obj => ({
  metadata: { namespace: 'default', name, ownerReferences, labels },
});

beforeEach(() => {
  api.calls = [];
  api.lists = new Map();
});

describe('vmOwnedDisks', () => {
  it('finds the DataVolumes and the claims the VM owns, not its persistent state', () => {
    const dvs = [obj('web-root', [vmRef]), obj('web-data', [{ kind: 'Other', name: 'x', uid: 'o' }, vmRef]), obj('other', [])];
    const pvcs = [
      obj('web-root', [dvRef('web-root')]),
      obj('web-old', [vmRef]), // its DataVolume was garbage-collected: CDI moved the owner here
      obj('persistent-state-for-web-abcde', [vmRef], { 'persistent-state-for': 'web' }),
    ];
    expect(vmOwnedDisks(vm(), dvs, pvcs)).toEqual([
      { kind: 'dv', name: 'web-root', index: 0, uid: UID },
      { kind: 'dv', name: 'web-data', index: 1, uid: UID },
      { kind: 'pvc', name: 'web-old', index: 0, uid: UID },
    ]);
  });

  it('matches by uid only: a disk of another VM with the same name stays', () => {
    const dvs = [obj('web-root', [{ ...vmRef, uid: 'an-older-web' }])];
    expect(vmOwnedDisks(vm(), dvs, [])).toEqual([]);
  });
});

describe('deleteVm', () => {
  it('without keeping disks: one Foreground delete', async () => {
    await deleteVm(vm());
    expect(api.calls).toEqual([
      { method: 'DELETE', path: VM_PATH, body: { kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Foreground' } },
    ]);
  });

  it('keeping disks: the templates go, each disk is released, then a Background delete', async () => {
    api.lists.set(DVS, [obj('web-root', [vmRef]), obj('web-data', [{ kind: 'Other', name: 'x', uid: 'o' }, vmRef])]);
    api.lists.set(PVCS, [obj('web-root', [dvRef('web-root')]), obj('persistent-state-for-web-abcde', [vmRef], { 'persistent-state-for': 'web' })]);
    await deleteVm(vm(), { keepDisks: true });
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${VM_PATH}`,
      `GET ${DVS}`,
      `GET ${PVCS}`,
      `PATCH ${DVS}/web-root`,
      `PATCH ${DVS}/web-data`,
      `DELETE ${VM_PATH}`,
    ]);
    // KubeVirt adopts an orphan DataVolume its VM still has a template for: the templates go first.
    expect(api.calls[0].body).toEqual({ spec: { dataVolumeTemplates: null } });
    // Only the VM's entry goes, and only while it is still there.
    expect(api.calls[4]).toMatchObject({
      contentType: 'json',
      body: [
        { op: 'test', path: '/metadata/ownerReferences/1/uid', value: UID },
        { op: 'remove', path: '/metadata/ownerReferences/1' },
      ],
    });
    expect(api.calls[5].body).toEqual({ kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Background' });
  });

  it('keeping disks of a VM with no templates: nothing to drop from the VM', async () => {
    await deleteVm(vm({}, []), { keepDisks: true });
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual([`GET ${DVS}`, `GET ${PVCS}`, `DELETE ${VM_PATH}`]);
  });

  it('keeping disks: when the disks cannot be listed, the VM is not deleted', async () => {
    api.lists.set(PVCS, Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(deleteVm(vm(), { keepDisks: true })).rejects.toThrow('Could not list the disks to keep');
    expect(api.calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('keeping disks without CDI: no DataVolumes to release', async () => {
    api.lists.set(DVS, Object.assign(new Error('not found'), { status: 404 }));
    api.lists.set(PVCS, [obj('web-disk', [vmRef])]);
    await deleteVm(vm({}, []), { keepDisks: true });
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual([`GET ${DVS}`, `GET ${PVCS}`, `PATCH ${PVCS}/web-disk`, `DELETE ${VM_PATH}`]);
  });
});

describe('deletionStuckOrphaning', () => {
  it('is a deletion waiting on the orphan finalizer', () => {
    const at = '2026-01-01T00:00:00Z';
    expect(deletionStuckOrphaning(vm({ deletionTimestamp: at, finalizers: ['orphan', 'kubevirt.io/virtualMachineControllerFinalize'] }))).toBe(true);
    expect(deletionStuckOrphaning(vm({ deletionTimestamp: at, finalizers: ['foregroundDeletion'] }))).toBe(false);
    expect(deletionStuckOrphaning(vm({ finalizers: ['orphan'] }))).toBe(false);
  });
});
