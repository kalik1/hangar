/*
 * Thin wrappers over Headlamp's clusterRequest: Hangar always talks to the
 * cluster of the current route, with Headlamp's own auth (kubeconfig
 * headers or cookies), so the plugin never handles tokens.
 */

import { ApiProxy, Utils } from '@kinvolk/headlamp-plugin/lib';

export function currentCluster(): string {
  return (Utils.getCluster?.() as string | null) || '';
}

type Init = { method?: string; body?: unknown; contentType?: string; json?: boolean; query?: Record<string, string> };

export async function kreq<T = any>(path: string, init: Init = {}): Promise<T> {
  const { method = 'GET', body, contentType = 'application/json', json = true, query } = init;
  // KubeVirt's subresource PUTs (start, stop, pause…) answer 406 to a strict
  // "Accept: application/json": stay lenient when no JSON answer is needed.
  const headers: Record<string, string> = { Accept: json ? 'application/json, */*' : '*/*' };
  if (body !== undefined) headers['Content-Type'] = contentType;
  const res = await ApiProxy.clusterRequest(
    path,
    {
      method,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      headers,
      cluster: currentCluster(),
      isJSON: json,
      autoLogoutOnAuthError: false,
    } as any,
    query as any
  );
  return res as T;
}

type RawInit = {
  method?: string;
  /** Sent as it is: bytes for the guest bridge's writes. */
  body?: BodyInit;
  contentType?: string;
  accept?: string;
  query?: Record<string, string>;
  signal?: AbortSignal;
  /** Headlamp's default is 2 minutes. */
  timeoutMs?: number;
};

/**
 * A request whose answer is the fetch Response itself (headers and raw
 * bytes), through the same Headlamp proxy and auth. A failure rejects as
 * kreq's do: an Error with `status` and Headlamp's "Status text - message".
 * A request cancelled through `signal` rejects with `cancelled: true`.
 * `read` takes the answer apart (its body included) under the same signal
 * and timeout.
 */
export async function kraw<T = Response>(path: string, init: RawInit = {}, read: (r: Response) => Promise<T> = async r => r as unknown as T): Promise<T> {
  const { method = 'GET', body, contentType = 'application/octet-stream', accept = '*/*', query, signal, timeoutMs = 2 * 60 * 1000 } = init;
  const headers: Record<string, string> = { Accept: accept };
  if (body !== undefined) headers['Content-Type'] = contentType;
  // Headlamp's own timeout signal is replaced by this one.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = (await ApiProxy.clusterRequest(
      path,
      { method, body, headers, cluster: currentCluster(), isJSON: false, autoLogoutOnAuthError: false, signal: ctl.signal } as any,
      query as any
    )) as Response;
    return await read(res);
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** PUT on a KubeVirt subresource (start, stop, pause…): empty answers, so no JSON. */
export function kput(path: string, body: unknown = {}): Promise<unknown> {
  return kreq(path, { method: 'PUT', body, json: false });
}

export function kpost<T = any>(path: string, body: unknown, query?: Record<string, string>): Promise<T> {
  return kreq<T>(path, { method: 'POST', body, query });
}

export function kmerge<T = any>(path: string, patch: unknown): Promise<T> {
  return kreq<T>(path, { method: 'PATCH', body: patch, contentType: 'application/merge-patch+json' });
}

export function kjsonpatch<T = any>(path: string, ops: unknown[]): Promise<T> {
  return kreq<T>(path, { method: 'PATCH', body: ops, contentType: 'application/json-patch+json' });
}

export function kdelete(path: string, body?: unknown): Promise<unknown> {
  return kreq(path, { method: 'DELETE', body, json: true });
}

/** A readable message from an API error ("Forbidden - …" → the part after the dash). */
export function errorText(err: unknown): string {
  const e = err as { status?: number; message?: string };
  const msg = e?.message ?? String(err);
  const detail = msg.includes(' - ') ? msg.split(' - ').slice(1).join(' - ') : msg;
  if (e?.status === 403) return `Not allowed: ${detail}`;
  if (e?.status === 409) return `Changed meanwhile: ${detail}`;
  return detail || 'The request failed';
}
