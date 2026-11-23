/*
 * A VM's host devices (GPUs, PCI and USB passthrough), in Configure: the
 * devices it asks for, which physical one it holds while running, and
 * "Add device" from the datacenter's device mappings.
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
import { Link as RouterLink } from 'react-router-dom';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import * as H from '../../api/hardware';
import * as E from '../../model/edit';
import { addVmDevice, availability, hostsForVmDevices, Inventory, Mapping, mappingsOf, pciName, removeVmDevice, usbName, vmDevices, withDeviceKinds } from '../../model/hardware';
import { Obj } from '../../model/types';
import { key, powerState } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { AvailLines, mappingIcon, mappingKindLabel } from '../devices/parts';
import { Note } from '../storage/parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
const invs = (a: H.AgentsReading): Inventory[] => [...a.hosts.values()].flatMap(r => (r.inv ? [r.inv] : []));

/** The physical device a running VM holds for each of its devices, from the host agent. */
function useHeld(vm: Obj, host: string | undefined): Map<string, string[]> {
  const agents = H.useInventories(30000);
  const inv = host ? agents.hosts.get(host)?.inv : undefined;
  const me = `${vm.metadata.namespace}/${vm.metadata.name}`;
  const out = new Map<string, string[]>();
  if (!inv) return out;
  for (const p of inv.pci.filter(x => x.usedBy === me)) {
    const k = `pci:${p.vendor}:${p.device}`;
    out.set(k, [...(out.get(k) ?? []), `${p.address} ${pciName(p)}`]);
  }
  for (const u of inv.usb.filter(x => x.usedBy === me)) {
    const k = `usb:${u.vendor}:${u.product}`;
    out.set(k, [...(out.get(k) ?? []), `USB ${u.path} ${usbName(u)}`]);
  }
  return out;
}

function heldFor(held: Map<string, string[]>, m?: Mapping): string[] {
  if (!m) return [];
  if (m.kind === 'pci') return held.get(`pci:${m.selector}`) ?? [];
  if (m.kind === 'usb') return (m.usb ?? []).flatMap(s => held.get(`usb:${s.vendor}:${s.product}`) ?? []);
  return [];
}

function AddDeviceDialog({ vm, d, mappings, onClose }: { vm: Obj; d: HangarData; mappings: Mapping[]; onClose: () => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const running = powerState(vm, d.idx.vmi.get(key(vm))).kind !== 'off';
  const have = new Set(vmDevices(vm).map(x => x.deviceName));
  const options = mappings.map(m => ({ m, avail: availability(m.resourceName, d.nodes, d.launchers) }));
  const firstFree = options.find(o => o.avail.some(a => a.free > 0)) ?? options[0];
  const [pick, setPick] = React.useState(firstFree?.m.resourceName ?? '');
  const [pin, setPin] = React.useState('');
  const chosen = options.find(o => o.m.resourceName === pick);
  const hosts = chosen?.avail.filter(a => a.total > 0) ?? [];
  const save = () => {
    if (!chosen) return;
    let next = addVmDevice(vm, { resourceName: chosen.m.resourceName, gpu: chosen.m.gpu, kind: chosen.m.kind }).vm;
    if (pin) next = E.setPolicies(next, { hostAffinity: { host: pin, required: true } });
    quiet(A.updateVm(vm, `Add ${mappingKindLabel(chosen.m)} ${chosen.m.label}`, next));
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-adddev-title">
      <DialogTitle id="hangar-adddev-title" sx={{ fontSize: 18 }}>
        Add a host device to {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.75 }}>
        {options.length === 0 ? (
          <Typography sx={{ fontSize: 14 }}>
            No device mappings yet. Give a device to VMs from a host's{' '}
            <Box component={RouterLink} to={hrefFor('hosts')} sx={{ color: 'inherit' }}>
              Hardware tab
            </Box>{' '}
            first.
          </Typography>
        ) : (
          <RadioGroup value={pick} onChange={e => setPick(e.target.value)} aria-label="Device mapping">
            {options.map(({ m, avail }) => (
              <FormControlLabel
                key={m.resourceName}
                value={m.resourceName}
                control={<Radio size="small" />}
                sx={{ alignItems: 'flex-start', py: 0.5, mr: 0, '& .MuiFormControlLabel-label': { flex: 1, minWidth: 0 } }}
                label={
                  <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', pt: 0.75 }}>
                    <Icon icon={mappingIcon(m)} width={18} style={{ color: t.muted, flex: 'none' }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ fontSize: 14, fontWeight: 600 }}>
                        {m.label} {have.has(m.resourceName) && <Tag>it has one</Tag>}
                      </Box>
                      <Box sx={{ fontSize: 12.5, color: t.muted }}>
                        {mappingKindLabel(m)}
                        {k8s && (
                          <>
                            {' '}
                            <K8sName>{m.resourceName}</K8sName>
                          </>
                        )}
                      </Box>
                    </Box>
                    <Box sx={{ width: 210, flex: 'none' }}>
                      <AvailLines avail={avail} />
                    </Box>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
        )}
        {chosen && hosts.length > 0 && (
          <TextField select size="small" label="Host" value={pin} onChange={e => setPin(e.target.value)} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
            <MenuItem value="">Any host with a free one</MenuItem>
            {hosts.map(h => (
              <MenuItem key={h.host} value={h.host}>
                Only {h.host} ({h.free} free)
              </MenuItem>
            ))}
          </TextField>
        )}
        {chosen && chosen.avail.every(a => a.free === 0) && (
          <Note tone="warn">No host has a free one now: the VM will wait to power on until one is free.</Note>
        )}
        <Typography sx={{ fontSize: 13, color: t.muted }}>
          With a host device the VM cannot move to another host while running: to move it, shut it down and power it on elsewhere.
          {running ? ' The VM gets the device at its next power-on.' : ''}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!chosen} onClick={save}>
          Add device
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function HostDevicesPanel({ vm, later }: { vm: Obj; later?: React.ReactNode }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const kv = H.useKubevirt(d.kubevirt);
  const agents = H.useInventories(30000);
  const mappings = withDeviceKinds(mappingsOf(kv), invs(agents));
  const vmi = d.idx.vmi.get(key(vm));
  const host = vmi?.status?.nodeName as string | undefined;
  const held = useHeld(vm, host);
  const devs = vmDevices(vm);
  const hosts = hostsForVmDevices(vm, d.nodes);
  const remove = async (name: string, label: string) => {
    const ok = await confirm({
      title: `Remove ${label} from ${vm.metadata.name}?`,
      body: <p>The VM gives the device back at its next power-off. Its host keeps the device ready for other VMs.</p>,
      confirm: 'Remove',
      danger: true,
    });
    if (ok) quiet(A.updateVm(vm, `Remove host device ${label}`, removeVmDevice(vm, name)));
  };
  return (
    <Panel
      title="Host devices"
      icon="mdi:expansion-card-variant"
      dense
      actions={
        <>
          {later}
          <Button size="small" onClick={() => openDialog(close => <AddDeviceDialog vm={vm} d={d} mappings={mappings} onClose={close} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={16} />}>
            Add
          </Button>
        </>
      }
    >
      {devs.length === 0 ? (
        <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>No passthrough devices: GPUs, disk controllers or USB devices of a host can be added here.</Box>
      ) : (
        <>
          {devs.map(x => {
            const m = mappings.find(mm => mm.resourceName === x.deviceName);
            const now = heldFor(held, m);
            const label = m?.label ?? x.deviceName;
            return (
              <Box key={x.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' } }}>
                <Icon icon={mappingIcon({ kind: m?.kind ?? 'pci', gpu: x.as === 'gpu' })} width={18} style={{ color: t.muted }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ fontSize: 14, fontWeight: 600 }}>
                    {label} <Box component="span" sx={{ fontWeight: 400, color: t.muted, fontSize: 12.5 }}>{x.as === 'gpu' ? 'GPU' : m?.kind === 'usb' ? 'USB device' : 'PCI device'}</Box>
                  </Box>
                  <Box sx={{ fontSize: 12.5, color: t.muted, ...tabular }}>
                    {!m
                      ? 'No mapping has this name: the VM will not power on'
                      : now.length
                      ? `Now ${now.join(', ')} on ${host?.split('.')[0]}`
                      : vmi
                      ? `On ${host?.split('.')[0]}`
                      : 'Gets a free one at power-on'}
                  </Box>
                  {k8s && (
                    <K8sName>
                      {x.as === 'gpu' ? 'gpus' : 'hostDevices'}/{x.name}: {x.deviceName}
                    </K8sName>
                  )}
                </Box>
                <IconAction icon="mdi:link-off" label="Remove from VM" onClick={() => remove(x.name, label)} />
              </Box>
            );
          })}
          <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}`, fontSize: 12.5, color: t.muted }}>
            {hosts && hosts.length
              ? `Runs only on ${hosts.map(h => h.split('.')[0]).join(', ')}, and cannot move while running.`
              : 'No host has all these devices: the VM cannot power on.'}
          </Box>
        </>
      )}
    </Panel>
  );
}

/** Rows for the Summary's device table: the VM's host devices. */
export function useVmDeviceRows(vm: Obj): { name: string; label: string; kind: string; icon: string }[] {
  const d = useHangar();
  const kv = H.useKubevirt(d.kubevirt);
  const agents = H.useInventories(60000);
  const mappings = withDeviceKinds(mappingsOf(kv), invs(agents));
  return vmDevices(vm).map(x => {
    const m = mappings.find(mm => mm.resourceName === x.deviceName);
    return {
      name: x.name,
      label: m?.label ?? x.deviceName,
      kind: x.as === 'gpu' ? 'GPU (passthrough)' : m?.kind === 'usb' ? 'USB device (passthrough)' : 'PCI device (passthrough)',
      icon: mappingIcon({ kind: m?.kind ?? 'pci', gpu: x.as === 'gpu' }),
    };
  });
}
