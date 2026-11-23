/*
 * What Hangar needs to pick a VM's NAT network (model/podnet.ts): each
 * host's pod ranges (Cilium's CiliumNodes, else Node podCIDRs, else pod
 * addresses), the service network (ServiceCIDRs, else around the
 * kubernetes Service) and the hosts' addresses. Read once a minute per
 * cluster; parts that are missing or not readable are left out.
 */

import React from 'react';
import { NetFacts, netFacts } from '../model/podnet';
import { Obj } from '../model/types';
import { currentCluster, kreq } from './client';

const list = (path: string): Promise<Obj[] | null> => kreq<any>(path).then(r => (r?.items ?? []) as Obj[], () => null);

const cache = new Map<string, { at: number; p: Promise<Omit<Parameters<typeof netFacts>[0], 'nodes'>> }>();

function readParts() {
  const k = currentCluster();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = (async () => {
    const [ciliumNodes, serviceCidrs, svc] = await Promise.all([
      list('/apis/cilium.io/v2/ciliumnodes'),
      list('/apis/networking.k8s.io/v1/servicecidrs'),
      kreq<any>('/api/v1/namespaces/default/services/kubernetes').catch(() => null),
    ]);
    // Pod addresses only when no range is readable (a list of every pod is heavy).
    const pods = ciliumNodes?.length ? null : await list('/api/v1/pods?fieldSelector=status.phase%3DRunning');
    return { ciliumNodes, serviceCidrs, kubernetesServiceIp: svc?.spec?.clusterIP ?? null, pods };
  })();
  cache.set(k, { at: Date.now(), p });
  return p;
}

/** The cluster's ranges; null while loading. */
export function useNetFacts(nodes: Obj[]): NetFacts | null {
  const [parts, setParts] = React.useState<Awaited<ReturnType<typeof readParts>> | null>(null);
  React.useEffect(() => {
    let alive = true;
    readParts().then(p => alive && setParts(p));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => (parts ? netFacts({ nodes, ...parts }) : null), [parts, nodes]);
}
