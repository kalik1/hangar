/*
 * Optimistic overlay for lists that are polled, not watched (networks):
 * what Hangar just created shows at once, what it just deleted disappears
 * at once, until the next poll agrees (or 60 s pass).
 */

import React from 'react';
import { Obj } from '../model/types';
import { key } from '../model/vm';

const TTL = 60000;

class Overlay {
  added = new Map<string, { obj: Obj; at: number }>();
  removed = new Map<string, number>();
  private listeners = new Set<() => void>();
  version = 0;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getVersion = () => this.version;

  add(o: Obj) {
    this.added.set(key(o), { obj: o, at: Date.now() });
    this.removed.delete(key(o));
    this.emit();
  }

  remove(k: string) {
    this.removed.set(k, Date.now());
    this.added.delete(k);
    this.emit();
  }

  apply(items: Obj[]): Obj[] {
    const now = Date.now();
    const keys = new Set(items.map(key));
    for (const [k, v] of this.added) if (keys.has(k) || now - v.at > TTL) this.added.delete(k);
    for (const [k, at] of this.removed) if (!keys.has(k) || now - at > TTL) this.removed.delete(k);
    const out = items.filter(o => !this.removed.has(key(o)));
    for (const v of this.added.values()) out.push(v.obj);
    return out;
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const nadOverlay = new Overlay();

/** The list with Hangar's own recent changes applied. */
export function useOverlay(o: Overlay, items: Obj[]): Obj[] {
  const v = React.useSyncExternalStore(o.subscribe, o.getVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => o.apply(items), [items, v]);
}
