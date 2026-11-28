import { Obj } from '../model/types';
import { kdelete, kpost, kreq } from './client';
import { forwardToGuest, publishPorts } from './ports';
import { publishWeb, unpublishWeb } from './web';

vi.mock('./client', () => ({ currentCluster: () => 'main', kreq: vi.fn(), kpost: vi.fn(), kdelete: vi.fn() }));
vi.mock('./actions', () => ({ runTask: (_: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('./ports', () => ({
  publishPorts: vi.fn(),
  forwardToGuest: vi.fn(),
  SVC_PATH: (ns?: string, name = '') => `/api/v1${ns ? `/namespaces/${ns}` : ''}/services${name ? '/' + name : ''}`,
}));

const vm: Obj = { metadata: { name: 'web1', namespace: 'lab', uid: 'uid-web1' }, spec: {} };
const host = 'web1-lab.192.0.2.10.nip.io';
const req = (extra: any = {}) => ({
  vm,
  port: { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' as const },
  selector: { selector: { 'vmi.kubevirt.io/id': 'web1' }, viaTemplate: false },
  host,
  className: 'traefik',
  traefik: true,
  what: 'HTTP (80/TCP)',
  ...extra,
});
const notFound = Object.assign(new Error('not found'), { status: 404 });

beforeEach(() => {
  vi.mocked(kreq).mockReset();
  vi.mocked(kpost).mockReset();
  vi.mocked(kdelete).mockReset();
  vi.mocked(publishPorts).mockReset();
  vi.mocked(forwardToGuest).mockReset();
  vi.mocked(kpost).mockImplementation(async (_p, body) => body as Obj);
});

describe('publishWeb', () => {
  it("adds the guest port to the VM's ClusterIP Service when it lacks it, then routes the host to it", async () => {
    vi.mocked(kreq).mockRejectedValueOnce(notFound);
    vi.mocked(publishPorts).mockResolvedValue({ service: {} as Obj, vmChanged: true });
    const listAdd = { nic: 'default', ports: [{ port: 80, protocol: 'TCP' as const }] };
    const r = await publishWeb(req({ listAdd, issuer: { kind: 'ClusterIssuer', name: 'lab-ca' } }));
    expect(vi.mocked(publishPorts).mock.calls[0][0]).toMatchObject({ mode: 'cluster', ports: [{ name: 'http', targetPort: 80 }], listAdd });
    expect(r.vmChanged).toBe(true);
    const [path, ing] = vi.mocked(kpost).mock.calls[0] as [string, Obj];
    expect(path).toBe('/apis/networking.k8s.io/v1/namespaces/lab/ingresses');
    expect(ing.spec.rules[0].http.paths[0].backend).toEqual({ service: { name: 'web1-cluster', port: { name: 'http' } } });
    expect(ing.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('lab-ca');
    expect(ing.spec.tls[0].hosts).toEqual([host]);
  });
  it('reuses the port the ClusterIP Service already has, by its name', async () => {
    vi.mocked(kreq).mockResolvedValueOnce({ metadata: { name: 'web1-cluster' }, spec: { ports: [{ name: 'web', port: 8080, targetPort: 80, protocol: 'TCP' }] } });
    await publishWeb(req());
    expect(publishPorts).not.toHaveBeenCalled();
    expect((vi.mocked(kpost).mock.calls[0][1] as Obj).spec.rules[0].http.paths[0].backend.service.port).toEqual({ name: 'web' });
  });
  it('an Ingress of that name already there: says so', async () => {
    vi.mocked(kreq).mockResolvedValueOnce({ metadata: { name: 'web1-cluster' }, spec: { ports: [{ name: 'http', port: 80, targetPort: 80 }] } });
    vi.mocked(kpost).mockRejectedValue(Object.assign(new Error('AlreadyExists'), { status: 409 }));
    await expect(publishWeb(req())).rejects.toThrow(`An Ingress for ${host} already exists in lab`);
  });
});

describe('unpublishWeb', () => {
  it('deletes the Ingress and leaves the ClusterIP port', async () => {
    vi.mocked(kdelete).mockResolvedValue({});
    const ingress = { metadata: { name: 'web1-web-abcde', namespace: 'lab' } };
    await unpublishWeb({ key: 'k', ingress, host, path: '/', managed: true, serviceName: 'web1-cluster', servicePort: 'http' }, vm);
    expect(vi.mocked(kdelete).mock.calls[0][0]).toBe('/apis/networking.k8s.io/v1/namespaces/lab/ingresses/web1-web-abcde');
    expect(kreq).not.toHaveBeenCalled();
  });
});
