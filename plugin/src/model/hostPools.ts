/*
 * Local storage host by host. A local datastore (TopoLVM, static local
 * volumes, local-path…) is really one pool per host: what matters is the
 * host that fills up, not the sum. For each host: the thin pool's real size
 * and use (data and metadata, from topolvm-node's metrics), the room
 * TopoLVM still advertises (its overprovisioning limit, from the node
 * annotation or the metric) next to the space physically free, and the
 * disks — with their VMs — that live there.
 */

import { claimLocality } from './placement';
import { DiskRow, PoolSample } from './storage';
import { Obj } from './types';

export type PoolLevel = 'ok' | 'warn' | 'fault';

/** Thin pools: past these, writes stall (data) or the pool goes read-only (metadata). */
export const DATA_WARN = 80;
export const DATA_FAULT = 90;
export const META_WARN = 70;
export const META_FAULT = 85;

export interface HostPool {
  host: string;
  /** Whether Hangar could read this host's pool (TopoLVM metrics). */
  measured: boolean;
  thin: boolean;
  sizeBytes?: number;
  /** Written (thin) or allocated (thick volume group). */
  usedBytes?: number;
  /** 0..100 */
  dataPercent?: number;
  metaPercent?: number;
  physFreeBytes?: number;
  /** What TopoLVM still accepts on this host: its overprovisioning limit on thin pools. */
  advertisedBytes?: number;
  /** Sum of the sizes of the disks on this host. */
  provisionedBytes: number;
  disks: DiskRow[];
  vms: { namespace: string; name: string }[];
  level: PoolLevel;
  /** Why the level is not ok, in plain words. */
  reason?: string;
}

export function poolLevel(dataPercent?: number, metaPercent?: number): { level: PoolLevel; reason?: string } {
  const d = dataPercent ?? 0;
  const m = metaPercent ?? 0;
  if (m >= META_FAULT) return { level: 'fault', reason: `metadata ${Math.round(m)}% full: the pool turns read-only when it fills` };
  if (d >= DATA_FAULT) return { level: 'fault', reason: `${Math.round(d)}% written: guests stall when it fills` };
  if (m >= META_WARN) return { level: 'warn', reason: `metadata ${Math.round(m)}% full` };
  if (d >= DATA_WARN) return { level: 'warn', reason: `${Math.round(d)}% written` };
  return { level: 'ok' };
}

/** TopoLVM's node annotation for a device class (the default class has two spellings). */
export function advertisedFromNode(node: Obj | undefined, deviceClass: string | undefined): number | undefined {
  const a = node?.metadata.annotations ?? {};
  const v = (deviceClass ? a[`capacity.topolvm.io/${deviceClass}`] : undefined) ?? a['capacity.topolvm.io/00default'];
  const n = Number(v);
  return v !== undefined && isFinite(n) ? n : undefined;
}

export interface HostPoolsInput {
  /** The datastore (StorageClass) name. */
  datastore: string;
  /** TopoLVM samples of every host; [] when not TopoLVM or not readable. */
  samples: PoolSample[];
  /** TopoLVM device class of the datastore (undefined: any / the default). */
  deviceClass?: string;
  nodes: Obj[];
  rows: DiskRow[];
  pvIdx: Map<string, Obj>;
  /** Read the TopoLVM node annotation for the advertised room. */
  topolvm?: boolean;
}

/** One entry per host that has a pool sample or a disk of this datastore, sorted by name. */
export function hostPools(i: HostPoolsInput): HostPool[] {
  const byHost = new Map<string, HostPool>();
  const get = (host: string): HostPool => {
    let p = byHost.get(host);
    if (!p) {
      p = { host, measured: false, thin: false, provisionedBytes: 0, disks: [], vms: [], level: 'ok' };
      byHost.set(host, p);
    }
    return p;
  };
  const mine = i.samples.filter(s => !i.deviceClass || s.deviceClass === i.deviceClass);
  for (const s of mine) {
    const p = get(s.node);
    p.measured = true;
    if (s.thinSize !== undefined) {
      p.thin = true;
      p.sizeBytes = (p.sizeBytes ?? 0) + s.thinSize;
      const used = (s.thinSize * (s.thinDataPercent ?? 0)) / 100;
      p.usedBytes = (p.usedBytes ?? 0) + used;
      p.dataPercent = s.thinDataPercent;
      p.metaPercent = s.thinMetaPercent;
      p.physFreeBytes = (p.physFreeBytes ?? 0) + Math.max(0, s.thinSize - used);
      if (s.thinOverprovisionedAvailable !== undefined) p.advertisedBytes = (p.advertisedBytes ?? 0) + s.thinOverprovisionedAvailable;
    } else if (s.vgSize !== undefined) {
      p.sizeBytes = (p.sizeBytes ?? 0) + s.vgSize;
      const used = s.vgSize - (s.vgFree ?? 0);
      p.usedBytes = (p.usedBytes ?? 0) + used;
      p.dataPercent = s.vgSize ? (used / s.vgSize) * 100 : undefined;
      p.physFreeBytes = (p.physFreeBytes ?? 0) + (s.vgFree ?? 0);
      if (s.vgFree !== undefined) p.advertisedBytes = (p.advertisedBytes ?? 0) + s.vgFree;
    }
  }
  for (const r of i.rows) {
    if (r.datastore !== i.datastore || !r.pvc) continue;
    const pv = r.pvc.spec?.volumeName ? i.pvIdx.get(r.pvc.spec.volumeName) : undefined;
    const loc = claimLocality(r.pvc, pv, i.nodes);
    if (loc.kind !== 'local') continue;
    for (const host of loc.hosts) {
      const p = get(host);
      p.disks.push(r);
      p.provisionedBytes += r.sizeBytes;
      for (const u of r.uses) {
        const ns = u.vm.metadata.namespace as string;
        if (!p.vms.some(v => v.namespace === ns && v.name === u.vm.metadata.name)) p.vms.push({ namespace: ns, name: u.vm.metadata.name });
      }
    }
  }
  if (i.topolvm) {
    for (const p of byHost.values()) {
      if (p.advertisedBytes === undefined) p.advertisedBytes = advertisedFromNode(i.nodes.find(n => n.metadata.name === p.host), i.deviceClass);
    }
  }
  for (const p of byHost.values()) {
    const l = poolLevel(p.dataPercent, p.metaPercent);
    p.level = l.level;
    p.reason = l.reason;
    p.vms.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/** The worst level among the hosts (the aggregate hides a full host). */
export function worstLevel(pools: HostPool[]): PoolLevel {
  return pools.some(p => p.level === 'fault') ? 'fault' : pools.some(p => p.level === 'warn') ? 'warn' : 'ok';
}
