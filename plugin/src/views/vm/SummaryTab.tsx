/*
 * VM summary: guest, hardware, placement and policies, usage, notes, tags,
 * the VM's recent tasks.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import * as A from '../../api/actions';
import { useHangar, useTasks } from '../../api/data';
import { useGuestInfo } from '../../api/guest';
import { last, useMetrics } from '../../api/metrics';
import { liveGate } from '../../model/placement';
import { isProtected } from '../../model/protection';
import { Obj } from '../../model/types';
import { formatBytes, formatCores, parseQuantity, pct } from '../../model/units';
import {
  disks,
  EVICTION_LABELS,
  evictionStrategy,
  guestAgent,
  hardware,
  isTemplate,
  key,
  nics,
  notes,
  runStrategy,
  runStrategyLabel,
  tags,
} from '../../model/vm';
import { deviceOptions, sharesOf, startPaused } from '../../model/vmoptions';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { TaskRows } from '../../shell/TasksDock';
import { K8sName, KV, Meter, Panel, Sparkline, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { useVmDeviceRows } from './DevicesSection';

/** The VM's extra devices in words (Configure → Devices, Shared folders). */
function deviceWords(vm: Obj): string {
  const o = deviceOptions(vm);
  const out: string[] = [];
  out.push(o.graphics ? (o.video ? `${o.video} video` : 'graphics') : 'headless');
  if (o.sound) out.push(`audio (${o.sound})`);
  if (o.rng) out.push('RNG');
  if (o.watchdog) out.push(`watchdog (${o.watchdog})`);
  if (o.panic) out.push('crash reports');
  if (o.vsock) out.push('VSOCK');
  if (o.downwardMetrics) out.push('host metrics');
  const shares = sharesOf(vm).length;
  if (shares) out.push(`${shares} shared folder${shares > 1 ? 's' : ''}`);
  if (startPaused(vm)) out.push('starts paused');
  return out.join(', ');
}

function NotesEditor({ vm }: { vm: Obj }) {
  const t = useTokens();
  const [edit, setEdit] = React.useState(false);
  const [text, setText] = React.useState(notes(vm));
  const current = notes(vm);
  return edit ? (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <TextField multiline minRows={3} value={text} onChange={e => setText(e.target.value)} size="small" inputProps={{ 'aria-label': 'Notes' }} />
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
        <Button size="small" color="inherit" onClick={() => (setText(current), setEdit(false))}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disableElevation
          onClick={() => {
            A.patchVm(vm, 'Edit notes', { metadata: { annotations: { description: text || null } } }).catch(() => undefined);
            setEdit(false);
          }}
        >
          Save notes
        </Button>
      </Box>
    </Box>
  ) : (
    <Box
      sx={{ fontSize: 14, whiteSpace: 'pre-wrap', color: current ? t.text : t.muted, cursor: 'text', minHeight: 24 }}
      onClick={() => (setText(current), setEdit(true))}
    >
      {current || 'Add notes about what this VM is for, who owns it, how to reach it.'}
    </Box>
  );
}

export function SummaryTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const m = useMetrics();
  const allTasks = useTasks();
  const vmi = d.idx.vmi.get(key(vm));
  const hw = hardware(vm, vmi, d.instancetypes);
  const os = vmOs(vm, d);
  const agent = guestAgent(vmi);
  const info = useGuestInfo(vm.metadata.namespace as string, vm.metadata.name, agent);
  const ds = disks(vm);
  const ns = nics(vm, vmi);
  const hostDevs = useVmDeviceRows(vm);
  const lm = liveGate(vmi);
  const samples = m.vms.get(key(vm));
  const cur = last(samples);
  const tpl = isTemplate(vm);
  const vmTasks = allTasks.filter(x => x.target?.kind === 'vm' && x.target.namespace === vm.metadata.namespace && x.target.name === vm.metadata.name).slice(0, 6);
  const snaps = d.idx.snapshots.get(key(vm)) ?? [];
  const pvcSize = (claim?: string) => {
    if (!claim) return undefined;
    const pvc = d.idx.pvc.get(`${vm.metadata.namespace}/${claim}`);
    return parseQuantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage);
  };
  const datastore = (claim?: string) => (claim ? d.idx.pvc.get(`${vm.metadata.namespace}/${claim}`)?.spec?.storageClassName : undefined);

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1.25fr) minmax(0,1fr)' }, gap: 2, alignItems: 'start' }}>
      <Box sx={{ display: 'grid', gap: 2 }}>
        {!tpl && (
          <Panel title="Guest" icon="mdi:monitor">
            <KV
              rows={[
                ['Operating system', os.name + (os.fromAgent ? '' : ' (from the settings)')],
                ['Guest agent', agent ? 'Running' : vmi ? 'Not running: install qemu-guest-agent for IPs, users and filesystems' : '—'],
                ['Hostname', info?.os?.hostname ?? vmi?.status?.guestOSInfo?.hostname ?? '—'],
                ['Kernel', os.kernel ?? '—'],
                ['IP addresses', ns.flatMap(n => n.ips).join(', ') || '—'],
                ['Logged-in users', info ? (info.users.length ? info.users.map(u => u.userName).join(', ') : 'Nobody') : '—'],
              ]}
            />
            {info && info.filesystems.length > 0 && (
              <Box sx={{ mt: 2, display: 'grid', gap: 1.25 }}>
                {info.filesystems.map(f => (
                  <Meter
                    key={`${f.diskName}-${f.mountPoint}`}
                    label={`${f.mountPoint} (${f.fileSystemType})`}
                    used={f.usedBytes}
                    total={f.totalBytes}
                    format={n => formatBytes(n)}
                  />
                ))}
              </Box>
            )}
          </Panel>
        )}
        <Panel title="Hardware" icon="mdi:chip" actions={<Button size="small" component={RouterLink} to={hrefFor('vm', vm.metadata.namespace, vm.metadata.name, 'configure')} sx={{ textTransform: 'none' }}>Edit</Button>}>
          <KV
            rows={[
              [
                'CPU',
                <>
                  {hw.vcpus} vCPU ({hw.sockets} socket{hw.sockets > 1 ? 's' : ''} × {hw.cores} core{hw.cores > 1 ? 's' : ''}
                  {hw.threads > 1 ? ` × ${hw.threads} threads` : ''}){hw.dedicatedCpus ? ', dedicated' : ''}
                </>,
              ],
              ['Memory', formatBytes(hw.memoryBytes)],
              ...(hw.instancetype
                ? ([['Size profile', <>{hw.instancetype.name} {k8s && <K8sName>{hw.instancetype.kind}</K8sName>}</>]] as [React.ReactNode, React.ReactNode][])
                : []),
              ['Firmware', `${hw.firmware}${hw.tpm ? ', TPM' : ''}`],
              ...(hw.gpus || hw.hostDevices ? ([['Passthrough', `${hw.gpus} GPU, ${hw.hostDevices} host devices`]] as [React.ReactNode, React.ReactNode][]) : []),
              ['Devices', deviceWords(vm)],
            ]}
          />
          <Box component="table" sx={{ width: '100%', mt: 2, fontSize: 13.5, borderCollapse: 'collapse', ...tabular, '& td, & th': { py: 0.5, pr: 1.5, textAlign: 'left', borderTop: `1px solid ${t.rule}` }, '& th': { color: t.muted, fontWeight: 600, fontSize: 12.5, borderTop: 'none' } }}>
            <thead>
              <tr>
                <th>Device</th>
                <th>Type</th>
                <th>Size</th>
                <th>{k8s ? 'StorageClass' : 'Datastore'}</th>
              </tr>
            </thead>
            <tbody>
              {ds
                .filter(x => !x.config)
                .map(x => (
                  <tr key={x.name}>
                    <td>
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                        <Icon icon={x.device === 'cdrom' ? 'mdi:disc' : 'mdi:harddisk'} width={16} style={{ color: t.muted }} />
                        {x.name}
                        {x.bootOrder !== undefined && <Tag>boot {x.bootOrder}</Tag>}
                      </Box>
                      {k8s && x.claimName && (
                        <Box>
                          <K8sName>pvc/{x.claimName}</K8sName>
                        </Box>
                      )}
                    </td>
                    <td>
                      {x.device === 'cdrom' ? 'CD/DVD' : 'Disk'}, {x.bus}
                    </td>
                    <td>{formatBytes(pvcSize(x.claimName))}</td>
                    <td>{datastore(x.claimName) ?? (x.sourceKind === 'containerDisk' ? 'Image (ephemeral)' : '—')}</td>
                  </tr>
                ))}
              {ns.map(n => (
                <tr key={`nic-${n.name}`}>
                  <td>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                      <Icon icon="mdi:ethernet" width={16} style={{ color: t.muted }} />
                      {n.name}
                    </Box>
                  </td>
                  <td>
                    Network adapter, {n.model}
                  </td>
                  <td>{n.mac ?? '—'}</td>
                  <td>
                    {n.network} ({n.binding})
                  </td>
                </tr>
              ))}
              {hostDevs.map(x => (
                <tr key={`dev-${x.name}`}>
                  <td>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                      <Icon icon={x.icon} width={16} style={{ color: t.muted }} />
                      {x.label}
                    </Box>
                  </td>
                  <td>{x.kind}</td>
                  <td>—</td>
                  <td>From the host</td>
                </tr>
              ))}
            </tbody>
          </Box>
        </Panel>
        <Panel title="Notes" icon="mdi:note-text-outline">
          <NotesEditor vm={vm} />
          {tags(vm).length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1.5 }}>
              {tags(vm).map(([k, v]) => (
                <Tag key={k}>
                  <Icon icon="mdi:tag-outline" width={13} /> {k}: {v}
                </Tag>
              ))}
            </Box>
          )}
        </Panel>
      </Box>
      <Box sx={{ display: 'grid', gap: 2 }}>
        {!tpl && (
          <Panel title="Usage" icon="mdi:chart-line" footer={<Box sx={{ fontSize: 12.5, color: t.muted }}>Measured on the host, last 30 minutes.</Box>}>
            {cur && vmi ? (
              <Box sx={{ display: 'grid', gap: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Box sx={{ flex: 1 }}>
                    <Meter label="CPU" used={cur.cpu} total={hw.vcpus} format={n => `${formatCores(n)} vCPU`} caption={`${Math.round(pct(cur.cpu, hw.vcpus))}% of ${hw.vcpus} vCPU`} />
                  </Box>
                  <Sparkline values={(samples ?? []).map(s => s.cpu)} max={hw.vcpus} width={140} height={36} label="CPU usage" />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Box sx={{ flex: 1 }}>
                    <Meter
                      label="Memory"
                      used={cur.mem}
                      total={hw.memoryBytes}
                      format={n => formatBytes(n)}
                      caption="Includes the emulator's own memory"
                    />
                  </Box>
                  <Sparkline values={(samples ?? []).map(s => s.mem)} max={hw.memoryBytes * 1.2} width={140} height={36} label="Memory usage" />
                </Box>
              </Box>
            ) : (
              <Box sx={{ color: t.muted, fontSize: 14 }}>{vmi ? 'Waiting for the first measurement…' : 'The VM is powered off.'}</Box>
            )}
          </Panel>
        )}
        <Panel title="Placement and policies" icon="mdi:map-marker-outline">
          <KV
            labelWidth={170}
            rows={[
              [
                'Host',
                vmi?.status?.nodeName ? (
                  <Box component={RouterLink} to={hrefFor('host', vmi.status.nodeName)} sx={{ color: 'inherit' }}>
                    {vmi.status.nodeName}
                  </Box>
                ) : (
                  'Not running'
                ),
              ],
              [k8s ? 'Namespace' : 'Folder', vm.metadata.namespace],
              ['Power policy', runStrategyLabel(runStrategy(vm))],
              ['Delete protection', isProtected(vm) ? 'On: the VM and its disks cannot be deleted' : 'Off'],
              ['On host maintenance', EVICTION_LABELS[evictionStrategy(vm, d.kubevirt)] ?? evictionStrategy(vm, d.kubevirt)],
              ['Live migration', vmi ? (lm.ok ? 'Possible' : `Not possible. ${lm.why}`) : '—'],
              ['Snapshots', d.has.snapshots ? `${snaps.length}` : 'Not available on this cluster'],
              ['Created', vm.metadata.creationTimestamp ? new Date(vm.metadata.creationTimestamp).toLocaleString() : '—'],
            ]}
          />
        </Panel>
        <Panel title="Recent tasks" icon="mdi:history" dense>
          {vmTasks.length ? (
            <TaskRows list={vmTasks} now={Date.now()} />
          ) : (
            <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>Nothing done on this VM from Hangar yet.</Box>
          )}
        </Panel>
      </Box>
    </Box>
  );
}
