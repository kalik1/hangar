/*
 * Moving a VM's disks to another datastore ("storage migration"), as pure
 * functions: the new disk's name and DataVolume, and the VM with the disk
 * swapped. Two ways, chosen by the caller:
 *
 * - live: a blank disk on the target, then the VM's volume points at it
 *   with `updateVolumesStrategy: Migration`; KubeVirt copies the data while
 *   the guest runs (a migration with block copy, so only where another
 *   host can take the VM: diskMoveMode).
 * - powered off: a copy (CDI clone) of the old disk on the target, then the
 *   VM's volume points at the copy. A running VM that cannot move live is
 *   shut down first and started again after.
 *
 * The VM keeps owning its disks: the new one replaces the old entry in
 * dataVolumeTemplates, so deleting the VM still deletes it.
 */

import { clone } from './edit';
import { HostVerdict } from './placement';
import { isProtected, PROTECTED_LABEL } from './protection';
import { Until, UntilWorld, volumesChanging } from './tasks';
import { Obj } from './types';
import { cond } from './vm';
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
  return newDiskFromSpec(vm, m.root ?? m.claim, name, newDiskSpec(m, vm.metadata.namespace as string, live));
}

/** The new disk's DataVolume, owned by the VM. `root`: the disk's first name. */
export function newDiskFromSpec(vm: Obj, root: string, name: string, spec: any): Obj {
  const ns = vm.metadata.namespace as string;
  return {
    apiVersion: 'cdi.kubevirt.io/v1beta1',
    kind: 'DataVolume',
    metadata: {
      name,
      namespace: ns,
      // A protected VM's new disk is protected too.
      ...(isProtected(vm) ? { labels: { [PROTECTED_LABEL]: 'true' } } : {}),
      annotations: { [A_MOVED_FROM]: root, 'cdi.kubevirt.io/storage.bind.immediate.requested': 'true' },
      ...(vm.metadata.uid
        ? {
            ownerReferences: [
              { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: vm.metadata.name, uid: vm.metadata.uid, controller: true, blockOwnerDeletion: true } as any,
            ],
          }
        : {}),
    },
    spec,
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

/* ------------------------------------------------------ how to move */

export type DiskMoveMode =
  /** It runs and another host can take it: KubeVirt copies the disks while it migrates there. */
  | { mode: 'live'; targets: string[] }
  /** Copies, then the VM uses them; `restart`: it runs now, so Hangar shuts it down first and starts it again after. */
  | { mode: 'offline'; restart: boolean; why?: string }
  | { mode: 'blocked'; why: string };

export interface DiskMoveModeInput {
  /** powerState(vm, vmi).kind and its label. */
  power: string;
  powerLabel: string;
  /** KubeVirt's StorageLiveMigratable on the running instance. */
  storageLive: boolean;
  /** The reason of a False LiveMigratable. */
  liveReason?: string;
  /** What the KubeVirt CR lacks for live disk moves (liveDiskMovesEnabled). */
  kubevirtMissing: string[];
  /** The Migrate dialog's per-host verdicts (placement). */
  hosts: HostVerdict[];
}

/**
 * Live only where KubeVirt can run the copy: it copies the disks of a
 * running VM during a migration to another host (the target pod must not
 * share the host with the source), so a host must be able to take the VM
 * live, its disks' place aside. On one host there is no live move: the VM
 * is shut down, its disks copied, and started again.
 */
export function diskMoveMode(i: DiskMoveModeInput): DiskMoveMode {
  if (i.power === 'off') return { mode: 'offline', restart: false };
  if (i.power !== 'on') return { mode: 'blocked', why: `The VM is ${i.powerLabel.toLowerCase()}: wait until it is powered off or running.` };
  const others = i.hosts.filter(h => !h.current);
  const targets = others.filter(h => h.liveDiskMove.ok).map(h => h.host);
  const why = i.kubevirtMissing.length
    ? 'Live disk moves are not enabled in this cluster.'
    : i.liveReason === 'HostDeviceNotLiveMigratable'
    ? 'It uses a device of its host, so KubeVirt cannot copy its disks while it runs.'
    : !i.storageLive
    ? 'KubeVirt cannot copy its disks while it runs.'
    : others.length === 0
    ? 'This datacenter has one host: KubeVirt copies the disks of a running VM while it moves it to another host.'
    : !targets.length
    ? `No other host can take it while it runs (${others.map(h => `${h.host}: ${lowerFirst(h.liveDiskMove.reasons[0] ?? 'not available')}`).join('; ')}).`
    : undefined;
  return why ? { mode: 'offline', restart: true, why } : { mode: 'live', targets };
}

const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

/* ------------------------------------------- a live move that cannot end */

export interface StuckDiskMove {
  /** Each volume: the claim the guest still runs on, and the new one the VM names. */
  volumes: { volume: string; oldClaim: string; newClaim: string }[];
  /** KubeVirt's kubevirt-workload-update migrations for it that have not finished. */
  migrations: string[];
}

const WORKLOAD_UPDATE = 'kubevirt-workload-update-';
const STUCK_AFTER = 5 * 60 * 1000;

function volumeClaim(v: any): string | undefined {
  return v?.dataVolume?.name ?? v?.persistentVolumeClaim?.claimName;
}

/**
 * A live disk move that cannot end, as Hangar 0.1.x started them where no
 * other host could take the VM (every single-host cluster): KubeVirt's
 * VolumesChange stays True, the VM names the new disk, still blank, while
 * the guest runs on the old one, and each kubevirt-workload-update
 * migration stays Pending. A restart would boot the blank disk. Null while
 * a copy runs, or for the first minutes of a move.
 */
export function stuckDiskMove(vm: Obj, vmi: Obj | null | undefined, migrations: Obj[], now = Date.now()): StuckDiskMove | null {
  const c = cond(vm, 'VolumesChange');
  if (c?.status !== 'True') return null;
  const since = Date.parse(c.lastTransitionTime ?? '');
  if (isFinite(since) && now - since < STUCK_AFTER) return null;
  const vols: any[] = vm.spec?.template?.spec?.volumes ?? [];
  // The instance lists them; so does the VM (kept after the end: VolumesChange says whether it goes on).
  const migrated: any[] = vmi?.status?.migratedVolumes?.length
    ? vmi.status.migratedVolumes
    : vm.status?.volumeUpdateState?.volumeMigrationState?.migratedVolumes ?? [];
  const volumes = migrated
    .map(m => ({ volume: m.volumeName as string, oldClaim: m.sourcePVCInfo?.claimName as string, newClaim: m.destinationPVCInfo?.claimName as string }))
    .filter(x => x.volume && x.oldClaim && x.newClaim && x.oldClaim !== x.newClaim && volumeClaim(vols.find(v => v.name === x.volume)) === x.newClaim);
  if (!volumes.length) return null;
  const open = migrations.filter(
    m =>
      m.metadata.namespace === vm.metadata.namespace &&
      m.spec?.vmiName === vm.metadata.name &&
      m.metadata.name.startsWith(WORKLOAD_UPDATE) &&
      !['Succeeded', 'Failed'].includes(m.status?.phase ?? '')
  );
  // A copy under way is not stuck.
  if (open.some(m => !['', 'Pending', 'Scheduling'].includes(m.status?.phase ?? ''))) return null;
  return { volumes, migrations: open.map(m => m.metadata.name) };
}

/**
 * The VM with the old disks back: each volume names its old claim again
 * (a DataVolume when there is one), the new disk's dataVolumeTemplates
 * entry goes, and the old one comes back when the VM owns the old
 * DataVolume. KubeVirt then calls the volume change off.
 */
export function revertDiskMove(vm: Obj, stuck: StuckDiskMove, dvs: Map<string, Obj>): Obj {
  const out = clone(vm);
  const ns = vm.metadata.namespace as string;
  const t = out.spec.template.spec;
  const vols: any[] = t.volumes ?? [];
  let templates: any[] = out.spec.dataVolumeTemplates ?? [];
  for (const s of stuck.volumes) {
    const i = vols.findIndex(v => v.name === s.volume);
    if (i < 0) continue;
    const hot = vols[i].dataVolume?.hotpluggable ?? vols[i].persistentVolumeClaim?.hotpluggable;
    const oldDv = dvs.get(`${ns}/${s.oldClaim}`);
    vols[i] = oldDv
      ? { name: s.volume, dataVolume: { name: s.oldClaim, ...(hot ? { hotpluggable: true } : {}) } }
      : { name: s.volume, persistentVolumeClaim: { claimName: s.oldClaim, ...(hot ? { hotpluggable: true } : {}) } };
    templates = templates.filter(d => d.metadata?.name !== s.newClaim);
    const owned = !!vm.metadata.uid && (oldDv?.metadata.ownerReferences ?? []).some(r => r.uid === vm.metadata.uid);
    if (oldDv && owned && !templates.some(d => d.metadata?.name === s.oldClaim))
      templates.push({ metadata: { name: s.oldClaim, ...(isProtected(vm) ? { labels: { [PROTECTED_LABEL]: 'true' } } : {}) }, spec: clone(oldDv.spec) });
  }
  t.volumes = vols;
  out.spec.dataVolumeTemplates = templates;
  return out;
}

/* ------------------------------------------------- staged disk moves */

export type DiskMoveUntil = Extract<Until, { type: 'diskMove' }>;

export type DiskMoveStep =
  | { kind: 'wait'; progress?: number; message: string }
  /** Powered off: the copies can be made. */
  | { kind: 'create' }
  | { kind: 'swap' }
  | { kind: 'cleanup' }
  | { kind: 'done'; message?: string }
  | { kind: 'failed'; message: string };

/** What a disk move needs next, from the live objects. */
export function diskMoveStep(u: DiskMoveUntil, w: UntilWorld): DiskMoveStep {
  if (u.stage === 'stop') {
    const p = w.vmPower(u.namespace, u.name);
    if (!p) return { kind: 'failed', message: 'The VM is gone' };
    if (p.kind === 'off') return { kind: 'create' };
    return { kind: 'wait', message: 'Shutting down the guest' };
  }
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
