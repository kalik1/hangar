/*
 * The datacenter at a glance: capacity, VM states, hosts, alarms, recent
 * tasks. Everything links to where you act on it.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar, useTasks } from '../../api/data';
import { last, useMetrics } from '../../api/metrics';
import { useTopolvmPools } from '../../api/storage';
import { alarms, Severity } from '../../model/alarms';
import { compute, datastores } from '../../model/capacity';
import { hostPools } from '../../model/hostPools';
import { datacenterName } from '../../model/inventory';
import { hostState } from '../../model/inventory';
import { liveGate } from '../../model/placement';
import { poolSummary } from '../../model/storage';
import { formatBytes, formatCores, parseQuantity } from '../../model/units';
import { isTemplate, key, powerState } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { TaskRows } from '../../shell/TasksDock';
import { Empty, Meter, Panel } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { LedTone, tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { HostPoolBars } from '../storage/HostPools';

const SEV: Record<Severity, { icon: string; color: string; label: string }> = {
  critical: { icon: 'mdi:alert-circle-outline', color: '#E5484D', label: 'Critical' },
  warning: { icon: 'mdi:alert-outline', color: '#E8A33D', label: 'Warning' },
  info: { icon: 'mdi:information-outline', color: '#3D8BFD', label: 'Information' },
};

export function Dashboard() {
  const d = useHangar();
  const t = useTokens();
  const m = useMetrics();
  const tasks = useTasks();
  const vms = d.vms.filter(v => !isTemplate(v));
  const c = compute(d.nodes, vms, d.idx.vmi, d.instancetypes);
  const usedCpu = d.nodes.reduce((s, n) => s + (last(m.hosts.get(n.metadata.name))?.cpu ?? 0), 0);
  const usedMem = d.nodes.reduce((s, n) => s + (last(m.hosts.get(n.metadata.name))?.mem ?? 0), 0);
  const hasUsage = d.nodes.some(n => m.hosts.get(n.metadata.name)?.length);
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  // Real thin-pool usage from TopoLVM (its node annotations report the overprovisioning limit, not free space).
  const hasTopolvm = d.storageClasses.some(sc => sc.provisioner === 'topolvm.io');
  const pools = useTopolvmPools(hasTopolvm);
  const topolvmProvisioned = ds.filter(x => x.provisioner === 'topolvm.io').reduce((a, x) => a + x.provisionedBytes, 0);
  const pool = hasTopolvm ? poolSummary(pools.samples, undefined, topolvmProvisioned) : null;
  // The same pools host by host: the aggregate hides the host that fills up first.
  const byHost = hasTopolvm ? hostPools({ datastore: '', samples: pools.samples, nodes: d.nodes, rows: [], pvIdx: d.idx.pv }) : [];
  const provisioned = ds.reduce((s, x) => s + x.provisionedBytes, 0);
  const states: { label: string; tone: LedTone; n: number }[] = [
    { label: 'Powered on', tone: 'on', n: 0 },
    { label: 'Suspended', tone: 'standby', n: 0 },
    { label: 'In transition', tone: 'busy', n: 0 },
    { label: 'Error', tone: 'fault', n: 0 },
    { label: 'Powered off', tone: 'off', n: 0 },
  ];
  for (const vm of vms) {
    const p = powerState(vm, d.idx.vmi.get(key(vm)));
    const s = states.find(x => x.tone === p.tone);
    if (s) s.n++;
  }
  const al = alarms({ vms, vmiIdx: d.idx.vmi, nodes: d.nodes, dvs: d.dvs, pvcs: d.pvcs, migrations: d.migrations, kubevirt: d.kubevirt });
  const kvVersion = d.kubevirt?.status?.observedKubeVirtVersion;
  const templates = d.vms.length - vms.length;
  return (
    <Box sx={{ p: 2, display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          <Icon icon="mdi:office-building-outline" width={22} style={{ verticalAlign: -3, marginRight: 8, color: t.muted }} />
          {datacenterName(d.cluster, d.nodes)}
        </Typography>
        <Typography sx={{ color: t.muted, fontSize: 14, ...tabular }}>
          {d.nodes.length} host{d.nodes.length === 1 ? '' : 's'}, {vms.length} VMs, {templates} template{templates === 1 ? '' : 's'}
          {kvVersion ? `, KubeVirt ${kvVersion}` : ''}
        </Typography>
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' } }}>
        <Panel title="CPU" icon="mdi:cpu-64-bit">
          <Meter
            label={hasUsage ? 'Used by the hosts' : 'Allocated to running VMs'}
            used={hasUsage ? usedCpu : undefined}
            allocated={Math.min(c.vcpuAllocated, c.cpuCores)}
            total={c.cpuCores}
            format={n => `${formatCores(n)} cores`}
            caption={`${c.vcpuAllocated} vCPU on running VMs, ${c.vcpuAllVms} on all VMs${c.cpuCores ? ` (${(c.vcpuAllVms / c.cpuCores).toFixed(1)}:1)` : ''}`}
          />
        </Panel>
        <Panel title="Memory" icon="mdi:memory">
          <Meter
            label={hasUsage ? 'Used by the hosts' : 'Allocated to running VMs'}
            used={hasUsage ? usedMem : undefined}
            allocated={c.memAllocated}
            total={c.memBytes}
            format={n => formatBytes(n)}
            caption={`${formatBytes(c.memAllocated)} on running VMs, ${formatBytes(c.memAllVms)} on all VMs`}
          />
        </Panel>
        <Panel title="Storage" icon="mdi:database-outline">
          {pool ? (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
            <Meter
              label={pool.thin ? 'Written to the thin pools' : 'Allocated'}
              used={pool.usedBytes}
              total={pool.sizeBytes}
              format={n => formatBytes(n)}
              caption={`${formatBytes(provisioned)} provisioned on ${ds.length} datastore${ds.length === 1 ? '' : 's'}${
                pool.overcommit ? `, ${pool.overcommit.toFixed(1)}× the pools (thin)` : ''
              }`}
            />
              <HostPoolBars pools={byHost} />
            </Box>
          ) : (
            <Box sx={{ fontSize: 14 }}>
              {formatBytes(provisioned)} provisioned on {ds.length} datastore{ds.length === 1 ? '' : 's'}
              <Box sx={{ fontSize: 12.5, color: t.muted, mt: 0.5 }}>The datastores do not report their physical free space.</Box>
            </Box>
          )}
        </Panel>
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr)' }, alignItems: 'start' }}>
        <Panel title="Virtual machines" icon="mdi:server" actions={<Box component={RouterLink} to={hrefFor('vms')} sx={{ fontSize: 13, color: t.accent }}>All VMs</Box>}>
          <Box sx={{ display: 'grid', gap: 0.75 }}>
            {states.map(s => (
              <Box key={s.label} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, fontSize: 14, opacity: s.n ? 1 : 0.55 }}>
                <Led tone={s.tone} />
                <Box sx={{ flex: 1 }}>{s.label}</Box>
                <Box sx={{ fontWeight: 600, ...tabular }}>{s.n}</Box>
              </Box>
            ))}
          </Box>
        </Panel>
        <Panel title="Hosts" icon="mdi:server-network" dense actions={<Box component={RouterLink} to={hrefFor('hosts')} sx={{ fontSize: 13, color: t.accent }}>All hosts</Box>}>
          {d.nodes.map(n => {
            const s = hostState(n);
            const u = last(m.hosts.get(n.metadata.name));
            const cpu = parseQuantity(n.status?.allocatable?.cpu);
            const mem = parseQuantity(n.status?.allocatable?.memory);
            const count = d.vmis.filter(v => v.status?.nodeName === n.metadata.name).length;
            return (
              <Box
                key={n.metadata.name}
                component={RouterLink}
                to={hrefFor('host', n.metadata.name)}
                sx={{ display: 'block', px: 2, py: 1.25, color: 'inherit', textDecoration: 'none', borderBottom: `1px solid ${t.rule}`, '&:hover': { background: t.hover } }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
                  <Led tone={s.tone} />
                  <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{n.metadata.name}</Box>
                  <Box sx={{ color: t.muted, fontSize: 13, ...tabular }}>{count} VMs</Box>
                </Box>
                {u && (
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 1 }}>
                    <Meter label="CPU" used={u.cpu} total={cpu} format={x => formatCores(x)} />
                    <Meter label="Memory" used={u.mem} total={mem} format={x => formatBytes(x, 0)} />
                  </Box>
                )}
              </Box>
            );
          })}
          {d.nodes.length > 1 && <Mobility />}
        </Panel>
        <Panel title={`Alarms${al.length ? ` (${al.length})` : ''}`} icon="mdi:bell-outline" dense>
          {al.length === 0 ? (
            <Empty icon="mdi:check-circle-outline" title="Nothing needs you">
              Hosts respond, VMs run as set, disks are ready.
            </Empty>
          ) : (
            al.slice(0, 12).map(a => {
              const s = SEV[a.severity];
              const href =
                a.target.kind === 'vm' ? hrefFor('vm', a.target.namespace, a.target.name) : a.target.kind === 'host' ? hrefFor('host', a.target.name) : a.target.kind === 'disk' ? hrefFor('storage', 'disks') : undefined;
              return (
                <Box
                  key={a.id}
                  component={href ? RouterLink : 'div'}
                  to={href}
                  sx={{ display: 'flex', gap: 1.25, px: 2, py: 1, borderBottom: `1px solid ${t.rule}`, color: 'inherit', textDecoration: 'none', '&:hover': href ? { background: t.hover } : undefined }}
                >
                  <Icon icon={s.icon} width={18} style={{ color: s.color, flex: 'none', marginTop: 2 }} aria-label={s.label} />
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ fontSize: 14, fontWeight: 600 }}>{a.title}</Box>
                    {a.detail && <Box sx={{ fontSize: 13, color: t.muted, overflowWrap: 'anywhere' }}>{a.detail}</Box>}
                  </Box>
                </Box>
              );
            })
          )}
        </Panel>
      </Box>

      <Panel title="Recent tasks" icon="mdi:history" dense>
        {tasks.length ? (
          <TaskRows list={tasks.slice(0, 8)} now={Date.now()} />
        ) : (
          <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>Power operations, migrations, clones and imports you start appear here.</Box>
        )}
      </Panel>
    </Box>
  );
}

/** How many running VMs can move between hosts while running, and what ties the others. */
function Mobility() {
  const d = useHangar();
  const t = useTokens();
  let live = 0;
  let devices = 0;
  let disks = 0;
  let other = 0;
  for (const v of d.vmis) {
    if (!v.status?.nodeName) continue;
    const g = liveGate(v);
    if (g.ok) live++;
    else if (g.reason === 'HostDeviceNotLiveMigratable') devices++;
    else if (g.reason === 'DisksNotLiveMigratable') disks++;
    else other++;
  }
  const total = live + devices + disks + other;
  if (!total) return null;
  const tied = [disks ? `${disks} on disks local to a host` : '', devices ? `${devices} with host devices` : '', other ? `${other} for other reasons` : '']
    .filter(Boolean)
    .join(', ');
  return (
    <Box sx={{ px: 2, py: 1.25, fontSize: 13, color: t.muted, display: 'flex', gap: 1, alignItems: 'center' }}>
      <Icon icon="mdi:transit-transfer" width={18} style={{ flex: 'none' }} />
      <span>
        {live} of {total} running VM{total === 1 ? '' : 's'} can move between hosts while running{tied ? `; ${tied}` : ''}.
      </span>
    </Box>
  );
}
