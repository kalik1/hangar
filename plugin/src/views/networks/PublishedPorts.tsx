/*
 * Networks → Published ports: every published port across the VMs (the VM,
 * the port, how it is published, the address, its state), with the
 * conflicts: a guest port published twice the same way, an address and port
 * two Services claim, a Hangar Service whose VM is gone.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { usePools, usePortsData } from '../../api/ports';
import { datacenterRows, DcRow, hostAddresses, modeInfo, parsePools } from '../../model/ports';
import { powerState } from '../../model/vm';
import { vmHref } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { K8sName, Panel, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { lbWords, LiveLabel, MODE_ICON, rowLive, whereText } from '../vm/portParts';

export function PublishedPorts({ focus }: { focus?: boolean }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const folders = React.useMemo(() => [...new Set(d.vms.map(v => v.metadata.namespace as string))].sort(), [d.vms]);
  const world = usePortsData(null, { intervalMs: 10000, folders, events: false });
  const poolsWorld = usePools();
  const pools = React.useMemo(() => parsePools(poolsWorld.metallb.items, poolsWorld.cilium.items, world.services), [poolsWorld, world.services]);
  const rows = React.useMemo(() => datacenterRows(world.services, d.vms, d.idx.launcher), [world.services, d.vms, d.idx.launcher]);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus]);
  const hosts = hostAddresses(d.nodes);
  const conflicts = rows.filter(r => r.conflict).length;

  const liveOf = (r: DcRow) => {
    const vmOn = r.vm ? powerState(r.vm, d.idx.vmi.get(`${r.vm.metadata.namespace}/${r.vm.metadata.name}`)).kind !== 'off' : false;
    return rowLive(r, world, pools, vmOn);
  };
  const columns: Column<DcRow>[] = [
    {
      id: 'vm',
      header: 'VM',
      sort: r => `${r.vm?.metadata.namespace ?? r.service.metadata.namespace}/${r.vm?.metadata.name ?? ''}`,
      cell: r =>
        r.vm ? (
          <Box>
            <Box component={RouterLink} to={vmHref(r.vm.metadata.namespace as string, r.vm.metadata.name, 'configure')} sx={{ color: 'inherit', fontWeight: 600 }}>
              {r.vm.metadata.name}
            </Box>
            <Box sx={{ fontSize: 12.5, color: t.muted }}>{r.vm.metadata.namespace}</Box>
          </Box>
        ) : (
          <Box sx={{ color: t.muted }}>{r.service.metadata.labels?.['hangar.magesgate.com/vm'] ?? '—'} (gone)</Box>
        ),
    },
    {
      id: 'port',
      header: 'Port',
      sort: r => Number(r.guest) || 0,
      cell: r => (
        <Box sx={tabular}>
          <b>{r.name ?? `port ${r.port}`}</b>{' '}
          <Box component="span" sx={{ color: t.muted }}>
            {r.guest}/{r.protocol}
          </Box>
        </Box>
      ),
    },
    {
      id: 'how',
      header: 'How',
      sort: r => r.mode,
      cell: r => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Icon icon={MODE_ICON[r.mode]} width={16} style={{ color: t.muted }} />
          {modeInfo(r.mode).short}
          {!r.managed && <Tag tone="muted">Outside Hangar</Tag>}
        </Box>
      ),
    },
    {
      id: 'address',
      header: 'Address',
      cell: r => {
        const live = liveOf(r);
        return (
          <Box sx={{ ...tabular, minWidth: 0 }}>
            <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.mode === 'host' && r.nodePort && hosts[0] ? `${hosts[0].ip}:${r.nodePort}` : whereText(r, live.lb)}</Box>
            {r.mode === 'host' && hosts.length > 1 && <Box sx={{ fontSize: 12.5, color: t.muted }}>or any of {hosts.length} host addresses</Box>}
            {live.lb && live.lb.phase !== 'waiting' && <Box sx={{ fontSize: 12.5, color: t.muted }}>{lbWords(live.lb, r.service)}</Box>}
            {k8s && <K8sName>service/{r.service.metadata.name}</K8sName>}
          </Box>
        );
      },
    },
    {
      id: 'state',
      header: 'State',
      sort: r => liveOf(r).text,
      cell: r => {
        const live = liveOf(r);
        return (
          <Box>
            <LiveLabel tone={live.tone}>{live.text}</LiveLabel>
            {r.conflict && (
              <Box sx={{ mt: 0.25 }}>
                <Tag tone="warn">
                  <Icon icon="mdi:alert-outline" width={13} /> {r.conflict}
                </Tag>
              </Box>
            )}
          </Box>
        );
      },
    },
  ];

  return (
    <Box ref={ref} id="published-ports" sx={{ scrollMarginTop: 16 }}>
      <Panel
        title={
          <>
            Published ports{' '}
            <Box component="span" sx={{ color: t.muted, fontWeight: 400, fontSize: 13.5, ...tabular }}>
              {rows.length} port{rows.length === 1 ? '' : 's'}
              {conflicts ? `, ${conflicts} in conflict` : ''}
            </Box>
          </>
        }
        icon="mdi:door-open"
        dense
      >
        <DataTable
          label="Published ports"
          rows={rows}
          columns={columns}
          rowKey={r => r.key}
          initialSort={{ id: 'vm', dir: 'asc' }}
          empty={
            <Box sx={{ p: 2, fontSize: 14, color: t.muted }}>
              {world.loaded
                ? world.denied.services
                  ? 'Your role cannot list Services: published ports cannot be shown.'
                  : "No VM publishes a port. Publish one from a VM's Configure → Published ports."
                : 'Reading the Services…'}
            </Box>
          }
        />
      </Panel>
    </Box>
  );
}
