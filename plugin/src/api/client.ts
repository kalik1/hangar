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
