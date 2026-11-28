/*
 * Networks: the pod network (NAT) and the VM networks on host bridges
 * (Multus NetworkAttachmentDefinitions), with their bridge, VLAN, MTU and
 * VMs; every published port of the VMs (Services); then the hosts' own
 * interfaces from nmstate.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { HangarData, useHangar } from '../../api/data';
import { deleteNetwork } from '../../api/networks';
import { nadOverlay, useOverlay } from '../../api/optimistic';
import { hostBridges, HostIface, hostInterfaces, NetworkRow, networkRows, vlanLabel } from '../../model/networks';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { confirm, openDialog } from '../../ui/dialogs';
import { Empty, IconAction, K8sName, Panel, Tag, Toolbar, ToolButton } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note, srOnly } from '../storage/parts';
import { CreateNetworkDialog } from './CreateNetworkDialog';
import { PublishedPorts } from './PublishedPorts';

export function NetworksView({ section }: { section?: string } = {}) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const nads = useOverlay(nadOverlay, d.has.nads ? d.nads : []);
  const rows = React.useMemo(() => networkRows(nads, d.vms), [nads, d.vms]);
  const attached = new Set(rows.flatMap(r => r.uses.map(u => `${u.vm.metadata.namespace}/${u.vm.metadata.name}`))).size;
  const create = () => openDialog(close => <CreateNetworkDialog d={d} onClose={close} />);

  const remove = async (r: NetworkRow) => {
    const ok = await confirm({
      title: `Delete network ${r.name}?`,
      body: (
        <>
          <p>No VM uses it. VMs can no longer get an adapter on it.</p>
          <p>The host bridge{r.cni.bridge ? ` ${r.cni.bridge}` : ''} and your physical network are not changed.</p>
        </>
      ),
      confirm: 'Delete network',
      danger: true,
    });
    if (ok) deleteNetwork(r).catch(() => undefined);
  };

  const columns: Column<NetworkRow>[] = [
    {
      id: 'name',
      header: 'Network',
      sort: r => (r.isPod ? '' : r.name),
      width: 280,
      cell: r => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
          <Icon icon={r.isPod ? 'mdi:router-network' : 'mdi:lan'} width={20} style={{ color: t.muted, flex: 'none' }} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</Box>
            {r.description && (
              <Box sx={{ fontSize: 12.5, color: t.muted, whiteSpace: 'normal', maxWidth: 360 }}>{r.description}</Box>
            )}
            {k8s && !r.isPod && <K8sName>NetworkAttachmentDefinition {r.key}</K8sName>}
          </Box>
        </Box>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      sort: r => r.cni.label,
      cell: r => (
        <Box title={r.cni.error}>
          {r.cni.label}
          {r.cni.error && (
            <Box component="span" sx={{ ml: 0.75 }}>
              <Tag tone="warn">Unreadable config</Tag>
            </Box>
          )}
          {k8s && r.cni.type && (
            <Box>
              <K8sName>
                cni {r.cni.type}
                {r.cni.chained.length ? ` + ${r.cni.chained.join(', ')}` : ''}
              </K8sName>
            </Box>
          )}
        </Box>
      ),
    },
    {
      id: 'bridge',
      header: 'Host side',
      sort: r => r.cni.bridge ?? r.cni.master ?? '',
      cell: r => (r.isPod ? <Box sx={{ color: t.muted }}>Each host's routing</Box> : r.cni.bridge ?? r.cni.master ?? '—'),
    },
    { id: 'vlan', header: 'VLAN', sort: r => r.cni.vlan ?? 0, cell: r => (r.isPod ? '—' : vlanLabel(r.cni)) },
    { id: 'mtu', header: 'MTU', align: 'right', minWidth: 900, sort: r => r.cni.mtu ?? 0, cell: r => (r.isPod ? '—' : r.cni.mtu ?? <Box sx={{ color: t.muted }}>default</Box>) },
    {
      id: 'scope',
      header: k8s ? 'Namespace' : 'Folders',
      sort: r => (r.allFolders ? '' : r.namespace ?? ''),
      cell: r => (r.allFolders ? 'All folders' : r.namespace),
    },
    {
      id: 'addr',
      header: 'Addresses',
      minWidth: 1150,
      cell: r => <Box sx={{ color: t.muted }}>{r.isPod ? 'Given by the cluster (NAT)' : r.cni.ipam ?? '—'}</Box>,
    },
    {
      id: 'vms',
      header: 'VMs',
      sort: r => r.uses.length,
      cell: r =>
        r.uses.length ? (
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', maxWidth: 320, whiteSpace: 'normal' }}>
            {r.uses.slice(0, 4).map(u => (
              <Box key={`${u.vm.metadata.namespace}/${u.vm.metadata.name}/${u.nic}`} component={RouterLink} to={hrefFor('vm', u.vm.metadata.namespace, u.vm.metadata.name)} sx={{ color: t.accent }}>
                {u.vm.metadata.name}
              </Box>
            ))}
            {r.uses.length > 4 && <Box sx={{ color: t.muted }}>and {r.uses.length - 4} more</Box>}
          </Box>
        ) : (
          <Box sx={{ color: t.muted }}>None</Box>
        ),
    },
    {
      id: 'actions',
      header: <Box component="span" sx={srOnly}>Actions</Box>,
      align: 'right',
      width: 56,
      cell: r =>
        r.isPod ? null : (
          <IconAction
            icon="mdi:delete-outline"
            label={r.uses.length ? `Delete ${r.name}: ${r.uses.length} VM${r.uses.length === 1 ? ' uses' : 's use'} it` : `Delete ${r.name}`}
            disabled={r.uses.length > 0}
            onClick={() => remove(r)}
          />
        ),
    },
  ];

  return (
    <Box sx={{ p: 2, display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          <Icon icon="mdi:lan" width={22} style={{ verticalAlign: -3, marginRight: 8, color: t.muted }} />
          Networks
        </Typography>
        <Typography sx={{ color: t.muted, fontSize: 14, ...tabular }}>
          {rows.length} network{rows.length === 1 ? '' : 's'}, {attached} VM{attached === 1 ? '' : 's'} connected
        </Typography>
      </Box>
      {!d.has.nads && !d.loading && (
        <Note tone="warn" icon={<Icon icon="mdi:alert-outline" width={18} style={{ color: '#B7791F', flex: 'none', marginTop: 1 }} />}>
          <b>Multus is not installed:</b> VMs can use only the pod network. Install Multus (and a bridge plugin such as ovs-cni) to connect VMs
          to VLANs and host bridges.
        </Note>
      )}
      <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
        <Toolbar>
          <ToolButton icon="mdi:plus" onClick={create} disabled={!d.has.nads} tooltip={d.has.nads ? undefined : 'Needs Multus'}>
            Create network
          </ToolButton>
        </Toolbar>
        <DataTable
          label="VM networks"
          rows={rows}
          columns={columns}
          rowKey={r => r.key}
          initialSort={{ id: 'name', dir: 'asc' }}
        />
        {d.has.nads && rows.length === 1 && (
          <Empty
            icon="mdi:lan-connect"
            title="Only the pod network so far"
            action={
              <ToolButton icon="mdi:plus" variant="outlined" onClick={create}>
                Create network
              </ToolButton>
            }
          >
            Put VMs straight on your LAN or a VLAN: create a network on a host bridge. VMs then get addresses from your network, as physical
            servers do.
          </Empty>
        )}
      </Box>
      <PublishedPorts focus={section === 'ports'} />
      <HostNetworks d={d} />
    </Box>
  );
}

function HostNetworks({ d }: { d: HangarData }) {
  const t = useTokens();
  const k8s = useK8s();
  if (!d.has.nmstate || !d.nodeNetworkStates.length) {
    return (
      <Panel title="Host networks" icon="mdi:server-network">
        <Box sx={{ fontSize: 14, color: t.muted }}>
          Install NMState (kubernetes-nmstate) to see each host's NICs, bonds, VLANs and bridges here, and to pick bridges when you create a
          network.
        </Box>
      </Panel>
    );
  }
  const bridges = hostBridges(d.nodeNetworkStates, d.nodes);
  const columns: Column<HostIface>[] = [
    {
      id: 'name',
      header: 'Interface',
      sort: i => i.name,
      cell: i => {
        const vmReady = bridges.find(b => b.name === i.name && (b.kind === 'ovs' ? i.type === 'ovs-bridge' : i.type === 'linux-bridge'));
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Icon icon={i.type === 'ethernet' ? 'mdi:ethernet' : i.type.includes('bridge') ? 'mdi:bridge' : 'mdi:lan-connect'} width={16} style={{ color: t.muted }} />
            <b>{i.name}</b>
            {vmReady?.marked && <Tag tone="accent">VM networks can use it</Tag>}
          </Box>
        );
      },
    },
    { id: 'type', header: 'Type', sort: i => i.label, cell: i => i.label },
    {
      id: 'state',
      header: 'State',
      sort: i => i.state,
      cell: i => (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
          <Led tone={i.state === 'up' ? 'on' : i.state === 'down' ? 'off' : 'standby'} size={8} />
          {i.state === 'up' ? 'Up' : i.state === 'down' ? 'Down' : i.state}
        </Box>
      ),
    },
    { id: 'detail', header: 'Ports, VLAN, bond', cell: i => <Box sx={{ color: t.muted }}>{i.detail ?? '—'}</Box> },
    { id: 'ip', header: 'Addresses', cell: i => (i.ips.length ? i.ips.join(', ') : <Box sx={{ color: t.muted }}>—</Box>) },
    { id: 'mtu', header: 'MTU', align: 'right', cell: i => i.mtu ?? '—' },
    ...(k8s ? [{ id: 'mac', header: 'MAC', cell: (i: HostIface) => <K8sName>{i.mac ?? '—'}</K8sName> } as Column<HostIface>] : []),
  ];
  return (
    <>
      {d.nodeNetworkStates.map(s => (
        <Panel
          key={s.metadata.name}
          title={
            <Box component="span">
              Host networks:{' '}
              <Box component={RouterLink} to={hrefFor('host', s.metadata.name)} sx={{ color: 'inherit' }}>
                {s.metadata.name}
              </Box>
            </Box>
          }
          icon="mdi:server-network"
          dense
        >
          <DataTable label={`Interfaces of ${s.metadata.name}`} rows={hostInterfaces(s)} columns={columns} rowKey={i => `${i.type}/${i.name}`} />
        </Panel>
      ))}
    </>
  );
}
