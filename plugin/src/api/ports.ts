/*
 * Published ports, live: the Services, EndpointSlices and Service Events of
 * a folder (or of every folder for the datacenter view), the LoadBalancer
 * address pools (MetalLB IPAddressPools, Cilium CiliumLoadBalancerIPPools)
 * and who announces each address; and the writes (publish, unpublish),
 * each a task. Polled while a view shows them, not watched: browsers cap
 * WebSockets per host.
 */

import React from 'react';
import {
  CILIUM_L2_CLASS,
  CILIUM_SATISFIED,
  conflictOf,
  isHangarService,
  L_VM,
  LbChoice,
  mergedPorts,
  Mode,
  modeInfo,
  modeOfService,
  PortRow,
  PortSpec,
  serviceManifest,
  serviceName,
  ServicePortIn,
  VmSelector,
  withListedPorts,
  withTemplateLabel,
} from '../model/ports';
import { Obj, VM } from '../model/types';
import { runTask, updateVm } from './actions';
import { currentCluster, kdelete, kmerge, kpost, kreq } from './client';
import { PATHS } from './resources';

const ns = (n: string) => encodeURIComponent(n);
export const SVC_PATH = (namespace?: string, name = '') =>
  `/api/v1${namespace ? `/namespaces/${ns(namespace)}` : ''}/services${name ? '/' + encodeURIComponent(name) : ''}`;
const SLICES = (namespace?: string) => `/apis/discovery.k8s.io/v1${namespace ? `/namespaces/${ns(namespace)}` : ''}/endpointslices`;
const EVENTS = (namespace: string) => `/api/v1/namespaces/${ns(namespace)}/events`;
const METALLB_POOLS = '/apis/metallb.io/v1beta1/ipaddresspools';
const METALLB_L2 = '/apis/metallb.io/v1beta1/namespaces/metallb-system/servicel2statuses';
const CILIUM_POOLS = ['/apis/cilium.io/v2/ciliumloadbalancerippools', '/apis/cilium.io/v2alpha1/ciliumloadbalancerippools'];
/** Cilium's L2 announcement lease of a Service (pkg/l2announcer/l2announcer.go, v1.20: "cilium-l2announce-<ns>.<svc>" in Cilium's namespace). */
export const ciliumLease = (namespace: string, svc: string) => `/apis/coordination.k8s.io/v1/namespaces/kube-system/leases/cilium-l2announce-${namespace}.${svc}`;

type Status = number | undefined;
const statusOf = (e: any): Status => e?.status;

async function list(path: string, query?: Record<string, string>): Promise<{ items: Obj[]; status?: number }> {
  try {
    const r = await kreq<{ items?: Obj[] }>(path, query ? { query } : {});
    return { items: r.items ?? [] };
  } catch (e) {
    return { items: [], status: statusOf(e) ?? 500 };
  }
}

export interface PortsWorld {
  loaded: boolean;
  services: Obj[];
  slices: Obj[];
  events: Obj[];
  /** Service key "ns/name" → the host that announces its LoadBalancer address. */
  announcers: Map<string, string>;
  /** What could not be read: services, slices, events, announcers (403: the role). */
  denied: { services: boolean; slices: boolean; events: boolean; announcers: boolean };
  refresh: () => void;
}

const EMPTY: Omit<PortsWorld, 'refresh'> = {
  loaded: false,
  services: [],
  slices: [],
  events: [],
  announcers: new Map(),
  denied: { services: false, slices: false, events: false, announcers: false },
};

/** Who answers for each LoadBalancer address: MetalLB's ServiceL2Status, Cilium's L2 lease. */
async function readAnnouncers(services: Obj[]): Promise<{ map: Map<string, string>; denied: boolean }> {
  const map = new Map<string, string>();
  let denied = false;
  const lbs = services.filter(s => modeOfService(s) === 'address' && (s.status?.loadBalancer?.ingress ?? []).length);
  if (!lbs.length) return { map, denied };
  const cilium = (s: Obj) => s.spec?.loadBalancerClass === CILIUM_L2_CLASS || (s.status?.conditions ?? []).some((c: any) => c.type === CILIUM_SATISFIED);
  if (lbs.some(s => !cilium(s))) {
    const l2 = await list(METALLB_L2);
    if (l2.status === 403) denied = true;
    for (const st of l2.items) {
      const sn = st.status?.serviceNamespace;
      const name = st.status?.serviceName;
      if (sn && name && st.status?.node) map.set(`${sn}/${name}`, st.status.node);
    }
  }
  await Promise.all(
    lbs.filter(cilium).map(async s => {
      try {
        const lease = await kreq<Obj>(ciliumLease(s.metadata.namespace as string, s.metadata.name));
        if (lease.spec?.holderIdentity) map.set(`${s.metadata.namespace}/${s.metadata.name}`, lease.spec.holderIdentity);
      } catch (e) {
        if (statusOf(e) === 403) denied = true;
      }
    })
  );
  return { map, denied };
}

/**
 * The published-port objects of one folder, or of every folder when
 * `namespace` is null (falling back to the given folders one by one when
 * the role cannot list cluster-wide). Polled every `intervalMs`.
 */
export function usePortsData(namespace: string | null, opts: { intervalMs?: number; folders?: string[]; events?: boolean } = {}): PortsWorld {
  const { intervalMs = 5000, folders = [], events = true } = opts;
  const [world, setWorld] = React.useState<Omit<PortsWorld, 'refresh'>>(EMPTY);
  const [tick, setTick] = React.useState(0);
  const refresh = React.useCallback(() => setTick(t => t + 1), []);
  const cluster = currentCluster();
  const foldersSig = folders.join(',');
  React.useEffect(() => {
    let alive = true;
    const read = async () => {
      const many = async (path: (n?: string) => string) => {
        if (namespace) return list(path(namespace));
        const all = await list(path());
        if (all.status !== 403 || !folders.length) return all;
        const parts = await Promise.all(folders.map(f => list(path(f))));
        return { items: parts.flatMap(p => p.items), status: parts.every(p => p.status === 403) ? 403 : undefined };
      };
      const [svcs, slices, evs] = await Promise.all([
        many(SVC_PATH),
        many(SLICES),
        namespace && events ? list(EVENTS(namespace), { fieldSelector: 'involvedObject.kind=Service' }) : Promise.resolve({ items: [] as Obj[], status: undefined }),
      ]);
      const ann = await readAnnouncers(svcs.items);
      if (!alive) return;
      setWorld({
        loaded: true,
        services: svcs.items,
        slices: slices.items,
        events: evs.items,
        announcers: ann.map,
        denied: { services: svcs.status === 403, slices: slices.status === 403, events: evs.status === 403, announcers: ann.denied },
      });
    };
    read();
    const id = window.setInterval(read, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, intervalMs, cluster, tick, foldersSig, events]);
  return React.useMemo(() => ({ ...world, refresh }), [world, refresh]);
}

export interface PoolsWorld {
  loaded: boolean;
  /** The API is served (the controller is installed). */
  metallb: { served: boolean; denied: boolean; items: Obj[] };
  cilium: { served: boolean; denied: boolean; items: Obj[] };
}

const NO_POOLS: PoolsWorld = { loaded: false, metallb: { served: false, denied: false, items: [] }, cilium: { served: false, denied: false, items: [] } };

async function readPools(): Promise<PoolsWorld> {
  const one = async (paths: string[]) => {
    for (const p of paths) {
      const r = await list(p);
      if (r.status === 404) continue;
      return { served: true, denied: r.status === 403, items: r.items };
    }
    return { served: false, denied: false, items: [] as Obj[] };
  };
  const [metallb, cilium] = await Promise.all([one([METALLB_POOLS]), one(CILIUM_POOLS)]);
  return { loaded: true, metallb, cilium };
}

/** The LoadBalancer address pools, re-read every 30 s (and on refresh). */
export function usePools(intervalMs = 30000): PoolsWorld & { refresh: () => void } {
  const [w, setW] = React.useState<PoolsWorld>(NO_POOLS);
  const [tick, setTick] = React.useState(0);
  const cluster = currentCluster();
  React.useEffect(() => {
    let alive = true;
    const read = () => readPools().then(r => alive && setW(r));
    read();
    const id = window.setInterval(read, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [intervalMs, cluster, tick]);
  const refresh = React.useCallback(() => setTick(t => t + 1), []);
  return React.useMemo(() => ({ ...w, refresh }), [w, refresh]);
}

/** Every Service of the cluster the user may list (for a free host port), else the folder's. */
export async function servicesForNodePorts(namespace: string): Promise<{ items: Obj[]; scope: 'cluster' | 'folder' }> {
  const all = await list(SVC_PATH());
  if (!all.status) return { items: all.items, scope: 'cluster' };
  return { items: (await list(SVC_PATH(namespace))).items, scope: 'folder' };
}

/* --------------------------------------------------------------- writes */

export interface PublishRequest {
  vm: VM;
  mode: Mode;
  ports: ServicePortIn[];
  selector: VmSelector;
  lb?: LbChoice;
  keepSourceIp?: boolean;
  /** Guest ports the adapter's list must forward (it forwards only listed ports). */
  listAdd?: { nic: string; ports: PortSpec[] };
  /** Before KubeVirt v1.7: Hangar's template label, which reaches the pod at the next start. */
  templateLabel?: boolean;
  /** For the task's title. */
  what: string;
}

export interface PublishResult {
  service: Obj;
  /** The VM was changed (port list, label): it applies at the next restart. */
  vmChanged: boolean;
}

const vmTarget = (vm: VM) => ({ kind: 'vm' as const, namespace: vm.metadata.namespace, name: vm.metadata.name });

/**
 * Publishes ports: creates the VM's Service for that way of publishing, or
 * adds the ports to it (with its resourceVersion, so a concurrent change is
 * refused), then, when the adapter forwards only listed ports, adds them to
 * the list. Each step is a task.
 */
export async function publishPorts(req: PublishRequest): Promise<PublishResult> {
  const namespace = req.vm.metadata.namespace as string;
  const name = serviceName(req.vm.metadata.name, req.mode);
  const service = await runTask({ title: `Publish ${req.what} ${modeInfo(req.mode).label.toLowerCase()}`, target: vmTarget(req.vm) }, async () => {
    let current: Obj | null = null;
    try {
      current = await kreq<Obj>(SVC_PATH(namespace, name));
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
    }
    if (!current) {
      return kpost<Obj>(SVC_PATH(namespace), serviceManifest({ vm: req.vm, mode: req.mode, ports: req.ports, selector: req.selector.selector, lb: req.lb, keepSourceIp: req.keepSourceIp }));
    }
    const why = conflictOf(req.ports, req.mode, [current], req.vm.metadata.name);
    if (why) throw new Error(why);
    const spec: any = { ports: mergedPorts(current, req.ports, req.mode) };
    if (req.mode !== 'cluster' && req.keepSourceIp !== undefined) {
      const want = req.keepSourceIp ? 'Local' : 'Cluster';
      if ((current.spec?.externalTrafficPolicy ?? 'Cluster') !== want) spec.externalTrafficPolicy = want;
    }
    return kmerge<Obj>(SVC_PATH(namespace, name), { metadata: { resourceVersion: current.metadata.resourceVersion }, spec });
  });
  let vmChanged = false;
  if (req.listAdd?.ports.length || req.templateLabel) {
    // The VM as it is now: the PUT carries its resourceVersion.
    const fresh = await kreq<VM>(PATHS.vm(namespace, req.vm.metadata.name));
    let next = fresh;
    if (req.listAdd?.ports.length) next = withListedPorts(next, req.listAdd.nic, req.listAdd.ports);
    if (req.templateLabel) next = withTemplateLabel(next);
    await updateVm(fresh, req.listAdd?.ports.length ? "Forward the published ports to the guest (adapter's port list)" : 'Label the VM for its published ports', next);
    vmChanged = true;
  }
  return { service, vmChanged };
}

/** Adds guest ports to the adapter's list (a port published elsewhere that the guest does not get). */
export async function forwardToGuest(vm: VM, nic: string, ports: PortSpec[]): Promise<void> {
  const fresh = await kreq<VM>(PATHS.vm(vm.metadata.namespace as string, vm.metadata.name));
  await updateVm(fresh, "Forward a published port to the guest (adapter's port list)", withListedPorts(fresh, nic, ports));
}

/** Unpublishes one port: removes it from the Service, or deletes the Service with its last port. */
export async function unpublishPort(row: PortRow, vm: VM): Promise<void> {
  const namespace = row.service.metadata.namespace as string;
  const name = row.service.metadata.name;
  await runTask({ title: `Unpublish ${row.name ?? row.port} (${row.port}/${row.protocol})`, target: vmTarget(vm) }, async () => {
    let current: Obj;
    try {
      current = await kreq<Obj>(SVC_PATH(namespace, name));
    } catch (e) {
      if (statusOf(e) === 404) return;
      throw e;
    }
    if (!isHangarService(current, current.metadata.labels?.[L_VM])) throw new Error(`${name} was not made by Hangar: change it where it was made`);
    const ports = (current.spec?.ports ?? []).filter((p: any) => !(p.port === row.port && (p.protocol ?? 'TCP').toUpperCase() === row.protocol));
    if (!ports.length) {
      await kdelete(SVC_PATH(namespace, name)).catch(e => (statusOf(e) === 404 ? undefined : Promise.reject(e)));
      return;
    }
    await kmerge(SVC_PATH(namespace, name), { metadata: { resourceVersion: current.metadata.resourceVersion }, spec: { ports } });
  });
}
