/*
 * k4all, when it runs the cluster: whether it does (discovery serves its API
 * group; without it every field is Hangar's, k4all spec §4 R9), and its
 * ClusterConfig, read for the metadata service settings (model/metadata.ts).
 */

import React from 'react';
import { MetadataService, metadataService } from '../model/metadata';
import { K4ALL_GROUP } from '../model/ownership';
import { Obj } from '../model/types';
import { currentCluster, kreq } from './client';

const present = new Map<string, Promise<boolean>>();

/** k4all runs the current cluster. Discovery is open to every authenticated user: 200 when the group exists. */
export function isK4all(): Promise<boolean> {
  const cluster = currentCluster();
  let p = present.get(cluster);
  if (!p) {
    p = kreq(`/apis/${K4ALL_GROUP}`).then(
      () => true,
      (e: any) => e?.status === 403
    );
    present.set(cluster, p);
  }
  return p;
}

/** k4all runs the current cluster; false until discovery answers. */
export function useK4all(): boolean {
  const [on, setOn] = React.useState(false);
  const cluster = currentCluster();
  React.useEffect(() => {
    let alive = true;
    isK4all().then(v => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, [cluster]);
  return on;
}

/** The one ClusterConfig k4all reads. */
export const CLUSTER_CONFIG = `/apis/${K4ALL_GROUP}/v1alpha1/clusterconfigs/k4all-cluster-config`;

const configs = new Map<string, { at: number; p: Promise<Obj | null | 'unknown'> }>();

/** k4all's ClusterConfig: null when there is none, 'unknown' when it cannot be read (role, error). Cached a minute. */
export function readClusterConfig(): Promise<Obj | null | 'unknown'> {
  const k = currentCluster();
  const hit = configs.get(k);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = kreq<Obj>(CLUSTER_CONFIG).catch((e: any) => (e?.status === 404 ? null : ('unknown' as const)));
  configs.set(k, { at: Date.now(), p });
  return p;
}

export interface K4allState {
  /** k4all runs the cluster. */
  on: boolean;
  /** Its metadata service settings: undefined while loading or without k4all, 'unknown' when unreadable. */
  metadata?: MetadataService | null | 'unknown';
}

/** Whether k4all runs the cluster and, if so, its metadata service settings. */
export function useK4allMetadata(): K4allState {
  const on = useK4all();
  const [metadata, setMetadata] = React.useState<K4allState['metadata']>(undefined);
  const cluster = currentCluster();
  React.useEffect(() => {
    if (!on) return;
    let alive = true;
    readClusterConfig().then(cc => alive && setMetadata(cc === 'unknown' ? 'unknown' : metadataService(cc)));
    return () => {
      alive = false;
    };
  }, [on, cluster]);
  return { on, metadata: on ? metadata : undefined };
}

/** The names of a namespace's ServiceAccounts; [] for a namespace that does not exist yet, null when they cannot be listed. */
export function useServiceAccounts(namespace: string | undefined, exists = true): string[] | null {
  const [names, setNames] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    if (!namespace) return;
    if (!exists) {
      setNames([]);
      return;
    }
    let alive = true;
    kreq<{ items?: Obj[] }>(`/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts`).then(
      r => alive && setNames((r.items ?? []).map(s => s.metadata.name).sort((a, b) => a.localeCompare(b))),
      () => alive && setNames(null)
    );
    return () => {
      alive = false;
    };
  }, [namespace, exists]);
  return names;
}
