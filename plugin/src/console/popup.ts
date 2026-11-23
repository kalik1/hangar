/*
 * Console pop-ups: a VM's console in its own browser window. One window per
 * cluster and VM: opening the console again brings that window to the front
 * (and switches it to the asked kind) instead of opening a second client,
 * since KubeVirt serves one console client per VM.
 */

import type { ConsoleKind } from './paths';

export const POPUP_ROUTE_NAME = 'hangar-console';
export const POPUP_ROUTE_PATH = '/hangar-console/:namespace/:name/:kind?';

/** Graphical consoles get a window sized for a 1280x800 guest plus the toolbar. */
const SIZES: Record<ConsoleKind, [number, number]> = { vnc: [1280, 860], serial: [1000, 680] };

/** The identity of a console window: cluster + VM. */
export function consolePopupKey(cluster: string, namespace: string, name: string): string {
  return `${cluster}/${namespace}/${name}`;
}

/** A window name browsers accept everywhere (no spaces or slashes). */
export function consolePopupName(cluster: string, namespace: string, name: string): string {
  return `hangar-console_${consolePopupKey(cluster, namespace, name).replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
}

export function consolePopupTitle(name: string, kind: ConsoleKind): string {
  return kind === 'serial' ? `${name} — Serial console` : `${name} — Console`;
}

/** window.open features: a real pop-up window, centered on the opener's screen. */
export function consolePopupFeatures(
  kind: ConsoleKind,
  screen?: { availWidth?: number; availHeight?: number; availLeft?: number; availTop?: number }
): string {
  const [w0, h0] = SIZES[kind];
  const sw = screen?.availWidth ?? 0;
  const sh = screen?.availHeight ?? 0;
  const w = sw ? Math.min(w0, sw) : w0;
  const h = sh ? Math.min(h0, sh) : h0;
  const parts = ['popup=yes', `width=${w}`, `height=${h}`];
  if (sw && sh) {
    parts.push(`left=${Math.round((screen?.availLeft ?? 0) + (sw - w) / 2)}`);
    parts.push(`top=${Math.round((screen?.availTop ?? 0) + (sh - h) / 2)}`);
  }
  return parts.join(',');
}

export type PopupOpenResult = 'opened' | 'focused' | 'switched' | 'blocked';

type WindowLike = {
  open: (url: string, target: string, features: string) => WindowLike | null;
  focus: () => void;
  location: { href: string; pathname?: string; replace: (url: string) => void };
};

/**
 * Opens the console window, or brings back the one already open for that VM.
 * Must run inside the click handler, or browsers block the pop-up.
 * `href` is the full URL of the console route for the asked kind; with
 * `focusOnly` an open window keeps the kind it shows.
 */
export function openOrFocusPopup(
  opener: WindowLike,
  href: string,
  name: string,
  features: string,
  opts: { focusOnly?: boolean } = {}
): { result: PopupOpenResult; win: WindowLike | null } {
  // An empty URL returns the window of that name without reloading it, or a blank new one.
  const win = opener.open('', name, features);
  if (!win) return { result: 'blocked', win: null };
  let current = '';
  try {
    current = win.location.href;
  } catch {
    current = '';
  }
  const target = new URL(href, opener.location.href).href;
  let result: PopupOpenResult;
  if (!current || current === 'about:blank') {
    win.location.replace(target);
    result = 'opened';
  } else if (current !== target && !opts.focusOnly) {
    win.location.replace(target);
    result = 'switched';
  } else result = 'focused';
  try {
    win.focus();
  } catch {
    /* some browsers refuse focus() on pop-ups: the window is open anyway */
  }
  return { result, win };
}
