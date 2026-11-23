/*
 * A Ceph pool as a datastore: cluster health, and capacity in the units a
 * user cares about (usable space after replication), from Rook's
 * CephCluster and CephBlockPool status.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { Meter } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { useTokens } from '../../ui/useTokens';

export interface CephInfo {
  cluster: Obj;
  pool?: Obj;
  poolName?: string;
  /** Copies of each block (replicated) or data+coding chunks (erasure coded). */
  replicas: number;
  efficiency: number;
  health?: string;
  rawTotal?: number;
  rawUsed?: number;
  rawAvailable?: number;
}

const CEPH = /(^|\.)(rbd|cephfs)\.csi\.ceph\.com$/;

/** The Ceph cluster and pool behind a StorageClass, when Rook runs it. */
export function cephFor(sc: Obj | undefined, d: HangarData): CephInfo | null {
  if (!sc || !CEPH.test(sc.provisioner ?? '') || !d.cephClusters.length) return null;
  const clusterNs = sc.parameters?.clusterID;
  const cluster = d.cephClusters.find(c => c.metadata.namespace === clusterNs) ?? d.cephClusters[0];
  const poolName = sc.parameters?.pool ?? sc.parameters?.dataPool;
  const pool = d.cephPools.find(p => p.metadata.namespace === cluster.metadata.namespace && (p.spec?.name ?? p.metadata.name) === poolName);
  const ec = pool?.spec?.erasureCoded;
  const replicas = ec?.dataChunks ? ec.dataChunks + (ec.codingChunks ?? 0) : pool?.spec?.replicated?.size ?? 3;
  const efficiency = ec?.dataChunks ? ec.dataChunks / replicas : 1 / replicas;
  const cap = cluster.status?.ceph?.capacity ?? {};
  return {
    cluster,
    pool,
    poolName,
    replicas,
    efficiency,
    health: cluster.status?.ceph?.health,
    rawTotal: cap.bytesTotal,
    rawUsed: cap.bytesUsed,
    rawAvailable: cap.bytesAvailable,
  };
}

const HEALTH: Record<string, { tone: 'on' | 'standby' | 'fault'; label: string }> = {
  HEALTH_OK: { tone: 'on', label: 'Healthy' },
  HEALTH_WARN: { tone: 'standby', label: 'Warning' },
  HEALTH_ERR: { tone: 'fault', label: 'Error' },
};

export function CephCapacity({ ceph, provisionedBytes }: { ceph: CephInfo; provisionedBytes: number }) {
  const t = useTokens();
  const h = HEALTH[ceph.health ?? ''] ?? { tone: 'standby' as const, label: ceph.health ? ceph.health : 'Health not reported yet' };
  const usableTotal = ceph.rawTotal !== undefined ? ceph.rawTotal * ceph.efficiency : undefined;
  const usableUsed = ceph.rawUsed !== undefined ? ceph.rawUsed * ceph.efficiency : undefined;
  const ec = ceph.pool?.spec?.erasureCoded?.dataChunks;
  const scheme = ec
    ? `erasure coded ${ec}+${ceph.pool?.spec?.erasureCoded?.codingChunks ?? 0}`
    : `${ceph.replicas} copies of every block${ceph.pool?.spec?.failureDomain ? `, on different ${ceph.pool.spec.failureDomain}s` : ''}`;
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 13.5 }}>
        <Led tone={h.tone} /> Ceph cluster {ceph.cluster.metadata.name}: {h.label}
        {ceph.pool?.status?.phase && ceph.pool.status.phase !== 'Ready' ? `, pool ${ceph.pool.status.phase.toLowerCase()}` : ''}
      </Box>
      {ceph.health !== 'HEALTH_OK' && warnings(ceph.cluster).length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 12.5, color: t.muted }}>
          {warnings(ceph.cluster).map(w => (
            <li key={w}>{w}</li>
          ))}
        </Box>
      )}
      {usableTotal !== undefined && usableUsed !== undefined ? (
        <Meter
          label="Usable space"
          used={usableUsed}
          total={usableTotal}
          format={n => formatBytes(n)}
          caption={`${formatBytes(Math.max(0, usableTotal - usableUsed))} free after replication (${formatBytes(ceph.rawTotal)} raw)`}
        />
      ) : (
        <Typography sx={{ fontSize: 13, color: t.muted }}>The cluster has not reported its capacity yet.</Typography>
      )}
      <Typography sx={{ fontSize: 13, color: t.muted, lineHeight: 1.5 }}>
        <b style={{ color: t.text }}>{formatBytes(provisionedBytes)} provisioned</b> in pool {ceph.poolName ?? '—'}: {scheme}. Disks are thin: they take space as
        guests write.
      </Typography>
    </Box>
  );
}

/** Ceph's health messages, the ones worth reading first. */
function warnings(cluster: Obj): string[] {
  const details: Record<string, { message?: string; severity?: string }> = cluster.status?.ceph?.details ?? {};
  return Object.entries(details)
    .sort(([, a], [, b]) => (a.severity === 'HEALTH_ERR' ? -1 : 0) - (b.severity === 'HEALTH_ERR' ? -1 : 0))
    .map(([k, v]) => v.message || k)
    .slice(0, 3);
}
