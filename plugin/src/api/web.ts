/*
 * Published ports, the web address: the folder's Ingresses and
 * Certificates, the ingress classes and the cert-manager issuers (polled
 * while a view shows them), and the writes: the VM's ClusterIP Service gets
 * the guest port if it lacks it, then the Ingress. Never a Secret.
 */

import React from 'react';
import { serviceName, ServicePortIn, VmSelector } from '../model/ports';
import { Obj, VM } from '../model/types';
import { IngressClassRow, ingressClassRows, ingressManifest, IssuerRef, Listed, testUrl, UrlTest, WebRow } from '../model/web';
import { runTask } from './actions';
import { currentCluster, kdelete, kpost, kreq } from './client';
import { forwardToGuest, publishPorts, SVC_PATH } from './ports';

const enc = encodeURIComponent;
const ING = (ns?: string, name = '') => `/apis/networking.k8s.io/v1${ns ? `/namespaces/${enc(ns)}` : ''}/ingresses${name ? '/' + enc(name) : ''}`;
const CLASSES = '/apis/networking.k8s.io/v1/ingressclasses';
const CERTS = (ns: string) => `/apis/cert-manager.io/v1/namespaces/${enc(ns)}/certificates`;
const ISSUERS = (ns: string) => `/apis/cert-manager.io/v1/namespaces/${enc(ns)}/issuers`;
const CLUSTER_ISSUERS = '/apis/cert-manager.io/v1/clusterissuers';

async function listed(path: string, query?: Record<string, string>): Promise<Listed> {
  try {
    const r = await kreq<{ items?: Obj[] }>(path, query ? { query } : {});
    return r.items ?? [];
  } catch (e: any) {
    return e?.status === 404 ? 'missing' : e?.status === 403 ? 'denied' : [];
  }
}

const items = (l: Listed): Obj[] => (Array.isArray(l) ? l : []);

export interface WebWorld {
  loaded: boolean;
  /** The folder's Ingresses ('denied' when the role cannot list them). */
  ingresses: Listed;
  certificates: Obj[] | 'denied';
  issuers: Listed;
  clusterIssuers: Listed;
  /** The ingress classes; null when the role cannot list them (cluster-scoped). */
  classes: IngressClassRow[] | null;
  refresh: () => void;
}

const EMPTY: Omit<WebWorld, 'refresh'> = { loaded: false, ingresses: [], certificates: [], issuers: [], clusterIssuers: [], classes: [] };

/** A folder's web addresses and what choosing one needs. Ingresses and Certificates every 10 s, the rest every 60 s. */
export function useWebData(namespace: string, intervalMs = 10000): WebWorld {
  const [w, setW] = React.useState<Omit<WebWorld, 'refresh'>>(EMPTY);
  const [tick, setTick] = React.useState(0);
  const cluster = currentCluster();
  React.useEffect(() => {
    let alive = true;
    let n = 0;
    const read = async () => {
      const slow = n++ % 6 === 0;
      const [ingresses, certs, issuers, clusterIssuers, classes] = await Promise.all([
        listed(ING(namespace)),
        listed(CERTS(namespace)),
        slow ? listed(ISSUERS(namespace)) : Promise.resolve(null),
        slow ? listed(CLUSTER_ISSUERS) : Promise.resolve(null),
        slow ? listed(CLASSES) : Promise.resolve(null),
      ]);
      if (!alive) return;
      setW(prev => ({
        loaded: true,
        ingresses,
        certificates: certs === 'denied' ? 'denied' : items(certs),
        issuers: issuers ?? prev.issuers,
        clusterIssuers: clusterIssuers ?? prev.clusterIssuers,
        classes: classes === null ? prev.classes : classes === 'denied' ? null : ingressClassRows(items(classes)),
      }));
    };
    read();
    const id = window.setInterval(read, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [namespace, intervalMs, cluster, tick]);
  const refresh = React.useCallback(() => setTick(t => t + 1), []);
  return React.useMemo(() => ({ ...w, refresh }), [w, refresh]);
}

/** For choosing a host: every Ingress the user can see (its hosts are taken, its status has the ingress's address) and Traefik's Services. */
export async function webContext(namespace: string): Promise<{ ingresses: Obj[]; services: Obj[] }> {
  let ing = await listed(ING());
  if (!Array.isArray(ing)) ing = await listed(ING(namespace));
  let svcs = await listed(SVC_PATH(), { labelSelector: 'app.kubernetes.io/name=traefik' });
  if (!Array.isArray(svcs)) svcs = [];
  return { ingresses: items(ing), services: svcs };
}

/* --------------------------------------------------------------- writes */

export interface WebRequest {
  vm: VM;
  /** The guest port on the VM's ClusterIP Service (added when missing). */
  port: ServicePortIn;
  selector: VmSelector;
  listAdd?: { nic: string; ports: { port: number; protocol: 'TCP' | 'UDP' }[] };
  templateLabel?: boolean;
  host: string;
  className: string;
  traefik: boolean;
  issuer?: IssuerRef;
  what: string;
}

export interface WebResult {
  ingress: Obj;
  vmChanged: boolean;
}

const vmTarget = (vm: VM) => ({ kind: 'vm' as const, namespace: vm.metadata.namespace, name: vm.metadata.name });

/**
 * Publishes a web address: the VM's ClusterIP Service gets the guest port if
 * it lacks it (and the adapter's list too, as for the other ways), then the
 * Ingress routes the host to it. Each step is a task.
 */
export async function publishWeb(req: WebRequest): Promise<WebResult> {
  const namespace = req.vm.metadata.namespace as string;
  const svcName = serviceName(req.vm.metadata.name, 'cluster');
  let svc: Obj | null = null;
  try {
    svc = await kreq<Obj>(SVC_PATH(namespace, svcName));
  } catch (e: any) {
    if (e?.status !== 404) throw e;
  }
  const have = ((svc?.spec?.ports ?? []) as any[]).find(p => Number(p.targetPort ?? p.port) === req.port.targetPort && (p.protocol ?? 'TCP') === 'TCP' && p.name);
  let portName = have?.name as string | undefined;
  let vmChanged = false;
  if (!portName) {
    const r = await publishPorts({ vm: req.vm, mode: 'cluster', ports: [req.port], selector: req.selector, listAdd: req.listAdd, templateLabel: req.templateLabel, what: req.what });
    vmChanged = r.vmChanged;
    portName = req.port.name;
  } else if (req.listAdd?.ports.length) {
    await forwardToGuest(req.vm, req.listAdd.nic, req.listAdd.ports);
    vmChanged = true;
  }
  const ingress = await runTask({ title: `Publish web address https://${req.host}/`, target: vmTarget(req.vm) }, () =>
    kpost<Obj>(
      ING(namespace),
      ingressManifest({ vm: req.vm, host: req.host, className: req.className, traefik: req.traefik, issuer: req.issuer, serviceName: svcName, portName: portName as string })
    ).catch((e: any) => Promise.reject(e?.status === 409 ? new Error(`An Ingress for ${req.host} already exists in ${namespace}`) : e))
  );
  return { ingress, vmChanged };
}

/** Removes a web address: its Ingress (cert-manager's Certificate goes with it; the TLS Secret stays). The ClusterIP port stays. */
export async function unpublishWeb(row: WebRow, vm: VM): Promise<void> {
  const ns = row.ingress.metadata.namespace as string;
  await runTask({ title: `Unpublish web address https://${row.host}/`, target: vmTarget(vm) }, () =>
    kdelete(ING(ns, row.ingress.metadata.name)).catch((e: any) => (e?.status === 404 ? undefined : Promise.reject(e)))
  );
}

/* ------------------------------------------------------- the URL test */

let cspBlocked = false;

/** The page's security policy refused a test before: the button stays hidden. */
export function urlTestBlocked(): boolean {
  return cspBlocked;
}

/** Runs the one-time URL test, noticing a Content-Security-Policy that refuses it. */
export async function runUrlTest(url: string): Promise<UrlTest> {
  let hit = false;
  const on = (e: Event) => {
    const v = e as SecurityPolicyViolationEvent;
    if ((v.effectiveDirective || v.violatedDirective || '').startsWith('connect-src') || (v.effectiveDirective || '').startsWith('default-src')) hit = true;
  };
  document.addEventListener('securitypolicyviolation', on);
  try {
    const r = await testUrl(url, {
      blocked: () => hit,
    });
    if (r === 'blocked') cspBlocked = true;
    return r;
  } finally {
    document.removeEventListener('securitypolicyviolation', on);
  }
}
