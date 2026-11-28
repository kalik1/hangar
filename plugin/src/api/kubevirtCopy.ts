/*
 * The KubeVirt resource as Hangar last wrote it. Hangar polls the KubeVirt
 * list once a minute, so for up to a minute after a write the listed copy
 * still shows the old state. Every write of the resource (device mappings,
 * api/hardware.ts; feature gates, api/gates.ts) keeps the object the API
 * server answered with, and the views read that copy until the list catches
 * up: the same or a newer resourceVersion (a newer generation), or two
 * minutes. It is kept per cluster: another cluster's never shows.
 */

import React from 'react';
import { Obj } from '../model/types';
import { currentCluster } from './client';

const KEEP_MS = 120000;

let written: { cluster: string; obj: Obj; at: number } | null = null;
let version = 0;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getVersion = () => version;

/** Keeps what a write of the KubeVirt resource returned and tells the views. */
export function keepWritten(obj: Obj | null | undefined) {
  if (!obj?.metadata?.resourceVersion) return;
  written = { cluster: currentCluster(), obj, at: Date.now() };
  version++;
  listeners.forEach(l => l());
}

/** Forgets the written copy (tests). */
export function forgetWritten() {
  written = null;
  version++;
  listeners.forEach(l => l());
}

/** The copy to show: the listed one, or the one Hangar just wrote while the list has not caught up. */
export function freshestKubevirt(listed: Obj | null, cluster: string, now = Date.now()): Obj | null {
  const w = written;
  if (!w || w.cluster !== cluster || now - w.at >= KEEP_MS) return listed;
  if (listed && (listed.metadata.name !== w.obj.metadata.name || listed.metadata.namespace !== w.obj.metadata.namespace)) return listed;
  if (listed?.metadata.resourceVersion === w.obj.metadata.resourceVersion) return listed;
  // A newer generation in the list is a change made after Hangar's write.
  if (listed && listed.metadata.generation !== undefined && (w.obj.metadata.generation ?? 0) < listed.metadata.generation) return listed;
  return w.obj;
}

/** The KubeVirt CR: the list's copy, or the one Hangar just wrote if the list has not caught up. */
export function useKubevirt(listed: Obj | null): Obj | null {
  React.useSyncExternalStore(subscribe, getVersion);
  return freshestKubevirt(listed, currentCluster());
}
