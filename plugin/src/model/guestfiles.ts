/*
 * The Files tab's pure logic (hangar#6): the guest bridge's guestfiles
 * subresource (bridge/internal/apis/v1alpha1/guestfiles.go, mirrored
 * below), what its errors mean, guest paths (Linux and Windows), the roots,
 * sorting, the overwrite and conflict rules, and what the guest agent may
 * reach in each OS, with the guest-side change that widens it.
 */

import { BRIDGE_GROUP, GuestAgentCommand, GuestFilesystemInfo, isWindowsId, rhelFamily } from './guestinfo';
import { formatBytes } from './units';

/* ------------------------------------------- the bridge's API (v1alpha1) */

export { BRIDGE_GROUP };
export const GUESTFILES = 'guestfiles';
/** The role with get, create, update and delete on guestfiles (distribution/rbac.yaml). */
export const GUESTFILES_ROLE = 'hangar-guest-admin';

export type GuestFileOp = 'list' | 'stat' | 'read' | 'hash' | 'write' | 'create' | 'mkdir' | 'rename' | 'chown' | 'delete';

/** Each op's HTTP method; RBAC checks its verb (GET get, PUT update, POST create, DELETE delete). */
export const OP_METHOD: Record<GuestFileOp, 'GET' | 'PUT' | 'POST' | 'DELETE'> = {
  list: 'GET',
  stat: 'GET',
  read: 'GET',
  hash: 'GET',
  write: 'PUT',
  create: 'POST',
  mkdir: 'POST',
  rename: 'POST',
  chown: 'POST',
  delete: 'DELETE',
};

export type FileVerb = 'get' | 'create' | 'update' | 'delete';

export const OP_VERB: Record<GuestFileOp, FileVerb> = {
  list: 'get',
  stat: 'get',
  read: 'get',
  hash: 'get',
  write: 'update',
  create: 'create',
  mkdir: 'create',
  rename: 'create',
  chown: 'create',
  delete: 'delete',
};

export type GuestFileType = 'file' | 'directory' | 'symlink' | 'blockDevice' | 'charDevice' | 'fifo' | 'socket' | 'other';

/** One entry of a directory, or one file's stat. */
export interface GuestFile {
  name: string;
  type: GuestFileType;
  size: number;
  /** The permission bits (decimal, up to 0o7777); Linux only. */
  mode?: number;
  uid?: number;
  gid?: number;
  /** Names where the guest knows them (GNU find; not busybox, not Windows). */
  user?: string;
  group?: string;
  /** RFC 3339 in UTC, with the guest's precision. */
  mtime?: string;
}

export interface GuestFileList {
  entries: GuestFile[];
  cursor?: string;
  partial: boolean;
  partialReason?: string;
}

export interface GuestFileHash {
  algorithm: 'sha256' | string;
  hash: string;
  size: number;
  mtime?: string;
}

export interface GuestFileWrite {
  written: number;
  size: number;
}

/** One read call's answer: the bytes and the X-Hangar-File-* headers. */
export interface ReadChunk {
  bytes: Uint8Array;
  offset: number;
  /** The file's size when it was read. */
  size: number;
  mtime?: string;
  eof: boolean;
}

/** A write call's body, at most (the bridge sends it to the agent in 128 KiB writes). */
export const WRITE_CHUNK = 1 << 20;
/** A read call's length, at most (the bridge reads it from the agent in 1 MiB reads). */
export const READ_CHUNK = 3 << 20;
/** A list page, at most. */
export const LIST_LIMIT = 5000;
/** Above this, Hangar warns that the agent channel is slow (about 15 s up, 11 s down). */
export const LARGE_FILE_BYTES = 200 * 1000 * 1000;
/** The prototype's throughput, for the warning. */
export const UP_BYTES_PER_S = 13 * 1000 * 1000;
export const DOWN_BYTES_PER_S = 19 * 1000 * 1000;

/* ------------------------------------------------------------- errors */

/**
 * What a failed call means: the bridge's causes (details.causes[0].reason),
 * read from the status and the message, because Headlamp's request keeps
 * only those; plus the API server's own answers.
 */
export type FileReason =
  /** RBAC: the user's role lacks this verb on guestfiles (no causes). */
  | 'Forbidden'
  /** The guest's agent configuration disables commands the op needs. */
  | 'Blocked'
  | 'PermissionDenied'
  | 'ReadOnlyFileSystem'
  | 'NotFound'
  | 'AlreadyExists'
  | 'NotADirectory'
  | 'IsADirectory'
  | 'DirectoryNotEmpty'
  | 'NotARegularFile'
  /** A list cursor older than 30 minutes or than a guest reboot: list again. */
  | 'Expired'
  | 'Invalid'
  | 'NotSupported'
  | 'NotResponding'
  | 'NotConnected'
  /** 503 from the API server: the bridge's pods do not answer, or the VM moves to another host. */
  | 'Unavailable'
  | 'Timeout'
  | 'NoSpace'
  | 'TooLarge'
  /** No APIService for the group (404 from the API server). */
  | 'Absent'
  /** No answer at all (the browser, Headlamp, a proxy). */
  | 'Network'
  | 'Cancelled'
  | 'Failed';

export interface FileError {
  reason: FileReason;
  status?: number;
  message: string;
  /** Blocked: the disabled commands the bridge names. */
  commands?: string[];
}

const has = (s: string, ...words: string[]) => {
  const l = s.toLowerCase();
  return words.some(w => l.includes(w));
};

/** The disabled commands of a Blocked message ("…configuration disables guest-exec, guest-exec-status (qemu-ga …"). */
export function blockedCommandsOf(message: string): string[] {
  const m = /disables (.+?) \(qemu-ga/.exec(message);
  return m ? m[1].split(/,\s*/).filter(Boolean) : [];
}

/** A failed call's meaning, from its HTTP status and the Status message. */
export function classifyError(status: number | undefined, message: string): FileError {
  const msg = message.trim();
  const e = (reason: FileReason, extra?: Partial<FileError>): FileError => ({ reason, status, message: msg, ...extra });
  switch (status) {
    case undefined:
    case 0:
    case 408:
      return e('Network');
    case 502:
      return has(msg, 'unreachable') || !msg ? e('Network') : e('Failed');
    case 403:
      if (has(msg, 'configuration disables')) return e('Blocked', { commands: blockedCommandsOf(msg) });
      if (has(msg, 'read-only file system')) return e('ReadOnlyFileSystem');
      if (has(msg, 'permission denied', 'operation not permitted', 'access is denied', 'access to the path', 'selinux')) return e('PermissionDenied');
      return e('Forbidden');
    case 404:
      return has(msg, 'could not find the requested resource') ? e('Absent') : e('NotFound');
    case 409:
      if (has(msg, 'file exists', 'already exists', 'cannot overwrite existing')) return e('AlreadyExists');
      if (has(msg, 'not a directory')) return e('NotADirectory');
      if (has(msg, 'not empty')) return e('DirectoryNotEmpty');
      if (has(msg, 'is a directory')) return e('IsADirectory');
      if (has(msg, 'not a regular file')) return e('NotARegularFile');
      if (has(msg, 'past the end')) return e('Invalid');
      return e('Failed');
    case 410:
      return e('Expired');
    case 400:
      return e('Invalid');
    case 413:
      return e('TooLarge');
    case 501:
      return e('NotSupported');
    case 503:
      if (has(msg, 'not connected', 'not configured')) return e('NotConnected');
      if (has(msg, 'respond', 'unsynced', 'not available due to an error')) return e('NotResponding');
      return e('Unavailable');
    case 504:
      return e('Timeout');
    case 507:
      return e('NoSpace');
  }
  return e('Failed');
}

/**
 * Worth sending again after a pause: the bridge did not run the op (the
 * agent is not connected or does not respond, the bridge's pods or the VM
 * are moving). `idempotent` ops (reads, and writes at the same offset) are
 * also sent again after no answer or a timeout.
 */
export function retryable(e: FileError, idempotent: boolean): boolean {
  if (e.reason === 'NotConnected' || e.reason === 'NotResponding' || e.reason === 'Unavailable') return true;
  return idempotent && (e.reason === 'Network' || e.reason === 'Timeout');
}

/** The pauses before each retry, in ms: about a minute in all, which covers a live migration. */
export const TRANSFER_RETRY_MS = [1000, 2000, 2000, 5000, 5000, 5000, 10000, 10000, 10000, 10000];
/** Interactive calls (list, stat): as the Guest tab, twice after 2 s. */
export const QUICK_RETRY_MS = [2000, 2000];

/* ------------------------------------------------------------- paths */

export const isWindowsPath = (p: string) => /^[A-Za-z]:([\\/]|$)/.test(p);

/**
 * A path in its plain form: Linux "/a/b" (no trailing slash but the root,
 * "." and ".." resolved); Windows "C:\a\b", the drive upper-case, the root
 * "C:\".
 */
export function normalizePath(p: string, win: boolean): string {
  if (win) {
    const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p.trim());
    if (!m) return p;
    const parts = resolveParts(m[2].split(/[\\/]+/));
    return `${m[1].toUpperCase()}:\\${parts.join('\\')}`;
  }
  const parts = resolveParts(p.split('/'));
  return `/${parts.join('/')}`;
}

function resolveParts(parts: string[]): string[] {
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out;
}

export function joinPath(dir: string, name: string, win: boolean): string {
  const sep = win ? '\\' : '/';
  return dir.endsWith(sep) || (!win && dir.endsWith('/')) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** The directory a path is in; null for a root. */
export function parentPath(p: string, win: boolean): string | null {
  const n = normalizePath(p, win);
  if (win) {
    if (/^[A-Z]:\\$/.test(n)) return null;
    const i = n.lastIndexOf('\\');
    return i <= 2 ? n.slice(0, 3) : n.slice(0, i);
  }
  if (n === '/') return null;
  const i = n.lastIndexOf('/');
  return i === 0 ? '/' : n.slice(0, i);
}

export function baseName(p: string, win: boolean): string {
  const n = normalizePath(p, win);
  const i = n.lastIndexOf(win ? '\\' : '/');
  return n.slice(i + 1) || n;
}

/** The path bar's segments: each with the path up to it. */
export function crumbs(p: string, win: boolean): { label: string; path: string }[] {
  const n = normalizePath(p, win);
  const out: { label: string; path: string }[] = [];
  if (win) {
    const root = n.slice(0, 3);
    out.push({ label: root, path: root });
    let cur = root;
    for (const s of n.slice(3).split('\\').filter(Boolean)) {
      cur = joinPath(cur, s, true);
      out.push({ label: s, path: cur });
    }
    return out;
  }
  out.push({ label: '/', path: '/' });
  let cur = '/';
  for (const s of n.split('/').filter(Boolean)) {
    cur = joinPath(cur, s, false);
    out.push({ label: s, path: cur });
  }
  return out;
}

/** p is dir or inside it. */
export function underPath(p: string, dir: string, win: boolean): boolean {
  const a = normalizePath(p, win);
  const b = normalizePath(dir, win);
  const sep = win ? '\\' : '/';
  const cmp = (s: string) => (win ? s.toLowerCase() : s);
  return cmp(a) === cmp(b) || cmp(a).startsWith(cmp(b.endsWith(sep) ? b : b + sep));
}

/** A name the guest can take: not empty, no separator, not "." or "..". */
export function nameProblem(name: string, win: boolean): string | null {
  if (!name.trim()) return 'Type a name.';
  if (name === '.' || name === '..') return 'Not . or ..';
  if (name.includes('/') || (win && /[\\:*?"<>|]/.test(name))) return win ? 'No \\ / : * ? " < > |' : 'No /';
  if (name.includes('\0')) return 'No NUL character';
  return null;
}

/** An owner for chown: "user", "user:group" or ":group", names or ids (Samba's "name$" too). */
export function ownerProblem(text: string): string | null {
  const name = '[A-Za-z0-9_][A-Za-z0-9_.-]*\\$?';
  return new RegExp(`^(${name}(:${name})?|:${name})$`).test(text.trim()) ? null : 'user, user:group or :group';
}

export function parseOwner(text: string): { owner?: string; group?: string } {
  const [o, g] = text.trim().split(':');
  return { owner: o || undefined, group: g || undefined };
}

/** The root a path is on: the longest mount point it is under. */
export function rootOf(path: string, roots: string[], win: boolean): string | undefined {
  return [...roots].sort((a, b) => b.length - a.length).find(r => underPath(path, r, win));
}

/* ------------------------------------------------------------- roots */

/** Where the VM pane starts: the guest's mount points (guestinfo sections=disks); / or C:\ without them. */
export function fileRoots(filesystems: GuestFilesystemInfo[] | undefined, win: boolean): string[] {
  const out: string[] = [];
  for (const f of filesystems ?? []) {
    const mp = (f.mountpoint ?? '').trim();
    if (!mp) continue;
    if (win) {
      if (!isWindowsPath(mp)) continue;
      const r = normalizePath(mp, true);
      if (!out.includes(r)) out.push(r);
    } else if (mp.startsWith('/')) {
      const r = normalizePath(mp, false);
      if (!out.includes(r)) out.push(r);
    }
  }
  const root = win ? 'C:\\' : '/';
  if (!win && !out.includes(root)) out.push(root);
  if (win && !out.length) out.push(root);
  return out.sort((a, b) => (a === root ? -1 : b === root ? 1 : a.localeCompare(b)));
}

/* ----------------------------------------------------------- entries */

export type SortKey = 'name' | 'size' | 'mtime' | 'mode' | 'owner';

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
const byName = (a: string, b: string) => (collator ? collator.compare(a, b) : a.localeCompare(b));

/** RFC 3339 with up to nanoseconds, as ms since the epoch. */
export function mtimeMs(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
  return isFinite(t) ? t : undefined;
}

export const isDir = (e: Pick<GuestFile, 'type'>) => e.type === 'directory';

export const ownerOf = (e: GuestFile) => (e.user ?? (e.uid !== undefined ? String(e.uid) : '')) + (e.group || e.gid !== undefined ? `:${e.group ?? e.gid}` : '');

/** Folders first, then by the key; names break ties. */
export function sortEntries<T extends GuestFile>(list: T[], key: SortKey, desc = false): T[] {
  const val = (e: T): number | string => {
    switch (key) {
      case 'size':
        return e.size;
      case 'mtime':
        return mtimeMs(e.mtime) ?? 0;
      case 'mode':
        return e.mode ?? -1;
      case 'owner':
        return ownerOf(e);
      default:
        return e.name;
    }
  };
  const sign = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
    const va = val(a);
    const vb = val(b);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : byName(String(va), String(vb));
    return (c || byName(a.name, b.name)) * sign;
  });
}

/** The entries whose name contains the text (any case). */
export function filterEntries<T extends GuestFile>(list: T[], text: string): T[] {
  const q = text.trim().toLowerCase();
  return q ? list.filter(e => e.name.toLowerCase().includes(q)) : list;
}

const TYPE_CHAR: Record<GuestFileType, string> = {
  file: '-',
  directory: 'd',
  symlink: 'l',
  blockDevice: 'b',
  charDevice: 'c',
  fifo: 'p',
  socket: 's',
  other: '?',
};

/** "drwxr-xr-x", "-rwsr-xr-x", "drwxrwxrwt"; "—" without a mode (Windows). */
export function formatMode(type: GuestFileType, mode: number | undefined): string {
  if (mode === undefined) return '—';
  const rwx = (bits: number, special: boolean, ch: string) =>
    `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${special ? (bits & 1 ? ch : ch.toUpperCase()) : bits & 1 ? 'x' : '-'}`;
  return (
    TYPE_CHAR[type] +
    rwx((mode >> 6) & 7, !!(mode & 0o4000), 's') +
    rwx((mode >> 3) & 7, !!(mode & 0o2000), 's') +
    rwx(mode & 7, !!(mode & 0o1000), 't')
  );
}

export const TYPE_LABEL: Record<GuestFileType, string> = {
  file: 'File',
  directory: 'Folder',
  symlink: 'Link',
  blockDevice: 'Block device',
  charDevice: 'Character device',
  fifo: 'FIFO',
  socket: 'Socket',
  other: 'Other',
};

/* --------------------------------------------- what the agent reaches */

/**
 * - confined: SELinux confines the agent (virt_qemu_ga_t) on Fedora and the
 *   RHEL family: writes in /tmp and /var/tmp only, part of the guest hidden;
 * - root: Linux without SELinux (Debian, Ubuntu…): root, permissions ignored;
 * - system: Windows, SYSTEM;
 * - unknown: the OS is not known yet.
 */
export type AgentReach = 'confined' | 'root' | 'system' | 'unknown';

export function agentReach(osId: string | undefined): AgentReach {
  const id = (osId ?? '').toLowerCase();
  if (!id) return 'unknown';
  if (isWindowsId(id)) return 'system';
  if (id === 'fedora' || rhelFamily(id)) return 'confined';
  return 'root';
}

/** Where a confined agent may write. */
export const CONFINED_WRITABLE = ['/tmp', '/var/tmp'];

export const confinedWritable = (path: string) => CONFINED_WRITABLE.some(d => underPath(path, d, false));

/**
 * The guest-side change that lets the agent read and write every file
 * (spec §8.11), verbatim from the lab test of 2026-11-28
 * (results-selinux-cloudinit.md: KubeVirt, Fedora 45 and Rocky 9.9, reboot
 * and revert included): a systemd drop-in with an empty FILTER_RPC_ARGS
 * (every agent command on), and a CIL module that puts virt_qemu_ga_t in
 * files_unconfined_type with chown, fowner and fsetid, where SELinux is on.
 * The New VM wizard's option writes the same files at first boot.
 */
export const FULL_ACCESS_ENABLE = [
  '# Hangar: let the QEMU guest agent read and write every file (run in the guest, as a sudoer)',
  'sudo mkdir -p /etc/hangar /etc/systemd/system/qemu-guest-agent.service.d',
  "printf '[Service]\\nEnvironmentFile=-/etc/hangar/qemu-ga.env\\n' | sudo tee /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf >/dev/null",
  "echo 'FILTER_RPC_ARGS=' | sudo tee /etc/hangar/qemu-ga.env >/dev/null",
  "printf '(typeattributeset files_unconfined_type (virt_qemu_ga_t))\\n(allow virt_qemu_ga_t self (capability (chown fowner fsetid)))\\n' | sudo tee /etc/hangar/hangar_qemu_ga.cil >/dev/null",
  'if command -v selinuxenabled >/dev/null && selinuxenabled; then sudo semodule -i /etc/hangar/hangar_qemu_ga.cil; fi',
  'sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent',
];

export const FULL_ACCESS_REVERT = [
  '# Hangar: undo it (run in the guest, as a sudoer)',
  'if command -v selinuxenabled >/dev/null && selinuxenabled; then sudo semodule -r hangar_qemu_ga; fi',
  'sudo rm -rf /etc/hangar /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf',
  'sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent',
];

export interface FullAccess {
  enable: string[];
  revert: string[];
  /** On RHEL-family guests the drop-in also turns the allow-list off, an admin's own FILTER_RPC_ARGS included. */
  overridesAllowList: boolean;
}

/** The change for a guest whose agent SELinux confines; null where there is nothing to change (Windows, Debian, Ubuntu). */
export function fullAccessFor(osId: string | undefined, evidence = false): FullAccess | null {
  const reach = agentReach(osId);
  if (reach === 'system') return null;
  // Elsewhere the change is harmless (Debian, Ubuntu: qemu-ga is not
  // confined): shown when the guest proved confined all the same.
  if (reach !== 'confined' && !evidence) return null;
  return { enable: FULL_ACCESS_ENABLE, revert: FULL_ACCESS_REVERT, overridesAllowList: rhelFamily(osId) };
}

/** The commands the bridge needs for files, in the order of the lab's tested sed (flush last). */
export const FILE_COMMANDS = [
  'guest-exec',
  'guest-exec-status',
  'guest-file-open',
  'guest-file-close',
  'guest-file-read',
  'guest-file-write',
  'guest-file-seek',
  'guest-file-flush',
];

/**
 * The file commands guest-info lists as disabled, when any the bridge
 * calls is (Rocky's default allow-list disables all eight): the list to
 * enable, flush included as in the tested sed.
 */
export function blockedFileCommands(commands: GuestAgentCommand[] | undefined): string[] {
  if (!commands?.length) return [];
  const off = new Set(commands.filter(c => !c.enabled).map(c => c.name));
  const needed = FILE_COMMANDS.filter(c => c !== 'guest-file-flush');
  if (!needed.some(c => off.has(c))) return [];
  return FILE_COMMANDS.filter(c => off.has(c));
}

/* ---------------------------------------------- overwrite and conflicts */

export type Choice = 'replace' | 'skip' | 'keepBoth';

export interface Conflict {
  /** The name both sides have. */
  name: string;
  /** Where the copy goes ("the VM", "this PC"). */
  where: string;
  existing: Pick<GuestFile, 'type' | 'size' | 'mtime'>;
  incoming: Pick<GuestFile, 'type' | 'size' | 'mtime'>;
  /** The choices that apply: no replace of a folder by a file, nor the reverse. */
  choices: Choice[];
}

export interface Answer {
  choice: Choice;
  /** Apply to the other conflicts of the same copy. */
  all: boolean;
}

export function conflictChoices(existing: Pick<GuestFile, 'type'>, incoming: Pick<GuestFile, 'type'>): Choice[] {
  return isDir(existing) !== isDir(incoming) ? ['skip', 'keepBoth'] : ['replace', 'skip', 'keepBoth'];
}

/**
 * The overwrite questions of one copy: replace, skip or keep both, with
 * "apply to all". A folder copied onto a folder of the same name goes into
 * it (its files are asked one by one). null from `ask` cancels the copy.
 */
export class ConflictPolicy {
  private all?: Choice;
  constructor(private ask: (c: Conflict) => Promise<Answer | null>) {}

  async decide(c: Omit<Conflict, 'choices'>): Promise<Choice | 'merge' | null> {
    if (isDir(c.existing) && isDir(c.incoming)) return 'merge';
    const choices = conflictChoices(c.existing, c.incoming);
    if (this.all && choices.includes(this.all)) return this.all;
    const a = await this.ask({ ...c, choices });
    if (!a) return null;
    if (a.all) this.all = a.choice;
    return a.choice;
  }
}

/** "report.docx" → ["report", ".docx"]; ".bashrc" → [".bashrc", ""]; "a.tar.gz" → ["a", ".tar.gz"]. */
export function splitExt(name: string): [string, string] {
  const m = /^(.+?)((?:\.tar)?\.[^.\s]{1,10})$/.exec(name);
  if (!m) return [name, ''];
  return [m[1], m[2]];
}

/** The first "name (n).ext" that is free, for keep both. */
export function keepBothName(name: string, taken: (n: string) => boolean): string {
  const [base0, ext] = splitExt(name);
  const base = base0.replace(/ \(\d+\)$/, '');
  for (let n = 1; ; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!taken(cand)) return cand;
  }
}

/* --------------------------------------------------- edit on this PC */

/** The VM copy a local file was made from: what write-back checks against. */
export interface FileVersion {
  size: number;
  mtime?: string;
  /** The SHA-256 of the bytes Hangar read. */
  sha256?: string;
}

/** Same size and the same mtime (both known): the VM copy did not change, without hashing it. */
export const statSame = (base: FileVersion, now: Pick<GuestFile, 'size' | 'mtime'>) => base.size === now.size && !!base.mtime && base.mtime === now.mtime;

/** After a stat that differs: the hash decides (a touch changes the mtime, not the bytes). */
export const hashSame = (base: FileVersion, now: GuestFileHash) => !!base.sha256 && base.size === now.size && base.sha256 === now.hash.toLowerCase();

export type EditConflictChoice = 'keepVm' | 'overwrite' | 'saveBoth';

/* ------------------------------------------------------------ progress */

/** Bytes per second, smoothed over samples a second or more apart. */
export class RateMeter {
  private lastT?: number;
  private lastBytes = 0;
  rate?: number;

  sample(bytes: number, now: number): number | undefined {
    if (this.lastT === undefined) {
      this.lastT = now;
      this.lastBytes = bytes;
      return this.rate;
    }
    const dt = (now - this.lastT) / 1000;
    if (dt >= 1) {
      const inst = (bytes - this.lastBytes) / dt;
      this.rate = this.rate === undefined ? inst : this.rate * 0.6 + inst * 0.4;
      this.lastT = now;
      this.lastBytes = bytes;
    }
    return this.rate;
  }
}

export function durationText(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '';
  const s = Math.ceil(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "12 MiB of 100 MiB · 13 MiB/s · 7 s left". */
export function progressText(done: number, total: number, rate?: number): string {
  const parts = [`${formatBytes(done)} of ${formatBytes(total)}`];
  if (rate && rate > 0) {
    parts.push(`${formatBytes(rate)}/s`);
    if (total > done) parts.push(`${durationText((total - done) / rate)} left`);
  }
  return parts.join(' · ');
}

/** About how long the agent channel takes for this many bytes, for the large-file warning. */
export function channelTime(bytes: number, up: boolean): string {
  return durationText(bytes / (up ? UP_BYTES_PER_S : DOWN_BYTES_PER_S));
}

/* ------------------------------------------------------------- helpers */

/** "a.txt", "a.txt and b.txt", "a.txt, b.txt and 3 more". */
export function namesText(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, max - 1).join(', ')} and ${names.length - max + 1} more`;
}

/** A failed operation in words, with what to do; the path and the OS make the SELinux case plain. */
export function errorText(e: FileError, o: { path?: string; osId?: string } = {}): string {
  const m = e.message;
  switch (e.reason) {
    case 'Forbidden':
      return `Your role does not allow this on this VM: it needs ${GUESTFILES_ROLE} (get, create, update and delete on virtualmachineinstances/guestfiles).`;
    case 'Blocked':
      return `The guest’s agent configuration disables ${e.commands?.length ? namesText(e.commands, 8) : 'a command this needs'}: the tab shows how to enable ${e.commands && e.commands.length > 1 ? 'them' : 'it'}.`;
    case 'PermissionDenied':
      if (o.path && agentReach(o.osId) === 'confined' && !confinedWritable(o.path))
        return `The guest agent may not do this here: SELinux confines it in this guest, and it writes only in /tmp and /var/tmp. The tab shows the guest-side change that lets it reach every file. (${m})`;
      return m;
    case 'ReadOnlyFileSystem':
      return `The filesystem is read-only in the guest. (${m})`;
    case 'NoSpace':
      return `No space left in the guest. (${m})`;
    case 'NotConnected':
      return 'The guest agent is not connected; Hangar tried again for a while.';
    case 'NotResponding':
      return 'The guest agent does not respond; restarting it in the guest brings it back.';
    case 'Unavailable':
      return `The guest bridge does not answer, or the VM is moving to another host; Hangar tried again for a while. (${m})`;
    case 'Absent':
      return 'This cluster has no guest bridge.';
    case 'Network':
      return `No answer from the cluster: ${m || 'the request failed'}`;
    case 'TooLarge':
      return `A proxy between this browser and the cluster refused a 1 MiB request: raise its body size limit. (${m})`;
    case 'Timeout':
      return `The guest did not answer in time; the command may still run there. (${m})`;
    case 'Expired':
      return 'The listing is gone from the guest: list again.';
    default:
      return m || 'The operation failed';
  }
}
