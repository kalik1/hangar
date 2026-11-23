/*
 * What the current user may do, from SelfSubjectAccessReviews, cached per
 * cluster for a few minutes. Controls a user may not use are disabled with
 * the reason instead of failing after a click.
 */

import React from 'react';
import { currentCluster, kpost } from './client';

export interface Attrs {
  verb: string;
  group: string;
  resource: string;
  subresource?: string;
  namespace?: string;
}

const cache = new Map<string, { at: number; p: Promise<boolean> }>();
const TTL = 5 * 60 * 1000;

export function can(a: Attrs): Promise<boolean> {
  const k = `${currentCluster()}|${a.verb}|${a.group}|${a.resource}|${a.subresource ?? ''}|${a.namespace ?? ''}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = kpost('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    spec: { resourceAttributes: { verb: a.verb, group: a.group, resource: a.resource, subresource: a.subresource, namespace: a.namespace } },
  })
    .then(r => !!r?.status?.allowed)
    // If the review itself fails, do not block: the API will refuse if it must.
    .catch(() => true);
  cache.set(k, { at: Date.now(), p });
  return p;
}

/** true/false once known; true while loading so controls do not flicker. */
export function useCan(a: Attrs | null): boolean {
  const [ok, setOk] = React.useState(true);
  const sig = a ? JSON.stringify(a) : '';
  React.useEffect(() => {
    if (!a) return;
    let alive = true;
    can(a).then(v => alive && setOk(v));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return ok;
}

export interface VmPerms {
  power: boolean;
  edit: boolean;
  remove: boolean;
  console: boolean;
  migrate: boolean;
}

export const ALL_PERMS: VmPerms = { power: true, edit: true, remove: true, console: true, migrate: true };

/** What the user may do with VMs of a folder. */
export function useVmPerms(namespace?: string): VmPerms {
  const sub = (s: string) => ({ verb: 'update', group: 'subresources.kubevirt.io', resource: 'virtualmachines', subresource: s, namespace });
  const power = useCan(sub('start'));
  const edit = useCan({ verb: 'update', group: 'kubevirt.io', resource: 'virtualmachines', namespace });
  const remove = useCan({ verb: 'delete', group: 'kubevirt.io', resource: 'virtualmachines', namespace });
  const consoleOk = useCan({ verb: 'get', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'vnc', namespace });
  const migrate = useCan({ verb: 'create', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations', namespace });
  return React.useMemo(() => ({ power, edit, remove, console: consoleOk, migrate }), [power, edit, remove, consoleOk, migrate]);
}

export const NOT_ALLOWED = 'Your role does not allow this';
