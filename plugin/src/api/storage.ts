/*
 * Disk operations (expand, delete) and the thin-pool reading of TopoLVM:
 * its node annotations report overprovisioned capacity, so Hangar reads
 * the real pool size and usage from topolvm-node's metrics when the user
 * may (pods/proxy), and says so when it may not.
 */

import React from 'react';
import { sizeQuantity } from '../model/library';
import { DiskRow, parseTopolvmMetrics, PoolSample } from '../model/storage';
import { TaskTarget } from '../model/tasks';
import { Obj } from '../model/types';
import { formatBytes } from '../model/units';
import { runTask } from './actions';
import { kdelete, kmerge, kreq } from './client';
import { PATHS } from './resources';
import { SPATHS } from './storageResources';

function diskTarget(row: DiskRow): TaskTarget {
  const vm = row.uses[0]?.vm;
  if (vm) return { kind: 'vm', namespace: vm.metadata.namespace, name: vm.metadata.name };
  if (row.kind === 'image') return { kind: 'image', namespace: row.namespace, name: row.name };
  return { kind: 'datastore', namespace: row.namespace, name: row.name };
}

/** Grows a disk: the claim's request. The guest still has to grow its partitions. */
export function expandDisk(row: DiskRow, bytes: number) {
  return runTask({ title: `Expand disk ${row.name} to ${formatBytes(bytes)}`, target: diskTarget(row) }, () =>
    kmerge(PATHS.pvc(row.namespace, row.name), { spec: { resources: { requests: { storage: sizeQuantity(bytes) } } } })
  );
}

/** Deletes a disk: its DataVolume when it has one (the claim goes with it), else the claim. */
export function deleteDisk(row: DiskRow) {
  return runTask({ title: `Delete disk ${row.name}`, target: diskTarget(row) }, async () => {
    if (row.dv) await kdelete(PATHS.dv(row.namespace, row.name));
    if (row.pvc && (!row.dv || !(row.pvc.metadata.ownerReferences ?? []).some(o => o.kind === 'DataVolume')))
      await kdelete(PATHS.pvc(row.namespace, row.name)).catch((e: any) => {
        if (e?.status !== 404) throw e;
      });
  });
}

export interface PoolReading {
  samples: PoolSample[];
  /** Why the real pool size is not known (no permission, no metrics). */
  unavailable?: string;
  loaded: boolean;
}

let cache: { at: number; value: PoolReading } | null = null;

async function readPools(): Promise<PoolReading> {
  let pods: Obj[];
  try {
    const list = await kreq<{ items: Obj[] }>(SPATHS.pods(), {
      query: { labelSelector: 'app.kubernetes.io/name=topolvm,app.kubernetes.io/component=node' },
    });
    pods = (list.items ?? []).filter(p => p.status?.phase === 'Running');
  } catch (e: any) {
    return { samples: [], loaded: true, unavailable: e?.status === 403 ? 'You may not list the TopoLVM pods.' : 'The TopoLVM pods cannot be listed.' };
  }
  if (!pods.length) return { samples: [], loaded: true, unavailable: 'No TopoLVM node pod is running.' };
  const samples: PoolSample[] = [];
  let denied = false;
  await Promise.all(
    pods.map(async p => {
      const port =
        (p.spec?.containers ?? []).flatMap((c: any) => c.ports ?? []).find((x: any) => x.name === 'metrics')?.containerPort ?? 8080;
      try {
        const res = await kreq<Response>(SPATHS.podProxy(p.metadata.namespace as string, p.metadata.name, port, 'metrics'), { json: false });
        samples.push(...parseTopolvmMetrics(await res.text()));
      } catch (e: any) {
        if (e?.status === 403) denied = true;
      }
    })
  );
  if (!samples.length)
    return {
      samples,
      loaded: true,
      unavailable: denied ? 'You may not read the TopoLVM metrics (pods/proxy).' : 'TopoLVM does not report its pools.',
    };
  return { samples, loaded: true };
}

/** TopoLVM pools, refreshed every minute while a view needs them. */
export function useTopolvmPools(enabled: boolean): PoolReading {
  const [v, setV] = React.useState<PoolReading>(() => cache?.value ?? { samples: [], loaded: false });
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = async () => {
      if (cache && Date.now() - cache.at < 30000) {
        setV(cache.value);
        return;
      }
      const r = await readPools();
      cache = { at: Date.now(), value: r };
      if (alive) setV(r);
    };
    run();
    const id = window.setInterval(run, 60000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [enabled]);
  return v;
}
