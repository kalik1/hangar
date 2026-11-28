/*
 * The Files tab's channel to a VM's files: the guest bridge's guestfiles
 * subresource (subresources.hangar.magesgate.com/v1alpha1). Transfers go
 * through the FileChannel interface only, so another channel (SFTP over
 * KubeVirt's portforward, later) can take its place.
 */

import React from 'react';
import {
  BRIDGE_GROUP,
  classifyError,
  FileError,
  FileVerb,
  GuestFile,
  GuestFileHash,
  GuestFileList,
  GuestFileOp,
  GUESTFILES,
  GuestFileWrite,
  LIST_LIMIT,
  OP_METHOD,
  QUICK_RETRY_MS,
  ReadChunk,
  retryable,
} from '../model/guestfiles';
import { BRIDGE_VERSION } from '../model/guestinfo';
import { kraw } from './client';
import { can } from './permissions';

/** A failed file operation, with what it means (model/guestfiles.ts classifyError). */
export class GuestFileError extends Error implements FileError {
  reason: FileError['reason'];
  status?: number;
  commands?: string[];
  constructor(e: FileError) {
    super(e.message);
    this.reason = e.reason;
    this.status = e.status;
    this.commands = e.commands;
  }
}

export const isFileError = (e: unknown): e is GuestFileError => e instanceof GuestFileError;

/** A rejection of kraw (Headlamp's "Status text - message") as a GuestFileError. */
export function toFileError(e: any): GuestFileError {
  if (e instanceof GuestFileError) return e;
  if (e?.cancelled || e?.name === 'AbortError') return new GuestFileError({ reason: 'Cancelled', message: 'Cancelled' });
  const m = String(e?.message ?? e);
  const msg = m.includes(' - ') ? m.split(' - ').slice(1).join(' - ') : m;
  return new GuestFileError(classifyError(e?.status, msg));
}

export const cancelled = () => new GuestFileError({ reason: 'Cancelled', message: 'Cancelled' });

/** The calls of the Files tab. Each throws a GuestFileError. */
export interface FileChannel {
  /** Windows paths (C:\…). */
  readonly windows: boolean;
  /** Every page of a directory's listing. */
  list(path: string, signal?: AbortSignal): Promise<GuestFileList>;
  stat(path: string, signal?: AbortSignal): Promise<GuestFile>;
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<ReadChunk>;
  hash(path: string, signal?: AbortSignal): Promise<GuestFileHash>;
  write(path: string, offset: number, truncate: boolean, body: Uint8Array, signal?: AbortSignal): Promise<GuestFileWrite>;
  create(path: string, exclusive: boolean): Promise<GuestFile>;
  mkdir(path: string, exclusive: boolean): Promise<GuestFile>;
  rename(from: string, to: string, exclusive: boolean): Promise<GuestFile>;
  chown(path: string, owner?: string, group?: string): Promise<GuestFile>;
  remove(path: string, recursive: boolean): Promise<void>;
}

/* ------------------------------------------------------------ retries */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Calls fn, and again after each pause while it fails with a state worth
 * waiting out (the agent reconnecting, the VM moving to another host). The
 * bridge's retryAfterSeconds does not reach Hangar (Headlamp keeps only an
 * error's message): the pauses are fixed.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  o: { pauses: number[]; idempotent: boolean; signal?: AbortSignal; sleep?: Sleep; onRetry?: (e: GuestFileError, attempt: number) => void }
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw cancelled();
    try {
      return await fn();
    } catch (err) {
      const e = toFileError(err);
      if (o.signal?.aborted) throw cancelled();
      if (attempt >= o.pauses.length || !retryable(e, o.idempotent)) throw e;
      o.onRetry?.(e, attempt + 1);
      await (o.sleep ?? sleep)(o.pauses[attempt], o.signal);
    }
  }
}

/* ------------------------------------------------------------ the bridge */

export const guestFilesPath = (namespace: string, name: string) =>
  `/apis/${BRIDGE_GROUP}/${BRIDGE_VERSION}/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstances/${encodeURIComponent(name)}/${GUESTFILES}`;

const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v));

/** The bridge's channel to one VM. */
export function bridgeChannel(namespace: string, name: string, windows: boolean, o: { sleep?: Sleep } = {}): FileChannel {
  const path = guestFilesPath(namespace, name);
  const call = <T>(op: GuestFileOp, params: Record<string, string>, read: (r: Response) => Promise<T>, extra: { body?: Uint8Array; signal?: AbortSignal } = {}) =>
    kraw(path, { method: OP_METHOD[op], query: { op, ...params }, body: extra.body as BodyInit | undefined, signal: extra.signal, accept: op === 'read' ? '*/*' : 'application/json' }, read).catch(e => {
      throw toFileError(e);
    });
  const json = <T>(r: Response) => r.json() as Promise<T>;
  const quick = <T>(fn: () => Promise<T>, signal?: AbortSignal) => withRetry(fn, { pauses: QUICK_RETRY_MS, idempotent: true, signal, sleep: o.sleep });
  const bool = (b: boolean) => (b ? 'true' : 'false');

  const page = (dir: string, cursor: string | undefined, signal?: AbortSignal) =>
    quick(() => call<GuestFileList>('list', { path: dir, ...(cursor ? { cursor } : {}), limit: String(LIST_LIMIT) }, json, { signal }), signal);

  return {
    windows,
    async list(dir, signal) {
      // A cursor the bridge forgot (30 minutes, a guest reboot) answers Expired: list again, twice at most.
      for (let round = 0; ; round++) {
        try {
          const first = await page(dir, undefined, signal);
          const entries = [...(first.entries ?? [])];
          let cursor = first.cursor;
          while (cursor) {
            const next = await page(dir, cursor, signal);
            entries.push(...(next.entries ?? []));
            cursor = next.cursor;
          }
          return { entries, partial: !!first.partial, partialReason: first.partialReason };
        } catch (e) {
          if (isFileError(e) && e.reason === 'Expired' && round < 2) continue;
          throw e;
        }
      }
    },
    stat: (p, signal) => quick(() => call<GuestFile>('stat', { path: p }, json, { signal }), signal),
    read: (p, offset, length, signal) =>
      call<ReadChunk>(
        'read',
        { path: p, offset: String(offset), length: String(length) },
        async r => {
          const bytes = new Uint8Array(await r.arrayBuffer());
          // A body shorter than its length: the file changed during the read. Read again.
          // (A compressed answer's length is the compressed one: not comparable.)
          const encoded = (r.headers.get('Content-Encoding') ?? 'identity') !== 'identity';
          const declared = encoded ? undefined : num(r.headers.get('Content-Length'));
          if (declared !== undefined && bytes.length < declared)
            throw new GuestFileError({ reason: 'Network', message: `${p} changed during the read: ${bytes.length} of ${declared} bytes` });
          const eofHeader = r.headers.get('X-Hangar-File-Eof');
          return {
            bytes,
            offset: num(r.headers.get('X-Hangar-File-Offset')) ?? offset,
            size: num(r.headers.get('X-Hangar-File-Size')) ?? NaN,
            mtime: r.headers.get('X-Hangar-File-Mtime') ?? undefined,
            // Without the header (a proxy dropped it), a short answer is the end.
            eof: eofHeader === null ? bytes.length < length : eofHeader === 'true',
          };
        },
        { signal }
      ),
    hash: (p, signal) => quick(() => call<GuestFileHash>('hash', { path: p }, json, { signal }), signal),
    write: (p, offset, truncate, body, signal) =>
      call<GuestFileWrite>('write', { path: p, offset: String(offset), ...(truncate ? { truncate: 'true' } : {}) }, json, { body, signal }),
    create: (p, exclusive) => call<GuestFile>('create', { path: p, exclusive: bool(exclusive) }, json),
    mkdir: (p, exclusive) => call<GuestFile>('mkdir', { path: p, exclusive: bool(exclusive) }, json),
    rename: (from, to, exclusive) => call<GuestFile>('rename', { from, to, exclusive: bool(exclusive) }, json),
    chown: (p, owner, group) => call<GuestFile>('chown', { path: p, ...(owner ? { owner } : {}), ...(group ? { group } : {}) }, json),
    remove: async (p, recursive) => {
      await call('delete', { path: p, recursive: bool(recursive) }, async () => undefined);
    },
  };
}

/* -------------------------------------------------------- permissions */

export interface FilePerms {
  loading: boolean;
  get: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}

const VERBS: FileVerb[] = ['get', 'create', 'update', 'delete'];

/** The user's verbs on this VM's guestfiles (SelfSubjectAccessReviews that name the VM: resourceNames bindings count). */
export function useFilePerms(namespace: string, name: string): FilePerms {
  const [perms, setPerms] = React.useState<FilePerms>({ loading: true, get: false, create: false, update: false, delete: false });
  React.useEffect(() => {
    let alive = true;
    setPerms(p => ({ ...p, loading: true }));
    Promise.all(VERBS.map(verb => can({ verb, group: BRIDGE_GROUP, resource: 'virtualmachineinstances', subresource: GUESTFILES, namespace, name }))).then(
      ([get, create, update, del]) => alive && setPerms({ loading: false, get, create, update, delete: del })
    );
    return () => {
      alive = false;
    };
  }, [namespace, name]);
  return perms;
}
