/*
 * Storage → Templates: VMs kept as templates (label
 * hangar.magesgate.com/template), with what a new VM gets from each —
 * guest OS, size, disks and where they are — and the actions: deploy a VM,
 * edit, clone the template, convert it back to a VM, delete. New templates
 * come from a powered-off VM, cloned or converted.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { HangarData } from '../../api/data';
import { useVmPerms } from '../../api/permissions';
import { Obj } from '../../model/types';
import { formatAge, formatBytes, parseQuantity } from '../../model/units';
import { claimNames, hardware, isTemplate, key, osIcon, powerState } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { openDialog } from '../../ui/dialogs';
import { Empty, IconAction, K8sName, Tag, Toolbar, ToolButton } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { vmActions, VmContextMenu } from '../vm/actions';
import { CloneDialog } from '../vm/CloneDialog';
import { SearchField } from './DatastoresTab';
import { srOnly } from './parts';

interface TemplateDisks {
  count: number;
  bytes: number;
  datastores: string[];
}

function templateDisks(vm: Obj, d: HangarData): TemplateDisks {
  const ns = vm.metadata.namespace as string;
  let bytes = 0;
  const ds = new Set<string>();
  const claims = claimNames(vm);
  for (const c of claims) {
    const pvc = d.idx.pvc.get(`${ns}/${c}`);
    const q = parseQuantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage);
    if (isFinite(q)) bytes += q;
    if (pvc?.spec?.storageClassName) ds.add(pvc.spec.storageClassName);
  }
  return { count: claims.length, bytes, datastores: [...ds] };
}

export function TemplatesTab({ d, folder }: { d: HangarData; folder?: string }) {
  const t = useTokens();
  const k8s = useK8s();
  const history = useHistory();
  const [q, setQ] = React.useState('');
  const [inFolder, setInFolder] = React.useState(folder ?? '');
  const [menu, setMenu] = React.useState<{ vm: Obj; x: number; y: number } | null>(null);
  React.useEffect(() => setInFolder(folder ?? ''), [folder]);
  const all = d.vms.filter(isTemplate);
  const folders = [...new Set(all.map(v => v.metadata.namespace as string))].sort();
  const rows = all.filter(vm => {
    if (inFolder && vm.metadata.namespace !== inFolder) return false;
    if (q) {
      const hay = [vm.metadata.name, vm.metadata.namespace, vm.metadata.annotations?.description, vmOs(vm, d).name].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const columns: Column<Obj>[] = [
    {
      id: 'name',
      header: 'Template',
      sort: vm => vm.metadata.name,
      width: 300,
      cell: vm => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
          <Icon icon={osIcon(vmOs(vm, d).id)} width={20} style={{ color: t.muted, flex: 'none' }} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{vm.metadata.name}</Box>
            {vm.metadata.annotations?.description && (
              <Box sx={{ fontSize: 12.5, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>{vm.metadata.annotations.description}</Box>
            )}
            {k8s && (
              <K8sName>
                VirtualMachine {vm.metadata.namespace}/{vm.metadata.name}
              </K8sName>
            )}
          </Box>
        </Box>
      ),
    },
    { id: 'os', header: 'Guest OS', minWidth: 900, sort: vm => vmOs(vm, d).name, cell: vm => vmOs(vm, d).name },
    { id: 'folder', header: k8s ? 'Namespace' : 'Folder', sort: vm => vm.metadata.namespace ?? '', cell: vm => vm.metadata.namespace },
    {
      id: 'size',
      header: 'Size',
      sort: vm => hardware(vm, undefined, d.instancetypes).memoryBytes,
      cell: vm => {
        const hw = hardware(vm, undefined, d.instancetypes);
        return (
          <span>
            {hw.vcpus} vCPU, {formatBytes(hw.memoryBytes)}
            {hw.instancetype && (
              <Box component="span" sx={{ color: t.muted }}>
                {' '}
                · {hw.instancetype.name}
              </Box>
            )}
          </span>
        );
      },
    },
    {
      id: 'disks',
      header: 'Disks',
      sort: vm => templateDisks(vm, d).bytes,
      cell: vm => {
        const x = templateDisks(vm, d);
        return (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <span>
              {x.count} disk{x.count === 1 ? '' : 's'}, {formatBytes(x.bytes)}
            </span>
            {x.datastores.length > 0 && (
              <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>
                on {x.datastores.join(', ')}
              </Box>
            )}
          </Box>
        );
      },
    },
    {
      id: 'created',
      header: 'Created',
      minWidth: 1100,
      sort: vm => vm.metadata.creationTimestamp ?? '',
      cell: vm => (vm.metadata.creationTimestamp ? `${formatAge(vm.metadata.creationTimestamp)} ago` : '—'),
    },
    {
      id: 'actions',
      header: <Box component="span" sx={srOnly}>Actions</Box>,
      align: 'right',
      width: 200,
      cell: vm => <TemplateActions vm={vm} d={d} />,
    },
  ];

  return (
    <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
      <Toolbar>
        <ToolButton icon="mdi:file-document-plus-outline" onClick={() => openDialog(close => <MakeTemplateDialog d={d} onClose={close} />)}>
          New template from a VM
        </ToolButton>
        <Box sx={{ flex: 1 }} />
        {folders.length > 1 && (
          <TextField
            select
            size="small"
            value={inFolder}
            onChange={e => setInFolder(e.target.value)}
            SelectProps={{ displayEmpty: true }}
            inputProps={{ 'aria-label': 'Folder' }}
            sx={{ minWidth: 160, mr: 1, '& .MuiSelect-select': { py: 0.6, fontSize: 13.5 } }}
          >
            <MenuItem value="">All folders</MenuItem>
            {folders.map(f => (
              <MenuItem key={f} value={f}>
                {f}
              </MenuItem>
            ))}
          </TextField>
        )}
        <SearchField value={q} onChange={setQ} label="Filter the templates" />
      </Toolbar>
      <DataTable
        label="Templates"
        rows={rows}
        columns={columns}
        rowKey={key}
        onOpen={vm => history.push(hrefFor('vm', vm.metadata.namespace, vm.metadata.name))}
        onContextMenu={(vm, e) => setMenu({ vm, x: e.clientX, y: e.clientY })}
        initialSort={{ id: 'name', dir: 'asc' }}
        empty={
          all.length === 0 ? (
            <Empty
              icon="mdi:file-document-outline"
              title="No templates yet"
              action={
                <ToolButton icon="mdi:file-document-plus-outline" variant="outlined" onClick={() => openDialog(close => <MakeTemplateDialog d={d} onClose={close} />)}>
                  New template from a VM
                </ToolButton>
              }
            >
              A template is a VM kept as a master copy: set one up, power it off, and make it a template. New VMs from it get a copy of
              its disks in one step.
            </Empty>
          ) : (
            <Empty icon="mdi:filter-variant" title="Nothing matches the filter" />
          )
        }
      />
      {menu && <VmContextMenu vm={menu.vm} anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </Box>
  );
}

/** Deploy, edit, clone, convert, delete: the VM actions a template has, as buttons. */
function TemplateActions({ vm, d }: { vm: Obj; d: HangarData }) {
  const history = useHistory();
  const perms = useVmPerms(vm.metadata.namespace);
  const acts = vmActions(vm, d, href => history.push(href), { perms });
  const get = (id: string) => acts.find(a => a.id === id);
  const deploy = get('clone');
  const edit = get('edit');
  const convert = get('template');
  const del = get('delete');
  const btn = (a: ReturnType<typeof get>, icon: string, label: string) =>
    a ? <IconAction icon={icon} label={a.enabled ? label : `${label}: ${a.why ?? ''}`} disabled={!a.enabled} onClick={() => a.run()} /> : null;
  return (
    <Box sx={{ display: 'inline-flex' }}>
      {btn(deploy, 'mdi:rocket-launch-outline', `New VM from ${vm.metadata.name}`)}
      {btn(edit, 'mdi:tune-variant', `Edit ${vm.metadata.name}`)}
      <IconAction
        icon="mdi:content-duplicate"
        label={perms.edit ? `Clone ${vm.metadata.name} into another template` : `Clone ${vm.metadata.name}: your role does not allow this`}
        disabled={!perms.edit}
        onClick={() => openDialog(close => <CloneDialog source={vm} data={d} mode="template" onClose={close} />)}
      />
      {btn(convert, 'mdi:server', `Convert ${vm.metadata.name} to a VM`)}
      {btn(del, 'mdi:delete-outline', `Delete ${vm.metadata.name}`)}
    </Box>
  );
}

/** Pick a VM, then clone it into a template (it stays) or convert it (it becomes the template). */
function MakeTemplateDialog({ d, onClose }: { d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const history = useHistory();
  const vms = d.vms.filter(v => !isTemplate(v)).sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
  const off = (v: Obj) => powerState(v, d.idx.vmi.get(key(v))).kind === 'off';
  const [vmKey, setVmKey] = React.useState(() => (vms.find(off) ? key(vms.find(off)!) : ''));
  const [how, setHow] = React.useState<'clone' | 'convert'>('clone');
  const vm = vms.find(v => key(v) === vmKey);
  const go = () => {
    if (!vm) return;
    onClose();
    if (how === 'clone') openDialog(close => <CloneDialog source={vm} data={d} mode="template" onClose={close} />);
    else vmActions(vm, d, href => history.push(href)).find(a => a.id === 'template')?.run();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-mktpl-title">
      <DialogTitle id="hangar-mktpl-title" sx={{ fontSize: 18 }}>
        New template from a VM
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13.5, color: t.muted }}>
          The VM must be powered off, so its disks are copied in a consistent state. Prepare the guest first (updates, cleanup, a
          generic hostname): every new VM starts from this state.
        </Typography>
        <TextField select size="small" label="VM" value={vmKey} onChange={e => setVmKey(e.target.value)} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          {!vms.length && <MenuItem value="">No VM</MenuItem>}
          {vms.map(v => (
            <MenuItem key={key(v)} value={key(v)} disabled={!off(v)}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', width: '100%' }}>
                <span>{v.metadata.name}</span>
                <Box component="span" sx={{ color: t.muted, fontSize: 13 }}>
                  {v.metadata.namespace}
                </Box>
                <Box sx={{ flex: 1 }} />
                {!off(v) && <Tag>{powerState(v, d.idx.vmi.get(key(v))).label.toLowerCase()}: power it off first</Tag>}
              </Box>
            </MenuItem>
          ))}
        </TextField>
        <RadioGroup value={how} onChange={e => setHow(e.target.value as 'clone' | 'convert')}>
          <FormControlLabel value="clone" control={<Radio size="small" />} label="Clone it into a template (the VM stays as it is)" />
          <FormControlLabel value="convert" control={<Radio size="small" />} label="Convert it: the VM becomes the template, and can be converted back" />
        </RadioGroup>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disableElevation disabled={!vm || !off(vm)} onClick={go}>
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}
