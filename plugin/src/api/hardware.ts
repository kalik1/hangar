/*
 * Host hardware: the node agent's inventories (read through pods/proxy,
 * like TopoLVM's metrics), the agent's desired state (ConfigMap
 * hangar-system/hangar-passthrough), KubeVirt's device mappings, and the
 * operations that move a device between the host and VMs.
 *
 * KubeVirt's device plugin lists a host's devices when it starts, so after
 * a device changes sides Hangar restarts KubeVirt's agent on that host
 * (virt-handler; running VMs are not affected). New mappings need no
 * restart: changing the KubeVirt CR makes every host look again.
 */

import React from 'react';
import * as E from '../model/edit';
import {
  addMapping,
  enablePassthrough,
  HostDisk,
  hostDiskClaim,
  Inventory,
  Mapping,
  NewMapping,
  parseInventory,
  PciDevice,
  removeMapping,
  renameMapping,
} from '../model/hardware';
import { tasks, TaskTarget } from '../model/tasks';
import { Obj, VM } from '../model/types';
import { updateVm } from './actions';
import { errorText, kdelete, kmerge, kpost, kreq } from './client';
import { keepWritten } from './kubevirtCopy';
import { PATHS } from './resources';

export { useKubevirt } from './kubevirtCopy';

export const AGENT_NS = 'hangar-system';
export const AGENT_SELECTOR = 'app.kubernetes.io/name=hangar-node-agent';
export const DESIRED_CM = 'hangar-passthrough';
const PORT = 8095;

const P = {
  pods: (ns: string, q?: string) => `/api/v1/namespaces/${ns}/pods${q ?? ''}`,
  pod: (ns: string, name: string) => `/api/v1/namespaces/${ns}/pods/${name}`,
  proxy: (pod: string) => `/api/v1/namespaces/${AGENT_NS}/pods/${pod}:${PORT}/proxy/inventory.json`,
  cm: (name = '') => `/api/v1/namespaces/${AGENT_NS}/configmaps${name ? '/' + name : ''}`,
  kubevirt: (ns: string, name: string) => `/apis/kubevirt.io/v1/namespaces/${ns}/kubevirts/${name}`,
  pvs: (name = '') => `/api/v1/persistentvolumes${name ? '/' + name : ''}`,
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------- agent store */

export interface HostReading {
  inv?: Inventory;
  /** Agent pod on that host. */
  pod?: Obj;
  error?: string;
  at: number;
}

export interface AgentsReading {
  loaded: boolean;
  /** The agent is not installed (no namespace, no pods). */
  missing: boolean;
  /** You may not read the inventories (pods/proxy). */
  denied: boolean;
  hosts: Map<string, HostReading>;
}

let state: AgentsReading = { loaded: false, missing: false, denied: false, hosts: new Map() };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
let inflight: Promise<void> | null = null;
let lastFetch = 0;

async function fetchAll(): Promise<void> {
  let pods: Obj[] = [];
  try {
    const list = await kreq<{ items: Obj[] }>(P.pods(AGENT_NS), { query: { labelSelector: AGENT_SELECTOR } });
    pods = (list.items ?? []).filter(p => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp);
  } catch (e: any) {
    state = { loaded: true, missing: e?.status === 404, denied: e?.status === 403, hosts: new Map() };
    emit();
    return;
  }
  const hosts = new Map<string, HostReading>();
  let denied = false;
  await Promise.all(
    pods.map(async p => {
      const node = p.spec?.nodeName as string;
      try {
        const res = await kreq<Response>(P.proxy(p.metadata.name), { json: false });
        hosts.set(node, { inv: parseInventory(await res.text()), pod: p, at: Date.now() });
      } catch (e: any) {
        if (e?.status === 403) denied = true;
        const prev = state.hosts.get(node);
        hosts.set(node, { inv: prev?.inv, pod: p, error: e?.status === 403 ? 'You may not read the host inventory.' : errorText(e), at: Date.now() });
      }
    })
  );
  state = { loaded: true, missing: pods.length === 0 && !denied, denied: denied && hosts.size === 0, hosts };
  lastFetch = Date.now();
  emit();
}

/** Reads every host's inventory now (shared by all views). */
export function refreshInventories(): Promise<void> {
  if (!inflight)
    inflight = fetchAll().finally(() => {
      inflight = null;
    });
  return inflight;
}

/** All hosts' inventories, polled while a view uses them. */
export function useInventories(intervalMs = 20000): AgentsReading {
  const v = React.useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
  React.useEffect(() => {
    if (Date.now() - lastFetch > 5000) refreshInventories();
    const id = window.setInterval(refreshInventories, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return v;
}

/** Waits until `ok(inventory)` holds for a host, re-reading every 3 s. */
async function waitHost(host: string, ok: (inv: Inventory) => boolean, timeoutMs: number): Promise<Inventory> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await fetchAll();
    const inv = state.hosts.get(host)?.inv;
    if (inv && ok(inv)) return inv;
    if (Date.now() > until) throw new Error('The host has not confirmed it yet: check the Hardware tab in a minute');
    await sleep(3000);
  }
}

/* ------------------------------------------------------ desired state */

function parseList(s: string | undefined): string[] {
  return (s ?? '')
    .split(/[\s,]+/)
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Adds or removes PCI addresses in a host's desired list (read, modify, write with resourceVersion). */
async function changeDesired(host: string, add: string[], remove: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let cm: Obj | null = null;
    try {
      cm = await kreq<Obj>(P.cm(DESIRED_CM));
    } catch (e: any) {
      if (e?.status !== 404) throw e;
    }
    const cur = new Set(parseList(cm?.data?.[host]));
    add.forEach(a => cur.add(a.toLowerCase()));
    remove.forEach(a => cur.delete(a.toLowerCase()));
    const value = [...cur].sort().join('\n') + (cur.size ? '\n' : '');
    try {
      if (!cm) {
        await kpost(P.cm(), {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: DESIRED_CM, namespace: AGENT_NS, labels: { 'app.kubernetes.io/part-of': 'hangar' } },
          data: { [host]: value },
        });
      } else {
        await kreq(P.cm(DESIRED_CM), { method: 'PUT', body: { ...cm, data: { ...(cm.data ?? {}), [host]: value } } });
      }
      return;
    } catch (e: any) {
      if (e?.status !== 409 || attempt === 2) throw e;
    }
  }
}

/** Makes the kubelet refresh the agent's ConfigMap now rather than within a minute. */
async function nudgeAgent(host: string) {
  const pod = state.hosts.get(host)?.pod;
  if (!pod) return;
  await kmerge(P.pod(AGENT_NS, pod.metadata.name), { metadata: { annotations: { 'hangar.magesgate.com/nudge': String(Date.now()) } } }).catch(() => undefined);
}

/* ------------------------------------------------------------ KubeVirt */

async function updateKubevirt(kv: Obj, change: (fresh: Obj) => Obj): Promise<Obj> {
  const ns = kv.metadata.namespace as string;
  const name = kv.metadata.name;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await kreq<Obj>(P.kubevirt(ns, name));
    const next = change(fresh);
    try {
      const out = await kreq<Obj>(P.kubevirt(ns, name), { method: 'PUT', body: { ...next, status: undefined } });
      keepWritten(out);
      return out;
    } catch (e: any) {
      if (e?.status !== 409 || attempt === 2) throw e;
    }
  }
  throw new Error('KubeVirt kept changing');
}

/** Restarts KubeVirt's agent (virt-handler) on a host so it lists the host's devices again. */
async function reloadDevicesOn(kv: Obj | null, host: string) {
  const ns = kv?.metadata.namespace ?? 'kubevirt';
  const list = await kreq<{ items: Obj[] }>(P.pods(ns), { query: { labelSelector: 'kubevirt.io=virt-handler', fieldSelector: `spec.nodeName=${host}` } });
  for (const p of list.items ?? []) await kdelete(P.pod(ns, p.metadata.name));
}

/* --------------------------------------------------------------- tasks */

async function track<T>(title: string, target: TaskTarget, fn: (say: (m: string) => void) => Promise<T>): Promise<T> {
  const t = tasks.add({ title, target, timeoutMs: 30 * 60 * 1000 });
  try {
    const out = await fn(m => tasks.update(t.id, { message: m }));
    tasks.update(t.id, { status: 'done', message: undefined });
    return out;
  } catch (e) {
    tasks.update(t.id, { status: 'failed', message: errorText(e) });
    throw e;
  }
}

const hostTarget = (host: string): TaskTarget => ({ kind: 'host', name: host });

/** Asks a host's agent for vfio-pci on these devices and waits until it confirms. */
async function prepareOnHost(host: string, addrs: string[], say: (m: string) => void) {
  say('Asking the host to release the devices');
  await changeDesired(host, addrs, []);
  await nudgeAgent(host);
  say('Waiting for the host to prepare them (vfio-pci)');
  const settled = (inv: Inventory, a: string) => {
    const p = inv.pci.find(x => x.address === a);
    return p?.driver === 'vfio-pci' || p?.binder?.state === 'failed' || p?.binder?.state === 'refused' || p?.binder?.state === 'missing';
  };
  const inv = await waitHost(host, i => addrs.every(a => settled(i, a)), 4 * 60 * 1000);
  const bad = inv.pci.filter(p => addrs.includes(p.address) && p.driver !== 'vfio-pci');
  if (bad.length) throw new Error(bad.map(p => `${p.address}: ${p.binder?.message ?? 'not prepared'}`).join(' '));
}

/**
 * Gives PCI devices of a host to VMs: the agent binds them to vfio-pci,
 * then they join an existing mapping (KubeVirt's agent on the host is
 * restarted to see them) or a new one.
 */
export function givePciToVms(o: { kv: Obj; host: string; devices: PciDevice[]; mapping: Mapping | NewMapping; isNew: boolean; title: string }) {
  const addrs = o.devices.map(d => d.address);
  return track(o.title, hostTarget(o.host), async say => {
    await prepareOnHost(o.host, addrs, say);
    if (o.isNew) {
      say('Adding the device mapping');
      await updateKubevirt(o.kv, fresh => addMapping(fresh, o.mapping as NewMapping));
    } else {
      say("Restarting KubeVirt's agent on the host so it sees them");
      await reloadDevicesOn(o.kv, o.host);
    }
  });
}

/**
 * The same for identical devices on several hosts at once: every host
 * prepares its own in parallel (one task each); then a new mapping is
 * created once, or each host's KubeVirt agent is restarted.
 */
export async function givePciToVmsOnHosts(o: { kv: Obj; groups: { host: string; devices: PciDevice[] }[]; mapping: Mapping | NewMapping; isNew: boolean; label: string }) {
  if (o.groups.length === 1) {
    const g = o.groups[0];
    return givePciToVms({ kv: o.kv, host: g.host, devices: g.devices, mapping: o.mapping, isNew: o.isNew, title: `Give ${o.label} to VMs (${g.devices.map(d => d.address).join(', ')})` });
  }
  const results = await Promise.allSettled(
    o.groups.map(g =>
      track(`Give ${o.label} to VMs (${g.devices.map(d => d.address).join(', ')})`, hostTarget(g.host), async say => {
        await prepareOnHost(g.host, g.devices.map(d => d.address), say);
        if (!o.isNew) {
          say("Restarting KubeVirt's agent on the host so it sees them");
          await reloadDevicesOn(o.kv, g.host);
        }
      })
    )
  );
  if (!results.some(r => r.status === 'fulfilled')) throw new Error('No host prepared its devices');
  if (o.isNew) {
    const m = o.mapping as NewMapping;
    await track(`Create device mapping ${m.label}`, { kind: 'device', name: m.label }, () => updateKubevirt(o.kv, fresh => addMapping(fresh, m)));
  }
}

/** Gives PCI devices back to the host's own drivers. */
export function returnPciToHost(o: { kv: Obj | null; host: string; devices: PciDevice[]; title: string }) {
  const addrs = o.devices.map(d => d.address);
  return track(o.title, hostTarget(o.host), async say => {
    const held = o.devices.find(d => d.usedBy);
    if (held) throw new Error(`${held.address} is in use by ${held.usedBy}: power that VM off first`);
    say('Asking the host to take the devices back');
    await changeDesired(o.host, [], addrs);
    await nudgeAgent(o.host);
    say('Waiting for the host');
    await waitHost(o.host, inv => addrs.every(a => inv.pci.find(p => p.address === a)?.driver !== 'vfio-pci'), 4 * 60 * 1000);
    say("Restarting KubeVirt's agent on the host so it forgets them");
    await reloadDevicesOn(o.kv, o.host);
  });
}

/** Restarts KubeVirt's agent on a host: it lists the host's devices again. */
export function reloadDevices(kv: Obj | null, host: string) {
  return track('Reload devices', hostTarget(host), () => reloadDevicesOn(kv, host));
}

/** A mapping that needs no host preparation: USB devices, vGPU profiles. */
export function createMapping(kv: Obj, m: NewMapping, host?: string) {
  return track(`Create device mapping ${m.label}`, host ? hostTarget(host) : { kind: 'device', name: m.label }, async () => {
    await updateKubevirt(kv, fresh => addMapping(fresh, m));
  });
}

export function deleteMapping(kv: Obj, m: Mapping) {
  return track(`Delete device mapping ${m.label}`, { kind: 'device', name: m.label }, async () => {
    await updateKubevirt(kv, fresh => removeMapping(fresh, m.resourceName));
  });
}

export function relabelMapping(kv: Obj, m: Mapping, label: string, gpu: boolean) {
  return track(`Rename device mapping to ${label}`, { kind: 'device', name: label }, async () => {
    await updateKubevirt(kv, fresh => renameMapping(fresh, m.resourceName, label, gpu));
  });
}

export function turnOnPassthrough(kv: Obj) {
  return track('Turn on device passthrough', { kind: 'device', name: 'KubeVirt' }, async () => {
    await updateKubevirt(kv, fresh => enablePassthrough(fresh));
  });
}

/* ---------------------------------------------------------- host disks */

/** Hangar's host-disk PVs, polled while a view needs them. */
export function useHostDiskVolumes(enabled: boolean): Obj[] {
  const [pvs, setPvs] = React.useState<Obj[]>([]);
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = () =>
      kreq<{ items: Obj[] }>(P.pvs(), { query: { labelSelector: 'hangar.magesgate.com/host-disk=true' } })
        .then(r => alive && setPvs(r.items ?? []))
        .catch(() => undefined);
    run();
    const id = window.setInterval(run, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [enabled]);
  return pvs;
}

/** Gives a whole disk of a host to a VM: a local block volume on that host, a claim in the VM's folder, attached as a disk. */
export function giveDiskToVm(o: { host: string; disk: HostDisk; vm: VM; bus: string }) {
  const ns = o.vm.metadata.namespace as string;
  const claim = `${o.vm.metadata.name}-${o.disk.name}`.slice(0, 63);
  return track(`Give disk ${o.disk.name} of ${o.host} to ${o.vm.metadata.name}`, hostTarget(o.host), async say => {
    const { pv, pvc } = hostDiskClaim(o.host, o.disk, ns, claim);
    say('Creating the volume');
    await kpost(P.pvs(), pv);
    try {
      await kpost(PATHS.pvc(ns), pvc);
    } catch (e) {
      await kdelete(P.pvs(pv.metadata.name)).catch(() => undefined);
      throw e;
    }
    say('Attaching it to the VM');
    const fresh = await kreq<VM>(PATHS.vm(ns, o.vm.metadata.name));
    await updateVm(fresh, `Attach host disk ${o.disk.name}`, E.attachDisk(fresh, claim, o.bus).vm);
  });
}

/** Takes a host disk back: deletes its claim (it must be detached) and its volume. The data stays on the disk. */
export function releaseHostDisk(o: { host: string; pv: Obj }) {
  return track(`Take back disk ${o.pv.metadata.annotations?.['hangar.magesgate.com/disk'] ?? o.pv.metadata.name}`, hostTarget(o.host), async () => {
    const ref = o.pv.spec?.claimRef;
    if (ref?.name) await kdelete(PATHS.pvc(ref.namespace, ref.name)).catch((e: any) => (e?.status === 404 ? undefined : Promise.reject(e)));
    await kdelete(P.pvs(o.pv.metadata.name));
  });
}
