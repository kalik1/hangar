/*
 * The managedFields of a listed object, from a GET of the object itself.
 * The same file is in Hangar and Cairn.
 *
 * Headlamp's list queries (v0.46: useList and the refetch of its watch)
 * delete metadata.managedFields from every object they hand back. What
 * k4all owns is read from managedFields (src/model/ownership.ts, k4all spec
 * §4 R9), so read from list data it finds no owner, and k4all's fields
 * would look like the console's. A GET of the single object keeps them.
 * Ownership kept in an annotation (KubeVirt's feature gates) is in the
 * listed copy and needs no GET.
 */

import React from 'react';
import { Obj } from '../model/types';
import { currentCluster, kreq } from './client';

const hasManagedFields = (o: Obj) =>
  Array.isArray(o.metadata?.managedFields) && o.metadata.managedFields.length > 0;

/**
 * The object as a GET of `path` returns it, managedFields included: read
 * when the listed copy first comes and again whenever it changes (its
 * resourceVersion), so never on a render alone. The listed copy itself
 * when it already has managedFields (one the console just wrote). Null
 * while the first GET runs, when it fails, without a listed object or a
 * path, and when `enabled` is false (no request then: without k4all
 * nothing is k4all's). A failed new read keeps the last copy.
 */
export function useManagedFields(
  listed: Obj | null | undefined,
  path: string | null,
  enabled = true
): Obj | null {
  const cluster = currentCluster();
  const direct = !!listed && hasManagedFields(listed);
  const key = enabled && listed && path && !direct ? `${cluster}\n${path}` : null;
  const rv = listed?.metadata?.resourceVersion;
  const [got, setGot] = React.useState<{ key: string; obj: Obj } | null>(null);
  React.useEffect(() => {
    if (!key || !path) return;
    let alive = true;
    kreq<Obj>(path).then(
      obj => {
        if (alive && obj?.metadata) setGot({ key, obj });
      },
      () => undefined
    );
    return () => {
      alive = false;
    };
  }, [key, path, rv]);
  if (!enabled || !listed || !path) return null;
  if (direct) return listed;
  return got && got.key === key ? got.obj : null;
}
