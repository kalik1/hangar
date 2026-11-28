import { Obj } from './types';
import * as W from './web';

const vm: Obj = { metadata: { name: 'web1', namespace: 'lab', uid: 'uid-web1' }, spec: {} };
const cls = (name: string, controller: string, isDefault = false): Obj => ({
  metadata: { name, annotations: isDefault ? { 'ingressclass.kubernetes.io/is-default-class': 'true' } : {} },
  spec: { controller },
});

describe('the ingress class', () => {
  it('takes the default class, else the only one, else the user picks', () => {
    const k4all = W.ingressClassRows([cls('nginx', 'k8s.io/ingress-nginx'), cls('traefik', W.TRAEFIK_CONTROLLER, true)]);
    expect(k4all.map(c => c.name)).toEqual(['traefik', 'nginx']);
    expect(W.pickClass(k4all)).toBe('traefik');
    expect(W.pickClass(W.ingressClassRows([cls('haproxy', 'haproxy.org/ingress-controller')]))).toBe('haproxy');
    expect(W.pickClass(W.ingressClassRows([cls('a', 'x'), cls('b', 'y')]))).toBeNull();
    expect(W.pickClass([])).toBeNull();
  });
  it("Traefik's annotations only for Traefik's controller; when classes cannot be read, the class named traefik", () => {
    const rows = W.ingressClassRows([cls('traefik', W.TRAEFIK_CONTROLLER, true), cls('nginx', 'traefik.io/ingress-nginx-provider')]);
    expect(W.isTraefikClass('traefik', rows)).toBe(true);
    expect(W.isTraefikClass('nginx', rows)).toBe(false);
    expect(W.isTraefikClass('traefik', null)).toBe(true);
    expect(W.isTraefikClass('other', null)).toBe(false);
  });
});

describe('the host', () => {
  const other: Obj = { metadata: { name: 'dash', namespace: 'k4all' }, spec: { rules: [{ host: 'dashboard.192.0.2.10.nip.io' }], tls: [{ hosts: ['tls-only.example.com'] }] } };
  it('is a DNS-1123 subdomain, not a wildcard, not used by another Ingress', () => {
    expect(W.hostProblem('web1-lab.192.0.2.10.nip.io', [other])).toBeNull();
    expect(W.hostProblem('', [])).toMatch(/Type the name/);
    expect(W.hostProblem('*.example.com', [])).toMatch(/wildcard/);
    expect(W.hostProblem('Web.example.com', [])).toMatch(/lowercase/);
    expect(W.hostProblem('a..b', [])).toMatch(/Two dots/);
    expect(W.hostProblem('-a.example.com', [])).toMatch(/no "-" at either end/);
    expect(W.hostProblem(`${'a'.repeat(64)}.example.com`, [])).toMatch(/63/);
    expect(W.hostProblem('192.0.2.10', [])).toMatch(/not a name/);
    expect(W.hostProblem('dashboard.192.0.2.10.nip.io', [other])).toBe('dashboard.192.0.2.10.nip.io is used by the Ingress k4all/dash');
    expect(W.hostProblem('tls-only.example.com', [other])).toMatch(/used by/);
  });
  it('suggests <vm>-<namespace>.<ingress IPv4>.nip.io', () => {
    expect(W.suggestHost('web1', 'lab', '192.0.2.10')).toBe('web1-lab.192.0.2.10.nip.io');
    expect(W.suggestHost('My.VM', 'team_a', '192.0.2.10')).toBe('my-vm-team-a.192.0.2.10.nip.io');
    expect(W.suggestHost('web1', 'lab', null)).toBe('');
    expect(W.suggestHost('web1', 'lab', 'ingress.example.com')).toBe('');
    const long = W.suggestHost('v'.repeat(60), 'namespace', '192.0.2.10');
    expect(long.split('.')[0].length).toBeLessThanOrEqual(63);
    expect(W.hostProblem(long, [])).toBeNull();
  });
  it("finds the ingress's IPv4 from Ingress status, else from Traefik's Service", () => {
    const ing = (ip: string, className = 'traefik'): Obj => ({ metadata: { name: 'x' }, spec: { ingressClassName: className }, status: { loadBalancer: { ingress: [{ ip }] } } });
    expect(W.ingressIpv4([ing('192.0.2.20', 'nginx'), ing('192.0.2.10')], 'traefik')).toBe('192.0.2.10');
    const svc: Obj = { metadata: { name: 'traefik', labels: { 'app.kubernetes.io/name': 'traefik' } }, spec: { externalIPs: ['192.0.2.30'] } };
    expect(W.ingressIpv4([], 'traefik', [svc])).toBe('192.0.2.30');
    expect(W.ingressIpv4([], 'traefik', [])).toBeNull();
  });
});

describe('the Ingress', () => {
  const base = { vm, host: 'web1-lab.192.0.2.10.nip.io', className: 'traefik', serviceName: 'web1-cluster', portName: 'http' };
  it('routes the host to the VM\'s ClusterIP Service, is owned by the VM and named after the host', () => {
    const i = W.ingressManifest({ ...base, traefik: false });
    expect(i.metadata.name).toMatch(/^web1-web-[0-9a-f]{5}$/);
    expect(i.metadata.name).toBe(W.ingressName('web1', base.host));
    expect(i.metadata.labels).toEqual({ 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' });
    expect(i.metadata.ownerReferences).toEqual([{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'web1', uid: 'uid-web1', controller: true, blockOwnerDeletion: false }]);
    expect(i.spec).toEqual({
      ingressClassName: 'traefik',
      rules: [{ host: base.host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web1-cluster', port: { name: 'http' } } } }] } }],
    });
    // Another controller: no annotations at all, no TLS without an issuer.
    expect(i.metadata.annotations).toBeUndefined();
  });
  it("Traefik: HTTPS only, through websecure", () => {
    const i = W.ingressManifest({ ...base, traefik: true });
    expect(i.metadata.annotations).toEqual({ 'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure', 'traefik.ingress.kubernetes.io/router.tls': 'true' });
    expect(i.spec.tls).toBeUndefined();
  });
  it('with an issuer: its annotation and spec.tls with a Secret named after the Ingress', () => {
    const c = W.ingressManifest({ ...base, traefik: true, issuer: { kind: 'ClusterIssuer', name: 'lab-ca' } });
    expect(c.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('lab-ca');
    expect(c.metadata.annotations['cert-manager.io/issuer']).toBeUndefined();
    expect(c.spec.tls).toEqual([{ hosts: [base.host], secretName: `${c.metadata.name}-tls` }]);
    const n = W.ingressManifest({ ...base, traefik: false, issuer: { kind: 'Issuer', name: 'folder-ca' } });
    expect(n.metadata.annotations).toEqual({ 'cert-manager.io/issuer': 'folder-ca' });
  });
  it('a long VM name still gives a name of at most 63 characters', () => {
    expect(W.ingressName('x'.repeat(80), 'a.example.com').length).toBeLessThanOrEqual(63);
    expect(W.ingressName('web1', 'a.example.com')).not.toBe(W.ingressName('web1', 'b.example.com'));
  });
  it('only for a plain HTTP port of the guest', () => {
    expect(W.webPortProblem(80, 'TCP')).toBeNull();
    expect(W.webPortProblem(8080, 'TCP')).toBeNull();
    expect(W.webPortProblem(443, 'TCP')).toMatch(/serves HTTPS/);
    expect(W.webPortProblem(53, 'UDP')).toMatch(/TCP/);
  });
});

describe('the issuers', () => {
  const ci = (name: string, ready: string | null, spec: any = { ca: { secretName: 'ca' } }): Obj => ({
    metadata: { name },
    spec,
    ...(ready ? { status: { conditions: [{ type: 'Ready', status: ready, reason: ready === 'True' ? 'KeyPairVerified' : 'ErrGetKeyPair', message: ready === 'True' ? 'ok' : 'secret "ca" not found' }] } } : {}),
  });
  it('none: cert-manager not served', () => {
    expect(W.issuerList('missing', 'missing')).toEqual({ rows: [], noCertManager: true, clusterDenied: false });
  });
  it('a ClusterIssuer ready or not, and a namespaced Issuer', () => {
    const l = W.issuerList([ci('broken', 'False'), ci('lab-ca', 'True')], [{ ...ci('folder-ca', null), metadata: { name: 'folder-ca', namespace: 'lab' } }]);
    expect(l.rows.map(r => [r.kind, r.name, r.ready, r.why])).toEqual([
      ['ClusterIssuer', 'lab-ca', true, undefined],
      ['ClusterIssuer', 'broken', false, 'secret "ca" not found'],
      ['Issuer', 'folder-ca', null, undefined],
    ]);
    expect(l.noCertManager).toBe(false);
  });
  it('ClusterIssuers the role cannot list: the folder\'s Issuers, and says why', () => {
    const l = W.issuerList('denied', []);
    expect(l).toEqual({ rows: [], noCertManager: false, clusterDenied: true });
  });
  it('an ACME HTTP-01 issuer cannot pass for a nip.io name of a private address, and says so', () => {
    const le = W.issuerList([ci('letsencrypt', 'True', { acme: { server: 'https://acme.example/dir', solvers: [{ http01: { ingress: {} } }] } })], []).rows[0];
    expect(le).toMatchObject({ acme: true, http01: true });
    expect(W.acmeProblem(le, 'web1-lab.192.168.5.10.nip.io')).toMatch(/cannot reach 192.168.5.10, a private address/);
    expect(W.acmeProblem(le, 'web1-lab.10-1-2-3.sslip.io')).toMatch(/10.1.2.3/);
    expect(W.acmeProblem(le, 'web1-lab.203.0.113.5.nip.io')).toBeNull();
    expect(W.acmeProblem(le, 'www.example.com')).toBeNull();
    const ca = W.issuerList([ci('lab-ca', 'True')], []).rows[0];
    expect(W.acmeProblem(ca, 'web1-lab.192.168.5.10.nip.io')).toBeNull();
  });
});

describe('the TLS state', () => {
  const host = 'web1-lab.192.0.2.10.nip.io';
  const ing = (tls: boolean, issuer = true): Obj => ({
    metadata: { name: 'web1-web-abcde', namespace: 'lab', annotations: issuer ? { 'cert-manager.io/cluster-issuer': 'lab-ca' } : {} },
    spec: { ...(tls ? { tls: [{ hosts: [host], secretName: 'web1-web-abcde-tls' }] } : {}), rules: [{ host }] },
  });
  const cert = (conditions: any[], extra: any = {}): Obj => ({ metadata: { name: 'web1-web-abcde-tls', namespace: 'lab' }, spec: { secretName: 'web1-web-abcde-tls' }, status: { conditions, ...extra } });
  it("the ingress's default certificate without spec.tls", () => {
    expect(W.tlsState(ing(false, false), host, [])).toEqual({ kind: 'default' });
  });
  it('Ready: valid until notAfter', () => {
    const c = cert([{ type: 'Ready', status: 'True', reason: 'Ready' }], { notAfter: '2027-02-26T10:00:00Z', renewalTime: '2027-01-27T10:00:00Z' });
    expect(W.tlsState(ing(true), host, [c])).toEqual({ kind: 'valid', notAfter: '2027-02-26T10:00:00Z', renewalTime: '2027-01-27T10:00:00Z', renewing: false });
  });
  it('Issuing: requesting', () => {
    const c = cert([
      { type: 'Ready', status: 'False', reason: 'DoesNotExist', message: 'Issuing certificate as Secret does not exist' },
      { type: 'Issuing', status: 'True', reason: 'DoesNotExist', message: 'Issuing certificate as Secret does not exist' },
    ]);
    expect(W.tlsState(ing(true), host, [c])).toEqual({ kind: 'requesting', message: 'Issuing certificate as Secret does not exist' });
    expect(W.tlsState(ing(true), host, [])).toMatchObject({ kind: 'requesting' });
  });
  it('failed: the message', () => {
    const c = cert(
      [
        { type: 'Ready', status: 'False', reason: 'DoesNotExist' },
        { type: 'Issuing', status: 'False', reason: 'Failed', message: 'The certificate request has failed to complete and will be retried: issuer not ready' },
      ],
      { lastFailureTime: '2026-11-28T10:00:00Z' }
    );
    expect(W.tlsState(ing(true), host, [c])).toEqual({ kind: 'failed', message: 'The certificate request has failed to complete and will be retried: issuer not ready' });
  });
  it('unreadable: no permission to read Certificates; a Secret made elsewhere', () => {
    expect(W.tlsState(ing(true), host, 'denied')).toEqual({ kind: 'unknown', why: 'denied' });
    expect(W.tlsState(ing(true, false), host, [])).toEqual({ kind: 'unknown', why: 'secret' });
  });
});

describe('the address to point the name at', () => {
  it('an IP, a hostname, or none yet', () => {
    expect(W.ingressAddress({ metadata: { name: 'x' }, status: { loadBalancer: { ingress: [{ ip: '192.0.2.10' }] } } })).toBe('192.0.2.10');
    expect(W.ingressAddress({ metadata: { name: 'x' }, status: { loadBalancer: { ingress: [{ hostname: 'lb.example.com' }] } } })).toBe('lb.example.com');
    expect(W.ingressAddress({ metadata: { name: 'x' }, status: {} })).toBeNull();
  });
});

describe('web rows', () => {
  const svc: Obj = { metadata: { name: 'web1-cluster', namespace: 'lab', labels: { 'app.kubernetes.io/managed-by': 'hangar', 'hangar.magesgate.com/vm': 'web1' } }, spec: { ports: [{ name: 'http', port: 80, targetPort: 8080 }] } };
  it("lists Hangar's Ingresses for the VM and others that route to its Services", () => {
    const mine = W.ingressManifest({ vm, host: 'a.example.com', className: 'traefik', traefik: true, serviceName: 'web1-cluster', portName: 'http' });
    const theirs: Obj = { metadata: { name: 'legacy', namespace: 'lab' }, spec: { rules: [{ host: 'b.example.com', http: { paths: [{ path: '/app', backend: { service: { name: 'web1-cluster', port: { number: 80 } } } }] } }] } };
    const unrelated: Obj = { metadata: { name: 'other', namespace: 'lab' }, spec: { rules: [{ host: 'c.example.com', http: { paths: [{ path: '/', backend: { service: { name: 'db', port: { number: 5432 } } } }] } }] } };
    const rows = W.webRows([theirs, mine, unrelated], [svc], 'web1');
    expect(rows.map(r => [r.host, r.path, r.managed, r.servicePort, r.guest])).toEqual([
      ['a.example.com', '/', true, 'http', 8080],
      ['b.example.com', '/app', false, 80, 8080],
    ]);
  });
});

describe('the URL test', () => {
  it('an opaque answer: answered', async () => {
    const f = vi.fn<(u: string, init: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 200 }));
    expect(await W.testUrl('https://a.example.com/', { fetch: f as any })).toBe('answered');
    expect(f.mock.calls[0][1]).toMatchObject({ mode: 'no-cors', cache: 'no-store' });
  });
  it('a TypeError: refused (DNS, routing and TLS look the same)', async () => {
    const f = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await W.testUrl('https://a.example.com/', { fetch: f as any })).toBe('refused');
  });
  it('no answer in time: timeout', async () => {
    const f = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    );
    expect(await W.testUrl('https://a.example.com/', { fetch: f as any, timeoutMs: 20 })).toBe('timeout');
  });
  it("the page's security policy refused it: blocked", async () => {
    const f = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await W.testUrl('https://a.example.com/', { fetch: f as any, blocked: () => true })).toBe('blocked');
  });
});
