/*
 * Uploads a file from the browser into a new library image (CDI upload).
 *
 * 1. a DataVolume with `source.upload` (CDI starts an upload server for it),
 * 2. an UploadTokenRequest (upload.cdi.kubevirt.io) for a short-lived token,
 * 3. the file, POSTed by the browser straight to CDI's upload proxy
 *    (cdiConfig.status.uploadProxyURL) with `Authorization: Bearer <token>`.
 *
 * Why straight to the proxy: the API server's service proxy would avoid
 * CORS and certificates, but it strips the Authorization header once it has
 * authenticated the user, and CDI's upload proxy reads the token only from
 * that header (tested: it answers 400). The proxy allows every origin
 * (CORS), so the browser only needs to reach it over HTTPS with a
 * certificate it trusts. `checkProxy()` tells the user before they wait.
 */

import { tasks } from '../model/tasks';
import { Obj } from '../model/types';
import { UPLOAD_PATH,uploadError, uploadTokenRequest } from '../model/upload';
import { errorText, kdelete, kpost, kreq } from './client';
import { PATHS } from './resources';
import { SPATHS } from './storageResources';

export type UploadPhase = 'preparing' | 'uploading' | 'processing' | 'done' | 'failed' | 'cancelled';

export interface UploadState {
  key: string;
  namespace: string;
  name: string;
  fileName: string;
  total: number;
  loaded: number;
  phase: UploadPhase;
  error?: string;
  /** Bytes per second, smoothed. */
  rate?: number;
}

type Listener = () => void;

class UploadStore {
  private map = new Map<string, UploadState>();
  private xhrs = new Map<string, XMLHttpRequest>();
  private listeners = new Set<Listener>();
  private snapshot: UploadState[] = [];

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.snapshot;

  get(k: string) {
    return this.map.get(k);
  }

  set(s: UploadState) {
    this.map.set(s.key, s);
    this.emit();
  }

  patch(k: string, p: Partial<UploadState>) {
    const s = this.map.get(k);
    if (s) this.set({ ...s, ...p });
  }

  attach(k: string, x: XMLHttpRequest | null) {
    if (x) this.xhrs.set(k, x);
    else this.xhrs.delete(k);
    this.updateUnloadGuard();
  }

  abort(k: string) {
    this.xhrs.get(k)?.abort();
  }

  active(): UploadState[] {
    return [...this.map.values()].filter(s => s.phase === 'preparing' || s.phase === 'uploading');
  }

  private emit() {
    this.snapshot = [...this.map.values()];
    this.updateUnloadGuard();
    for (const l of this.listeners) l();
  }

  private guard = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = '';
  };
  private guarded = false;

  /** While a file is on its way, leaving the page would cut it: ask first. */
  private updateUnloadGuard() {
    if (typeof window === 'undefined') return;
    const want = this.active().length > 0;
    if (want && !this.guarded) window.addEventListener('beforeunload', this.guard);
    if (!want && this.guarded) window.removeEventListener('beforeunload', this.guard);
    this.guarded = want;
  }
}

export const uploads = new UploadStore();

/** Is the proxy reachable from this browser (TLS trusted, CORS fine)? */
export async function checkProxy(base: string, timeoutMs = 6000): Promise<boolean> {
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/healthz`, { mode: 'cors', cache: 'no-store', signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(t);
  }
}

async function waitUploadReady(ns: string, name: string, timeoutMs = 10 * 60 * 1000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const dv = await kreq<Obj>(PATHS.dv(ns, name)).catch(() => null);
    const phase = dv?.status?.phase;
    if (phase === 'UploadReady') return;
    if (phase === 'Succeeded') throw new Error('The image already has its content.');
    if (phase === 'Failed') {
      const c = (dv?.status?.conditions ?? []).find((x: any) => x.type === 'Running');
      throw new Error(c?.message || 'CDI could not prepare the upload.');
    }
    if (Date.now() > until)
      throw new Error('CDI did not get the disk ready for the upload within 10 minutes: check the datastore and the cdi-upload pod.');
    await new Promise(r => setTimeout(r, 2000));
  }
}

function send(base: string, token: string, file: File, k: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    uploads.attach(k, xhr);
    let lastT = Date.now();
    let lastLoaded = 0;
    xhr.upload.onprogress = e => {
      const now = Date.now();
      const dt = (now - lastT) / 1000;
      const prev = uploads.get(k)?.rate;
      let rate = prev;
      if (dt >= 1) {
        const inst = (e.loaded - lastLoaded) / dt;
        rate = prev ? prev * 0.6 + inst * 0.4 : inst;
        lastT = now;
        lastLoaded = e.loaded;
      }
      uploads.patch(k, { loaded: e.loaded, total: e.total || file.size, rate });
    };
    xhr.onload = () => {
      uploads.attach(k, null);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(uploadError(xhr.status, xhr.responseText, base)));
    };
    xhr.onerror = () => {
      uploads.attach(k, null);
      reject(new Error(uploadError(0, '', base)));
    };
    xhr.onabort = () => {
      uploads.attach(k, null);
      reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }));
    };
    xhr.open('POST', `${base}${UPLOAD_PATH}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(file);
  });
}

export interface UploadRequest {
  file: File;
  /** The DataVolume to create (source.upload); omit `create` to send to an existing one. */
  dataVolume: Obj;
  create: boolean;
  base: string;
  title: string;
}

/**
 * Runs an upload as a task: create the image, wait for CDI, send the file
 * (progress in the task and in `uploads`), then wait for CDI to process it.
 */
export async function startUpload(req: UploadRequest): Promise<void> {
  const ns = req.dataVolume.metadata.namespace as string;
  const name = req.dataVolume.metadata.name;
  const k = `${ns}/${name}`;
  const task = tasks.add({
    title: req.title,
    target: { kind: 'image', namespace: ns, name },
    until: { type: 'dataVolume', namespace: ns, name },
    timeoutMs: 12 * 60 * 60 * 1000,
  });
  uploads.set({ key: k, namespace: ns, name, fileName: req.file.name, total: req.file.size, loaded: 0, phase: 'preparing' });
  let lastPct = -1;
  const unsub = uploads.subscribe(() => {
    const s = uploads.get(k);
    if (!s || s.phase !== 'uploading' || !s.total) return;
    const pct = Math.floor((s.loaded / s.total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      tasks.update(task.id, { progress: pct, message: `Uploading ${req.file.name}` });
    }
  });
  try {
    if (req.create) await kpost(PATHS.dv(ns), req.dataVolume);
    tasks.update(task.id, { message: 'Preparing the disk' });
    await waitUploadReady(ns, name);
    const tr = await kpost<Obj>(SPATHS.uploadToken(ns), uploadTokenRequest(ns, name));
    const token = tr?.status?.token;
    if (!token) throw new Error('CDI gave no upload token: check that your user may create uploadtokenrequests in this namespace.');
    uploads.patch(k, { phase: 'uploading' });
    await send(req.base, token, req.file, k);
    uploads.patch(k, { phase: 'processing', loaded: req.file.size });
    tasks.update(task.id, { progress: 100, message: 'Processing the image' });
  } catch (e: any) {
    if (e?.cancelled) {
      uploads.patch(k, { phase: 'cancelled' });
      tasks.update(task.id, { status: 'warning', message: 'Upload cancelled: the empty image was deleted' });
      await kdelete(PATHS.dv(ns, name)).catch(() => undefined);
    } else {
      const msg = e?.status ? errorText(e) : e?.message ?? String(e);
      uploads.patch(k, { phase: 'failed', error: msg });
      tasks.update(task.id, { status: 'failed', message: msg });
    }
  } finally {
    unsub();
  }
}

/** Stops an upload; the image it was filling is deleted. */
export function cancelUpload(k: string) {
  uploads.abort(k);
}
