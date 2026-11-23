/*
 * Local storage, host by host: one line per host with its thin pool (or
 * volume group) — what is written of its real size, metadata, space
 * physically free next to the room TopoLVM still advertises — and the disks
 * and VMs that live there. Used by the datastore cards, the Dashboard and
 * the host page; the aggregate stays the headline, this is the detail that
 * shows the host that fills up first.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { HangarData } from '../../api/data';
import { PoolReading } from '../../api/storage';
import { HostPool, hostPools, PoolLevel } from '../../model/hostPools';
import { datastoreReach } from '../../model/placement';
import { DiskInventory, topolvmDeviceClass } from '../../model/storage';
import { formatBytes } from '../../model/units';
import { hrefFor } from '../../shell/nav';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

export const LEVEL_COLOR: Record<PoolLevel, string | null> = { ok: null, warn: '#E8A33D', fault: '#E5484D' };

const TOPOLVM = /^topolvm\.(io|cybozu\.com)$/;

/** Whether a datastore keeps each disk on one host (so a per-host view makes sense). */
export function isLocalDatastore(provisioner: string | undefined, shared: boolean): boolean {
  return datastoreReach({ shared, provisioner: provisioner ?? '' }) === 'local';
}

/** The per-host pools of one datastore. */
export function datastoreHostPools(d: HangarData, inv: DiskInventory, pools: PoolReading, name: string): HostPool[] {
  const sc = d.storageClasses.find(s => s.metadata.name === name);
  const topolvm = TOPOLVM.test(sc?.provisioner ?? '');
  const dc = topolvm && sc ? topolvmDeviceClass(sc, d.nodes) : undefined;
  return hostPools({
    datastore: name,
    samples: topolvm ? pools.samples : [],
    deviceClass: dc,
    nodes: d.nodes,
    rows: inv.rows,
    pvIdx: d.idx.pv,
    topolvm,
  });
}

/** "kube-worker-1" for "kube-worker-1.example.com". */
export function shortHost(host: string): string {
  return host.split('.')[0];
}

function Bar({ pct, level, label }: { pct: number; level: PoolLevel; label: string }) {
  const t = useTokens();
  return (
    <Box
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      sx={{ position: 'relative', height: 6, borderRadius: 1, background: t.meterTrack, overflow: 'hidden', minWidth: 60 }}
    >
      <Box sx={{ position: 'absolute', inset: 0, width: `${Math.max(1, Math.min(100, pct))}%`, background: LEVEL_COLOR[level] ?? t.meterUsed }} />
    </Box>
  );
}

function VmList({ p, max = 4 }: { p: HostPool; max?: number }) {
  const t = useTokens();
  if (!p.vms.length) return null;
  const shown = p.vms.slice(0, max);
  return (
    <>
      {': '}
      {shown.map((v, i) => (
        <React.Fragment key={`${v.namespace}/${v.name}`}>
          {i > 0 && ', '}
          <Box component={RouterLink} to={hrefFor('vm', v.namespace, v.name)} sx={{ color: t.accent }}>
            {v.name}
          </Box>
        </React.Fragment>
      ))}
      {p.vms.length > max && <span title={p.vms.slice(max).map(v => v.name).join(', ')}> +{p.vms.length - max}</span>}
    </>
  );
}

/** Full detail: datastore cards and the host page. */
export function HostPoolList({ pools, hostLinks = true, unavailable }: { pools: HostPool[]; hostLinks?: boolean; unavailable?: string }) {
  const t = useTokens();
  if (!pools.length) return <Typography sx={{ fontSize: 13, color: t.muted }}>No host holds disks of this datastore yet.</Typography>;
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1.25 }}>
      {pools.map(p => {
        const pct = p.sizeBytes ? ((p.usedBytes ?? 0) / p.sizeBytes) * 100 : 0;
        const color = LEVEL_COLOR[p.level];
        return (
          <Box component="li" key={p.host} sx={{ display: 'grid', gap: 0.5, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
              {hostLinks ? (
                <Box component={RouterLink} to={hrefFor('host', p.host)} title={p.host} sx={{ fontWeight: 600, fontSize: 13.5, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {shortHost(p.host)}
                </Box>
              ) : (
                <Box sx={{ fontWeight: 600, fontSize: 13.5 }}>{p.thin ? 'Thin pool' : 'Volume group'}</Box>
              )}
              <Box sx={{ flex: 1 }} />
              {p.measured && p.sizeBytes !== undefined ? (
                <Box sx={{ fontSize: 13, color: color ?? t.muted, whiteSpace: 'nowrap', ...tabular }}>
                  {formatBytes(p.usedBytes)} of {formatBytes(p.sizeBytes)} {p.thin ? 'written' : 'used'} ({Math.round(pct)}%)
                </Box>
              ) : (
                <Box sx={{ fontSize: 13, color: t.muted }}>pool not readable</Box>
              )}
            </Box>
            {p.measured && p.sizeBytes !== undefined && <Bar pct={pct} level={p.level} label={`${p.host}: ${Math.round(pct)}% of the pool ${p.thin ? 'written' : 'used'}`} />}
            <Box sx={{ fontSize: 12.5, color: t.muted, lineHeight: 1.5, ...tabular }}>
              {p.reason && (
                <Box component="span" sx={{ color: color ?? t.text, fontWeight: 600 }}>
                  {p.reason[0].toUpperCase() + p.reason.slice(1)}.{' '}
                </Box>
              )}
              {p.measured && (
                <>
                  {p.thin && p.metaPercent !== undefined && !(p.reason ?? '').startsWith('metadata') && `Metadata ${p.metaPercent.toFixed(1)}%. `}
                  {p.physFreeBytes !== undefined && `${formatBytes(p.physFreeBytes)} physically free`}
                  {p.thin && p.advertisedBytes !== undefined && `; TopoLVM accepts ${formatBytes(p.advertisedBytes)} more (its overprovisioning limit)`}
                  {'. '}
                </>
              )}
              {!p.measured && p.advertisedBytes !== undefined && `TopoLVM accepts ${formatBytes(p.advertisedBytes)} more (an overprovisioning limit, not free space). `}
              {p.disks.length ? (
                <>
                  {p.disks.length} disk{p.disks.length === 1 ? '' : 's'}, {formatBytes(p.provisionedBytes)} provisioned
                  {p.thin && p.sizeBytes ? ` (${(p.provisionedBytes / p.sizeBytes).toFixed(1)}× the pool)` : ''}
                  <VmList p={p} />
                </>
              ) : (
                'No disks here yet.'
              )}
            </Box>
          </Box>
        );
      })}
      {unavailable && pools.some(p => !p.measured) && (
        <Typography component="li" sx={{ fontSize: 12.5, color: t.muted }}>
          Hangar cannot read the pools: {unavailable}
        </Typography>
      )}
    </Box>
  );
}

/** One line per host, for the Dashboard. */
export function HostPoolBars({ pools }: { pools: HostPool[] }) {
  const t = useTokens();
  const measured = pools.filter(p => p.measured && p.sizeBytes);
  if (measured.length < 2) return null;
  return (
    <Box component="ul" aria-label="Thin pools by host" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.75 }}>
      {measured.map(p => {
        const pct = ((p.usedBytes ?? 0) / (p.sizeBytes as number)) * 100;
        const color = LEVEL_COLOR[p.level];
        return (
          <Box
            component="li"
            key={p.host}
            sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 9em) minmax(0,1fr) auto', alignItems: 'center', gap: 1, fontSize: 12.5 }}
            title={`${p.host}: ${formatBytes(p.usedBytes)} of ${formatBytes(p.sizeBytes)} written${p.metaPercent !== undefined ? `, metadata ${p.metaPercent.toFixed(1)}%` : ''}${p.reason ? ` — ${p.reason}` : ''}`}
          >
            <Box component={RouterLink} to={hrefFor('host', p.host)} sx={{ color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortHost(p.host)}
            </Box>
            <Bar pct={pct} level={p.level} label={`${p.host}: ${Math.round(pct)}% written`} />
            <Box sx={{ color: color ?? t.muted, whiteSpace: 'nowrap', ...tabular }}>
              {Math.round(pct)}%{p.level !== 'ok' && p.reason?.startsWith('metadata') ? ' meta' : ''}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
