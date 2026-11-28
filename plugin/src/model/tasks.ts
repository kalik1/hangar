/*
 * Recent tasks, like a classic virtualizer's bottom pane: every operation
 * started from Hangar becomes a task. A task whose API call succeeded may
 * still wait for the cluster to confirm the outcome (the VM is on, the
 * migration finished, the import is done): `until` says what to wait for,
 * and src/api/data.tsx resolves it against the live objects.
 *
 * The store is a small external store (subscribe/getSnapshot) kept per
 * cluster in localStorage, so tasks survive a reload.
 */

export type TaskStatus = 'running' | 'done' | 'failed' | 'warning';

export interface TaskTarget {
  kind: 'vm' | 'host' | 'image' | 'datastore' | 'network' | 'folder' | 'template' | 'snapshot' | 'device' | 'flavor' | 'datacenter';
  namespace?: string;
  name: string;
}

export type Until =
  | { type: 'vmPower'; namespace: string; name: string; kinds: string[] }
  | { type: 'vmGone'; namespace: string; name: string }
  | { type: 'vmExists'; namespace: string; name: string }
  | { type: 'migration'; namespace: string; name: string }
  | { type: 'dataVolume'; namespace: string; name: string }
  | { type: 'snapshot'; namespace: string; name: string }
  | { type: 'restore'; namespace: string; name: string }
  | { type: 'hostDrained'; name: string }
  /** The VM runs on this host (a cold move: shut down, placed there, powered on). */
  | { type: 'vmOnHost'; namespace: string; name: string; host: string }
  /** The running VM uses these claims for these volumes (a storage migration finished). */
  | { type: 'volumesMoved'; namespace: string; name: string; volumes: { volume: string; claim: string }[] }
  /**
   * A disk move in stages, advanced by src/api/move.ts from the task
   * resolver (so it goes on after a reload, from any open Hangar page):
   * [stop (a running VM shuts down, then the copies are made)] → copy (new
   * DataVolumes ready) → switch (live: KubeVirt copies) → cleanup.
   */
  | {
      type: 'diskMove';
      namespace: string;
      name: string;
      live: boolean;
      deleteOld: boolean;
      stage: 'stop' | 'copy' | 'switch' | 'cleanup';
      /** Powered off for the move: Hangar shut it down, and starts it again once it uses the copies. */
      restart?: boolean;
      /** root: the disk's first name (moved-from), for copies made at the stop stage. */
      moves: { volume: string; claim: string; newName: string; spec: any; root?: string }[];
    };

export interface Task {
  id: string;
  title: string;
  target?: TaskTarget;
  status: TaskStatus;
  started: number;
  finished?: number;
  message?: string;
  /** 0..100 when known. */
  progress?: number;
  until?: Until;
  /** Give up waiting after this many ms (then: warning). */
  timeoutMs?: number;
}

type Listener = () => void;

const MAX = 60;
const DEFAULT_TIMEOUT = 15 * 60 * 1000;

export class TaskStore {
  private tasks: Task[] = [];
  private listeners = new Set<Listener>();
  private storageKey = '';

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {}

  /** Switches to the task list of a cluster. */
  useCluster(cluster: string) {
    const k = `hangar.tasks.${cluster}`;
    if (k === this.storageKey) return;
    this.storageKey = k;
    try {
      const raw = this.storage?.getItem(k);
      // A task with nothing to wait for that was still running when the page
      // closed will never finish here: say so instead of spinning forever.
      this.tasks = (raw ? (JSON.parse(raw) as Task[]) : []).map(t =>
        t.status === 'running' && !t.until
          ? { ...t, status: 'warning' as const, finished: Date.now(), message: 'Interrupted: the page closed before it finished. Check the target.' }
          : t
      );
    } catch {
      this.tasks = [];
    }
    this.emit();
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): Task[] => this.tasks;

  add(t: Omit<Task, 'id' | 'started' | 'status'> & Partial<Pick<Task, 'status'>>): Task {
    const task: Task = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      started: Date.now(),
      status: 'running',
      timeoutMs: DEFAULT_TIMEOUT,
      ...t,
    };
    this.tasks = [task, ...this.tasks].slice(0, MAX);
    this.save();
    return task;
  }

  update(id: string, patch: Partial<Task>) {
    let changed = false;
    this.tasks = this.tasks.map(t => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      if (next.status !== 'running' && !next.finished) next.finished = Date.now();
      changed = changed || JSON.stringify(next) !== JSON.stringify(t);
      return changed ? next : t;
    });
    if (changed) this.save();
  }

  clearFinished() {
    this.tasks = this.tasks.filter(t => t.status === 'running');
    this.save();
  }

  running(): Task[] {
    return this.tasks.filter(t => t.status === 'running');
  }

  private save() {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.tasks));
    } catch {
      /* private mode or full storage: tasks stay in memory */
    }
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const tasks = new TaskStore();

/** Outcome of an `until` check against the live objects. */
export type UntilResult = { status: TaskStatus; message?: string; progress?: number } | null;

export interface UntilWorld {
  vmPower: (ns: string, name: string) => { kind: string; label: string; detail?: string } | null;
  migration: (ns: string, name: string) => any | null;
  dataVolume: (ns: string, name: string) => any | null;
  snapshot: (ns: string, name: string) => any | null;
  restore: (ns: string, name: string) => any | null;
  hostVmCount: (name: string) => number;
  /** The running instance of a VM (for vmOnHost, volumesMoved). */
  vmi?: (ns: string, name: string) => any | null;
  /** The VM object (for volumesMoved: its conditions). */
  vm?: (ns: string, name: string) => any | null;
  /** The newest migration of a VM (for progress words). */
  vmMigration?: (ns: string, name: string) => any | null;
}

/** null: still waiting. */
export function checkUntil(u: Until, w: UntilWorld, elapsedMs: number): UntilResult {
  switch (u.type) {
    case 'vmPower': {
      const p = w.vmPower(u.namespace, u.name);
      if (!p) return elapsedMs > 20000 ? { status: 'failed', message: 'The VM is gone' } : null;
      if (u.kinds.includes(p.kind)) return { status: 'done' };
      // Errors right after a start are often transient (scheduling, disks); give them a minute.
      if (p.kind === 'error' && elapsedMs > 60000) return { status: 'failed', message: p.detail ?? p.label };
      return null;
    }
    case 'vmGone':
      return w.vmPower(u.namespace, u.name) ? null : { status: 'done' };
    case 'vmExists':
      return w.vmPower(u.namespace, u.name) ? { status: 'done' } : null;
    case 'migration': {
      const m = w.migration(u.namespace, u.name);
      if (!m) return elapsedMs > 20000 ? { status: 'warning', message: 'The migration record is gone' } : null;
      const phase = m.status?.phase;
      if (phase === 'Succeeded') return { status: 'done' };
      if (phase === 'Failed') return { status: 'failed', message: migrationFailure(m) };
      const words = migrationPhaseWords(phase);
      return words ? { status: 'running', message: words } : null;
    }
    case 'vmOnHost': {
      const vmi = w.vmi?.(u.namespace, u.name);
      if (vmi?.status?.phase === 'Running' && vmi.status?.nodeName === u.host) return { status: 'done', message: `Running on ${u.host}` };
      const p = w.vmPower(u.namespace, u.name);
      if (!p) return elapsedMs > 20000 ? { status: 'failed', message: 'The VM is gone' } : null;
      if (p.kind === 'error' && elapsedMs > 90000) return { status: 'failed', message: p.detail ?? p.label };
      if (vmi?.status?.phase === 'Running' && vmi.status?.nodeName && vmi.status.nodeName !== u.host)
        return elapsedMs > 180000 ? { status: 'warning', message: `It started on ${vmi.status.nodeName}` } : { status: 'running', message: 'Shutting down' };
      return { status: 'running', message: p.kind === 'off' ? 'Powered off, starting on the new host' : p.label };
    }
    case 'volumesMoved': {
      const vm = w.vm?.(u.namespace, u.name);
      if (!vm) return null;
      const stuck = (vm.status?.conditions ?? []).find((c: any) => c.type === 'ManualRecoveryRequired' && c.status === 'True');
      if (stuck) return { status: 'failed', message: stuck.message || 'The disk copy stopped: put the old disk back in the VM' };
      const vmi = w.vmi?.(u.namespace, u.name);
      const vs: any[] = vmi?.status?.volumeStatus ?? [];
      const moved = u.volumes.every(x => vs.find(v => v.name === x.volume)?.persistentVolumeClaimInfo?.claimName === x.claim);
      const pending = volumesChanging(vm, vmi);
      const m = w.vmMigration?.(u.namespace, u.name);
      if (moved && !pending && (!m || m.status?.phase === 'Succeeded')) return { status: 'done' };
      if (m?.status?.phase === 'Failed') return { status: 'running', message: `Copy failed, KubeVirt retries: ${migrationFailure(m)}` };
      return { status: 'running', message: migrationPhaseWords(m?.status?.phase) ?? 'Copying the disk' };
    }
    case 'dataVolume': {
      const dv = w.dataVolume(u.namespace, u.name);
      if (!dv) return null;
      const phase = dv.status?.phase;
      const progress = parseFloat(String(dv.status?.progress ?? '').replace('%', ''));
      if (phase === 'Succeeded') return { status: 'done', progress: 100 };
      if (phase === 'Failed') return { status: 'failed', message: dv.status?.conditions?.find((c: any) => c.type === 'Running')?.message };
      return { status: 'running', progress: isFinite(progress) ? progress : undefined };
    }
    case 'snapshot': {
      const s = w.snapshot(u.namespace, u.name);
      if (!s) return null;
      if (s.status?.readyToUse) return { status: 'done' };
      if (s.status?.phase === 'Failed') return { status: 'failed', message: s.status?.error?.message };
      return null;
    }
    case 'restore': {
      const r = w.restore(u.namespace, u.name);
      if (!r) return null;
      if (r.status?.complete) return { status: 'done' };
      return null;
    }
    case 'diskMove':
      // Advanced (with writes) by src/api/move.ts, not here.
      return null;
    case 'hostDrained':
      return w.hostVmCount(u.name) === 0 ? { status: 'done' } : null;
  }
  return null;
}

/**
 * KubeVirt is still swapping volumes: the VolumesChange condition (on the VM
 * or its instance). The VM's volumeMigrationState keeps the list of migrated
 * volumes after the end, so it cannot tell.
 */
export function volumesChanging(vm: any, vmi: any): boolean {
  const on = (o: any) => (o?.status?.conditions ?? []).some((c: any) => c.type === 'VolumesChange' && c.status === 'True');
  return on(vm) || on(vmi);
}

/** What a running migration is doing, in plain words. */
export function migrationPhaseWords(phase: string | undefined): string | undefined {
  switch (phase) {
    case 'Pending':
    case 'Scheduling':
      return 'Finding a place on the target host';
    case 'Scheduled':
    case 'PreparingTarget':
      return 'Preparing the target host';
    case 'TargetReady':
    case 'Running':
      return 'Copying memory to the target host';
    default:
      return undefined;
  }
}

function migrationFailure(m: any): string {
  const c = (m.status?.conditions ?? []).find((x: any) => x.status === 'True' && /fail/i.test(x.type + x.reason));
  return c?.message || m.status?.migrationState?.failureReason || 'The migration failed';
}
