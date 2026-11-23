/*
 * Delete protection (model/protection.ts): whether the admission policy that
 * enforces it is installed, and turning it on or off for a VM and its disks.
 */

import React from 'react';
import { labelPatch, PolicyState, policyState, protectedClaims, PROTECTION_POLICY, withVmProtection } from '../model/protection';
import { Obj, VM } from '../model/types';
import { runTask } from './actions';
import { currentCluster, kmerge, kreq } from './client';
import { PATHS } from './resources';

const ADM = '/apis/admissionregistration.k8s.io/v1';

async function getOrNull(path: string): Promise<Obj | null | 'forbidden'> {
  try {
    return await kreq<Obj>(path);
  } catch (e: any) {
    if (e?.status === 404) return null;
    if (e?.status === 403 || e?.status === 401) return 'forbidden';
    throw e;
  }
}

const cache = new Map<string, { at: number; p: Promise<PolicyState> }>();

export function readPolicyState(force = false): Promise<PolicyState> {
  const k = currentCluster();
  const hit = cache.get(k);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.p;
  const p = Promise.all([
    getOrNull(`${ADM}/validatingadmissionpolicies/${PROTECTION_POLICY}`),
    getOrNull(`${ADM}/validatingadmissionpolicybindings/${PROTECTION_POLICY}`),
  ])
    .then(([pol, bind]) => policyState(pol, bind))
    .catch(() => 'unknown' as PolicyState);
  cache.set(k, { at: Date.now(), p });
  return p;
}

/** The policy's state; null while loading. */
export function useProtectionPolicy(): { state: PolicyState | null; recheck: () => void } {
  const [state, setState] = React.useState<PolicyState | null>(null);
  const [gen, setGen] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    readPolicyState(gen > 0).then(s => alive && setState(s));
    return () => {
      alive = false;
    };
  }, [gen]);
  return { state, recheck: React.useCallback(() => setGen(g => g + 1), []) };
}

const ignore404 = (e: any) => (e?.status === 404 ? undefined : Promise.reject(e));

/** Labels (or unlabels) the disks of a VM: DataVolumes and PVCs. */
export async function labelDisks(namespace: string, claims: string[], on: boolean): Promise<void> {
  for (const c of claims) {
    await kmerge(PATHS.dv(namespace, c), labelPatch(on)).catch(ignore404);
    await kmerge(PATHS.pvc(namespace, c), labelPatch(on)).catch(ignore404);
  }
}

/**
 * Protection on or off for a VM and its disks. On: the VM first, so it is
 * never deletable with protected disks half done. Off: the disks first, so
 * a VM that becomes deletable never leaves protected disks its deletion
 * would get stuck on.
 */
export function setVmProtection(vm: VM, on: boolean) {
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name;
  return runTask({ title: on ? 'Protect from deletion' : 'Remove delete protection', target: { kind: 'vm', namespace: ns, name } }, async () => {
    const fresh = await kreq<VM>(PATHS.vm(ns, name));
    const claims = protectedClaims(fresh);
    const put = (v: VM) => kreq(PATHS.vm(ns, name), { method: 'PUT', body: { ...v, status: undefined } });
    if (on) {
      await put(withVmProtection(fresh, true));
      await labelDisks(ns, claims, true);
    } else {
      await labelDisks(ns, claims, false);
      await put(withVmProtection(fresh, false));
    }
  });
}
