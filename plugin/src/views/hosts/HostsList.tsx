/*
 * Hosts: state, hardware, how loaded they are, VMs on each, maintenance.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { last, useMetrics } from '../../api/metrics';
import { hostCpuModel, hostRoles, hostState } from '../../model/inventory';
import { cpuVendor } from '../../model/placement';
import { Obj } from '../../model/types';
import { formatBytes, formatCores, parseQuantity, pct } from '../../model/units';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { K8sName } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { useTokens } from '../../ui/useTokens';

export function MiniBar({ value, total }: { value: number; total: number }) {
  const t = useTokens();
  const p = pct(value, total);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box sx={{ width: 70, height: 6, borderRadius: 1, background: t.meterTrack, overflow: 'hidden' }}>
        <Box sx={{ width: `${p}%`, height: '100%', background: p > 85 ? '#E8A33D' : t.meterUsed }} />
      </Box>
      <span>{Math.round(p)}%</span>
    </Box>
  );
}

export function HostsList() {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const m = useMetrics();
  const history = useHistory();
  const vmCount = (n: Obj) => d.vmis.filter(v => v.status?.nodeName === n.metadata.name).length;
  // What the VM pods on the host request (guest memory plus overhead), like the scheduler counts it.
  const vmMemory = (n: Obj) =>
    d.launchers
      .filter(p => p.spec?.nodeName === n.metadata.name && !p.metadata.deletionTimestamp && (p.status?.phase === 'Running' || p.status?.phase === 'Pending'))
      .reduce((s, p) => s + (p.spec?.containers ?? []).reduce((x: number, c: any) => x + (parseQuantity(c.resources?.requests?.memory) || 0), 0), 0);
  const columns: Column<Obj>[] = [
    {
      id: 'name',
      header: 'Host',
      sort: n => n.metadata.name,
      cell: n => (
        <Box>
          <Box sx={{ fontWeight: 600 }}>{n.metadata.name}</Box>
          {k8s && <K8sName>node {hostRoles(n).join(', ') || 'worker'}</K8sName>}
        </Box>
      ),
    },
    {
      id: 'state',
      header: 'State',
      sort: n => hostState(n).label,
      cell: n => {
        const s = hostState(n);
        return (
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
            <Led tone={s.tone} /> {s.label}
          </Box>
        );
      },
    },
    { id: 'vms', header: 'VMs', align: 'right', sort: vmCount, cell: vmCount },
    {
      id: 'cpu',
      header: 'CPU',
      sort: n => last(m.hosts.get(n.metadata.name))?.cpu ?? 0,
      cell: n => {
        const u = last(m.hosts.get(n.metadata.name));
        const cap = parseQuantity(n.status?.allocatable?.cpu);
        return u ? <MiniBar value={u.cpu} total={cap} /> : `${formatCores(cap)} cores`;
      },
    },
    {
      id: 'mem',
      header: 'Memory',
      sort: n => last(m.hosts.get(n.metadata.name))?.mem ?? 0,
      cell: n => {
        const u = last(m.hosts.get(n.metadata.name));
        const cap = parseQuantity(n.status?.allocatable?.memory);
        return u ? <MiniBar value={u.mem} total={cap} /> : formatBytes(cap);
      },
    },
    {
      id: 'given',
      header: 'Memory given to VMs',
      minWidth: 760,
      sort: n => vmMemory(n),
      cell: n => <MiniBar value={vmMemory(n)} total={parseQuantity(n.status?.allocatable?.memory)} />,
    },
    {
      id: 'hw',
      header: 'Hardware',
      minWidth: 900,
      cell: n =>
        `${formatCores(parseQuantity(n.status?.capacity?.cpu))} CPUs, ${formatBytes(parseQuantity(n.status?.capacity?.memory))}${
          hostCpuModel(n) ? `, ${[cpuVendor(n), hostCpuModel(n)].filter(Boolean).join(' ')}` : ''
        }`,
    },
    {
      id: 'os',
      header: 'System',
      minWidth: 1100,
      cell: n => `${n.status?.nodeInfo?.osImage ?? ''}, Kubernetes ${n.status?.nodeInfo?.kubeletVersion ?? ''}`,
    },
    {
      id: 'ip',
      header: 'Address',
      cell: n => (n.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address ?? '—',
    },
  ];
  return (
    <Box sx={{ p: 2, display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600, flex: 1 }}>
          Hosts
        </Typography>
        <Button component={RouterLink} to={hrefFor('devices')} size="small" sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:expansion-card-variant" width={18} />}>
          Device mappings
        </Button>
      </Box>
      <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
        <DataTable label="Hosts" rows={d.nodes} columns={columns} rowKey={n => n.metadata.name} onOpen={n => history.push(hrefFor('host', n.metadata.name))} />
      </Box>
    </Box>
  );
}
