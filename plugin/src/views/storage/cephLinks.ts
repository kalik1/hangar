/*
 * Links into the Ceph plugin (a separate Headlamp plugin), only when it is
 * installed: Headlamp keeps every registered plugin route in its store,
 * keyed by path, so Hangar looks for the Ceph plugin's routes there instead
 * of guessing. No route, no link: never a dead one.
 *
 * Pages the Ceph plugin promises: /ceph, /ceph/pools/<pool>, /ceph/osds,
 * /ceph/rbd/<pool>/<image> (cluster-prefixed by Headlamp) — as routes of
 * their own, or through one catch-all route like /ceph/:view?/:a?/:b?.
 */

import { Router } from '@kinvolk/headlamp-plugin/lib';
import { useSelector } from 'react-redux';
import { currentCluster } from '../../api/client';

interface StoreRoute {
  path?: string | string[];
  name?: string;
  useClusterURL?: boolean;
}

export interface RouteRef {
  name?: string;
  path: string;
  /** Parameter names, in order. */
  params: string[];
  useClusterURL: boolean;
  /** Reached through a catch-all route: its optional parameters, filled with the fixed segments, then the values. */
  via?: { params: string[]; fixed: string[] };
}

export interface CephRoutes {
  overview?: RouteRef;
  pool?: RouteRef;
  osds?: RouteRef;
  rbd?: RouteRef;
}

const PATTERNS: [keyof CephRoutes, RegExp][] = [
  ['overview', /^\/ceph\/?((\/:[A-Za-z0-9_]+\?)*)$/],
  ['pool', /^\/ceph\/pools\/:([A-Za-z0-9_]+)$/],
  ['osds', /^\/ceph\/osds\/?$/],
  ['rbd', /^\/ceph\/rbd\/:([A-Za-z0-9_]+)\/:([A-Za-z0-9_]+)$/],
];

/** The Ceph plugin's routes among Headlamp's registered ones. */
export function findCephRoutes(routes: Record<string, StoreRoute> | undefined | null): CephRoutes {
  const out: CephRoutes = {};
  for (const r of Object.values(routes ?? {})) {
    const paths = Array.isArray(r?.path) ? r.path : r?.path ? [r.path] : [];
    for (const path of paths) {
      for (const [kind, re] of PATTERNS) {
        if (out[kind] || !re.test(path)) continue;
        const params = [...path.matchAll(/:([A-Za-z0-9_]+)(?!\?)(?=\/|$)/g)].map(m => m[1]);
        out[kind] = { name: r.name, path, params, useClusterURL: r.useClusterURL !== false };
      }
    }
  }
  // One catch-all route (/ceph/:view?/:a?/…) serves the pages without routes of their own.
  const all = out.overview;
  const optional = all ? [...all.path.matchAll(/:([A-Za-z0-9_]+)\?/g)].map(m => m[1]) : [];
  const pages: [keyof CephRoutes, string, string[]][] = [
    ['pool', 'pools', ['pool']],
    ['osds', 'osds', []],
    ['rbd', 'rbd', ['pool', 'image']],
  ];
  for (const [kind, segment, names] of pages) {
    if (out[kind] || !all || optional.length < 1 + names.length) continue;
    out[kind] = {
      name: all.name,
      path: ['/ceph', segment, ...names.map(n => `:${n}`)].join('/'),
      params: names,
      useClusterURL: all.useClusterURL,
      via: { params: optional, fixed: [segment] },
    };
  }
  return out;
}

/** Fills a route's path with values, in parameter order. */
export function fillPath(ref: RouteRef, values: string[]): string {
  let i = 0;
  return ref.path
    .replace(/\/:[A-Za-z0-9_]+\?/g, '')
    .replace(/:([A-Za-z0-9_]+)/g, () => encodeURIComponent(values[i++] ?? ''));
}

/** A URL for the route: Headlamp's own builder when it knows the name, else the cluster path. */
export function cephUrl(ref: RouteRef | undefined, values: string[] = [], cluster = currentCluster()): string | null {
  if (!ref) return null;
  if (values.some(v => !v)) return null;
  if (ref.name) {
    const params: Record<string, string> = {};
    if (ref.via) {
      const filled = [...ref.via.fixed, ...values];
      ref.via.params.forEach((p, i) => filled[i] !== undefined && (params[p] = filled[i]));
    } else ref.params.forEach((p, i) => (params[p] = values[i]));
    try {
      const url = Router.createRouteURL(ref.name, params);
      if (url) return url;
    } catch {
      /* fall back to the path */
    }
  }
  const path = fillPath(ref, values);
  return ref.useClusterURL && cluster ? `/c/${encodeURIComponent(cluster)}${path}` : path;
}

/** The Ceph plugin's routes, live (plugins register after Hangar sometimes). */
export function useCephRoutes(): CephRoutes {
  const routes = useSelector((s: any) => s?.routes?.routes as Record<string, StoreRoute> | undefined);
  return findCephRoutes(routes);
}
