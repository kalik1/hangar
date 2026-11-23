/*
 * Moving VMs and their disks: a powered-off move to another host (cold
 * migration), and moving disks to another datastore, live or powered off.
 * Live migration itself is A.migrate in actions.ts.
 */

import React from 'react';
import { setPolicies } from '../model/edit';
import { A_MOVED_FROM, DiskMove, diskMoveStep, DiskMoveUntil, newDiskName, newDiskObject, newDiskSpec, swapDisks } from '../model/move';
import { pinnedHost, podSum } from '../model/placement';
import { Task, tasks, UntilWorld } from '../model/tasks';
import { Obj, VM } from '../model/types';
import { runTask } from './actions';
import { errorText, kdelete, kpost, kput, kreq } from './client';
import { labelDisks } from './protection';
import { PATHS } from './resources';

/**
 * Cold migration: the VM is pinned to the target host, then (when it is
 * running) the guest shuts down and starts again there. Unless `keepPin`,
 * the pin is lifted once it runs there (KubeVirt applies that live), so
 * the VM is not tied to the host afterwards. A powered-off VM keeps the pin
 * until it starts: that is how it gets there.
 */
export function coldMove(vm: VM, host: string, opts: { running: boolean; keepPin?: boolean }) {
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name;
  return runTask(
    {
      title: opts.running ? `Move powered off to ${host}` : `Place on ${host}`,
      target: { kind: 'vm', namespace: ns, name },
      until: opts.running ? { type: 'vmOnHost', namespace: ns, name, host } : undefined,
      timeoutMs: 20 * 60 * 1000,
    },
    async () => {
      const latest = await kreq<VM>(PATHS.vm(ns, name));
      const next = setPolicies(latest, { hostAffinity: { host, required: true } });
      const body = { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', ...next, status: undefined };
      await kreq(PATHS.vm(ns, name), { method: 'PUT', body });
      if (opts.running) {
        await kput(PATHS.vmSub(ns, name, 'restart'), {});
        if (!opts.keepPin) void unpinWhenThere(ns, name, host);
      }
    }
  );
}

/** Lifts the host pin once the VM runs on that host (while this page stays open; else the pin stays). */
async function unpinWhenThere(ns: string, name: string, host: string) {
  const start = Date.now();
  while (Date.now() - start < 15 * 60 * 1000) {
    await new Promise(r => window.setTimeout(r, 4000));
    const vmi = await kreq<Obj>(PATHS.vmi(ns, name)).catch(() => null);
    if (vmi?.status?.phase !== 'Running' || vmi.status?.nodeName !== host) continue;
    const latest = await kreq<VM>(PATHS.vm(ns, name)).catch(() => null);
    if (!latest || pinnedHost(latest.spec?.template?.spec) !== host) return;
    const next = setPolicies(latest, { hostAffinity: null });
    await kreq(PATHS.vm(ns, name), { method: 'PUT', body: { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', ...next, status: undefined } }).catch(() => undefined);
    return;
  }
}

export interface MoveDisksInput {
  vm: VM;
  moves: DiskMove[];
  /** Live (the VM runs and KubeVirt can copy while it runs) or powered off. */
  live: boolean;
  /** Delete the old disks once the VM uses the new ones. */
  deleteOld: boolean;
  /** Names already used by claims and DataVolumes in the folder. */
  taken: Set<string>;
  /** Old claim → the name it was first (moved disks keep it). */
  roots?: Map<string, string>;
}

/**
 * Moves disks to another datastore: the new DataVolumes are created here,
 * the rest is a staged task ("diskMove") the resolver advances, so it goes
 * on after a reload. Live: blank disks, then the VM points at them with
 * updateVolumesStrategy Migration and KubeVirt copies while the guest runs.
 * Powered off: copies (CDI clones), and the VM is changed only when they
 * are complete.
 */
export function moveDisks(i: MoveDisksInput) {
  const vm = i.vm;
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name;
  const taken = new Set(i.taken);
  const plan = i.moves.map(m => {
    const newName = newDiskName(i.roots?.get(m.claim) ?? m.claim, m.claim, m.datastore, taken);
    taken.add(newName);
    return { move: { ...m, root: i.roots?.get(m.claim) ?? m.claim }, newName, spec: newDiskSpec(m, ns, i.live) };
  });
  const what = i.moves.length === 1 ? `disk ${i.moves[0].volume}` : `${i.moves.length} disks`;
  return runTask(
    {
      title: `Move ${what} to ${[...new Set(i.moves.map(m => m.datastore))].join(', ')}`,
      target: { kind: 'vm', namespace: ns, name },
      until: {
        type: 'diskMove',
        namespace: ns,
        name,
        live: i.live,
        deleteOld: i.deleteOld,
        stage: 'copy',
        moves: plan.map(p => ({ volume: p.move.volume, claim: p.move.claim, newName: p.newName, spec: p.spec })),
      },
      timeoutMs: 12 * 60 * 60 * 1000,
    },
    async () => {
      for (const p of plan) await kpost(PATHS.dv(ns), newDiskObject(vm, p.move, p.newName, i.live));
    }
  );
}

const inFlight = new Set<string>();

/** One step of a staged disk move (called by the task resolver every few seconds). */
export function advanceDiskMove(t: Task, w: UntilWorld) {
  const u = t.until as DiskMoveUntil;
  if (inFlight.has(t.id)) return;
  const step = diskMoveStep(u, w);
  if (step.kind === 'wait') {
    tasks.update(t.id, { progress: step.progress, message: step.message });
    return;
  }
  if (step.kind === 'failed') {
    tasks.update(t.id, { status: 'failed', message: step.message });
    return;
  }
  if (step.kind === 'done') {
    tasks.update(t.id, { status: 'done', message: step.message ?? 'The VM uses the new disks' });
    return;
  }
  inFlight.add(t.id);
  const run = async () => {
    if (step.kind === 'swap') {
      const latest = await kreq<VM>(PATHS.vm(u.namespace, u.name));
      const vols: any[] = latest.spec?.template?.spec?.volumes ?? [];
      const already = u.moves.every(m => vols.find(v => v.name === m.volume)?.dataVolume?.name === m.newName);
      if (!already) {
        const next = swapDisks(
          latest,
          u.moves.map(m => ({ move: { volume: m.volume, claim: m.claim, datastore: '', sizeBytes: 0 }, newName: m.newName, spec: m.spec })),
          u.live
        );
        await kreq(PATHS.vm(u.namespace, u.name), { method: 'PUT', body: { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', ...next, status: undefined } });
      }
      if (u.live) tasks.update(t.id, { until: { ...u, stage: 'switch' }, message: 'Starting the copy', progress: undefined });
      else if (u.deleteOld) tasks.update(t.id, { until: { ...u, stage: 'cleanup' } });
      else tasks.update(t.id, { status: 'done', message: 'The VM uses the new disks' });
      return;
    }
    // cleanup: the old disks, DataVolume first (else CDI recreates the claim).
    const gone = (e: any) => (e?.status === 404 ? undefined : Promise.reject(e));
    for (const m of u.moves) {
      // The old disk of a protected VM carries the protection label; its data lives on in the new (protected) disk.
      await labelDisks(u.namespace, [m.claim], false).catch(() => undefined);
      await kdelete(PATHS.dv(u.namespace, m.claim)).catch(gone);
      await kdelete(PATHS.pvc(u.namespace, m.claim)).catch(gone);
    }
    tasks.update(t.id, { status: 'done', message: `The VM uses the new disks; old disk${u.moves.length === 1 ? '' : 's'} deleted` });
  };
  run()
    .catch(e => tasks.update(t.id, { status: 'failed', message: errorText(e) }))
    .finally(() => inFlight.delete(t.id));
}

/** The claims and DataVolumes in a folder (taken names) and the disks' first names. */
export function diskNames(ns: string, pvcs: Obj[], dvs: Obj[]): { taken: Set<string>; roots: Map<string, string> } {
  const taken = new Set<string>();
  const roots = new Map<string, string>();
  for (const o of [...pvcs, ...dvs]) {
    if (o.metadata.namespace !== ns) continue;
    taken.add(o.metadata.name);
    const r = o.metadata.annotations?.[A_MOVED_FROM];
    if (r) roots.set(o.metadata.name, r);
  }
  return { taken, roots };
}


/**
 * Memory requested by every pod on each host (what the scheduler counts),
 * read once when a placement dialog opens. Undefined when the user cannot
 * list pods: the verdicts then count VM pods only.
 */
export function usePodMemoryRequests(): Map<string, number> | undefined {
  const [m, setM] = React.useState<Map<string, number> | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    kreq<{ items: Obj[] }>('/api/v1/pods', { query: { fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' } })
      .then(list => {
        const out = new Map<string, number>();
        for (const p of list.items ?? []) {
          const node = p.spec?.nodeName;
          if (!node || p.metadata.deletionTimestamp) continue;
          out.set(node, (out.get(node) ?? 0) + podSum(p, 'requests', 'memory'));
        }
        if (live) setM(out);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return m;
}
