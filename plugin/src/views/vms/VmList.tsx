/*
 * The VM list of the datacenter or of a folder: power state, guest, host,
 * address, sizing and live usage, with bulk power actions.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { last, useMetrics } from '../../api/metrics';
import { Obj } from '../../model/types';
import { formatBytes, parseQuantity, pct } from '../../model/units';
import { formatAge } from '../../model/units';
import {
  claimNames,
  hardware,
  isTemplate,
  key,
  osIcon,
  powerActions,
  powerState,
  primaryIp,
  runningSince,
  runStrategy,
  tags,
} from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { confirm, openDialog } from '../../ui/dialogs';
import { Divider, Empty, K8sName, PowerLabel, Sparkline, Tag, Toolbar, ToolButton } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { openNewVmWizard } from '../../wizard/open';
import { vmOs } from '../os';
import { VmContextMenu } from '../vm/actions';
import { NewFolderDialog } from './NewFolderDialog';

type Filter = 'all' | 'on' | 'off' | 'paused' | 'problem';

export function vmDiskBytes(vm: Obj, d: HangarData): number {
  return claimNames(vm).reduce((s, c) => {
    const pvc = d.idx.pvc.get(`${vm.metadata.namespace}/${c}`);
    const q = parseQuantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage);
    return s + (isFinite(q) ? q : 0);
  }, 0);
}

export function VmList({ folder, templates }: { folder?: string; templates?: boolean }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const history = useHistory();
  const m = useMetrics();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [q, setQ] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [menu, setMenu] = React.useState<{ vm: Obj; x: number; y: number } | null>(null);
  const [now] = React.useState(Date.now());

  const inScope = d.vms.filter(vm => (!folder || vm.metadata.namespace === folder) && isTemplate(vm) === !!templates);
  const rows = inScope.filter(vm => {
    const p = powerState(vm, d.idx.vmi.get(key(vm)));
    if (filter === 'on' && !(p.kind === 'on' || p.kind === 'migrating')) return false;
    if (filter === 'off' && p.kind !== 'off') return false;
    if (filter === 'paused' && p.kind !== 'paused') return false;
    if (filter === 'problem' && p.tone !== 'fault') return false;
    if (q) {
      const vmi = d.idx.vmi.get(key(vm));
      const hay = [vm.metadata.name, vm.metadata.namespace, primaryIp(vmi), vmi?.status?.nodeName, vmOs(vm, d).name, ...tags(vm).map(x => x.join('='))]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });
  const counts = inScope.reduce(
    (c, vm) => {
      const p = powerState(vm, d.idx.vmi.get(key(vm)));
      if (p.kind === 'on' || p.kind === 'migrating') c.on++;
      else if (p.kind === 'off') c.off++;
      else if (p.kind === 'paused') c.paused++;
      if (p.tone === 'fault') c.problem++;
      return c;
    },
    { on: 0, off: 0, paused: 0, problem: 0 }
  );
  const sel = rows.filter(vm => selected.has(key(vm)));
  const selStates = sel.map(vm => powerActions(powerState(vm, d.idx.vmi.get(key(vm))), runStrategy(vm)));
  const bulk = (fn: (vm: Obj) => Promise<unknown>) => sel.forEach(vm => fn(vm).catch(() => undefined));

  const columns: Column<Obj>[] = [
    {
      id: 'name',
      header: 'Name',
      sort: vm => vm.metadata.name,
      width: 220,
      cell: vm => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          {templates && <Icon icon="mdi:file-document-outline" width={16} style={{ color: t.muted, flex: 'none' }} />}
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{vm.metadata.name}</Box>
            {k8s && <K8sName>VirtualMachine {vm.metadata.namespace}/{vm.metadata.name}</K8sName>}
          </Box>
        </Box>
      ),
    },
    ...(!templates
      ? [
          {
            id: 'state',
            header: 'State',
            sort: (vm: Obj) => powerState(vm, d.idx.vmi.get(key(vm))).label,
            cell: (vm: Obj) => {
              const p = powerState(vm, d.idx.vmi.get(key(vm)));
              return (
                <Box>
                  <PowerLabel p={p} size="sm" />
                  {k8s && (
                    <Box>
                      <K8sName>{p.printable}</K8sName>
                    </Box>
                  )}
                </Box>
              );
            },
          } as Column<Obj>,
        ]
      : []),
    {
      id: 'os',
      header: 'Guest OS',
      minWidth: 900,
      width: 190,
      sort: vm => vmOs(vm, d).name,
      cell: vm => {
        const os = vmOs(vm, d);
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }} title={`${os.name}: ${os.fromAgent ? 'reported by the guest agent' : 'from the VM settings'}`}>
            <Icon icon={osIcon(os.id)} width={16} style={{ color: t.muted, flex: 'none' }} />
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {os.name}
            </Box>
          </Box>
        );
      },
    },
    ...(!folder
      ? [
          {
            id: 'folder',
            header: k8s ? 'Namespace' : 'Folder',
            sort: (vm: Obj) => vm.metadata.namespace ?? '',
            cell: (vm: Obj) => vm.metadata.namespace,
          } as Column<Obj>,
        ]
      : []),
    ...(!templates
      ? [
          {
            id: 'host',
            header: 'Host',
            minWidth: 1000,
            width: 170,
            sort: (vm: Obj) => d.idx.vmi.get(key(vm))?.status?.nodeName ?? '',
            cell: (vm: Obj) => d.idx.vmi.get(key(vm))?.status?.nodeName ?? '—',
          } as Column<Obj>,
          {
            id: 'ip',
            header: 'IP address',
            sort: (vm: Obj) => primaryIp(d.idx.vmi.get(key(vm))) ?? '',
            cell: (vm: Obj) => primaryIp(d.idx.vmi.get(key(vm))) ?? '—',
          } as Column<Obj>,
        ]
      : []),
    {
      id: 'cpu',
      header: 'vCPU',
      align: 'right',
      sort: vm => hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).vcpus,
      cell: vm => hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).vcpus,
    },
    {
      id: 'mem',
      header: 'Memory',
      align: 'right',
      sort: vm => hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).memoryBytes,
      cell: vm => formatBytes(hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).memoryBytes),
    },
    {
      id: 'disk',
      header: 'Storage',
      align: 'right',
      minWidth: 1100,
      sort: vm => vmDiskBytes(vm, d),
      cell: vm => formatBytes(vmDiskBytes(vm, d)),
    },
    ...(!templates
      ? [
          {
            id: 'usage',
            header: 'CPU usage',
            minWidth: 1200,
            sort: (vm: Obj) => last(m.vms.get(key(vm)))?.cpu ?? -1,
            cell: (vm: Obj) => {
              const s = m.vms.get(key(vm));
              const hw = hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes);
              const cur = last(s);
              if (!cur || !d.idx.vmi.get(key(vm))) return '—';
              return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Sparkline values={s!.map(x => x.cpu)} max={hw.vcpus} width={64} height={18} label="CPU usage, last 30 minutes" />
                  <span>{Math.round(pct(cur.cpu, hw.vcpus))}%</span>
                </Box>
              );
            },
          } as Column<Obj>,
          {
            id: 'uptime',
            header: 'Uptime',
            minWidth: 1300,
            sort: (vm: Obj) => {
              const since = runningSince(d.idx.vmi.get(key(vm)));
              return since ? -new Date(since).getTime() : 1;
            },
            cell: (vm: Obj) => {
              const vmi = d.idx.vmi.get(key(vm));
              return vmi ? formatAge(runningSince(vmi), now) : '—';
            },
          } as Column<Obj>,
        ]
      : []),
    {
      id: 'tags',
      header: 'Tags',
      minWidth: 1400,
      cell: vm => (
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {tags(vm)
            .slice(0, 3)
            .map(([k, v]) => (
              <Tag key={k}>
                {k}: {v}
              </Tag>
            ))}
        </Box>
      ),
    },
  ];

  const title = templates ? 'Templates' : folder ? folder : 'All virtual machines';
  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          {folder && <Icon icon="mdi:folder-outline" width={20} style={{ marginRight: 6, verticalAlign: -2, color: t.muted }} />}
          {title}
        </Typography>
        {folder && k8s && <K8sName>namespace {folder}</K8sName>}
        <Typography sx={{ color: t.muted, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
          {templates ? `${inScope.length} templates` : `${counts.on} on, ${counts.off} off${counts.paused ? `, ${counts.paused} suspended` : ''} of ${inScope.length}`}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {!folder && (
          <ToolButton icon="mdi:folder-plus-outline" onClick={() => openDialog(close => <NewFolderDialog onClose={close} />)}>
            New folder
          </ToolButton>
        )}
        <ToggleButtonGroup
          size="small"
          exclusive
          value={templates ? 'templates' : 'vms'}
          onChange={(_, v) => v && history.push(v === 'templates' ? hrefFor('storage', 'templates', folder) : hrefFor('vms', folder))}
          aria-label="VMs or templates"
        >
          <ToggleButton value="vms" sx={{ textTransform: 'none', px: 1.5 }}>
            Virtual machines
          </ToggleButton>
          <ToggleButton value="templates" sx={{ textTransform: 'none', px: 1.5 }}>
            Templates
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
        <Toolbar>
          {!templates && (
            <>
              <ToolButton icon="mdi:play" disabled={!selStates.some(s => s.start)} onClick={() => bulk(vm => A.powerOn(vm))}>
                Power on
              </ToolButton>
              <ToolButton icon="mdi:power" disabled={!selStates.some(s => s.shutdown)} onClick={() => bulk(vm => A.shutDown(vm))}>
                Shut down
              </ToolButton>
              <ToolButton icon="mdi:restart" disabled={!selStates.some(s => s.restart)} onClick={() => bulk(vm => A.restart(vm))}>
                Restart
              </ToolButton>
              <ToolButton icon="mdi:pause" disabled={!selStates.some(s => s.suspend)} onClick={() => bulk(vm => A.suspend(vm))}>
                Suspend
              </ToolButton>
              <ToolButton icon="mdi:play-pause" disabled={!selStates.some(s => s.resume)} onClick={() => bulk(vm => A.resume(vm))}>
                Resume
              </ToolButton>
              <ToolButton
                icon="mdi:power-plug-off-outline"
                disabled={!selStates.some(s => s.powerOff)}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Power off ${sel.length} VM${sel.length > 1 ? 's' : ''}?`,
                    body: <p>They stop at once, like pulling the plug: unsaved data in the guests is lost.</p>,
                    confirm: 'Power off',
                    danger: true,
                  });
                  if (ok) bulk(vm => A.shutDown(vm, { force: true }));
                }}
              >
                Power off
              </ToolButton>
              <Divider />
            </>
          )}
          <ToolButton
            icon="mdi:delete-outline"
            disabled={!sel.length}
            onClick={async () => {
              const r = await confirm({
                title: `Delete ${sel.length} ${templates ? 'template' : 'VM'}${sel.length > 1 ? 's' : ''}?`,
                body: (
                  <>
                    <p>{sel.map(v => v.metadata.name).join(', ')}</p>
                    <p>Running VMs are powered off. Disks created with them are deleted too, unless you keep them.</p>
                  </>
                ),
                confirm: 'Delete',
                danger: true,
                typeToConfirm: sel.length > 1 ? `delete ${sel.length}` : sel[0]?.metadata.name,
                option: { label: 'Keep their disks' },
              });
              if (r) {
                bulk(vm => A.deleteVm(vm, { keepDisks: r.option }));
                setSelected(new Set());
              }
            }}
          >
            Delete
          </ToolButton>
          <Box sx={{ flex: 1 }} />
          {!templates && (
            <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} aria-label="Filter by state" sx={{ mr: 1 }}>
              {(
                [
                  ['all', 'All'],
                  ['on', 'On'],
                  ['off', 'Off'],
                  ['paused', 'Suspended'],
                  ['problem', `Problems${counts.problem ? ` (${counts.problem})` : ''}`],
                ] as [Filter, string][]
              ).map(([v, l]) => (
                <ToggleButton key={v} value={v} sx={{ textTransform: 'none', py: 0.25, px: 1.25, fontSize: 13 }}>
                  {l}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          <TextField
            size="small"
            placeholder="Filter"
            value={q}
            onChange={e => setQ(e.target.value)}
            inputProps={{ 'aria-label': 'Filter the list' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Icon icon="mdi:filter-variant" width={16} />
                </InputAdornment>
              ),
            }}
            sx={{ width: 180, my: 0.5, '& input': { py: 0.6, fontSize: 13.5 } }}
          />
        </Toolbar>
        <DataTable
          label={title}
          rows={rows}
          columns={columns}
          rowKey={key}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onOpen={vm => history.push(hrefFor('vm', vm.metadata.namespace, vm.metadata.name))}
          onContextMenu={(vm, e) => setMenu({ vm, x: e.clientX, y: e.clientY })}
          initialSort={{ id: 'name', dir: 'asc' }}
          empty={
            inScope.length === 0 ? (
              <Empty
                icon={templates ? 'mdi:file-document-outline' : 'mdi:server'}
                title={templates ? 'No templates here' : folder ? 'This folder has no VMs' : 'No virtual machines yet'}
                action={
                  !templates ? (
                    <ToolButton icon="mdi:plus" variant="outlined" onClick={() => openNewVmWizard({ folder })}>
                      New VM
                    </ToolButton>
                  ) : undefined
                }
              >
                {templates
                  ? 'Turn a powered-off VM into a template from its Actions menu, then create new VMs from it in one step.'
                  : 'Create one from an image of the library, an ISO, or an empty disk.'}
              </Empty>
            ) : (
              <Empty icon="mdi:filter-variant" title="Nothing matches the filter" />
            )
          }
        />
      </Box>
      {menu && (
        <VmContextMenu vm={menu.vm} anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
    </Box>
  );
}
