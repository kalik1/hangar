import { kpost, kreq } from './client';
import { readGuestInfo } from './guest';
import { can } from './permissions';

// Each test gets its own cluster name: discovery and reviews are cached per cluster.
let cluster = 0;
vi.mock('./resources', () => ({
  PATHS: { vmiSub: (ns: string, name: string, sub: string) => `/apis/subresources.kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${name}/${sub}` },
}));
vi.mock('./client', () => ({
  currentCluster: () => `c${cluster}`,
  kreq: vi.fn(),
  kpost: vi.fn(),
}));

const DISCOVERY = '/apis/subresources.hangar.magesgate.com/v1alpha1';
const GUESTINFO = '/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestinfo';
const discovered = { kind: 'APIResourceList', resources: [{ name: 'virtualmachineinstances/guestinfo' }, { name: 'virtualmachineinstances/guestfiles' }] };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

type Answers = { discovery: unknown; guestinfo?: unknown; allowed?: boolean };

function serve(a: Answers) {
  vi.mocked(kreq).mockImplementation(async (path: string) => {
    const v = path === DISCOVERY ? a.discovery : path === GUESTINFO ? a.guestinfo : fail(404, 'Not Found - unexpected');
    if (v instanceof Error) throw v;
    return v as any;
  });
  vi.mocked(kpost).mockImplementation(async () => ({ status: { allowed: a.allowed ?? true } }));
}

const calls = () => vi.mocked(kreq).mock.calls.map(c => c[0]);
const opts = { namespace: 'vms', name: 'vm', running: true };

beforeEach(() => {
  cluster++;
  vi.mocked(kreq).mockReset();
  vi.mocked(kpost).mockReset();
});

describe('readGuestInfo: the gating', () => {
  it('no APIService: the bridge is absent, and nothing else is asked', async () => {
    serve({ discovery: fail(404, 'Not Found - the server could not find the requested resource') });
    expect(await readGuestInfo(opts)).toEqual({ kind: 'absent' });
    expect(calls()).toEqual([DISCOVERY]);
    expect(kpost).not.toHaveBeenCalled();
  });

  it('an APIService whose pods do not answer', async () => {
    serve({ discovery: fail(503, 'Service Unavailable - the server is currently unable to handle the request') });
    expect(await readGuestInfo(opts)).toMatchObject({ kind: 'unavailable', apiService: true });
    expect(calls()).toEqual([DISCOVERY]);
  });

  it('a role without guestinfo on this VM: forbidden, from a review that names the VM', async () => {
    serve({ discovery: discovered, allowed: false });
    expect(await readGuestInfo(opts)).toEqual({ kind: 'forbidden', role: 'hangar-viewer' });
    expect(calls()).toEqual([DISCOVERY]);
    expect(vi.mocked(kpost).mock.calls[0][1]).toMatchObject({
      kind: 'SelfSubjectAccessReview',
      spec: {
        resourceAttributes: {
          verb: 'get',
          group: 'subresources.hangar.magesgate.com',
          resource: 'virtualmachineinstances',
          subresource: 'guestinfo',
          namespace: 'vms',
          name: 'vm',
        },
      },
    });
  });

  it('allowed: the answer, with the sections and the cloud-init users', async () => {
    const info = { kind: 'GuestInfo', agent: { connected: true, healthy: true }, readAt: '2026-11-28T04:00:00Z' };
    serve({ discovery: discovered, guestinfo: info });
    expect(await readGuestInfo({ ...opts, sections: ['cpu', 'time'], sshUsers: ['k4all'] })).toEqual({ kind: 'ok', info });
    expect(vi.mocked(kreq).mock.calls[1]).toEqual([GUESTINFO, { query: { sections: 'cpu,time', sshUsers: 'k4all' } }]);
  });

  it('the API server refuses (a review that could not be made lets the call decide)', async () => {
    serve({ discovery: discovered, guestinfo: fail(403, 'Forbidden - virtualmachineinstances.subresources.hangar.magesgate.com "vm" is forbidden') });
    vi.mocked(kpost).mockRejectedValue(new Error('no reviews'));
    expect(await readGuestInfo(opts)).toEqual({ kind: 'forbidden', role: 'hangar-viewer' });
  });

  it('503 from the bridge: unavailable for now, the message without the status text', async () => {
    serve({ discovery: discovered, guestinfo: fail(503, 'Service Unavailable - cannot reach the libvirt of virtualmachineinstance vms/vm yet: dial: no such file; try again') });
    expect(await readGuestInfo(opts)).toEqual({
      kind: 'unavailable',
      apiService: false,
      message: 'cannot reach the libvirt of virtualmachineinstance vms/vm yet: dial: no such file; try again',
    });
    // Discovery is asked again after a 503.
    expect(calls()).toEqual([DISCOVERY, GUESTINFO, DISCOVERY]);
  });

  it('404 and the APIService is gone meanwhile: absent', async () => {
    let gone = false;
    vi.mocked(kpost).mockResolvedValue({ status: { allowed: true } });
    vi.mocked(kreq).mockImplementation(async (path: string) => {
      if (path === DISCOVERY) {
        if (gone) throw fail(404, 'Not Found');
        return discovered;
      }
      gone = true;
      throw fail(404, 'Not Found - the server could not find the requested resource');
    });
    expect(await readGuestInfo(opts)).toEqual({ kind: 'absent' });
  });

  it('409: the VMI runs on no node', async () => {
    serve({ discovery: discovered, guestinfo: fail(409, 'Conflict - virtualmachineinstance vms/vm is not running') });
    expect(await readGuestInfo(opts)).toEqual({ kind: 'not-running' });
  });
});

describe('can', () => {
  it('names one object when asked', async () => {
    vi.mocked(kpost).mockResolvedValue({ status: { allowed: true } });
    await can({ verb: 'get', group: 'g', resource: 'r', namespace: 'n', name: 'one' });
    await can({ verb: 'get', group: 'g', resource: 'r', namespace: 'n', name: 'two' });
    await can({ verb: 'get', group: 'g', resource: 'r', namespace: 'n', name: 'one' });
    expect(vi.mocked(kpost).mock.calls.map(c => (c[1] as any).spec.resourceAttributes.name)).toEqual(['one', 'two']);
  });
});
