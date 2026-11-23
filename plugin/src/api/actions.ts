/*
 * Operations on VMs and hosts. Each one is a task in Recent tasks: the API
 * call, then (when there is something to wait for) the confirmation from
 * the live objects.
 */

import { Task, tasks, TaskTarget, Until } from '../model/tasks';
import { VM } from '../model/types';
import { errorText, kdelete, kjsonpatch, kmerge, kpost, kput, kreq } from './client';
import { PATHS } from './resources';

export interface RunOptions {
  title: string;
  target?: TaskTarget;
  until?: Until;
  timeoutMs?: number;
}

/** Runs `fn` as a task. Resolves with its result, or rejects after marking the task failed. */
export async function runTask<T>(opts: RunOptions, fn: () => Promise<T>): Promise<T> {
  const task: Task = tasks.add({ title: opts.title, target: opts.target, until: opts.until, timeoutMs: opts.timeoutMs });
  try {
    const out = await fn();
    if (!opts.until) tasks.update(task.id, { status: 'done' });
    return out;
  } catch (e) {
    tasks.update(task.id, { status: 'failed', message: errorText(e) });
    throw e;
  }
}

const vmTarget = (vm: VM): TaskTarget => ({ kind: 'vm', namespace: vm.metadata.namespace, name: vm.metadata.name });
const ns = (vm: VM) => vm.metadata.namespace as string;
const nm = (vm: VM) => vm.metadata.name;

export function powerOn(vm: VM, opts: { paused?: boolean } = {}) {
  return runTask(
    {
      title: 'Power on',
      target: vmTarget(vm),
      until: { type: 'vmPower', namespace: ns(vm), name: nm(vm), kinds: opts.paused ? ['paused'] : ['on'] },
    },
    () => kput(PATHS.vmSub(ns(vm), nm(vm), 'start'), opts.paused ? { paused: true } : {})
  );
}

/** Guest shutdown (ACPI), or power off at once when `force`. */
export function shutDown(vm: VM, opts: { force?: boolean } = {}) {
  return runTask(
    {
      title: opts.force ? 'Power off' : 'Shut down guest',
      target: vmTarget(vm),
      until: { type: 'vmPower', namespace: ns(vm), name: nm(vm), kinds: ['off'] },
    },
    () => kput(PATHS.vmSub(ns(vm), nm(vm), 'stop'), opts.force ? { gracePeriod: 0 } : {})
  );
}

export function restart(vm: VM, opts: { force?: boolean } = {}) {
  return runTask(
    {
      title: opts.force ? 'Power cycle' : 'Restart guest',
      target: vmTarget(vm),
      until: { type: 'vmPower', namespace: ns(vm), name: nm(vm), kinds: ['on'] },
    },
    () => kput(PATHS.vmSub(ns(vm), nm(vm), 'restart'), opts.force ? { gracePeriodSeconds: 0 } : {})
  );
}

/** Hard reset of the running instance, like the reset button. */
export function reset(vm: VM) {
  return runTask({ title: 'Reset', target: vmTarget(vm) }, () => kput(PATHS.vmiSub(ns(vm), nm(vm), 'reset')));
}

export function suspend(vm: VM) {
  return runTask(
    { title: 'Suspend', target: vmTarget(vm), until: { type: 'vmPower', namespace: ns(vm), name: nm(vm), kinds: ['paused'] } },
    () => kput(PATHS.vmiSub(ns(vm), nm(vm), 'pause'))
  );
}

export function resume(vm: VM) {
  return runTask(
    { title: 'Resume', target: vmTarget(vm), until: { type: 'vmPower', namespace: ns(vm), name: nm(vm), kinds: ['on'] } },
    () => kput(PATHS.vmiSub(ns(vm), nm(vm), 'unpause'))
  );
}

/** Live migration. With a target host it is pinned there (KubeVirt adds the node selector). */
export async function migrate(vm: VM, opts: { host?: string } = {}) {
  const name = `${nm(vm)}-move-${Date.now().toString(36)}`;
  return runTask(
    {
      title: opts.host ? `Migrate to ${opts.host}` : 'Migrate',
      target: vmTarget(vm),
      until: { type: 'migration', namespace: ns(vm), name },
      timeoutMs: 60 * 60 * 1000,
    },
    () =>
      kpost(PATHS.migrations(ns(vm)), {
        apiVersion: 'kubevirt.io/v1',
        kind: 'VirtualMachineInstanceMigration',
        metadata: { name, namespace: ns(vm), labels: { 'hangar.magesgate.com/initiated': 'true' } },
        spec: {
          vmiName: nm(vm),
          ...(opts.host ? { addedNodeSelector: { 'kubernetes.io/hostname': opts.host } } : {}),
        },
      })
  );
}

export function cancelMigration(namespace: string, name: string, vmName: string) {
  return runTask({ title: 'Cancel migration', target: { kind: 'vm', namespace, name: vmName } }, () =>
    kdelete(PATHS.migrations(namespace, name))
  );
}

export function setRunStrategy(vm: VM, runStrategy: string) {
  return runTask({ title: 'Change power policy', target: vmTarget(vm) }, () =>
    kmerge(PATHS.vm(ns(vm), nm(vm)), { spec: { runStrategy, running: null } })
  );
}

/** Merge-patches the VM (metadata or spec). */
export function patchVm(vm: VM, title: string, patch: unknown) {
  return runTask({ title, target: vmTarget(vm) }, () => kmerge(PATHS.vm(ns(vm), nm(vm)), patch));
}

/** JSON-patches the VM, with a resourceVersion test so a concurrent edit is not overwritten. */
export function jsonPatchVm(vm: VM, title: string, ops: unknown[]) {
  const guarded = vm.metadata.resourceVersion
    ? [{ op: 'test', path: '/metadata/resourceVersion', value: vm.metadata.resourceVersion }, ...ops]
    : ops;
  return runTask({ title, target: vmTarget(vm) }, () => kjsonpatch(PATHS.vm(ns(vm), nm(vm)), guarded));
}

/**
 * Replaces the VM with an edited copy (PUT). The copy carries the
 * resourceVersion it was made from, so the API refuses it if someone
 * changed the VM meanwhile.
 */
export function updateVm(vm: VM, title: string, next: VM) {
  const body = { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', ...next, status: undefined };
  return runTask({ title, target: vmTarget(vm) }, () => kreq(PATHS.vm(ns(vm), nm(vm)), { method: 'PUT', body }));
}

/** Grows a disk (PVC). The guest sees the new size after a restart, or at once if the cluster can expand online. */
export function expandDisk(namespace: string, claim: string, bytes: number, vmName?: string) {
  return runTask(
    { title: 'Expand disk', target: vmName ? { kind: 'vm', namespace, name: vmName } : { kind: 'datastore', namespace, name: claim } },
    () => kmerge(PATHS.pvc(namespace, claim), { spec: { resources: { requests: { storage: `${Math.ceil(bytes / 2 ** 30)}Gi` } } } })
  );
}

/** Deletes a disk: its DataVolume first (else CDI would recreate the PVC), then the PVC. */
export function deleteClaim(namespace: string, claim: string) {
  const gone = (e: any) => (e?.status === 404 ? undefined : Promise.reject(e));
  return runTask({ title: 'Delete disk', target: { kind: 'datastore', namespace, name: claim } }, async () => {
    await kdelete(PATHS.dv(namespace, claim)).catch(gone);
    await kdelete(PATHS.pvc(namespace, claim)).catch(gone);
  });
}

/** Deletes the VM. Disks it owns (dataVolumeTemplates) go with it unless `keepDisks`. */
export function deleteVm(vm: VM, opts: { keepDisks?: boolean } = {}) {
  return runTask(
    {
      title: isTemplateVm(vm) ? 'Delete template' : 'Delete VM',
      target: vmTarget(vm),
      until: { type: 'vmGone', namespace: ns(vm), name: nm(vm) },
    },
    () =>
      kdelete(PATHS.vm(ns(vm), nm(vm)), {
        kind: 'DeleteOptions',
        apiVersion: 'v1',
        propagationPolicy: opts.keepDisks ? 'Orphan' : 'Foreground',
      })
  );
}

function isTemplateVm(vm: VM) {
  return vm.metadata.labels?.['hangar.magesgate.com/template'] === 'true';
}

export function createVm(vm: VM, title = 'Create VM') {
  const namespace = vm.metadata.namespace as string;
  return runTask(
    {
      title,
      target: { kind: 'vm', namespace, name: vm.metadata.name },
      until: { type: 'vmExists', namespace, name: vm.metadata.name },
    },
    () => kpost(PATHS.vm(namespace), vm)
  );
}

/* ---------------------------------------------------------------- hosts */

/** Maintenance mode: no new VMs (cordon), then every running VM that can move is migrated away. */
export async function enterMaintenance(host: string, vmsOnHost: { namespace: string; name: string; migratable: boolean }[]) {
  await runTask({ title: 'Enter maintenance mode', target: { kind: 'host', name: host } }, () =>
    kmerge(PATHS.node(host), { spec: { unschedulable: true } })
  );
  for (const v of vmsOnHost.filter(x => x.migratable)) {
    const name = `${v.name}-evac-${Date.now().toString(36)}`;
    await runTask(
      {
        title: `Evacuate to another host`,
        target: { kind: 'vm', namespace: v.namespace, name: v.name },
        until: { type: 'migration', namespace: v.namespace, name },
        timeoutMs: 60 * 60 * 1000,
      },
      () =>
        kpost(PATHS.migrations(v.namespace), {
          apiVersion: 'kubevirt.io/v1',
          kind: 'VirtualMachineInstanceMigration',
          metadata: { name, namespace: v.namespace, labels: { 'hangar.magesgate.com/initiated': 'true' } },
          spec: { vmiName: v.name },
        })
    ).catch(() => undefined);
  }
}

export function exitMaintenance(host: string) {
  return runTask({ title: 'Exit maintenance mode', target: { kind: 'host', name: host } }, () =>
    kmerge(PATHS.node(host), { spec: { unschedulable: null } })
  );
}
