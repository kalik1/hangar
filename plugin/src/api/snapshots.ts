/*
 * VM snapshot operations: take, delete, revert (with the shutdown before
 * and the power-on after), and the feature gate probe.
 */

import { GateState, restoreManifest, snapshotManifest } from '../model/snapshots';
import { Obj } from '../model/types';
import * as A from './actions';
import { errorText, kdelete, kpost, kreq } from './client';
import { PATHS } from './resources';
import { SPATHS } from './storageResources';

const vmTarget = (vm: Obj) => ({ kind: 'vm' as const, namespace: vm.metadata.namespace, name: vm.metadata.name });

export function takeSnapshot(vm: Obj, name: string, displayName: string, description?: string) {
  const ns = vm.metadata.namespace as string;
  return A.runTask(
    {
      title: `Take snapshot “${displayName}”`,
      target: vmTarget(vm),
      until: { type: 'snapshot', namespace: ns, name },
      timeoutMs: 30 * 60 * 1000,
    },
    () => kpost(SPATHS.vmSnapshots(ns), snapshotManifest(vm, name, displayName, description))
  );
}

export function deleteSnapshot(vm: Obj, snap: { name: string; displayName: string }) {
  return A.runTask({ title: `Delete snapshot “${snap.displayName}”`, target: vmTarget(vm) }, () =>
    kdelete(SPATHS.vmSnapshots(vm.metadata.namespace as string, snap.name))
  );
}

/** Polls `check` until true; null means it will never be: stop. */
async function waitFor(check: () => Promise<boolean | null>, timeoutMs: number, every = 2000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await check().catch(() => false);
    if (r === null) return false;
    if (r) return true;
    await new Promise(res => setTimeout(res, every));
  }
  return false;
}

async function isStopped(ns: string, name: string): Promise<boolean> {
  const vm = await kreq<Obj>(PATHS.vm(ns, name));
  if (vm.status?.printableStatus !== 'Stopped') return false;
  try {
    await kreq(PATHS.vmi(ns, name));
    return false;
  } catch (e: any) {
    return e?.status === 404;
  }
}

export interface RevertOptions {
  /** The VM is on: shut the guest down first, or power it off at once. */
  stop?: 'shutdown' | 'force';
  /** Power on again when the revert is done. */
  powerOn: boolean;
  /** Snapshot the current state first (after the shutdown, so it is consistent). */
  saveFirst?: { name: string; displayName: string; description?: string };
}

/**
 * Reverts the VM to a snapshot: (shut down), restore, (power on). Each step
 * is a task. KubeVirt replaces the disks with new ones made from the
 * snapshot and puts back the VM settings saved in it.
 */
export async function revertToSnapshot(vm: Obj, snap: { name: string; displayName: string }, opts: RevertOptions) {
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name;
  if (opts.stop) {
    await A.shutDown(vm, { force: opts.stop === 'force' });
    const ok = await waitFor(() => isStopped(ns, name), opts.stop === 'force' ? 2 * 60 * 1000 : 5 * 60 * 1000);
    if (!ok) {
      await A.runTask({ title: `Revert to “${snap.displayName}”`, target: vmTarget(vm) }, () =>
        Promise.reject(new Error('The VM did not power off in time: power it off, then revert again.'))
      ).catch(() => undefined);
      return;
    }
  }
  if (opts.saveFirst) {
    const sf = opts.saveFirst;
    await takeSnapshot(vm, sf.name, sf.displayName, sf.description);
    const ready = await waitFor(async () => {
      const s = await kreq<Obj>(SPATHS.vmSnapshots(ns, sf.name));
      if (s.status?.phase === 'Failed') return null;
      return !!s.status?.readyToUse;
    }, 15 * 60 * 1000, 3000);
    if (!ready) {
      await A.runTask({ title: `Revert to “${snap.displayName}”`, target: vmTarget(vm) }, () =>
        Promise.reject(new Error(`The snapshot of the current state (${sf.displayName}) is not ready: nothing was reverted.`))
      ).catch(() => undefined);
      return;
    }
  }
  const rname = `${name.slice(0, 40).replace(/-+$/, '')}-revert-${Date.now().toString(36)}`;
  await A.runTask(
    {
      title: `Revert to “${snap.displayName}”`,
      target: vmTarget(vm),
      until: { type: 'restore', namespace: ns, name: rname },
      timeoutMs: 30 * 60 * 1000,
    },
    () => kpost(SPATHS.vmRestores(ns), restoreManifest(vm, snap.name, rname))
  );
  if (!opts.powerOn) return;
  const done = await waitFor(async () => {
    const r = await kreq<Obj>(SPATHS.vmRestores(ns, rname));
    if ((r.status?.conditions ?? []).some((c: any) => c.type === 'Failure' && c.status === 'True')) return null;
    return !!r.status?.complete;
  }, 30 * 60 * 1000, 3000);
  if (done) await A.powerOn(vm).catch(() => undefined);
}

/** Deletes an old revert record. */
export function deleteRevert(vm: Obj, restore: Obj) {
  return A.runTask({ title: 'Remove revert record', target: vmTarget(vm) }, () =>
    kdelete(SPATHS.vmRestores(vm.metadata.namespace as string, restore.metadata.name))
  );
}

const gateCache = new Map<string, { at: number; state: GateState; message?: string }>();

/**
 * Asks KubeVirt whether it takes snapshots: a dry-run create runs the
 * admission webhook, which refuses when the Snapshot feature gate is off.
 */
export async function probeSnapshotGate(vm: Obj, cluster: string): Promise<{ state: GateState; message?: string }> {
  const k = `${cluster}/${vm.metadata.namespace}`;
  const c = gateCache.get(k);
  if (c && Date.now() - c.at < 60000) return c;
  const ns = vm.metadata.namespace as string;
  let out: { state: GateState; message?: string };
  try {
    await kpost(SPATHS.vmSnapshots(ns), snapshotManifest(vm, `hangar-probe-${Date.now().toString(36)}`, 'probe'), { dryRun: 'All' });
    out = { state: 'on' };
  } catch (e: any) {
    const msg = errorText(e);
    if (/feature gate/i.test(msg)) out = { state: 'off', message: msg };
    else out = { state: 'unknown', message: msg };
  }
  gateCache.set(k, { at: Date.now(), ...out });
  return out;
}

export function forgetGateProbe() {
  gateCache.clear();
}
