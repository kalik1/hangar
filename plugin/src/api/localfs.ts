/*
 * This PC's side of the Files tab.
 * - The File System Access API (Chromium: Chrome, Edge, Opera; Electron):
 *   a folder the user picks (showDirectoryPicker, read and write), kept in
 *   IndexedDB so reopening asks only for permission again; files saved with
 *   showSaveFilePicker.
 * - Elsewhere (Firefox, Safari, plain http): files the user picks or drops,
 *   and plain browser downloads.
 */

import type { GuestFile } from '../model/guestfiles';

/* ------------------------------------------------- sources and sinks */

/** Bytes to send: a local file. */
export interface Source {
  name: string;
  size: number;
  lastModified?: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/** Where bytes go: a local file. Nothing is final before close(); abort() drops it. */
export interface Sink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

function readBlob(b: Blob): Promise<ArrayBuffer> {
  if (typeof (b as any).arrayBuffer === 'function') return b.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(b);
  });
}

export function blobSource(file: Blob & { name?: string; lastModified?: number }, name = file.name ?? 'file'): Source {
  return {
    name,
    size: file.size,
    lastModified: file.lastModified,
    read: async (start, end) => new Uint8Array(await readBlob(file.slice(start, end))),
  };
}

export function bytesSource(name: string, data: Uint8Array, lastModified?: number): Source {
  return { name, size: data.length, lastModified, read: async (s, e) => data.slice(s, e) };
}

/** A sink that keeps the bytes and hands them over as a browser download on close. */
export function downloadSink(name: string, save: (blob: Blob, name: string) => void = saveBlob): Sink {
  let parts: Uint8Array[] = [];
  return {
    write: async b => {
      parts.push(b);
    },
    close: async () => {
      save(new Blob(parts as BlobPart[]), name);
      parts = [];
    },
    abort: async () => {
      parts = [];
    },
  };
}

/** A plain browser download of a blob. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ------------------------------------------- the File System Access API */

export const fsaSupported = () => typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';
export const savePickerSupported = () => typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function';
export const observerSupported = () => typeof window !== 'undefined' && typeof (window as any).FileSystemObserver === 'function';

/** A local file Hangar may read and write again: "Edit on this PC". */
export interface LocalFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<any>;
}

/** A writable file's sink: the browser writes a swap file and swaps it in on close, so abort leaves the old file. */
export async function handleSink(h: LocalFileHandle): Promise<Sink> {
  const w = await h.createWritable();
  return {
    write: b => w.write(b),
    close: () => w.close(),
    abort: () => w.abort().catch(() => undefined),
  };
}

/** A local folder: the local pane, and where copies from the VM go. */
export interface LocalDir {
  name: string;
  list(): Promise<GuestFile[]>;
  dir(name: string, create: boolean): Promise<LocalDir>;
  source(name: string): Promise<Source>;
  /** A new or replaced file (written on close), with its handle for "Edit on this PC". */
  create(name: string): Promise<{ sink: Sink; handle: LocalFileHandle }>;
  /** A file's handle, made empty when it is not there. */
  handle(name: string): Promise<LocalFileHandle>;
  remove(name: string, recursive: boolean): Promise<void>;
  /** Whether the browser still lets Hangar write here (after a reload it asks again). */
  permission(): Promise<'granted' | 'prompt' | 'denied'>;
  /** Asks for permission (needs a click). */
  requestPermission(): Promise<boolean>;
}

export function fsaDir(handle: any): LocalDir {
  return {
    name: handle.name,
    async list() {
      const out: GuestFile[] = [];
      for await (const h of handle.values()) {
        if (h.kind === 'directory') out.push({ name: h.name, type: 'directory', size: 0 });
        else {
          const f: File = await h.getFile();
          out.push({ name: h.name, type: 'file', size: f.size, mtime: new Date(f.lastModified).toISOString() });
        }
      }
      return out;
    },
    dir: async (name, create) => fsaDir(await handle.getDirectoryHandle(name, { create })),
    async source(name) {
      const fh = await handle.getFileHandle(name);
      return blobSource(await fh.getFile(), name);
    },
    async create(name) {
      const fh = await handle.getFileHandle(name, { create: true });
      return { sink: await handleSink(fh), handle: fh };
    },
    handle: name => handle.getFileHandle(name, { create: true }),
    remove: (name, recursive) => handle.removeEntry(name, { recursive }),
    permission: async () => (typeof handle.queryPermission === 'function' ? handle.queryPermission({ mode: 'readwrite' }) : 'granted'),
    requestPermission: async () => (typeof handle.requestPermission === 'function' ? (await handle.requestPermission({ mode: 'readwrite' })) === 'granted' : true),
  };
}

/** Asks the user for a folder; null when they cancel. */
export async function pickDirectory(): Promise<any | null> {
  try {
    return await (window as any).showDirectoryPicker({ id: 'hangar-files', mode: 'readwrite' });
  } catch {
    return null;
  }
}

/** Asks where to save a file; null when the user cancels. */
export async function pickSaveFile(suggestedName: string): Promise<LocalFileHandle | null> {
  try {
    return await (window as any).showSaveFilePicker({ id: 'hangar-files', suggestedName });
  } catch {
    return null;
  }
}

/* ----------------------------------------------- the folder, kept */

const DB = 'hangar-files';
const STORE = 'handles';
const ROOT_KEY = 'local-root';

function db(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Keeps the local pane's folder for the next visit (IndexedDB stores the handle itself). */
export async function saveRootHandle(handle: any | null): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>(resolve => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      if (handle) tx.objectStore(STORE).put(handle, ROOT_KEY);
      else tx.objectStore(STORE).delete(ROOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  d.close();
}

export async function loadRootHandle(): Promise<any | null> {
  const d = await db();
  if (!d) return null;
  const v = await new Promise<any>(resolve => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(ROOT_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  d.close();
  return v;
}
