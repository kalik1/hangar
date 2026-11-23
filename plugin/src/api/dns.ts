/*
 * The cluster's DNS service as the kubelets see it: kube-system/kubelet-config
 * (clusterDNS, clusterDomain), else the kube-dns Service. Read once per cluster.
 */

import React from 'react';
import { ClusterDns, parseKubeletDns } from '../model/dns';
import { currentCluster, kreq } from './client';

const cache = new Map<string, Promise<ClusterDns | null>>();

async function load(): Promise<ClusterDns | null> {
  try {
    const cm = await kreq('/api/v1/namespaces/kube-system/configmaps/kubelet-config');
    const parsed = parseKubeletDns(cm?.data?.kubelet ?? '');
    if (parsed?.servers.length) return parsed;
  } catch {
    /* not allowed or absent: try the Service */
  }
  try {
    const svc = await kreq('/api/v1/namespaces/kube-system/services/kube-dns');
    const ip = svc?.spec?.clusterIP;
    if (ip && ip !== 'None') return { servers: [ip], domain: 'cluster.local' };
  } catch {
    /* unknown */
  }
  return null;
}

/** null while loading or when the cluster does not say. */
export function useClusterDns(): ClusterDns | null {
  const cluster = currentCluster();
  const [v, setV] = React.useState<ClusterDns | null>(null);
  React.useEffect(() => {
    let live = true;
    if (!cache.has(cluster)) cache.set(cluster, load());
    cache.get(cluster)!.then(x => live && setV(x));
    return () => {
      live = false;
    };
  }, [cluster]);
  return v;
}
