/*
 * Hangar is one Headlamp route, /hangar/:view?/:a?/:b?/:c?, so the shell
 * (inventory tree, tasks, metrics history) stays mounted while you move
 * around. useNav() reads and builds those URLs.
 */

import { Router } from '@kinvolk/headlamp-plugin/lib';
import { useHistory, useParams } from 'react-router-dom';

export const ROUTE_NAME = 'hangar';
export const ROUTE_PATH = '/hangar/:view?/:a?/:b?/:c?';

export type View =
  | 'dashboard'
  | 'vms'
  | 'vm'
  | 'templates'
  | 'hosts'
  | 'host'
  | 'storage'
  | 'networks'
  | 'library'
  | 'tasks'
  | 'devices'
  | 'flavors'
  | 'settings';

const VIEWS: View[] = ['dashboard', 'vms', 'vm', 'templates', 'hosts', 'host', 'storage', 'networks', 'library', 'tasks', 'devices', 'flavors', 'settings'];

export interface Nav {
  view: View;
  a?: string;
  b?: string;
  c?: string;
  href: (view: View, a?: string, b?: string, c?: string) => string;
  go: (view: View, a?: string, b?: string, c?: string) => void;
}

export function hrefFor(view: View, a?: string, b?: string, c?: string): string {
  const params: Record<string, string> = {};
  if (view !== 'dashboard') params.view = view;
  if (a) params.a = a;
  if (b) params.b = b;
  if (c) params.c = c;
  return Router.createRouteURL(ROUTE_NAME, params);
}

export function useNav(): Nav {
  const p = useParams<{ view?: string; a?: string; b?: string; c?: string }>();
  const history = useHistory();
  const view = (VIEWS.includes(p.view as View) ? p.view : 'dashboard') as View;
  return {
    view,
    a: p.a,
    b: p.b,
    c: p.c,
    href: hrefFor,
    go: (v, a, b, c) => history.push(hrefFor(v, a, b, c)),
  };
}

/** Datacenter settings → Features, with a gate highlighted. */
export const gateHref = (gate?: string) => hrefFor('settings', 'features', gate);

/** Links to a VM's page and tab. */
export const vmHref = (ns: string, name: string, tab?: string) => hrefFor('vm', ns, name, tab);

/** Pages of the k4all addon (k4all spec §13) and their anchors. */
export type K4allPage = 'virtualization' | 'nodes' | 'storage';
export type K4allAnchor = 'feature-gates' | 'vm-state' | 'metadata';

/**
 * A page of the k4all addon's settings (/k4all/settings/<page>#<anchor>),
 * built on its settings route; null when the k4all plugin is not loaded.
 */
export function k4allHref(page: K4allPage, anchor?: K4allAnchor): string | null {
  let base = '';
  try {
    base = Router.createRouteURL('k4all-settings', {});
  } catch {
    return null;
  }
  if (!base || base === '/') return null;
  return `${base.replace(/\/$/, '')}/${page}${anchor ? `#${anchor}` : ''}`;
}
