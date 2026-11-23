/*
 * Device mappings, the datacenter's list of devices VMs can ask for
 * (Proxmox's resource mappings): one per kind of device, with how many
 * each host has ready and free, and the VMs that use it. Mappings are
 * made from a host's Hardware tab, where you choose which devices.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import * as H from '../../api/hardware';
import { NOT_ALLOWED, useCan } from '../../api/permissions';
import { availability, Mapping, mappingsOf, passthroughEnabled, pciName, usbName, vmsUsingResource, withDeviceKinds } from '../../model/hardware';
import { Obj } from '../../model/types';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { confirm, openDialog } from '../../ui/dialogs';
import { Empty, IconAction, K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';
import { AddDeviceWizard } from './AddDeviceWizard';
import { AvailLines, mappingIcon, mappingKindLabel, NoAgent } from './parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

function RenameDialog({ kv, m, onClose }: { kv: Obj; m: Mapping; onClose: () => void }) {
  const [label, setLabel] = React.useState(m.label);
  const [gpu, setGpu] = React.useState(m.gpu);
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-rename-mapping">
      <DialogTitle id="hangar-rename-mapping" sx={{ fontSize: 18 }}>
        Rename {m.label}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5 }}>
        <TextField size="small" label="Name" value={label} onChange={e => setLabel(e.target.value)} sx={{ mt: 0.5 }} />
        {m.kind === 'pci' && (
          <FormControlLabel control={<Checkbox checked={gpu} onChange={e => setGpu(e.target.checked)} />} label="New VMs get it as a GPU (display device)" />
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={label.trim().length < 2}
          onClick={() => {
            quiet(H.relabelMapping(kv, m, label.trim(), gpu));
            onClose();
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DevicesView() {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const kv = H.useKubevirt(d.kubevirt);
  const agents = H.useInventories(30000);
  const mappings = withDeviceKinds(
    mappingsOf(kv),
    [...agents.hosts.values()].flatMap(r => (r.inv ? [r.inv] : []))
  );
  const kvNs = kv?.metadata.namespace ?? 'kubevirt';
  const canMap = useCan({ verb: 'update', group: 'kubevirt.io', resource: 'kubevirts', namespace: kvNs });
  const canBind = useCan({ verb: 'update', group: '', resource: 'configmaps', namespace: H.AGENT_NS });
  const canReload = useCan({ verb: 'delete', group: '', resource: 'pods', namespace: kvNs });
  const addWhy = !kv ? 'KubeVirt is not readable' : !canMap || !canBind || !canReload ? NOT_ALLOWED : undefined;
  const openAdd = (preset?: Mapping) => kv && openDialog(close => <AddDeviceWizard d={d} kv={kv} mappings={mappings} preset={preset} onClose={close} />);

  /** A human name for what a mapping matches, from any host that has one. */
  const matches = (m: Mapping): string => {
    for (const r of agents.hosts.values()) {
      const inv = r.inv;
      if (!inv) continue;
      if (m.kind === 'pci') {
        const p = inv.pci.find(x => `${x.vendor}:${x.device}` === m.selector);
        if (p) return pciName(p);
      } else if (m.kind === 'usb') {
        const u = inv.usb.find(x => (m.usb ?? []).some(s => s.vendor === x.vendor && s.product === x.product));
        if (u) return usbName(u);
      } else {
        for (const p of inv.pci) {
          const ty = p.mdevTypes.find(x => (x.name || x.id).replace(/\s+/g, '_') === m.selector.replace(/\s+/g, '_'));
          if (ty) return `${ty.name || ty.id} on ${pciName(p)}`;
        }
      }
    }
    return m.kind === 'mdev' ? m.selector : `ID ${m.selector}`;
  };

  const remove = async (m: Mapping, users: string[]) => {
    if (!kv) return;
    const ok = await confirm({
      title: `Delete the mapping ${m.label}?`,
      body: (
        <>
          <p>
            VMs can no longer ask for it.{' '}
            {m.kind === 'pci' ? "The devices stay set aside on their hosts: give them back from each host's Hardware tab." : 'Hosts keep using their devices.'}
          </p>
          {users.length > 0 && <p>These VMs still ask for it and would not power on: {users.join(', ')}.</p>}
        </>
      ),
      confirm: 'Delete mapping',
      danger: true,
      typeToConfirm: users.length ? m.label : undefined,
    });
    if (ok) quiet(H.deleteMapping(kv, m));
  };

  const columns: Column<Mapping>[] = [
    {
      id: 'name',
      header: 'Mapping',
      sort: m => m.label,
      cell: m => (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <Icon icon={mappingIcon(m)} width={18} style={{ color: t.muted, marginTop: 2, flex: 'none' }} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontWeight: 600 }}>{m.label}</Box>
            <Box sx={{ fontSize: 12.5, color: t.muted }}>
              {mappingKindLabel(m)}
              {m.external ? ', from an external device plugin' : ''}
            </Box>
            {k8s && <K8sName>{m.resourceName}</K8sName>}
          </Box>
        </Box>
      ),
    },
    {
      id: 'matches',
      header: 'Matches',
      sort: m => matches(m),
      cell: m => (
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ fontSize: 13.5 }}>{matches(m)}</Box>
          <Box sx={{ fontSize: 12, color: t.muted, fontFamily: t.font.mono }}>{m.selector}</Box>
        </Box>
      ),
    },
    { id: 'hosts', header: 'Hosts', cell: m => <AvailLines avail={availability(m.resourceName, d.nodes, d.launchers)} /> },
    {
      id: 'vms',
      header: 'VMs that ask for it',
      cell: m => {
        const users = vmsUsingResource(d.vms, m.resourceName);
        if (!users.length) return <Box sx={{ color: t.muted, fontSize: 13 }}>None</Box>;
        return (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, fontSize: 13 }}>
            {users.map(u => {
              const [ns, name] = u.split('/');
              return (
                <Box key={u} component={RouterLink} to={hrefFor('vm', ns, name, 'configure')} sx={{ color: 'inherit' }}>
                  {name}
                </Box>
              );
            })}
          </Box>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: m => {
        const users = vmsUsingResource(d.vms, m.resourceName);
        return (
          <Box sx={{ whiteSpace: 'nowrap' }}>
            {m.kind === 'pci' ? (
              <IconAction icon="mdi:plus-box-multiple-outline" label={addWhy ?? "Add another host's device"} disabled={!!addWhy} onClick={() => openAdd(m)} />
            ) : (
              <IconAction icon="mdi:plus-box-multiple-outline" label={m.kind === 'usb' ? 'USB mappings match by vendor and product: identical devices on every host are offered already' : 'KubeVirt creates this profile on every host with the GPU'} disabled />
            )}
            <IconAction icon="mdi:pencil-outline" label={canMap ? 'Rename' : NOT_ALLOWED} disabled={!canMap || !kv} onClick={() => kv && openDialog(close => <RenameDialog kv={kv} m={m} onClose={close} />)} />
            <IconAction icon="mdi:delete-outline" label={canMap ? 'Delete mapping' : NOT_ALLOWED} disabled={!canMap || !kv} onClick={() => remove(m, users)} />
          </Box>
        );
      },
    },
  ];

  return (
    <Box sx={{ p: 2, display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
        <Box component={RouterLink} to={hrefFor('hosts')} sx={{ color: t.muted, fontSize: 14 }}>
          Hosts
        </Box>
        <Icon icon="mdi:chevron-right" width={16} style={{ color: t.muted, alignSelf: 'center' }} />
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600, flex: 1 }}>
          Device mappings
        </Typography>
        <span title={addWhy}>
          <Button variant="contained" disableElevation disabled={!!addWhy} onClick={() => openAdd()} startIcon={<Icon icon="mdi:plus" width={18} />} sx={{ textTransform: 'none', fontWeight: 600 }}>
            Add device
          </Button>
        </span>
      </Box>
      <Typography sx={{ fontSize: 14, color: t.muted, maxWidth: 760 }}>
        A mapping is a kind of device VMs can ask for: a GPU, a disk controller, a USB key. Add device picks the exact devices on the hosts (a host's Hardware tab
        does the same for one host). Identical devices on a host form a pool, and a VM gets a free one when it powers on.
      </Typography>
      {kv && !passthroughEnabled(kv) && (
        <Note tone="warn">
          Device passthrough is off in KubeVirt (feature gate HostDevices).{' '}
          <Button size="small" sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }} disabled={!canMap} onClick={() => quiet(H.turnOnPassthrough(kv))}>
            Turn it on
          </Button>
        </Note>
      )}
      {agents.missing && (
        <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface, p: 2 }}>
          <NoAgent />
        </Box>
      )}
      <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
        <DataTable
          label="Device mappings"
          rows={mappings}
          columns={columns}
          rowKey={m => m.resourceName}
          empty={
            <Empty
              icon="mdi:expansion-card-variant"
              title="No device mappings yet"
              action={
                <span title={addWhy}>
                  <Button variant="contained" disableElevation disabled={!!addWhy} onClick={() => openAdd()} startIcon={<Icon icon="mdi:plus" width={18} />} sx={{ textTransform: 'none' }}>
                    Add device
                  </Button>
                </span>
              }
            >
              Give VMs a GPU, a disk controller, a network card or a USB device of your hosts: pick the kind, then the exact devices.
            </Empty>
          }
        />
      </Box>
    </Box>
  );
}

