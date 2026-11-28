import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import * as A from '../../api/actions';
import { publishPorts } from '../../api/ports';
import { publishWeb, runUrlTest } from '../../api/web';
import { Obj } from '../../model/types';
import { openDialog } from '../../ui/dialogs';
import { PortsPanel } from './PortsPanel';

const vm = (iface: any): Obj => ({
  metadata: { name: 'web1', namespace: 'lab', uid: 'uid-web1' },
  spec: { template: { metadata: { labels: { app: 'web' } }, spec: { domain: { devices: { interfaces: [iface] } }, networks: [{ name: 'default', pod: {} }] } } },
});
const vmi: Obj = { metadata: { name: 'web1', namespace: 'lab', creationTimestamp: '2026-11-01T00:00:00Z' }, status: { phase: 'Running', printableStatus: 'Running', interfaces: [{ name: 'default', ipAddresses: ['10.0.2.2'] }] } };
const hangar = (name: string, type: string, ports: any[], extra: any = {}): Obj => ({
  metadata: { name, namespace: 'lab', uid: `uid-${name}`, labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' } },
  spec: { type, selector: { 'vmi.kubevirt.io/id': 'web1' }, ports, ...(extra.spec ?? {}) },
  status: extra.status ?? {},
});
const slice = (svc: string, ready: boolean): Obj => ({ metadata: { name: `${svc}-x`, namespace: 'lab', labels: { 'kubernetes.io/service-name': svc } }, endpoints: [{ conditions: { ready } }] });

const services = [
  hangar('web1-nodeport', 'NodePort', [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP', nodePort: 30022 }]),
  hangar('web1-lb', 'LoadBalancer', [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }], {
    spec: { loadBalancerClass: 'io.cilium/l2-announcer' },
    status: { loadBalancer: { ingress: [{ ip: '203.0.113.5' }] }, conditions: [{ type: 'cilium.io/IPAMRequestSatisfied', status: 'True', reason: 'satisfied' }] },
  }),
  { metadata: { name: 'legacy', namespace: 'lab' }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.9', selector: { app: 'web' }, ports: [{ port: 8080, targetPort: 8080 }] } },
];

const host = 'web1-lab.192.0.2.10.nip.io';
const ingress = (issuer: boolean, status = true): Obj => ({
  metadata: {
    name: 'web1-web-abcde',
    namespace: 'lab',
    labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' },
    annotations: issuer ? { 'cert-manager.io/cluster-issuer': 'lab-ca' } : {},
  },
  spec: {
    ingressClassName: 'traefik',
    ...(issuer ? { tls: [{ hosts: [host], secretName: 'web1-web-abcde-tls' }] } : {}),
    rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web1-cluster', port: { name: 'http' } } } }] } }],
  },
  status: status ? { loadBalancer: { ingress: [{ ip: '192.0.2.10' }] } } : {},
});
const clusterSvc = hangar('web1-cluster', 'ClusterIP', [{ name: 'http', port: 80, targetPort: 80, protocol: 'TCP' }]);

const emptyWeb = () => ({
  loaded: true,
  ingresses: [] as Obj[] | 'denied' | 'missing',
  certificates: [] as Obj[] | 'denied',
  issuers: [] as Obj[] | 'denied' | 'missing',
  clusterIssuers: [] as Obj[] | 'denied' | 'missing',
  classes: [{ name: 'traefik', controller: 'traefik.io/ingress-controller', isDefault: true }] as any,
  refresh: vi.fn(),
});

const state = {
  web: emptyWeb(),
  vmi: vmi as Obj | undefined,
  world: {
    loaded: true,
    services,
    slices: [slice('web1-nodeport', true), slice('web1-lb', true)],
    events: [] as Obj[],
    announcers: new Map([['lab/web1-lb', 'host-b']]),
    denied: { services: false, slices: false, events: false, announcers: false },
    refresh: vi.fn(),
  },
  pools: {
    loaded: true,
    metallb: { served: false, denied: false, items: [] as Obj[] },
    cilium: { served: true, denied: false, items: [{ metadata: { name: 'cil' }, spec: { blocks: [{ cidr: '203.0.113.0/28' }] } }] as Obj[] },
    refresh: vi.fn(),
  },
};

vi.mock('../../api/data', () => ({
  useHangar: () => ({
    idx: { vmi: new Map(state.vmi ? [['lab/web1', state.vmi]] : []), launcher: new Map() },
    kubevirt: { metadata: { name: 'kubevirt' }, status: { observedKubeVirtVersion: 'v1.9.1' } },
    nodes: [{ metadata: { name: 'host-a' }, status: { addresses: [{ type: 'InternalIP', address: '192.0.2.10' }] } }],
    namespaces: [{ metadata: { name: 'lab' } }],
    dvs: [],
    pvcs: [],
  }),
}));
vi.mock('../../api/ports', () => ({
  usePortsData: () => state.world,
  usePools: () => state.pools,
  publishPorts: vi.fn(),
  unpublishPort: vi.fn(),
  forwardToGuest: vi.fn(),
  servicesForNodePorts: () => Promise.resolve({ items: [], scope: 'cluster' }),
}));
vi.mock('../../api/permissions', () => ({
  NOT_ALLOWED: 'Your role does not allow this',
  useCan: () => true,
  useVmPerms: () => ({ power: true, edit: true, remove: true, console: true, migrate: true }),
}));
vi.mock('../../api/web', () => ({
  useWebData: () => state.web,
  // Another Ingress of the ingress's class: its status has the ingress's address (and its host is taken).
  webContext: () =>
    Promise.resolve({
      ingresses: [{ metadata: { name: 'dash', namespace: 'k4all' }, spec: { ingressClassName: 'traefik', rules: [{ host: 'dashboard.192.0.2.10.nip.io' }] }, status: { loadBalancer: { ingress: [{ ip: '192.0.2.10' }] } } }],
      services: [],
    }),
  publishWeb: vi.fn(),
  unpublishWeb: vi.fn(),
  runUrlTest: vi.fn(),
  urlTestBlocked: () => false,
}));
vi.mock('../../api/hardware', () => ({
  useInventories: () => ({ loaded: true, missing: false, denied: false, hosts: new Map([['host-a', { inv: { firewalld: true }, at: 0 }]]) }),
}));
vi.mock('../../api/k4all', () => ({ useK4all: () => true }));
vi.mock('../../api/protection', () => ({ labelDisks: vi.fn() }));
vi.mock('../../api/actions', () => ({ restart: vi.fn(() => Promise.resolve()) }));
vi.mock('../../ui/dialogs', () => ({ openDialog: vi.fn(), confirm: vi.fn() }));
vi.mock('../../shell/nav', () => ({ hrefFor: () => '/c/main/hangar/networks/ports' }));

const listed = { name: 'default', masquerade: {}, ports: [{ port: 80, protocol: 'TCP' }] };
const show = (v: Obj) =>
  render(
    <MemoryRouter>
      <PortsPanel vm={v} />
    </MemoryRouter>
  );

beforeEach(() => {
  state.vmi = vmi;
  state.web = emptyWeb();
  state.world.services = services;
  vi.mocked(publishPorts).mockReset();
  vi.mocked(openDialog).mockReset();
});

describe('Published ports panel', () => {
  it('shows each port with its live state, for NodePort, Cilium LoadBalancer and a Service made elsewhere', () => {
    show(vm(listed));
    expect(screen.getByText('Port 30022 on every host')).toBeTruthy();
    expect(screen.getByText('192.0.2.10:30022')).toBeTruthy();
    expect(screen.getAllByText('The VM is behind it')).toHaveLength(2);
    expect(screen.getByText('203.0.113.5:80')).toBeTruthy();
    expect(screen.getByText('203.0.113.5 from pool cil, announced by host-b')).toBeTruthy();
    expect(screen.getByText('Made outside Hangar')).toBeTruthy();
    expect(screen.getByText("The VM's pod is not selected yet")).toBeTruthy();
    // firewalld runs on a host and there is a host port.
    expect(screen.getByText(/firewalld runs on host-a/)).toBeTruthy();
  });

  it("says which ports the adapter's list forwards, and flags a published port missing from it", () => {
    show(vm(listed));
    expect(screen.getByText(/default forwards only the ports in its list \(80\/TCP\)/)).toBeTruthy();
    // ssh (22) and the other Service's 8080 are not in it.
    expect(screen.getAllByText(/Not in default's port list/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Add it (next restart)' })).toHaveLength(2);
  });

  it('publishes through the dialog, adds the port to the list and prompts for a restart', async () => {
    let dialog: ((close: () => void) => React.ReactNode) | null = null;
    vi.mocked(openDialog).mockImplementation(r => {
      dialog = r as any;
      return () => undefined;
    });
    vi.mocked(publishPorts).mockResolvedValue({ service: services[1], vmChanged: true });
    show(vm(listed));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(dialog).not.toBeNull();
    const close = vi.fn();
    const shown = render(<MemoryRouter>{dialog!(close)}</MemoryRouter>);
    const dlg = screen.getByRole('dialog');
    // SSH is the first preset; a pool serves VMs and the VM's own address exists: the port joins it.
    expect(within(dlg).getByText(/these ports join it/)).toBeTruthy();
    expect(within(dlg).getByText(/Hangar adds 22\/TCP to it/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Publish' }));
    });
    expect(close).toHaveBeenCalled();
    shown.unmount();
    const req = vi.mocked(publishPorts).mock.calls[0][0];
    expect(req).toMatchObject({
      mode: 'address',
      ports: [{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP' }],
      listAdd: { nic: 'default', ports: [{ port: 22, protocol: 'TCP' }] },
      selector: { selector: { 'vmi.kubevirt.io/id': 'web1' }, viaTemplate: false },
    });
    expect(req.lb).toBeUndefined();
    expect(await screen.findByText(/Added to the adapter's port list/)).toBeTruthy();
    expect(screen.getByText('Restart to forward the new ports.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(A.restart).toHaveBeenCalled();
  });

  it('a failed publish stays on its row with the reason', async () => {
    let dialog: ((close: () => void) => React.ReactNode) | null = null;
    vi.mocked(openDialog).mockImplementation(r => {
      dialog = r as any;
      return () => undefined;
    });
    vi.mocked(publishPorts).mockRejectedValue(Object.assign(new Error('Forbidden - services is forbidden'), { status: 403 }));
    show(vm({ name: 'default', masquerade: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const shown = render(<MemoryRouter>{dialog!(() => undefined)}</MemoryRouter>);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish' }));
    });
    shown.unmount();
    expect(await screen.findByText(/Not published: Not allowed: services is forbidden/)).toBeTruthy();
    // A list that forwards everything: nothing added, no restart.
    expect(vi.mocked(publishPorts).mock.calls[0][0].listAdd).toBeUndefined();
    expect(screen.queryByText('Restart to forward the new ports.')).toBeNull();
  });

  it('a pod adapter in bridge mode cannot publish, and says why', () => {
    show(vm({ name: 'default', bridge: {} }));
    expect(screen.getByText(/joins the pod network as a bridge/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('web addresses', () => {
  const withWeb = (ing: Obj, certs: Obj[] | 'denied' = []) => {
    state.world.services = [...services, clusterSvc];
    state.web = { ...emptyWeb(), ingresses: [ing], certificates: certs };
  };
  it("with the ingress's default certificate: the address to point at, the browser warning, the VM behind it", () => {
    withWeb(ingress(false));
    state.world.slices = [...state.world.slices, slice('web1-cluster', true)];
    show(vm(listed));
    expect(screen.getByRole('link', { name: `https://${host}/` })).toBeTruthy();
    expect(screen.getByText(/this nip.io name already does/)).toBeTruthy();
    expect(screen.getByText("The ingress's default certificate: browsers warn")).toBeTruthy();
    expect(screen.getByText(/Browsers will warn that this connection is not private/)).toBeTruthy();
    expect(screen.getAllByText('The VM is behind it').length).toBeGreaterThanOrEqual(3);
  });
  it('with an issuer: requesting, valid until, failed, unknown', () => {
    const cert = (conditions: any[], extra: any = {}): Obj => ({ metadata: { name: 'web1-web-abcde-tls', namespace: 'lab' }, spec: { secretName: 'web1-web-abcde-tls' }, status: { conditions, ...extra } });
    withWeb(ingress(true, false), []);
    const r = show(vm(listed));
    expect(screen.getByText('Waiting for the ingress to publish its address')).toBeTruthy();
    expect(screen.getByText(/Requesting a certificate from lab-ca/)).toBeTruthy();
    r.unmount();
    withWeb(ingress(true), [cert([{ type: 'Ready', status: 'True' }], { notAfter: '2027-02-26T10:00:00Z' })]);
    const r2 = show(vm(listed));
    expect(screen.getByText(/Certificate valid until/)).toBeTruthy();
    r2.unmount();
    withWeb(ingress(true), [cert([{ type: 'Issuing', status: 'False', reason: 'Failed', message: 'issuer lab-ca not ready' }])]);
    const r3 = show(vm(listed));
    expect(screen.getByText('Certificate failed: issuer lab-ca not ready')).toBeTruthy();
    r3.unmount();
    withWeb(ingress(true), 'denied');
    show(vm(listed));
    expect(screen.getByText('Certificate unknown: your role cannot read Certificates')).toBeTruthy();
  });
  it('tests the address once and says what the answer proves', async () => {
    withWeb(ingress(false));
    vi.mocked(runUrlTest).mockResolvedValue('refused');
    show(vm(listed));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test the address' }));
    });
    expect(screen.getByText(/The browser refused the certificate or could not reach the name/)).toBeTruthy();
    expect(screen.getByRole('link', { name: `Open ${host}` })).toBeTruthy();
    expect(vi.mocked(runUrlTest).mock.calls[0][0]).toBe(`https://${host}/`);
  });
  it('publishes a web address for HTTP through the dialog, on the ClusterIP Service it already has', async () => {
    state.world.services = [...services, clusterSvc];
    state.web = {
      ...emptyWeb(),
      clusterIssuers: [{ metadata: { name: 'lab-ca' }, spec: { ca: { secretName: 'ca' } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }],
    };
    let dialog: ((close: () => void) => React.ReactNode) | null = null;
    vi.mocked(openDialog).mockImplementation(r => {
      dialog = r as any;
      return () => undefined;
    });
    vi.mocked(publishWeb).mockResolvedValue({ ingress: ingress(true), vmChanged: false });
    show(vm({ name: 'default', masquerade: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const shown = render(<MemoryRouter>{dialog!(() => undefined)}</MemoryRouter>);
    const dlg = screen.getByRole('dialog');
    // SSH 22 is first; HTTPS is offered no web address (the guest would serve TLS).
    fireEvent.click(within(dlg).getByText('HTTPS 443'));
    expect(within(dlg).getByText(/The guest serves HTTPS here/)).toBeTruthy();
    fireEvent.click(within(dlg).getByText('HTTP 80'));
    fireEvent.click(within(dlg).getByLabelText(/Web address \(through the ingress\)/));
    // The suggested name comes from the ingress's address in an Ingress's status.
    expect(await within(dlg).findByDisplayValue('web1-lab.192.0.2.10.nip.io')).toBeTruthy();
    expect(within(dlg).getByText(/HTTPS \(443\) only/)).toBeTruthy();
    // The default certificate is said plainly; then an issuer is picked.
    expect(within(dlg).getByText(/Browsers will warn/)).toBeTruthy();
    fireEvent.mouseDown(within(dlg).getByLabelText('Certificate'));
    fireEvent.click(await screen.findByRole('option', { name: /lab-ca/ }));
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Publish' }));
    });
    shown.unmount();
    const req = vi.mocked(publishWeb).mock.calls[0][0];
    expect(req).toMatchObject({
      host: 'web1-lab.192.0.2.10.nip.io',
      className: 'traefik',
      traefik: true,
      issuer: { kind: 'ClusterIssuer', name: 'lab-ca' },
      port: { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' },
    });
    expect(await screen.findByText(/the ingress routes it to the VM/)).toBeTruthy();
  });
  it('with no ingress class the web way is off, and says why', async () => {
    vi.mocked(openDialog).mockImplementation(r => {
      render(<MemoryRouter>{(r as any)(() => undefined)}</MemoryRouter>);
      return () => undefined;
    });
    state.web = { ...emptyWeb(), classes: [] };
    show(vm({ name: 'default', masquerade: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dlg = screen.getByRole('dialog');
    fireEvent.click(within(dlg).getByText('HTTP 80'));
    expect(within(dlg).getByText('No ingress class on this cluster')).toBeTruthy();
  });
});
