/*
 * A fake guest for the Files tab's tests: an in-memory filesystem behind
 * the FileChannel interface, with the guest bridge's rules (truncate only at
 * offset 0, writes without it on an existing file at most at its end,
 * exclusive create and mkdir, partial listings) and, optionally, an agent
 * that SELinux confines (writes outside /tmp and /var/tmp denied) and
 * failures to inject.
 */

import { classifyError, FileError, GuestFile, GuestFileType, ReadChunk } from '../model/guestfiles';
import { sha256Hex } from '../model/sha256';
import { FileChannel, GuestFileError } from './guestfiles';

interface Node {
  type: GuestFileType;
  data: Uint8Array;
  mode: number;
  uid: number;
  gid: number;
  user: string;
  group: string;
  mtime: string;
}

export interface Call {
  op: string;
  path: string;
  offset?: number;
  truncate?: boolean;
  length?: number;
  bytes?: number;
  exclusive?: boolean;
  to?: string;
  owner?: string;
  group?: string;
}

const fail = (status: number, message: string) => new GuestFileError(classifyError(status, message));

export class FakeGuest implements FileChannel {
  nodes = new Map<string, Node>();
  calls: Call[] = [];
  /** Entries a confined agent cannot see, per directory. */
  hidden = new Map<string, number>();
  /** SELinux confines the agent: writes outside /tmp and /var/tmp are denied. */
  confined = false;
  private failures: { op: string; times: number; error: FileError }[] = [];
  private clock = Date.UTC(2026, 10, 28, 12);

  constructor(readonly windows = false) {
    this.mk('/', 'directory');
  }

  /** The next `times` calls of op fail with this error. */
  failNext(op: string, status: number, message: string, times = 1) {
    this.failures.push({ op, times, error: classifyError(status, message) });
  }

  file(path: string, content: string | Uint8Array, owner = 'root') {
    this.ensureParents(path);
    const n = this.mk(path, 'file', owner);
    n.data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    return this;
  }

  dir(path: string, owner = 'root') {
    this.ensureParents(path);
    this.mk(path, 'directory', owner);
    return this;
  }

  text(path: string): string {
    return new TextDecoder().decode(this.nodes.get(path)?.data);
  }

  /** Changes a file as the guest would (a user's edit in the VM). */
  touch(path: string, content?: string) {
    const n = this.nodes.get(path) as Node;
    if (content !== undefined) n.data = new TextEncoder().encode(content);
    n.mtime = this.tick();
  }

  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace('Z', '123456Z');
  }

  private mk(path: string, type: GuestFileType, owner = 'root'): Node {
    const n: Node = { type, data: new Uint8Array(0), mode: type === 'directory' ? 0o755 : 0o644, uid: owner === 'root' ? 0 : 1000, gid: owner === 'root' ? 0 : 1000, user: owner, group: owner, mtime: this.tick() };
    this.nodes.set(path, n);
    return n;
  }

  private parent(path: string) {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  }

  private ensureParents(path: string) {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts.slice(0, -1)) {
      cur += `/${p}`;
      if (!this.nodes.has(cur)) this.mk(cur, 'directory');
    }
  }

  private entry(path: string): GuestFile {
    const n = this.nodes.get(path) as Node;
    const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    return { name, type: n.type, size: n.type === 'directory' ? 4096 : n.data.length, mode: n.mode, uid: n.uid, gid: n.gid, user: n.user, group: n.group, mtime: n.mtime };
  }

  private gate(c: Call) {
    this.calls.push(c);
    const f = this.failures.find(x => x.op === c.op && x.times > 0);
    if (f) {
      f.times--;
      throw new GuestFileError(f.error);
    }
  }

  private writable(path: string) {
    if (this.confined && !/^\/(var\/)?tmp(\/|$)/.test(path))
      throw fail(
        403,
        `${path}: failed to open file '${path}' (mode: 'w'): Permission denied (the guest's permissions, or SELinux, which confines the guest agent on Fedora and the RHEL family to /tmp and /var/tmp for writes unless the guest is changed to let it reach every file)`
      );
  }

  private need(path: string): Node {
    const n = this.nodes.get(path);
    if (!n) throw fail(404, `${path}: No such file or directory`);
    return n;
  }

  async list(path: string) {
    this.gate({ op: 'list', path });
    const n = this.need(path);
    if (n.type !== 'directory') throw fail(409, `${path}: Not a directory`);
    const prefix = path === '/' ? '/' : `${path}/`;
    const entries = [...this.nodes.keys()].filter(k => k !== path && k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map(k => this.entry(k));
    const hidden = this.hidden.get(path) ?? 0;
    return hidden
      ? {
          entries,
          partial: true,
          partialReason: `SELinux confines the guest agent in this guest: the guest agent could not read ${hidden} entries of this directory, which the listing leaves out (find: '${prefix}x': Permission denied)`,
        }
      : { entries, partial: false };
  }

  async stat(path: string) {
    this.gate({ op: 'stat', path });
    this.need(path);
    return this.entry(path);
  }

  async read(path: string, offset: number, length: number): Promise<ReadChunk> {
    this.gate({ op: 'read', path, offset, length });
    const n = this.need(path);
    if (n.type !== 'file') throw fail(409, `${path}: Is a directory`);
    const bytes = n.data.slice(offset, offset + length);
    return { bytes, offset, size: n.data.length, mtime: offset === 0 ? n.mtime : n.mtime, eof: offset + bytes.length >= n.data.length };
  }

  async hash(path: string) {
    this.gate({ op: 'hash', path });
    const n = this.need(path);
    return { algorithm: 'sha256', hash: sha256Hex(n.data), size: n.data.length, mtime: n.mtime };
  }

  async write(path: string, offset: number, truncate: boolean, body: Uint8Array) {
    this.gate({ op: 'write', path, offset, truncate, bytes: body.length });
    if (truncate && offset !== 0) throw fail(400, 'offset: truncate starts the file again, at offset 0');
    this.writable(path);
    let n = this.nodes.get(path);
    if (!n) {
      if (!truncate) throw fail(404, `${path}: No such file or directory`);
      if (!this.nodes.has(this.parent(path))) throw fail(404, `${this.parent(path)}: No such file or directory`);
      n = this.mk(path, 'file');
    }
    if (n.type !== 'file') throw fail(409, `${path}: Is a directory`);
    if (truncate) n.data = new Uint8Array(0);
    if (offset > n.data.length) throw fail(409, `offset: ${offset} is past the end of ${path}`);
    const next = new Uint8Array(Math.max(n.data.length, offset + body.length));
    next.set(n.data);
    next.set(body, offset);
    n.data = next;
    n.mtime = this.tick();
    return { written: body.length, size: n.data.length };
  }

  async create(path: string, exclusive: boolean) {
    this.gate({ op: 'create', path, exclusive });
    this.writable(path);
    if (this.nodes.has(path) && exclusive) throw fail(409, `${path}: File exists`);
    if (!this.nodes.has(this.parent(path))) throw fail(404, `${this.parent(path)}: No such file or directory`);
    this.mk(path, 'file');
    return this.entry(path);
  }

  async mkdir(path: string, exclusive: boolean) {
    this.gate({ op: 'mkdir', path, exclusive });
    this.writable(path);
    const n = this.nodes.get(path);
    if (n && (exclusive || n.type !== 'directory')) throw fail(409, `${path}: File exists`);
    if (!n) {
      this.ensureParents(path);
      this.mk(path, 'directory');
    }
    return this.entry(path);
  }

  async rename(from: string, to: string, exclusive: boolean) {
    this.gate({ op: 'rename', path: from, to, exclusive });
    this.writable(to);
    const n = this.need(from);
    if (this.nodes.has(to) && exclusive) throw fail(409, `${to}: File exists`);
    for (const [k, v] of [...this.nodes]) {
      if (k === from || k.startsWith(`${from}/`)) {
        this.nodes.delete(k);
        this.nodes.set(to + k.slice(from.length), v);
      }
    }
    void n;
    return this.entry(to);
  }

  async chown(path: string, owner?: string, group?: string) {
    this.gate({ op: 'chown', path, owner, group });
    const n = this.need(path);
    if (owner) n.user = owner;
    if (group) n.group = group;
    return this.entry(path);
  }

  async remove(path: string, recursive: boolean) {
    this.gate({ op: 'delete', path });
    this.writable(path);
    this.need(path);
    const inside = [...this.nodes.keys()].filter(k => k.startsWith(`${path}/`));
    if (inside.length && !recursive) throw fail(409, `${path}: Directory not empty`);
    for (const k of [path, ...inside]) this.nodes.delete(k);
  }

  /** The ops called, as "op path[@offset][!truncate]". */
  log(op?: string): string[] {
    return this.calls
      .filter(c => !op || c.op === op)
      .map(c => `${c.op} ${c.path}${c.offset !== undefined ? `@${c.offset}` : ''}${c.truncate ? '!' : ''}${c.to ? ` → ${c.to}` : ''}`);
  }
}

/** Bytes 0..n-1 with a pattern. */
export function pattern(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 7 + (i >> 8)) & 0xff;
  return d;
}

/** A local folder in memory, for the copies to and from this PC. */
export class FakeLocalDir {
  files = new Map<string, { data: Uint8Array; lastModified: number }>();
  dirs = new Map<string, FakeLocalDir>();
  constructor(readonly name: string) {}

  async list() {
    return [
      ...[...this.dirs.keys()].map(n => ({ name: n, type: 'directory' as const, size: 0 })),
      ...[...this.files].map(([n, f]) => ({ name: n, type: 'file' as const, size: f.data.length, mtime: new Date(f.lastModified).toISOString() })),
    ];
  }
  async dir(name: string, create: boolean) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!create) throw new Error(`${name}: not found`);
      d = new FakeLocalDir(name);
      this.dirs.set(name, d);
    }
    return d as any;
  }
  async source(name: string) {
    const f = this.files.get(name);
    if (!f) throw new Error(`${name}: not found`);
    return { name, size: f.data.length, lastModified: f.lastModified, read: async (s: number, e: number) => f.data.slice(s, e) };
  }
  async create(name: string) {
    const parts: Uint8Array[] = [];
    const handle = { name, getFile: async () => new File([this.files.get(name)?.data ?? new Uint8Array(0)] as BlobPart[], name), createWritable: async () => undefined };
    return {
      handle,
      sink: {
        write: async (b: Uint8Array) => {
          parts.push(b);
        },
        close: async () => {
          const size = parts.reduce((n, p) => n + p.length, 0);
          const data = new Uint8Array(size);
          let o = 0;
          for (const p of parts) {
            data.set(p, o);
            o += p.length;
          }
          this.files.set(name, { data, lastModified: Date.now() });
        },
        abort: async () => undefined,
      },
    };
  }
  async handle(name: string) {
    return (await this.create(name)).handle;
  }
  async remove(name: string) {
    this.files.delete(name);
    this.dirs.delete(name);
  }
  async permission() {
    return 'granted' as const;
  }
  async requestPermission() {
    return true;
  }
}
