import { Obj } from '../model/types';
import { updateVm } from './actions';
import { kdelete, kmerge, kpost, kreq } from './client';
import { publishPorts, unpublishPort } from './ports';

vi.mock('./client', () => ({ currentCluster: () => 'main', kreq: vi.fn(), kpost: vi.fn(), kmerge: vi.fn(), kdelete: vi.fn() }));
vi.mock('./actions', () => ({ runTask: (_: unknown, fn: () => Promise<unknown>) => fn(), updateVm: vi.fn() }));
vi.mock('./resources', () => ({ PATHS: { vm: (ns: string, name = '') => `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines${name ? '/' + name : ''}` } }));

const vm: Obj = {
  metadata: { name: 'web1', namespace: 'lab', uid: 'uid-web1', resourceVersion: '7' },
  spec: { template: { spec: { domain: { devices: { interfaces: [{ name: 'default', masquerade: {}, ports: [{ port: 80 }] }] } }, networks: [{ name: 'default', pod: {} }] } } },
};
const notFound = Object.assign(new Error('not found'), { status: 404 });
const sel = { selector: { 'vmi.kubevirt.io/id': 'web1' }, viaTemplate: false };
const ssh = { name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' as const };
const mine = (ports: any[]): Obj => ({
  metadata: { name: 'web1-nodeport', namespace: 'lab', resourceVersion: '42', labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' } },
  spec: { type: 'NodePort', ports },
});

beforeEach(() => {
  vi.mocked(kreq).mockReset();
  vi.mocked(kpost).mockReset();
  vi.mocked(kmerge).mockReset();
  vi.mocked(kdelete).mockReset();
  vi.mocked(updateVm).mockReset();
});

describe('publishPorts', () => {
  it("creates the VM's Service when there is none", async () => {
    vi.mocked(kreq).mockRejectedValueOnce(notFound);
    vi.mocked(kpost).mockImplementation(async (_p, body) => body as Obj);
    const r = await publishPorts({ vm, mode: 'host', ports: [ssh], selector: sel, what: 'SSH' });
    expect(vi.mocked(kpost).mock.calls[0][0]).toBe('/api/v1/namespaces/lab/services');
    expect(r.service.metadata.name).toBe('web1-nodeport');
    expect(r.service.metadata.ownerReferences[0]).toMatchObject({ kind: 'VirtualMachine', uid: 'uid-web1' });
    expect(r.vmChanged).toBe(false);
    expect(updateVm).not.toHaveBeenCalled();
  });

  it('adds to the existing Service with its resourceVersion, so a concurrent change is refused', async () => {
    vi.mocked(kreq).mockResolvedValueOnce(mine([{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP', nodePort: 30080 }]));
    vi.mocked(kmerge).mockResolvedValue(mine([]));
    await publishPorts({ vm, mode: 'host', ports: [ssh], selector: sel, keepSourceIp: true, what: 'SSH' });
    expect(kpost).not.toHaveBeenCalled();
    const [path, patch] = vi.mocked(kmerge).mock.calls[0];
    expect(path).toBe('/api/v1/namespaces/lab/services/web1-nodeport');
    expect(patch).toEqual({
      metadata: { resourceVersion: '42' },
      spec: {
        ports: [
          { name: 'http', port: 80, targetPort: 80, protocol: 'TCP', nodePort: 30080 },
          { name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' },
        ],
        externalTrafficPolicy: 'Local',
      },
    });
  });

  it('refuses a Service of that name Hangar did not make, and a port it already has', async () => {
    vi.mocked(kreq).mockResolvedValueOnce({ metadata: { name: 'web1-nodeport', namespace: 'lab' }, spec: { type: 'NodePort', ports: [] } });
    await expect(publishPorts({ vm, mode: 'host', ports: [ssh], selector: sel, what: 'SSH' })).rejects.toThrow(/Hangar did not make it/);
    vi.mocked(kreq).mockResolvedValueOnce(mine([ssh]));
    await expect(publishPorts({ vm, mode: 'host', ports: [ssh], selector: sel, what: 'SSH' })).rejects.toThrow(/already published/);
    expect(kmerge).not.toHaveBeenCalled();
  });

  it("then adds the guest ports to the adapter's list, on the VM as it is now", async () => {
    const fresh = { ...vm, metadata: { ...vm.metadata, resourceVersion: '8' } };
    vi.mocked(kreq).mockRejectedValueOnce(notFound).mockResolvedValueOnce(fresh);
    vi.mocked(kpost).mockImplementation(async (_p, body) => body as Obj);
    const r = await publishPorts({ vm, mode: 'host', ports: [ssh], selector: sel, listAdd: { nic: 'default', ports: [{ port: 22, protocol: 'TCP' }] }, what: 'SSH' });
    expect(r.vmChanged).toBe(true);
    const [base, , next] = vi.mocked(updateVm).mock.calls[0];
    expect(base.metadata.resourceVersion).toBe('8');
    expect(next.spec.template.spec.domain.devices.interfaces[0].ports).toEqual([{ port: 80 }, { port: 22, protocol: 'TCP' }]);
  });

  it('a failed Service leaves the VM alone', async () => {
    vi.mocked(kreq).mockRejectedValueOnce(notFound);
    vi.mocked(kpost).mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(publishPorts({ vm, mode: 'host', ports: [ssh], selector: sel, listAdd: { nic: 'default', ports: [{ port: 22, protocol: 'TCP' }] }, what: 'SSH' })).rejects.toThrow('Forbidden');
    expect(updateVm).not.toHaveBeenCalled();
  });
});

describe('unpublishPort', () => {
  const row = (svc: Obj) => ({ key: 'k', service: svc, mode: 'host' as const, managed: true, name: 'ssh', protocol: 'TCP', port: 22, guest: 22, nodePort: 30022 });
  it('removes the port and keeps the others', async () => {
    const svc = mine([ssh, { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }]);
    vi.mocked(kreq).mockResolvedValueOnce(svc);
    await unpublishPort(row(svc), vm);
    expect(vi.mocked(kmerge).mock.calls[0][1]).toEqual({ metadata: { resourceVersion: '42' }, spec: { ports: [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }] } });
    expect(kdelete).not.toHaveBeenCalled();
  });
  it('deletes the Service with its last port', async () => {
    const svc = mine([ssh]);
    vi.mocked(kreq).mockResolvedValueOnce(svc);
    vi.mocked(kdelete).mockResolvedValue({});
    await unpublishPort(row(svc), vm);
    expect(vi.mocked(kdelete).mock.calls[0][0]).toBe('/api/v1/namespaces/lab/services/web1-nodeport');
  });
  it('a Service already gone is fine', async () => {
    vi.mocked(kreq).mockRejectedValueOnce(notFound);
    await expect(unpublishPort(row(mine([ssh])), vm)).resolves.toBeUndefined();
  });
});
