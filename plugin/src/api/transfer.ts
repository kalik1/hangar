/*
 * Copies between this PC and a VM, over a FileChannel (api/guestfiles.ts):
 * - a file up: the first chunk at offset 0 with truncate (or, for "keep
 *   both", an exclusive create first and no truncate), then each chunk of at
 *   most 1 MiB at the size so far; a failed chunk is sent again at the same
 *   offset (writes are idempotent), which also carries a transfer over a
 *   live migration's 503s; an owner set after the last chunk;
 * - a file down: reads of up to 3 MiB until the bridge says end of file;
 * - optionally the SHA-256 of the bytes sent or received against the
 *   guest's sha256sum (Get-FileHash on Windows);
 * - folders, walked on both sides, with the overwrite questions asked
 *   before the first byte moves;
 * - each copy a task in the tasks dock, with progress, speed, time left and
 *   Cancel; one copy at a time per VM, the others wait their turn.
 */

import {
  Choice,
  ConflictPolicy,
  FileError,
  FileVersion,
  GuestFile,
  hashSame,
  isDir,
  joinPath,
  keepBothName,
  progressText,
  RateMeter,
  READ_CHUNK,
  statSame,
  TRANSFER_RETRY_MS,
  WRITE_CHUNK,
} from '../model/guestfiles';
import { Sha256 } from '../model/sha256';
import { tasks } from '../model/tasks';
import { cancelled, FileChannel, GuestFileError, isFileError, Sleep, toFileError, withRetry } from './guestfiles';
import { LocalDir, LocalFileHandle, Sink, Source } from './localfs';

export interface TransferOptions {
  signal?: AbortSignal;
  /** Bytes of this file done so far. */
  onBytes?: (done: number) => void;
  /** Compare the SHA-256 with the guest's. */
  verify?: boolean;
  pauses?: number[];
  sleep?: Sleep;
  /** A chunk is being sent again (the agent reconnects, the VM moves). */
  onRetry?: (e: GuestFileError, attempt: number) => void;
}

export interface Owner {
  owner?: string;
  group?: string;
}

export interface UploadResult {
  size: number;
  sha256: string;
  verified: boolean;
}

/**
 * Writes a local file to path in the VM. mode replace: create or empty it
 * (offset 0 with truncate); new: create it, failing if anything is there
 * (keep both), then write.
 */
export async function uploadFile(ch: FileChannel, path: string, src: Source, mode: 'replace' | 'new', o: TransferOptions & { owner?: Owner } = {}): Promise<UploadResult> {
  const retry = <T>(fn: () => Promise<T>) =>
    withRetry(fn, { pauses: o.pauses ?? TRANSFER_RETRY_MS, idempotent: true, signal: o.signal, sleep: o.sleep, onRetry: o.onRetry });
  const hasher = new Sha256();
  if (mode === 'new') await withRetry(() => ch.create(path, true), { pauses: o.pauses ?? TRANSFER_RETRY_MS, idempotent: false, signal: o.signal, sleep: o.sleep });
  let offset = 0;
  if (src.size === 0 && mode === 'replace') await retry(() => ch.write(path, 0, true, new Uint8Array(0), o.signal));
  while (offset < src.size) {
    if (o.signal?.aborted) throw cancelled();
    const end = Math.min(offset + WRITE_CHUNK, src.size);
    const bytes = await src.read(offset, end);
    if (bytes.length !== end - offset) throw new GuestFileError({ reason: 'Failed', message: `${src.name} changed on this PC during the copy` });
    const at = offset;
    await retry(() => ch.write(path, at, mode === 'replace' && at === 0, bytes, o.signal));
    hasher.update(bytes);
    offset = end;
    o.onBytes?.(offset);
  }
  if (o.owner && (o.owner.owner || o.owner.group)) await ch.chown(path, o.owner.owner, o.owner.group);
  const sha256 = hasher.hex();
  if (o.verify) {
    const h = await retry(() => ch.hash(path, o.signal));
    if (h.hash.toLowerCase() !== sha256 || h.size !== src.size)
      throw new GuestFileError({ reason: 'Failed', message: `${path}: the SHA-256 in the VM (${h.hash.slice(0, 12)}…, ${h.size} bytes) is not this PC's (${sha256.slice(0, 12)}…)` });
  }
  return { size: src.size, sha256, verified: !!o.verify };
}

export interface DownloadResult {
  size: number;
  mtime?: string;
  sha256: string;
  verified: boolean;
  /** The file's size changed between reads: it changed in the VM during the copy. */
  changed: boolean;
}

/** Reads path from the VM into a local sink. */
export async function downloadFile(ch: FileChannel, path: string, sink: Sink, o: TransferOptions = {}): Promise<DownloadResult> {
  const retry = <T>(fn: () => Promise<T>) =>
    withRetry(fn, { pauses: o.pauses ?? TRANSFER_RETRY_MS, idempotent: true, signal: o.signal, sleep: o.sleep, onRetry: o.onRetry });
  const hasher = new Sha256();
  let offset = 0;
  let size0: number | undefined;
  let mtime: string | undefined;
  let changed = false;
  try {
    for (;;) {
      if (o.signal?.aborted) throw cancelled();
      const at = offset;
      const c = await retry(() => ch.read(path, at, READ_CHUNK, o.signal));
      if (c.offset !== at) throw new GuestFileError({ reason: 'Failed', message: `${path}: the guest answered offset ${c.offset} for ${at}` });
      if (size0 === undefined) {
        size0 = c.size;
        mtime = c.mtime;
      } else if (isFinite(c.size) && c.size !== size0) changed = true;
      await sink.write(c.bytes);
      hasher.update(c.bytes);
      offset += c.bytes.length;
      o.onBytes?.(offset);
      if (c.eof) break;
      if (!c.bytes.length) throw new GuestFileError({ reason: 'Failed', message: `${path}: the guest agent read nothing at ${offset} before the end of the file` });
    }
    const sha256 = hasher.hex();
    if (o.verify) {
      const h = await retry(() => ch.hash(path, o.signal));
      if (h.hash.toLowerCase() !== sha256)
        throw new GuestFileError({
          reason: 'Failed',
          message: `${path}: the SHA-256 in the VM (${h.hash.slice(0, 12)}…) is not that of the bytes read (${sha256.slice(0, 12)}…)${changed ? '; the file changed during the copy' : ''}`,
        });
    }
    await sink.close();
    return { size: offset, mtime, sha256, verified: !!o.verify, changed };
  } catch (e) {
    await sink.abort().catch(() => undefined);
    throw toFileError(e);
  }
}

/* -------------------------------------------- versions read in this page */

/** What Hangar last read of a VM file in this page: "Replace with a local file" checks the VM copy against it. */
const versions = new Map<string, FileVersion>();
const vkey = (vm: string, path: string) => `${vm}\n${path}`;
export const rememberVersion = (vm: string, path: string, v: FileVersion) => versions.set(vkey(vm, path), v);
export const knownVersion = (vm: string, path: string) => versions.get(vkey(vm, path));

/**
 * Whether the VM copy is still the version Hangar read: same size and
 * mtime, else the same SHA-256 (a touch changes the mtime only).
 */
export async function vmCopyState(ch: FileChannel, path: string, base: FileVersion, signal?: AbortSignal): Promise<'same' | 'changed' | 'gone'> {
  let st: GuestFile;
  try {
    st = await ch.stat(path, signal);
  } catch (e) {
    if (isFileError(e) && e.reason === 'NotFound') return 'gone';
    throw e;
  }
  if (statSame(base, st)) return 'same';
  if (!base.sha256 || st.size !== base.size) return 'changed';
  return hashSame(base, await ch.hash(path, signal)) ? 'same' : 'changed';
}

/* ------------------------------------------------------------ planning */

export type UploadItem = { kind: 'file'; name: string; source: Source } | { kind: 'dir'; name: string; dir: LocalDir };

export type UploadStep =
  | { op: 'mkdir'; path: string; exclusive: boolean }
  | { op: 'upload'; path: string; source: Source; mode: 'replace' | 'new'; created: boolean };

export interface Plan<S> {
  steps: S[];
  bytes: number;
  skipped: number;
  /** Folders whose listing was partial (SELinux): what it hid is not copied. */
  partial: string[];
}

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);
const byName = (list: GuestFile[]) => new Map(list.map(e => [e.name, e]));

async function localItems(dir: LocalDir): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  for (const e of await dir.list()) {
    if (isDir(e)) out.push({ kind: 'dir', name: e.name, dir: await dir.dir(e.name, false) });
    else out.push({ kind: 'file', name: e.name, source: await dir.source(e.name) });
  }
  return out;
}

/**
 * What a copy to the VM does, with the overwrite questions answered. The
 * folder's entries are those of `existing` (the pane's listing). Throws
 * Cancelled when a question is cancelled.
 */
export async function planUpload(ch: FileChannel, items: UploadItem[], vmDir: string, existing: GuestFile[], policy: ConflictPolicy): Promise<Plan<UploadStep>> {
  const plan: Plan<UploadStep> = { steps: [], bytes: 0, skipped: 0, partial: [] };
  const walk = async (list: UploadItem[], dir: string, there: Map<string, GuestFile> | null) => {
    const taken = new Set(there?.keys() ?? []);
    for (const it of list) {
      const ex = there?.get(it.name);
      let name = it.name;
      let choice: Choice | 'merge' | undefined;
      if (ex) {
        const incoming = it.kind === 'file' ? { type: 'file' as const, size: it.source.size, mtime: iso(it.source.lastModified) } : { type: 'directory' as const, size: 0 };
        const d = await policy.decide({ name: it.name, where: 'the VM', existing: ex, incoming });
        if (d === null) throw cancelled();
        if (d === 'skip') {
          plan.skipped++;
          continue;
        }
        choice = d;
        if (d === 'keepBoth') name = keepBothName(it.name, n => taken.has(n));
      }
      taken.add(name);
      const path = joinPath(dir, name, ch.windows);
      if (it.kind === 'file') {
        plan.steps.push({ op: 'upload', path, source: it.source, mode: choice === 'keepBoth' ? 'new' : 'replace', created: !ex || choice === 'keepBoth' });
        plan.bytes += it.source.size;
      } else {
        if (choice !== 'merge') plan.steps.push({ op: 'mkdir', path, exclusive: choice === 'keepBoth' });
        let inside: Map<string, GuestFile> | null = null;
        if (choice === 'merge') {
          const l = await ch.list(path);
          if (l.partial) plan.partial.push(path);
          inside = byName(l.entries);
        }
        await walk(await localItems(it.dir), path, inside);
      }
    }
  };
  await walk(items, vmDir, byName(existing));
  return plan;
}

export type DownloadStep = { op: 'mkdir'; local: string[] } | { op: 'download'; path: string; local: string[]; size: number };

/**
 * What a copy to this PC's folder does: the VM entries picked in vmDir,
 * folders walked in the VM, questions asked against the local folder.
 * Links and devices inside folders are not copied (counted as skipped).
 */
export async function planDownload(ch: FileChannel, entries: GuestFile[], vmDir: string, local: LocalDir, policy: ConflictPolicy): Promise<Plan<DownloadStep>> {
  const plan: Plan<DownloadStep> = { steps: [], bytes: 0, skipped: 0, partial: [] };
  const walk = async (list: GuestFile[], dir: string, there: LocalDir | null, at: string[], top: boolean) => {
    const existing = there ? byName(await there.list()) : null;
    const taken = new Set(existing?.keys() ?? []);
    for (const e of list) {
      const folder = isDir(e);
      if (!folder && e.type !== 'file' && !(top && e.type === 'symlink')) {
        plan.skipped++;
        continue;
      }
      const ex = existing?.get(e.name);
      let name = e.name;
      let choice: Choice | 'merge' | undefined;
      if (ex) {
        const d = await policy.decide({ name: e.name, where: 'this PC', existing: ex, incoming: { type: folder ? 'directory' : 'file', size: e.size, mtime: e.mtime } });
        if (d === null) throw cancelled();
        if (d === 'skip') {
          plan.skipped++;
          continue;
        }
        choice = d;
        if (d === 'keepBoth') name = keepBothName(e.name, n => taken.has(n));
      }
      taken.add(name);
      const path = joinPath(dir, e.name, ch.windows);
      if (!folder) {
        plan.steps.push({ op: 'download', path, local: [...at, name], size: e.size });
        plan.bytes += e.size;
        continue;
      }
      if (choice !== 'merge') plan.steps.push({ op: 'mkdir', local: [...at, name] });
      const l = await ch.list(path);
      if (l.partial) plan.partial.push(path);
      await walk(l.entries, path, choice === 'merge' && there ? await there.dir(e.name, false) : null, [...at, name], false);
    }
  };
  await walk(entries, vmDir, local, [], true);
  return plan;
}

/* ------------------------------------------------------------ running */

export interface StepFailure {
  path: string;
  error: FileError;
}

export interface RunResult {
  done: number;
  failed: StepFailure[];
  bytes: number;
}

/** Errors after which no other step can work: stop the copy. */
const FATAL = new Set<FileError['reason']>(['Cancelled', 'Blocked', 'Forbidden', 'Absent', 'NotConnected', 'NotResponding', 'Unavailable', 'Network', 'TooLarge']);
export const fatal = (e: FileError) => FATAL.has(e.reason);

export interface RunOptions extends TransferOptions {
  owner?: Owner;
  /** Total bytes done of the plan, and the file at hand. */
  onProgress?: (done: number, current: string) => void;
  /** A step finished: the version read or written, for later checks. */
  onVersion?: (path: string, v: FileVersion) => void;
}

const under = (p: string, dirs: string[], win: boolean) => dirs.some(d => p.startsWith(d + (win ? '\\' : '/')));

/** Runs a copy to the VM. A file the copy created and did not finish is deleted again. */
export async function runUpload(ch: FileChannel, plan: Plan<UploadStep>, o: RunOptions = {}): Promise<RunResult> {
  const res: RunResult = { done: 0, failed: [], bytes: 0 };
  const failedDirs: string[] = [];
  for (const s of plan.steps) {
    if (o.signal?.aborted) throw cancelled();
    if (under(s.path, failedDirs, ch.windows)) {
      res.failed.push({ path: s.path, error: { reason: 'Failed', message: `${s.path}: its folder could not be made` } });
      continue;
    }
    const base = res.bytes;
    try {
      if (s.op === 'mkdir') {
        await withRetry(() => ch.mkdir(s.path, s.exclusive), { pauses: o.pauses ?? TRANSFER_RETRY_MS, idempotent: false, signal: o.signal, sleep: o.sleep });
        if (o.owner && (o.owner.owner || o.owner.group)) await ch.chown(s.path, o.owner.owner, o.owner.group);
      } else {
        o.onProgress?.(base, s.path);
        const r = await uploadFile(ch, s.path, s.source, s.mode, {
          ...o,
          owner: s.created ? o.owner : undefined,
          onBytes: n => o.onProgress?.(base + n, s.path),
        }).catch(async e => {
          const fe = toFileError(e);
          // A new file that did not arrive whole is not left behind; a replaced one is incomplete.
          if (fe.reason !== 'Cancelled') throw fe;
          if (s.created) await ch.remove(s.path, false).catch(() => undefined);
          throw new GuestFileError({ reason: 'Cancelled', message: s.created ? 'Cancelled' : `Cancelled: ${s.path} is incomplete in the VM` });
        });
        res.bytes += s.source.size;
        o.onVersion?.(s.path, { size: r.size, sha256: r.sha256 });
      }
      res.done++;
    } catch (e) {
      const fe = toFileError(e);
      if (fatal(fe)) throw fe;
      if (s.op === 'mkdir') failedDirs.push(s.path);
      else res.bytes = base + s.source.size;
      res.failed.push({ path: s.path, error: fe });
    }
  }
  return res;
}

/** Runs a copy to this PC's folder; a file is final only once whole (the browser writes a swap file). */
export async function runDownload(ch: FileChannel, plan: Plan<DownloadStep>, root: LocalDir, o: RunOptions & { onHandle?: (path: string, h: LocalFileHandle) => void } = {}): Promise<RunResult> {
  const res: RunResult = { done: 0, failed: [], bytes: 0 };
  const dirs = new Map<string, LocalDir>([['', root]]);
  const dirAt = async (names: string[]): Promise<LocalDir> => {
    let cur = root;
    for (let i = 0; i < names.length; i++) {
      const k = names.slice(0, i + 1).join('/');
      let next = dirs.get(k);
      if (!next) {
        next = await cur.dir(names[i], true);
        dirs.set(k, next);
      }
      cur = next;
    }
    return cur;
  };
  for (const s of plan.steps) {
    if (o.signal?.aborted) throw cancelled();
    const base = res.bytes;
    try {
      if (s.op === 'mkdir') await dirAt(s.local);
      else {
        o.onProgress?.(base, s.path);
        const parent = await dirAt(s.local.slice(0, -1));
        const { sink, handle } = await parent.create(s.local[s.local.length - 1]);
        const r = await downloadFile(ch, s.path, sink, { ...o, onBytes: n => o.onProgress?.(base + n, s.path) });
        res.bytes += Math.max(s.size, r.size);
        o.onVersion?.(s.path, { size: r.size, mtime: r.mtime, sha256: r.sha256 });
        o.onHandle?.(s.path, handle);
      }
      res.done++;
    } catch (e) {
      const fe = toFileError(e);
      if (fatal(fe)) throw fe;
      if (s.op === 'download') res.bytes = base + s.size;
      res.failed.push({ path: s.op === 'download' ? s.path : s.local.join('/'), error: fe });
    }
  }
  return res;
}

/* ------------------------------------------------------- as a task */

const queues = new Map<string, Promise<unknown>>();

export interface TaskContext {
  signal: AbortSignal;
  /** Total bytes done, the plan's bytes, the file at hand. */
  progress: (done: number, total: number, current?: string) => void;
  message: (text: string) => void;
}

/**
 * Runs a copy as a task of the VM, after the copies before it on the same
 * VM: progress, speed and time left in the tasks dock, with Cancel. `body`
 * returns the final message and status.
 */
export function runAsTask(
  vm: { namespace: string; name: string },
  title: string,
  body: (t: TaskContext) => Promise<{ status: 'done' | 'warning' | 'failed'; message: string }>
): Promise<void> {
  const ctl = new AbortController();
  const task = tasks.add({ title, target: { kind: 'vm', namespace: vm.namespace, name: vm.name }, timeoutMs: 24 * 60 * 60 * 1000 });
  tasks.setCancel(task.id, () => ctl.abort());
  const k = `${vm.namespace}/${vm.name}`;
  const before = queues.get(k);
  if (before) tasks.update(task.id, { message: 'Waiting for the copy before it' });
  const meter = new RateMeter();
  let last = 0;
  const ctx: TaskContext = {
    signal: ctl.signal,
    progress: (done, total, current) => {
      const now = Date.now();
      const rate = meter.sample(done, now);
      if (now - last < 500 && done < total) return;
      last = now;
      const name = current ? current.split(/[\\/]/).pop() : undefined;
      tasks.update(task.id, { progress: total > 0 ? Math.min(100, (done / total) * 100) : undefined, message: `${progressText(done, total, rate)}${name ? ` · ${name}` : ''}` });
    },
    message: text => tasks.update(task.id, { message: text }),
  };
  const run = (before ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (ctl.signal.aborted) throw cancelled();
      return body(ctx);
    })
    .then(
      r => tasks.update(task.id, { status: r.status, message: r.message, progress: r.status === 'done' ? 100 : undefined }),
      e => {
        const fe = toFileError(e);
        tasks.update(task.id, { status: fe.reason === 'Cancelled' ? 'warning' : 'failed', message: fe.message, progress: undefined });
      }
    )
    .finally(() => {
      tasks.setCancel(task.id, null);
      if (queues.get(k) === run) queues.delete(k);
    });
  queues.set(k, run);
  return run;
}

/** Transfers running on this page: leaving it would cut them. */
export const transfersRunning = () => queues.size > 0;
