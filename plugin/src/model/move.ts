/*
 * Moving a VM's disks to another datastore ("storage migration"), as pure
 * functions: the new disk's name and DataVolume, and the VM with the disk
 * swapped. Two ways, chosen by the caller:
 *
 * - live: a blank disk on the target, then the VM's volume points at it
 *   with `updateVolumesStrategy: Migration`; KubeVirt copies the data while
 *   the guest runs (a migration with block copy).
 * - powered off: a copy (CDI clone) of the old disk on the target, then the
 *   VM's volume points at the copy.
 *
 * The VM keeps owning its disks: the new one replaces the old entry in
 * dataVolumeTemplates, so deleting the VM still deletes it.
 */

import { clone } from './edit';
import { isProtected, PROTECTED_LABEL } from './protection';
import { Until, UntilWorld, volumesChanging } from './tasks';
import { Obj } from './types';
import { slugify } from './vmspec';

export interface DiskMove {
  /** The VM's volume name ("rootdisk"). */
  volume: string;
  /** The claim it uses now. */
  claim: string;
  /** Target StorageClass. */
  datastore: string;
  sizeBytes: number;
  /** The disk's first name, when it was moved before. */
  root?: string;
}

/** On a moved disk: the name of the disk it was first. */
export const A_MOVED_FROM = 'hangar.magesgate.com/moved-from';

/**
 * A free name for the new disk: "<root>-<datastore>", numbered if taken, at
 * most 63 characters. `root` is the disk's first name (a moved disk keeps it
 * in an annotation), so moving back and forth does not grow the name.
 */
export function newDiskName(root: string, claim: string, datastore: string, taken: Set<string>): string {
  const ds = slugify(datastore).slice(0, 20) || 'disk';
  const stem = `${root}-${ds}`.slice(0, 58).replace(/-+$/, '');
  if (!taken.has(stem) && stem !== claim) return stem;
  for (let i = 2; i < 100; i++) {
    const n = `${stem}-${i}`;
    if (!taken.has(n) && n !== claim) return n;
  }
  return `${stem}-${Date.now().toString(36)}`.slice(0, 63);
}

/** DataVolume spec of the new disk: blank (live copy) or a clone of the old claim (powered off). */
export function newDiskSpec(m: DiskMove, namespace: string, live: boolean): any {
  const gi = Math.max(1, Math.ceil(m.sizeBytes / 2 ** 30));
  return {
    source: live ? { blank: {} } : { pvc: { namespace, name: m.claim } },
    storage: { storageClassName: m.datastore, resources: { requests: { storage: `${gi}Gi` } } },
  };
}

export function newDiskObject(vm: Obj, m: DiskMove, name: string, live: boolean): Obj {
  const ns = vm.metadata.namespace as string;
  return {
    apiVersion: 'cdi.kubevirt.io/v1beta1',
    kind: 'DataVolume',
    metadata: {
      name,
      namespace: ns,
      // A protected VM's new disk is protected too.
      ...(isProtected(vm) ? { labels: { [PROTECTED_LABEL]: 'true' } } : {}),
      annotations: { [A_MOVED_FROM]: m.root ?? m.claim, 'cdi.kubevirt.io/storage.bind.immediate.requested': 'true' },
      ...(vm.metadata.uid
        ? {
            ownerReferences: [
              { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: vm.metadata.name, uid: vm.metadata.uid, controller: true, blockOwnerDeletion: true } as any,
            ],
          }
        : {}),
    },
    spec: newDiskSpec(m, ns, live),
  };
}

/** The VM with each moved volume pointing at its new disk. */
export function swapDisks(vm: Obj, moves: { move: DiskMove; newName: string; spec: any }[], live: boolean): Obj {
  const out = clone(vm);
  out.spec ??= {};
  const t = (out.spec.template ??= {}).spec ?? (out.spec.template.spec = {});
  const vols: any[] = t.volumes ?? [];
  let templates: any[] = out.spec.dataVolumeTemplates ?? [];
  for (const { move, newName, spec } of moves) {
    const i = vols.findIndex(v => v.name === move.volume);
    if (i < 0) throw new Error(`The VM has no disk ${move.volume}`);
    const old = vols[i];
    const hotpluggable = old.dataVolume?.hotpluggable ?? old.persistentVolumeClaim?.hotpluggable;
    vols[i] = { name: move.volume, dataVolume: { name: newName, ...(hotpluggable ? { hotpluggable: true } : {}) } };
    templates = templates.filter(d => d.metadata?.name !== move.claim);
    templates.push({ metadata: { name: newName, ...(isProtected(vm) ? { labels: { [PROTECTED_LABEL]: 'true' } } : {}) }, spec });
  }
  t.volumes = vols;
  out.spec.dataVolumeTemplates = templates;
  if (live) out.spec.updateVolumesStrategy = 'Migration';
  return out;
}

/* ------------------------------------------------- staged disk moves */

export type DiskMoveUntil = Extract<Until, { type: 'diskMove' }>;

export type DiskMoveStep =
  | { kind: 'wait'; progress?: number; message: string }
  | { kind: 'swap' }
  | { kind: 'cleanup' }
  | { kind: 'done'; message?: string }
  | { kind: 'failed'; message: string };

/** What a disk move needs next, from the live objects. */
export function diskMoveStep(u: DiskMoveUntil, w: UntilWorld): DiskMoveStep {
  if (u.stage === 'copy') {
    const dvs = u.moves.map(m => w.dataVolume(u.namespace, m.newName));
    const failed = dvs.find(d => d?.status?.phase === 'Failed');
    if (failed) {
      const c = (failed.status?.conditions ?? []).find((x: any) => x.type === 'Running');
      return { kind: 'failed', message: c?.message || `Copy of ${failed.metadata?.name} failed` };
    }
    if (dvs.every(d => d?.status?.phase === 'Succeeded')) return { kind: 'swap' };
    const ps = dvs.map(d => parseFloat(String(d?.status?.progress ?? '').replace('%', ''))).filter(x => isFinite(x));
    const progress = ps.length ? ps.reduce((a, b) => a + b, 0) / u.moves.length : undefined;
    return { kind: 'wait', progress, message: u.live ? 'Preparing the new disk' : 'Copying the disk' };
  }
  if (u.stage === 'switch') {
    const vm = w.vm?.(u.namespace, u.name);
    if (!vm) return { kind: 'wait', message: 'Waiting for the VM' };
    const stuck = (vm.status?.conditions ?? []).find((c: any) => c.type === 'ManualRecoveryRequired' && c.status === 'True');
    if (stuck) return { kind: 'failed', message: stuck.message || 'The disk copy stopped: put the old disk back in the VM' };
    const vmi = w.vmi?.(u.namespace, u.name);
    const vs: any[] = vmi?.status?.volumeStatus ?? [];
    const moved = u.moves.every(x => vs.find(v => v.name === x.volume)?.persistentVolumeClaimInfo?.claimName === x.newName);
    const pending = volumesChanging(vm, vmi);
    const m = w.vmMigration?.(u.namespace, u.name);
    if (moved && !pending && (!m || m.status?.phase === 'Succeeded')) return u.deleteOld ? { kind: 'cleanup' } : { kind: 'done' };
    if (m?.status?.phase === 'Failed') return { kind: 'wait', message: 'Copy failed, KubeVirt retries' };
    const phase = m?.status?.phase;
    return { kind: 'wait', message: phase === 'Running' || phase === 'TargetReady' ? 'Copying the disk while the VM runs' : 'Starting the copy' };
  }
  return { kind: 'cleanup' };
}
