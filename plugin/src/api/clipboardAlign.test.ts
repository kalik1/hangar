import { HOOK_ANNOTATION, setClipboardAnnotation } from '../model/clipboard';
import { Obj } from '../model/types';
import { powerOn, restart } from './actions';

const api: { calls: { method: string; path: string; body?: any }[]; kubevirts: Obj[] } = { calls: [], kubevirts: [] };

// resources.ts needs Headlamp's runtime: the paths the calls use, as it writes them.
vi.mock('./resources', () => ({
  PATHS: {
    vm: (ns: string, name = '') => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines${name ? '/' + name : ''}`,
    vmSub: (ns: string, name: string, sub: string) => `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachines/${name}/${sub}`,
  },
}));
vi.mock('./client', () => ({
  errorText: (e: any) => e?.message ?? String(e),
  kreq: async (path: string) => {
    api.calls.push({ method: 'GET', path });
    return { items: api.kubevirts };
  },
  kmerge: async (path: string, body: unknown) => {
    api.calls.push({ method: 'PATCH', path, body });
  },
  kput: async (path: string, body: unknown) => {
    api.calls.push({ method: 'PUT', path, body });
  },
  kpost: async () => undefined,
  kdelete: async () => undefined,
  kjsonpatch: async () => undefined,
}));

const OLD = 'quay.io/kubevirt/sidecar-shim:v1.8.2';
const kubevirt = (version?: string): Obj => ({
  metadata: { name: 'kubevirt', namespace: 'kubevirt' },
  status: version ? { observedKubeVirtRegistry: 'quay.io/kubevirt', observedKubeVirtVersion: version } : {},
});
const vm = (annotations?: Record<string, string>): Obj => ({
  metadata: { name: 'web', namespace: 'demo' },
  spec: { template: { metadata: { annotations }, spec: {} } },
});
const VM_PATH = '/apis/kubevirt.io/v1/namespaces/demo/virtualmachines/web';
const SUB = (s: string) => `/apis/subresources.kubevirt.io/v1/namespaces/demo/virtualmachines/web/${s}`;

beforeEach(() => {
  api.calls = [];
  api.kubevirts = [kubevirt('v1.9.1')];
});

describe('the clipboard sidecar follows KubeVirt at the next power-on', () => {
  it('points the hook at the cluster sidecar-shim, then starts', async () => {
    await powerOn(vm(setClipboardAnnotation({}, true, OLD)));
    expect(api.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /apis/kubevirt.io/v1/kubevirts', `PATCH ${VM_PATH}`, `PUT ${SUB('start')}`]);
    const value = api.calls[1].body.spec.template.metadata.annotations[HOOK_ANNOTATION];
    expect(JSON.parse(value)[0].image).toBe('quay.io/kubevirt/sidecar-shim:v1.9.1');
  });

  it('also before a restart', async () => {
    await restart(vm(setClipboardAnnotation({}, true, OLD)));
    expect(api.calls.map(c => c.method)).toEqual(['GET', 'PATCH', 'PUT']);
    expect(api.calls[2].path).toBe(SUB('restart'));
  });

  it('touches nothing without the clipboard, when it is up to date, or when the version is unknown', async () => {
    await powerOn(vm());
    expect(api.calls.map(c => c.method)).toEqual(['PUT']);
    api.calls = [];
    await powerOn(vm(setClipboardAnnotation({}, true, 'quay.io/kubevirt/sidecar-shim:v1.9.1')));
    expect(api.calls.map(c => c.method)).toEqual(['GET', 'PUT']);
    api.calls = [];
    api.kubevirts = [kubevirt()];
    await powerOn(vm(setClipboardAnnotation({}, true, OLD)));
    expect(api.calls.map(c => c.method)).toEqual(['GET', 'PUT']);
  });
});
