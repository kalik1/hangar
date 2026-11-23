/*
 * A host: summary (hardware, system, virtualization), its VMs, maintenance
 * mode with evacuation by live migration, usage, events.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { useHangar } from '../../api/data';
import { last, useMetrics } from '../../api/metrics';
import { hostCpuModel, hostRoles, hostState } from '../../model/inventory';
import { Obj } from '../../model/types';
import { formatBytes, formatCores, parseQuantity } from '../../model/units';
import { hardware, key, powerState, primaryIp } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { Empty, K8sName, KV, Meter, Panel, PowerLabel } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { useTokens } from '../../ui/useTokens';
import { HostStoragePanel } from '../storage/HostStorage';
import { EventsTable, useEvents } from '../vm/EventsTab';
import { UsageChart } from '../vm/MonitorTab';
import { HardwareTab, HostTabs } from './HardwareTab';
import { openMaintenance, useEvacuationPlan } from './Maintenance';

export function HostPage({ name, tab }: { name: string; tab?: string }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const m = useMetrics();
  const history = useHistory();
  const node = d.idx.node.get(name);
  const { events } = useEvents(undefined, new Set([name]), 20000);
  const plan = useEvacuationPlan(name);
  if (!node) return d.loading ? null : <Empty icon="mdi:server-off" title={`There is no host ${name}`} />;
  const s = hostState(node);
  const vmis = d.vmis.filter(v => v.status?.nodeName === name);
  const vms = vmis.map(v => d.idx.vm.get(key(v))).filter((x): x is Obj => !!x);
  const samples = m.hosts.get(name) ?? [];
  const u = last(samples);
  const cpu = parseQuantity(node.status?.allocatable?.cpu);
  const mem = parseQuantity(node.status?.allocatable?.memory);
  const alloc = vms.reduce(
    (acc, vm) => {
      const hw = hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes);
      return { cpu: acc.cpu + hw.vcpus, mem: acc.mem + hw.memoryBytes };
    },
    { cpu: 0, mem: 0 }
  );
  const info = node.status?.nodeInfo ?? {};
  const kvm = parseQuantity(node.status?.allocatable?.['devices.kubevirt.io/kvm']);
  const enter = () => openMaintenance(name);

  const columns: Column<Obj>[] = [
    { id: 'name', header: 'VM', sort: vm => vm.metadata.name, cell: vm => <b>{vm.metadata.name}</b> },
    { id: 'state', header: 'State', cell: vm => <PowerLabel p={powerState(vm, d.idx.vmi.get(key(vm)))} size="sm" /> },
    { id: 'folder', header: k8s ? 'Namespace' : 'Folder', sort: vm => vm.metadata.namespace ?? '', cell: vm => vm.metadata.namespace },
    { id: 'ip', header: 'IP address', cell: vm => primaryIp(d.idx.vmi.get(key(vm))) ?? '—' },
    { id: 'cpu', header: 'vCPU', align: 'right', cell: vm => hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).vcpus },
    { id: 'mem', header: 'Memory', align: 'right', cell: vm => formatBytes(hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).memoryBytes) },
    {
      id: 'move',
      header: 'Can move live',
      cell: vm => {
        const r = plan.find(x => key(x.vm) === key(vm));
        if (!r) return '—';
        return r.live ? (
          <span title={`Can go to ${r.targets.join(', ')}`}>Yes</span>
        ) : (
          <Box component="span" title={r.why} sx={{ color: '#B7791F', display: 'inline-block', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
            No: {r.why}
          </Box>
        );
      },
    },
  ];

  return (
    <Box sx={{ p: 2, display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Icon icon="mdi:server" width={26} style={{ color: t.muted }} />
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          {name}
        </Typography>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
          <Led tone={s.tone} /> {s.label}
        </Box>
        {k8s && <K8sName>node, roles: {hostRoles(node).join(', ') || 'worker'}</K8sName>}
        <Box sx={{ flex: 1 }} />
        {s.maintenance ? (
          <Button variant="outlined" onClick={() => A.exitMaintenance(name).catch(() => undefined)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:wrench-outline" width={18} />}>
            Exit maintenance mode
          </Button>
        ) : (
          <Button variant="outlined" onClick={enter} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:wrench-outline" width={18} />} disabled={!s.ready}>
            Enter maintenance mode
          </Button>
        )}
      </Box>
      <HostTabs name={name} tab={tab} />
      {tab === 'hardware' ? (
        <HardwareTab host={name} />
      ) : (
        <>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1fr) minmax(0,1fr)' }, alignItems: 'start' }}>
        <Panel title="Hardware and system" icon="mdi:chip">
          <KV
            rows={[
              ['CPU', `${formatCores(parseQuantity(node.status?.capacity?.cpu))} logical CPUs${hostCpuModel(node) ? `, model ${hostCpuModel(node)}` : ''}`],
              ['Memory', formatBytes(parseQuantity(node.status?.capacity?.memory))],
              ['Virtualization', s.virt ? `KVM ready${isFinite(kvm) ? `, up to ${kvm} VMs` : ''}` : 'Not available on this host'],
              ['System', info.osImage],
              ['Kernel', info.kernelVersion],
              ['Kubernetes', `${info.kubeletVersion}, ${info.containerRuntimeVersion}`],
              ['Address', (node.status?.addresses ?? []).map((a: any) => a.address).join(', ')],
            ]}
          />
        </Panel>
        <Panel title="Resources" icon="mdi:gauge">
          <Box sx={{ display: 'grid', gap: 2 }}>
            <Meter label="CPU" used={u?.cpu} allocated={Math.min(alloc.cpu, cpu)} total={cpu} format={x => `${formatCores(x)} cores`} caption={`${alloc.cpu} vCPU given to ${vms.length} running VMs`} />
            <Meter label="Memory" used={u?.mem} allocated={alloc.mem} total={mem} format={x => formatBytes(x)} caption={`${formatBytes(alloc.mem)} given to running VMs`} />
          </Box>
        </Panel>
      </Box>
      <HostStoragePanel host={name} />
      <Panel title={`Virtual machines on this host (${vms.length})`} icon="mdi:server" dense>
        <DataTable
          label="VMs on this host"
          rows={vms}
          columns={columns}
          rowKey={key}
          onOpen={vm => history.push(hrefFor('vm', vm.metadata.namespace, vm.metadata.name))}
          empty={<Empty icon="mdi:server" title="No VM runs here" />}
        />
      </Panel>
      {samples.length > 1 && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' } }}>
          <Panel title="CPU, last 30 minutes" icon="mdi:cpu-64-bit">
            <UsageChart samples={samples} pick={x => x.cpu} max={cpu} format={x => `${formatCores(x)}`} label="CPU used" />
          </Panel>
          <Panel title="Memory, last 30 minutes" icon="mdi:memory">
            <UsageChart samples={samples} pick={x => x.mem} max={mem} format={x => formatBytes(x, 0)} label="Memory used" />
          </Panel>
        </Box>
      )}
      <Panel title="Events" icon="mdi:history" dense>
        {events && events.length ? <EventsTable events={events.slice(0, 30)} showObject={false} /> : <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>No recent events.</Box>}
      </Panel>
        </>
      )}
    </Box>
  );
}
