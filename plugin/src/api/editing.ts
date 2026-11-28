/*
 * "Edit on this PC" (File System Access API only): a VM file is saved to a
 * local file Hangar keeps a writable handle to; the user opens it with any
 * application (a browser cannot start one). Hangar watches the local file
 * (FileSystemObserver where the browser has it, and getFile() every 2 s) and,
 * when it changed, writes it back: on a click, or on every save with "write
 * each save". Before writing it checks the VM copy against the version it
 * read (size and mtime, then the SHA-256): when that changed too, the user
 * keeps the VM's, overwrites it, or saves both. Any file type: the bytes go
 * as they are. Editing ends when the page closes.
 */

import { EditConflictChoice, FileVersion, joinPath, keepBothName, parentPath } from '../model/guestfiles';
import { FileChannel, toFileError } from './guestfiles';
import { blobSource, handleSink, LocalFileHandle, observerSupported } from './localfs';
import { downloadFile, rememberVersion, uploadFile, vmCopyState } from './transfer';

export type EditState = 'saving' | 'watching' | 'changed' | 'writing' | 'conflict' | 'error';

export interface EditSession {
  id: string;
  vm: { namespace: string; name: string };
  vmPath: string;
  localName: string;
  /** The local folder's name, when the file went to the local pane's folder. */
  folder?: string;
  state: EditState;
  /** Write each save without asking. */
  auto: boolean;
  message?: string;
  /** When Hangar last wrote it to the VM. */
  writtenAt?: number;
}

interface Live {
  s: EditSession;
  ch: FileChannel;
  handle: LocalFileHandle;
  base: FileVersion;
  seen?: { lastModified: number; size: number };
  timer?: ReturnType<typeof setInterval>;
  observer?: { disconnect(): void };
}

export const POLL_MS = 2000;

type Listener = () => void;

export class EditStore {
  private live = new Map<string, Live>();
  private listeners = new Set<Listener>();
  private snapshot: EditSession[] = [];
  private seq = 0;

  constructor(private o: { pollMs?: number; observe?: boolean } = {}) {}

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Sessions with changes not yet in the VM: leaving the page would lose the link. */
  unsaved(): boolean {
    return this.snapshot.some(s => s.state === 'changed' || s.state === 'writing' || s.state === 'conflict' || s.state === 'saving');
  }

  /** Saves the VM file to the local handle, then watches it. */
  async start(ch: FileChannel, vm: EditSession['vm'], vmPath: string, handle: LocalFileHandle, folder?: string): Promise<EditSession> {
    const id = `edit-${++this.seq}`;
    const s: EditSession = { id, vm, vmPath, localName: handle.name, folder, state: 'saving', auto: false };
    const l: Live = { s, ch, handle, base: { size: 0 } };
    this.live.set(id, l);
    this.emit();
    try {
      const r = await downloadFile(ch, vmPath, await handleSink(handle));
      l.base = { size: r.size, mtime: r.mtime, sha256: r.sha256 };
      rememberVersion(`${vm.namespace}/${vm.name}`, vmPath, l.base);
      const f = await handle.getFile();
      l.seen = { lastModified: f.lastModified, size: f.size };
      this.patch(id, { state: 'watching', message: undefined });
      this.watch(l);
    } catch (e) {
      this.patch(id, { state: 'error', message: toFileError(e).message });
    }
    return this.live.get(id)?.s ?? s;
  }

  setAuto(id: string, auto: boolean) {
    this.patch(id, { auto });
    const l = this.live.get(id);
    if (auto && l?.s.state === 'changed') void this.writeBack(id);
  }

  /** Stops watching; the local file stays. */
  stop(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    if (l.timer) clearInterval(l.timer);
    l.observer?.disconnect();
    this.live.delete(id);
    this.emit();
  }

  stopAll() {
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  /** Looks at the local file now. */
  async check(id: string) {
    const l = this.live.get(id);
    if (!l || !l.seen || l.s.state === 'saving' || l.s.state === 'writing') return;
    let f: File;
    try {
      f = await l.handle.getFile();
    } catch (e) {
      this.patch(id, { state: 'error', message: `The file on this PC cannot be read any more: ${toFileError(e).message}` });
      return;
    }
    if (f.lastModified === l.seen.lastModified && f.size === l.seen.size) return;
    if (l.s.state === 'conflict') return;
    this.patch(id, { state: 'changed', message: undefined });
    if (l.s.auto) await this.writeBack(id);
  }

  /**
   * Writes the local file to the VM. Without a choice it first checks the
   * VM copy; when that changed too, the session waits for one.
   */
  async writeBack(id: string, choice?: EditConflictChoice) {
    const l = this.live.get(id);
    if (!l || l.s.state === 'writing' || l.s.state === 'saving') return;
    this.patch(id, { state: 'writing', message: undefined });
    try {
      const file = await l.handle.getFile();
      const seen = { lastModified: file.lastModified, size: file.size };
      if (choice === 'keepVm') {
        l.seen = seen;
        this.patch(id, { state: 'watching', message: 'The VM’s copy was kept: your changes are on this PC only.' });
        return;
      }
      if (!choice && (await vmCopyState(l.ch, l.s.vmPath, l.base)) === 'changed') {
        this.patch(id, { state: 'conflict', message: 'The VM’s copy changed too since Hangar read it.' });
        return;
      }
      let path = l.s.vmPath;
      let mode: 'replace' | 'new' = 'replace';
      if (choice === 'saveBoth') {
        const dir = parentPath(path, l.ch.windows) ?? path;
        const names = new Set((await l.ch.list(dir)).entries.map(e => e.name));
        path = joinPath(dir, keepBothName(path.split(/[\\/]/).pop() ?? 'file', n => names.has(n)), l.ch.windows);
        mode = 'new';
      }
      const r = await uploadFile(l.ch, path, blobSource(file, l.s.localName), mode);
      const st = await l.ch.stat(path);
      l.base = { size: r.size, mtime: st.mtime, sha256: r.sha256 };
      l.seen = seen;
      rememberVersion(`${l.s.vm.namespace}/${l.s.vm.name}`, path, l.base);
      this.patch(id, { state: 'watching', vmPath: path, writtenAt: Date.now(), message: choice === 'saveBoth' ? `Saved as ${path}; Hangar now writes there.` : undefined });
      // A save during the write is seen at the next look.
      void this.check(id);
    } catch (e) {
      this.patch(id, { state: 'error', message: toFileError(e).message });
    }
  }

  private watch(l: Live) {
    const id = l.s.id;
    l.timer = setInterval(() => void this.check(id), this.o.pollMs ?? POLL_MS);
    if ((this.o.observe ?? true) && observerSupported()) {
      try {
        const obs = new (window as any).FileSystemObserver(() => void this.check(id));
        obs.observe(l.handle);
        l.observer = obs;
      } catch {
        /* polling covers it */
      }
    }
  }

  private patch(id: string, p: Partial<EditSession>) {
    const l = this.live.get(id);
    if (!l) return;
    l.s = { ...l.s, ...p };
    this.emit();
  }

  private emit() {
    this.snapshot = [...this.live.values()].map(l => l.s);
    for (const f of this.listeners) f();
  }
}

/** The page's sessions: they outlive the tab (switching to Summary and back), not the page. */
export const edits = new EditStore();
