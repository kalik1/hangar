/*
 * Which console pop-ups are open, across the windows of this browser: the
 * pop-up announces itself on a BroadcastChannel (and keeps saying so), the
 * Hangar pages listen. The in-page console steps aside while the VM's
 * console is in its own window, since KubeVirt serves one client per VM.
 */

import React from 'react';

const CHANNEL = 'hangar-console-popups';
/** A pop-up repeats "open" this often… */
export const HEARTBEAT_MS = 2000;
/** …and counts as gone after this long without a word (crash, killed tab). */
export const STALE_MS = 6000;

export type PresenceMessage =
  | { type: 'open'; key: string; kind: string }
  | { type: 'closed'; key: string }
  | { type: 'query' }
  | { type: 'close'; key: string };

/** Pure bookkeeping: key -> last time it said "open". */
export function applyPresence(seen: Map<string, number>, msg: PresenceMessage, now: number): Map<string, number> {
  const next = new Map(seen);
  if (msg.type === 'open') next.set(msg.key, now);
  else if (msg.type === 'closed') next.delete(msg.key);
  return next;
}

export function isOpen(seen: Map<string, number>, key: string, now: number): boolean {
  const t = seen.get(key);
  return t !== undefined && now - t < STALE_MS;
}

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

let shared: { ch: BroadcastChannel | null; seen: Map<string, number>; subs: Set<() => void> } | null = null;

function hub() {
  if (shared) return shared;
  const ch = channel();
  shared = { ch, seen: new Map(), subs: new Set() };
  ch?.addEventListener('message', (e: MessageEvent<PresenceMessage>) => {
    if (!shared || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'open' || e.data.type === 'closed') {
      shared.seen = applyPresence(shared.seen, e.data, Date.now());
      shared.subs.forEach(f => f());
    }
  });
  ch?.postMessage({ type: 'query' } as PresenceMessage);
  return shared;
}

/** Marks a pop-up as just opened by this page, before it can say so itself. */
export function notePopupOpening(key: string) {
  const h = hub();
  h.seen = applyPresence(h.seen, { type: 'open', key, kind: '' }, Date.now());
  h.subs.forEach(f => f());
}

/** Asks the pop-up of that VM to close (the in-page console takes the console back). */
export function closePopup(key: string) {
  const h = hub();
  h.ch?.postMessage({ type: 'close', key } as PresenceMessage);
  h.seen = applyPresence(h.seen, { type: 'closed', key }, Date.now());
  h.subs.forEach(f => f());
}

/** True while the VM's console is open in its own window. */
export function useConsolePopupOpen(key: string): boolean {
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const h = hub();
    h.subs.add(tick);
    // Re-evaluate staleness even when nobody talks.
    const id = window.setInterval(tick, HEARTBEAT_MS);
    return () => {
      h.subs.delete(tick);
      window.clearInterval(id);
    };
  }, []);
  return isOpen(hub().seen, key, Date.now());
}

/** In the pop-up: say "open" now and then, "closed" on the way out, obey "close". */
export function useAnnouncePopup(key: string, kind: string) {
  React.useEffect(() => {
    const ch = channel();
    if (!ch) return;
    const say = () => ch.postMessage({ type: 'open', key, kind } as PresenceMessage);
    say();
    const id = window.setInterval(say, HEARTBEAT_MS);
    const onMsg = (e: MessageEvent<PresenceMessage>) => {
      if (e.data?.type === 'query') say();
      else if (e.data?.type === 'close' && e.data.key === key) window.close();
    };
    ch.addEventListener('message', onMsg);
    const bye = () => ch.postMessage({ type: 'closed', key } as PresenceMessage);
    window.addEventListener('pagehide', bye);
    return () => {
      bye();
      window.clearInterval(id);
      window.removeEventListener('pagehide', bye);
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [key, kind]);
}
