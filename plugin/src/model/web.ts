/*
 * Published ports, the web address: an HTTP port of the guest reachable as
 * https://<host>/ through the cluster's ingress. One Ingress per address,
 * in the VM's folder, owned by the VM, whose backend is the VM's ClusterIP
 * Service (model/ports.ts), so the selector and the "VM behind it" state
 * are the same as for the other ways. TLS ends at the ingress: the guest
 * serves plain HTTP. The certificate comes from a cert-manager issuer, or
 * is the ingress's default one (Traefik's own, self-signed). Its state is
 * read from the Ingress and the Certificate, never from a Secret.
 */

import { parseIp } from './podnet';
import { isHangarService, L_MANAGED_BY, L_VM, sha1Hex } from './ports';
import { Obj, VM } from './types';

export const TRAEFIK_CONTROLLER = 'traefik.io/ingress-controller';
export const A_DEFAULT_CLASS = 'ingressclass.kubernetes.io/is-default-class';
export const A_CLUSTER_ISSUER = 'cert-manager.io/cluster-issuer';
export const A_ISSUER = 'cert-manager.io/issuer';
export const A_TRAEFIK_ENTRYPOINTS = 'traefik.ingress.kubernetes.io/router.entrypoints';
export const A_TRAEFIK_TLS = 'traefik.ingress.kubernetes.io/router.tls';
/** Plainly, as the panel says it. */
export const DEFAULT_CERT_WARNING =
  "Browsers will warn that this connection is not private. Traefik's built-in certificate is self-signed and not issued for this name. Ask your cluster admin for a cert-manager issuer to get a trusted certificate.";

/* --------------------------------------------------------- the classes */

export interface IngressClassRow {
  name: string;
  /** Its controller; null when the classes cannot be read. */
  controller: string | null;
  isDefault: boolean;
}

export function ingressClassRows(list: Obj[]): IngressClassRow[] {
  return list
    .map(c => ({ name: c.metadata.name, controller: c.spec?.controller ?? null, isDefault: c.metadata.annotations?.[A_DEFAULT_CLASS] === 'true' }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** The class Hangar writes: the default one, else the only one; null when the user must pick. */
export function pickClass(classes: IngressClassRow[]): string | null {
  return classes.find(c => c.isDefault)?.name ?? (classes.length === 1 ? classes[0].name : null);
}

/**
 * Whether the class is Traefik's, for its annotations. When the classes
 * cannot be read (a role bound per folder), the class named `traefik` (the
 * name k4all's chart gives it) counts as Traefik's: its annotations keep the
 * route on HTTPS only, and other controllers ignore them.
 */
export function isTraefikClass(name: string, classes: IngressClassRow[] | null): boolean {
  const c = classes?.find(x => x.name === name);
  if (c) return c.controller === TRAEFIK_CONTROLLER;
  return classes === null && name === 'traefik';
}

/* ------------------------------------------------------------ the host */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The hostnames other Ingresses use (every rule and TLS host), except one Ingress. */
export function usedHosts(ingresses: Obj[], except?: { namespace?: string; name: string }): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of ingresses) {
    if (except && i.metadata.namespace === except.namespace && i.metadata.name === except.name) continue;
    const who = `${i.metadata.namespace}/${i.metadata.name}`;
    for (const r of i.spec?.rules ?? []) if (r.host) out.set(String(r.host).toLowerCase(), who);
    for (const t of i.spec?.tls ?? []) for (const h of t.hosts ?? []) out.set(String(h).toLowerCase(), who);
  }
  return out;
}

/** Why a hostname cannot be the web address: not a DNS-1123 subdomain, a wildcard, or used by another Ingress. */
export function hostProblem(host: string, ingresses: Obj[]): string | null {
  const h = host.trim();
  if (!h) return 'Type the name the VM answers on, such as web1.example.com';
  if (h.includes('*')) return 'A wildcard name serves many hosts: type one name';
  if (h !== h.toLowerCase()) return 'Use lowercase letters';
  if (h.length > 253) return 'At most 253 characters';
  const labels = h.split('.');
  if (labels.some(l => !l.length)) return 'Two dots in a row, or a dot at either end';
  if (labels.some(l => l.length > 63)) return 'Each part between dots has at most 63 characters';
  if (labels.some(l => !LABEL.test(l))) return 'Letters, digits and "-" between dots; no "-" at either end of a part';
  if (parseIp(h) !== null) return 'An address is not a name: an ingress routes by name (try the suggested nip.io name)';
  const taken = usedHosts(ingresses).get(h);
  return taken ? `${h} is used by the Ingress ${taken}` : null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/** `<vm>-<namespace>.<ingress IPv4>.nip.io`, which public wildcard DNS resolves to that address by itself. */
export function suggestHost(vmName: string, namespace: string, ingressIp: string | null): string {
  const first = slug(`${vmName}-${namespace}`).slice(0, 63).replace(/-$/, '');
  return ingressIp && parseIp(ingressIp) !== null ? `${first}.${ingressIp}.nip.io` : '';
}

/** The ingress's own IPv4 address: what its controller wrote into Ingresses of that class, else its Service's address. */
export function ingressIpv4(ingresses: Obj[], className: string | null, services: Obj[] = []): string | null {
  const ips = (o: Obj) => ((o.status?.loadBalancer?.ingress ?? []) as any[]).map(x => x.ip).filter((ip: string) => ip && parseIp(ip) !== null) as string[];
  for (const i of ingresses) if (!className || i.spec?.ingressClassName === className) if (ips(i)[0]) return ips(i)[0];
  for (const s of services) {
    if (s.metadata.labels?.['app.kubernetes.io/name'] !== 'traefik') continue;
    const ip = ips(s)[0] ?? ((s.spec?.externalIPs ?? []) as string[]).find(x => parseIp(x) !== null);
    if (ip) return ip;
  }
  return null;
}

/* ----------------------------------------------------------- the Ingress */

/** `<vm>-web-<hash5 of the host>`, a DNS-1123 name of at most 63 characters. */
export function ingressName(vmName: string, host: string): string {
  const suffix = `-web-${sha1Hex(host.trim().toLowerCase()).slice(0, 5)}`;
  return `${slug(vmName).slice(0, 63 - suffix.length).replace(/-$/, '')}${suffix}`;
}

export interface IssuerRef {
  kind: 'ClusterIssuer' | 'Issuer';
  name: string;
}

export interface IngressInput {
  vm: VM;
  host: string;
  className: string;
  /** The class's controller is Traefik's: route on websecure (443) only, with TLS. */
  traefik: boolean;
  issuer?: IssuerRef;
  /** The VM's ClusterIP Service and its port's name. */
  serviceName: string;
  portName: string;
}

export function ingressManifest(i: IngressInput): Obj {
  const host = i.host.trim().toLowerCase();
  const name = ingressName(i.vm.metadata.name, host);
  const annotations: Record<string, string> = {};
  if (i.traefik) {
    annotations[A_TRAEFIK_ENTRYPOINTS] = 'websecure';
    annotations[A_TRAEFIK_TLS] = 'true';
  }
  if (i.issuer) annotations[i.issuer.kind === 'ClusterIssuer' ? A_CLUSTER_ISSUER : A_ISSUER] = i.issuer.name;
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name,
      namespace: i.vm.metadata.namespace,
      labels: { [L_MANAGED_BY]: 'hangar', [L_VM]: i.vm.metadata.name },
      ...(Object.keys(annotations).length ? { annotations } : {}),
      ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: i.vm.metadata.name, uid: i.vm.metadata.uid, controller: true, blockOwnerDeletion: false }],
    },
    spec: {
      ingressClassName: i.className,
      ...(i.issuer ? { tls: [{ hosts: [host], secretName: `${name}-tls` }] } : {}),
      rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: i.serviceName, port: { name: i.portName } } } }] } }],
    },
  };
}

/** Why the guest port cannot get a web address (TLS ends at the ingress; the guest must serve plain HTTP). */
export function webPortProblem(port: number | undefined, protocol: string | undefined): string | null {
  if (protocol && protocol !== 'TCP') return 'A web address carries HTTP, over TCP';
  if (port === 443) return 'The guest serves HTTPS here: the ingress talks plain HTTP to the guest. Publish it on its own address or a host port instead';
  return null;
}

/* ----------------------------------------------------------- the issuers */

export interface IssuerRow extends IssuerRef {
  /** Ready condition; null when unknown. */
  ready: boolean | null;
  why?: string;
  acme: boolean;
  /** An ACME issuer that solves with HTTP-01. */
  http01: boolean;
}

export type Listed = Obj[] | 'denied' | 'missing';

export interface IssuerList {
  rows: IssuerRow[];
  /** cert-manager is not served on this cluster. */
  noCertManager: boolean;
  /** ClusterIssuers could not be listed (a role bound per folder). */
  clusterDenied: boolean;
}

function issuerRow(kind: IssuerRef['kind'], o: Obj): IssuerRow {
  const ready = ((o.status?.conditions ?? []) as any[]).find(c => c.type === 'Ready');
  const acme = !!o.spec?.acme;
  return {
    kind,
    name: o.metadata.name,
    ready: ready ? ready.status === 'True' : null,
    why: ready && ready.status !== 'True' ? ready.message || ready.reason : undefined,
    acme,
    http01: acme && ((o.spec.acme.solvers ?? []) as any[]).some(s => s.http01),
  };
}

/** The ClusterIssuers and the folder's Issuers, with their Ready condition. */
export function issuerList(clusterIssuers: Listed, issuers: Listed): IssuerList {
  const noCertManager = clusterIssuers === 'missing' && issuers === 'missing';
  const rows = [
    ...(Array.isArray(clusterIssuers) ? clusterIssuers.map(o => issuerRow('ClusterIssuer', o)) : []),
    ...(Array.isArray(issuers) ? issuers.map(o => issuerRow('Issuer', o)) : []),
  ].sort((a, b) => Number(b.ready === true) - Number(a.ready === true) || a.name.localeCompare(b.name));
  return { rows, noCertManager, clusterDenied: clusterIssuers === 'denied' };
}

const PRIVATE = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
] as const;

/** The IPv4 address a nip.io / sslip.io name resolves to. */
export function wildcardDnsIp(host: string): string | null {
  const m = host.toLowerCase().match(/(?:^|[.-])(\d{1,3}(?:[.-]\d{1,3}){3})\.(?:nip\.io|sslip\.io)$/);
  if (!m) return null;
  const ip = m[1].replace(/-/g, '.');
  return parseIp(ip) !== null ? ip : null;
}

export function isPrivateIpv4(ip: string): boolean {
  const n = parseIp(ip);
  if (n === null) return false;
  return PRIVATE.some(([base, bits]) => {
    const b = parseIp(base)!;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/** An ACME issuer cannot check a name that points at a private address over HTTP-01: say so before the user picks it. */
export function acmeProblem(issuer: IssuerRow | undefined, host: string): string | null {
  if (!issuer?.acme) return null;
  const ip = wildcardDnsIp(host);
  if (ip && isPrivateIpv4(ip) && issuer.http01)
    return `${issuer.name} is an ACME issuer checking over HTTP-01: the ACME server cannot reach ${ip}, a private address, so the certificate is never issued. Use another issuer or a public name.`;
  return null;
}

/* ------------------------------------------------------- the TLS state */

export type TlsState =
  | { kind: 'default' }
  | { kind: 'requesting'; message?: string }
  | { kind: 'valid'; notAfter?: string; renewalTime?: string; renewing: boolean }
  | { kind: 'failed'; message: string }
  /** denied: the role cannot read Certificates; secret: a certificate from a Secret made elsewhere (Hangar reads no Secret). */
  | { kind: 'unknown'; why: 'denied' | 'secret' };

export function issuerOf(ing: Obj): IssuerRef | null {
  const a = ing.metadata.annotations ?? {};
  if (a[A_CLUSTER_ISSUER]) return { kind: 'ClusterIssuer', name: a[A_CLUSTER_ISSUER] };
  if (a[A_ISSUER]) return { kind: 'Issuer', name: a[A_ISSUER] };
  return null;
}

/**
 * The TLS state of a web address, from the Ingress (its `spec.tls` and
 * issuer annotation say which mode it is) and, with an issuer, from the
 * Certificate cert-manager names after `secretName`. Never from a Secret.
 */
export function tlsState(ing: Obj, host: string, certs: Obj[] | 'denied'): TlsState {
  const tls = ((ing.spec?.tls ?? []) as any[]).find(t => !t.hosts?.length || t.hosts.includes(host));
  if (!tls?.secretName) return { kind: 'default' };
  if (certs === 'denied') return { kind: 'unknown', why: 'denied' };
  const here = certs.filter(c => c.metadata.namespace === ing.metadata.namespace);
  const cert = here.find(c => c.spec?.secretName === tls.secretName) ?? here.find(c => c.metadata.name === tls.secretName);
  if (!cert) return issuerOf(ing) ? { kind: 'requesting', message: 'cert-manager has not made the Certificate yet' } : { kind: 'unknown', why: 'secret' };
  const conds = (cert.status?.conditions ?? []) as any[];
  const ready = conds.find(c => c.type === 'Ready');
  const issuing = conds.find(c => c.type === 'Issuing');
  if (ready?.status === 'True') return { kind: 'valid', notAfter: cert.status?.notAfter, renewalTime: cert.status?.renewalTime, renewing: issuing?.status === 'True' };
  if (issuing?.status === 'True') return { kind: 'requesting', message: issuing.message };
  if ((issuing?.status === 'False' && issuing.reason === 'Failed') || cert.status?.lastFailureTime)
    return { kind: 'failed', message: issuing?.message || ready?.message || 'cert-manager could not issue it' };
  return { kind: 'requesting', message: ready?.message };
}

/** The address the DNS name must point to: what the ingress controller wrote into the Ingress; null before it has. */
export function ingressAddress(ing: Obj): string | null {
  const i = ((ing.status?.loadBalancer?.ingress ?? []) as any[])[0];
  return i?.ip || i?.hostname || null;
}

/* ------------------------------------------------------------ the rows */

export interface WebRow {
  key: string;
  ingress: Obj;
  host: string;
  path: string;
  /** Hangar made the Ingress for this VM (others are read-only). */
  managed: boolean;
  serviceName: string;
  /** The Service port (name or number). */
  servicePort: string | number;
  /** The guest's port, through the Service; undefined when the port is not found. */
  guest?: number | string;
  service?: Obj;
}

/** The VM's web addresses: Hangar's Ingresses for it, and others whose backend is one of its Services. */
export function webRows(ingresses: Obj[], vmServices: Obj[], vmName: string): WebRow[] {
  const rows: WebRow[] = [];
  for (const ing of ingresses) {
    const mine = ing.metadata.labels?.[L_MANAGED_BY] === 'hangar' && ing.metadata.labels?.[L_VM] === vmName;
    for (const rule of ing.spec?.rules ?? []) {
      for (const p of rule.http?.paths ?? []) {
        const b = p.backend?.service;
        if (!b?.name) continue;
        const svc = vmServices.find(s => s.metadata.namespace === ing.metadata.namespace && s.metadata.name === b.name);
        if (!mine && !svc) continue;
        const servicePort = b.port?.name ?? b.port?.number;
        const sp = ((svc?.spec?.ports ?? []) as any[]).find(x => (b.port?.name ? x.name === b.port.name : x.port === b.port?.number));
        rows.push({
          key: `${ing.metadata.namespace}/${ing.metadata.name}/${rule.host ?? '*'}${p.path ?? '/'}`,
          ingress: ing,
          host: rule.host ?? '',
          path: p.path ?? '/',
          managed: mine && (!svc || isHangarService(svc, vmName)),
          serviceName: b.name,
          servicePort,
          guest: sp ? sp.targetPort ?? sp.port : undefined,
          service: svc,
        });
      }
    }
  }
  return rows.sort((a, b) => a.host.localeCompare(b.host));
}

/* -------------------------------------------------------- the URL test */

export type UrlTest = 'answered' | 'refused' | 'timeout' | 'blocked';

/**
 * One no-cors fetch of the address, with a timeout. "answered": this
 * browser resolved the name and something answered HTTPS with a certificate
 * it trusts; not that the name points at this ingress, nor that the guest
 * serves the right page. "refused" (a TypeError) cannot tell DNS, routing
 * and TLS apart; with the default certificate it never passes. "blocked":
 * the page's Content-Security-Policy refused the request.
 */
export async function testUrl(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number; blocked?: () => boolean } = {}): Promise<UrlTest> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? 5000);
  try {
    await f(url, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal, credentials: 'omit', redirect: 'follow' });
    return 'answered';
  } catch {
    if (opts.blocked) {
      // A security policy violation is reported as a task of its own: give it a turn.
      await new Promise(r => setTimeout(r, 0));
      if (opts.blocked()) return 'blocked';
    }
    return timedOut ? 'timeout' : 'refused';
  } finally {
    clearTimeout(timer);
  }
}

export const URL_TEST_TEXT: Record<UrlTest, string> = {
  answered:
    'This browser reached the name and something answered over HTTPS with a certificate it trusts. That does not prove the name points at this ingress, nor that the guest serves the right page.',
  refused: 'The browser refused the certificate or could not reach the name: open the link to see which.',
  timeout: 'No answer within 5 seconds: the browser could not reach the name, or the guest is slow. Open the link to see.',
  blocked: "Headlamp's security policy does not let the page test the address: open the link instead.",
};
