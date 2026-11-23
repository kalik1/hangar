/*
 * Pieces the host Hardware tab, the device mappings view and the VM's
 * Host devices panel share: device state labels, per-host availability,
 * and the dialogs that move a device between the host and VMs.
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
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import * as H from '../../api/hardware';
import {
  DeviceState,
  groupMates,
  HostAvail,
  HostDisk,
  Inventory,
  isVf,
  Mapping,
  mappingForPci,
  MdevType,
  newResourceName,
  PciDevice,
  pciKind,
  pciKindLabel,
  pciName,
  stableDiskPath,
  UsbDevice,
  usbName,
} from '../../model/hardware';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { LedTone, tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

export function stateTone(s: DeviceState): LedTone {
  switch (s.kind) {
    case 'assigned':
    case 'ready':
      return 'on';
    case 'preparing':
    case 'returning':
      return 'busy';
    case 'failed':
      return 'fault';
    default:
      return 'off';
  }
}

/** LED and one line; "in use" links to the VM. */
export function DeviceStateLabel({ state, sub }: { state: DeviceState; sub?: React.ReactNode }) {
  const t = useTokens();
  const vm = state.kind === 'assigned' ? state.vm.split('/') : null;
  const msg = state.kind === 'failed' ? state.message : state.kind === 'returning' ? state.message : undefined;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.9, maxWidth: '100%' }} title={msg ? `${state.label}: ${msg}` : state.label}>
        <Led tone={stateTone(state)} size={8} />
        <Box component="span" sx={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: state.kind === 'failed' ? '#E5484D' : t.text }}>
          {vm ? (
            <>
              In use by{' '}
              <Box component={RouterLink} to={hrefFor('vm', vm[0], vm[1])} sx={{ color: 'inherit', fontWeight: 600 }}>
                {vm[1]}
              </Box>
            </>
          ) : (
            state.label
          )}
        </Box>
      </Box>
      {msg && <Box sx={{ fontSize: 12, color: t.muted, maxWidth: 340, whiteSpace: 'normal' }}>{msg}</Box>}
      {sub && <Box sx={{ fontSize: 12, color: t.muted }}>{sub}</Box>}
    </Box>
  );
}

export function mappingKindLabel(m: Mapping): string {
  if (m.kind === 'usb') return 'USB device';
  if (m.kind === 'mdev') return 'vGPU profile';
  return m.gpu ? 'GPU' : 'PCI device';
}

export function mappingIcon(m: { kind: string; gpu: boolean }): string {
  if (m.kind === 'usb') return 'mdi:usb';
  return m.gpu ? 'mdi:expansion-card' : 'mdi:chip';
}

/** "host: 1 free of 2", one line per host. */
export function AvailLines({ avail, empty = 'No host has one ready' }: { avail: HostAvail[]; empty?: string }) {
  const t = useTokens();
  if (!avail.length) return <Box sx={{ fontSize: 13, color: t.muted }}>{empty}</Box>;
  return (
    <Box sx={{ display: 'grid', gap: 0.25, fontSize: 13, ...tabular }}>
      {avail.map(a => (
        <Box key={a.host} sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline', minWidth: 0 }}>
          <Box component={RouterLink} to={hrefFor('host', a.host, 'hardware')} sx={{ color: 'inherit', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {a.host.split('.')[0]}
          </Box>
          <Box component="span" sx={{ color: a.free ? t.text : t.muted, whiteSpace: 'nowrap' }}>
            {a.free} free of {a.total}
            {a.healthy < a.total ? `, ${a.total - a.healthy} not ready` : ''}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** A short name for a new mapping: "Iris Xe Graphics VF" from "Alder Lake-P GT2 [Iris Xe Graphics]". */
export function suggestLabel(p: PciDevice): string {
  const n = pciName(p);
  const br = /\[([^\]]+)\]/.exec(n)?.[1];
  const base = (br ?? n).replace(/\s+/g, ' ').trim();
  return isVf(p) ? `${base} VF` : base;
}

/* ------------------------------------------------------------ dialogs */

function DialogShell({
  id,
  title,
  children,
  onClose,
  action,
  onAction,
  disabled,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby={id}>
      <DialogTitle id={id} sx={{ fontSize: 18 }}>
        {title}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.75, fontSize: 14, '& p': { m: 0 } }}>{children}</DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={disabled} onClick={onAction}>
          {action}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Give a PCI device (and its IOMMU group mates) to VMs. */
export function GivePciDialog({
  host,
  inv,
  device,
  mappings,
  kv,
  onClose,
}: {
  host: string;
  inv: Inventory;
  device: PciDevice;
  mappings: Mapping[];
  kv: Obj;
  onClose: () => void;
}) {
  const k8s = useK8s();
  const t = useTokens();
  const existing = mappingForPci(mappings, device);
  const mates = groupMates(inv, device).filter(m => m.driver !== 'vfio-pci' || !m.managed);
  const [label, setLabel] = React.useState(existing?.label ?? suggestLabel(device));
  const kind = pciKind(device.class);
  const [gpu, setGpu] = React.useState(existing?.gpu ?? (kind === 'gpu' || kind === 'accelerator'));
  const resourceName = existing?.resourceName ?? newResourceName(label, mappings);
  const ok = !!existing || label.trim().length > 1;
  const save = () => {
    const devices = [device, ...mates];
    quiet(
      H.givePciToVms({
        kv,
        host,
        devices,
        isNew: !existing,
        mapping: existing ?? { kind: 'pci', resourceName, label: label.trim(), gpu, selector: `${device.vendor}:${device.device}` },
        title: `Give ${suggestLabel(device)} (${device.address}) to VMs`,
      })
    );
    onClose();
  };
  return (
    <DialogShell id="hangar-givepci" title={`Give ${pciName(device)} to VMs`} onClose={onClose} action="Give to VMs" onAction={save} disabled={!ok}>
      <Box sx={{ color: t.muted, fontSize: 13, ...tabular }}>
        {device.address} · {pciKindLabel(device)} · {device.vendorName ?? device.vendor} · ID {device.vendor}:{device.device}
      </Box>
      <p>
        {device.driver && device.driver !== 'vfio-pci'
          ? `The host stops using it (its driver ${device.driver} lets go) and keeps it for VMs, also after a reboot.`
          : 'The host keeps it for VMs, also after a reboot.'}
      </p>
      {kind === 'network' && <Note tone="warn">The host loses this network port. Hangar refuses ports that carry the host's own addresses.</Note>}
      {device.bootVga && <Note tone="warn">The host shows its local console on this GPU: that screen goes dark.</Note>}
      {mates.length > 0 && (
        <Note>
          It shares IOMMU group {device.iommuGroup} with {mates.map(m => `${m.address} (${pciName(m)})`).join(', ')}. A VM can only take a whole group, so{' '}
          {mates.length === 1 ? 'that device goes' : 'those go'} too.
        </Note>
      )}
      {existing ? (
        <p>
          It joins the mapping <b>{existing.label}</b>: VMs that ask for one can get this device.
          {k8s && (
            <>
              {' '}
              <K8sName>{existing.resourceName}</K8sName>
            </>
          )}
        </p>
      ) : (
        <>
          <TextField
            size="small"
            label="Mapping name"
            value={label}
            onChange={e => setLabel(e.target.value)}
            helperText="What VMs ask for. Every host's identical devices (same vendor and device ID) join it when you give them to VMs."
          />
          <FormControlLabel control={<Checkbox checked={gpu} onChange={e => setGpu(e.target.checked)} />} label="Pass it as a GPU (display device)" />
          {k8s && (
            <Box sx={{ fontSize: 12.5 }}>
              <K8sName>
                permittedHostDevices.pciHostDevices: {device.vendor}:{device.device} → {resourceName}
              </K8sName>
            </Box>
          )}
        </>
      )}
      <Typography sx={{ fontSize: 12.5, color: t.muted }}>
        VMs with a host device run only on hosts that have a free one, and cannot move while running.
      </Typography>
    </DialogShell>
  );
}

/** Offer a USB device (by vendor and product) to VMs. */
export function UsbMappingDialog({ host, usb, mappings, kv, onClose }: { host: string; usb: UsbDevice; mappings: Mapping[]; kv: Obj; onClose: () => void }) {
  const k8s = useK8s();
  const t = useTokens();
  const [label, setLabel] = React.useState(usbName(usb));
  const resourceName = newResourceName(label, mappings);
  const save = () => {
    quiet(H.createMapping(kv, { kind: 'usb', resourceName, label: label.trim(), gpu: false, usb: [{ vendor: usb.vendor, product: usb.product }] }, host));
    onClose();
  };
  return (
    <DialogShell id="hangar-giveusb" title={`Offer ${usbName(usb)} to VMs`} onClose={onClose} action="Offer to VMs" onAction={save} disabled={label.trim().length < 2}>
      <Box sx={{ color: t.muted, fontSize: 13, ...tabular }}>
        USB {usb.vendor}:{usb.product} · port {usb.path} · {usb.manufacturer ?? usb.vendorName ?? ''}
      </Box>
      <p>
        VMs ask for it by vendor and product ID, so any host with the same device offers it too. The host keeps using it until a VM that has it
        powers on.
      </p>
      <TextField size="small" label="Mapping name" value={label} onChange={e => setLabel(e.target.value)} />
      {k8s && (
        <Box sx={{ fontSize: 12.5 }}>
          <K8sName>
            permittedHostDevices.usb: {usb.vendor}:{usb.product} → {resourceName}
          </K8sName>
        </Box>
      )}
    </DialogShell>
  );
}

/** Offer a vGPU profile (mediated device type) to VMs; KubeVirt creates the instances. */
export function MdevMappingDialog({ host, parent, type, mappings, kv, onClose }: { host: string; parent: PciDevice; type: MdevType; mappings: Mapping[]; kv: Obj; onClose: () => void }) {
  const k8s = useK8s();
  const [label, setLabel] = React.useState(type.name || type.id);
  const resourceName = newResourceName(label, mappings);
  const save = () => {
    quiet(H.createMapping(kv, { kind: 'mdev', resourceName, label: label.trim(), gpu: true, selector: type.name || type.id, mdevTypeId: type.id }, host));
    onClose();
  };
  return (
    <DialogShell id="hangar-givemdev" title={`Offer the vGPU profile ${type.name || type.id}`} onClose={onClose} action="Offer to VMs" onAction={save} disabled={label.trim().length < 2}>
      <p>
        {pciName(parent)} ({parent.address}) can split into {type.available ?? 'several'} more of these. KubeVirt creates them on every host with this
        GPU, and each VM that asks for one gets its own.
      </p>
      {type.description && <Box sx={{ fontSize: 13, color: 'text.secondary' }}>{type.description}</Box>}
      <TextField size="small" label="Mapping name" value={label} onChange={e => setLabel(e.target.value)} />
      {k8s && (
        <Box sx={{ fontSize: 12.5 }}>
          <K8sName>
            mediatedDevices: {type.name || type.id} → {resourceName}; mediatedDeviceTypes += {type.id}
          </K8sName>
        </Box>
      )}
    </DialogShell>
  );
}

/** Give a whole host disk to a VM. */
export function GiveDiskDialog({ host, disk, vms, onClose }: { host: string; disk: HostDisk; vms: Obj[]; onClose: () => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const sorted = [...vms].sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
  const [vm, setVm] = React.useState(sorted[0] ? `${sorted[0].metadata.namespace}/${sorted[0].metadata.name}` : '');
  const [bus, setBus] = React.useState('virtio');
  const chosen = sorted.find(v => `${v.metadata.namespace}/${v.metadata.name}` === vm);
  const save = () => {
    if (!chosen) return;
    quiet(H.giveDiskToVm({ host, disk, vm: chosen, bus }));
    onClose();
  };
  return (
    <DialogShell id="hangar-givedisk" title={`Give disk ${disk.name} to a VM`} onClose={onClose} action="Give to VM" onAction={save} disabled={!chosen}>
      <Box sx={{ color: t.muted, fontSize: 13, ...tabular }}>
        {[disk.vendor, disk.model].filter(Boolean).join(' ')} · {formatBytes(disk.sizeBytes ?? 0)} · {disk.transport}
        {disk.serial ? ` · serial ${disk.serial}` : ''}
      </Box>
      <p>The VM gets the whole disk as it is: Hangar does not format it. From then on the VM runs only on {host.split('.')[0]}.</p>
      <TextField select size="small" label="VM" value={vm} onChange={e => setVm(e.target.value)}>
        {sorted.map(v => (
          <MenuItem key={`${v.metadata.namespace}/${v.metadata.name}`} value={`${v.metadata.namespace}/${v.metadata.name}`}>
            {v.metadata.name} <Box component="span" sx={{ color: t.muted, ml: 1 }}>{v.metadata.namespace}</Box>
          </MenuItem>
        ))}
      </TextField>
      <TextField select size="small" label="Bus" value={bus} onChange={e => setBus(e.target.value)} sx={{ width: 160 }}>
        <MenuItem value="virtio">VirtIO</MenuItem>
        <MenuItem value="scsi">SCSI</MenuItem>
        <MenuItem value="sata">SATA</MenuItem>
      </TextField>
      {k8s && (
        <Box sx={{ fontSize: 12.5 }}>
          <K8sName>local block PersistentVolume {stableDiskPath(disk)} + PVC in {chosen?.metadata.namespace ?? 'the folder'}</K8sName>
        </Box>
      )}
      <Note tone="warn">Whatever is on the disk now belongs to the VM. Take it back from this tab when the VM no longer has it.</Note>
    </DialogShell>
  );
}

export function NoAgent({ denied }: { denied?: boolean }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'grid', gap: 1, fontSize: 14, color: t.muted, maxWidth: 680 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', color: t.text, fontWeight: 600 }}>
        <Icon icon="mdi:chip" width={18} /> {denied ? 'You may not read the hosts’ hardware' : 'Hangar’s host agent is not running'}
      </Box>
      {denied ? (
        <span>Reading it needs pods/proxy in the {H.AGENT_NS} namespace (the hangar-vm-admin role has it).</span>
      ) : (
        <>
          <span>
            The agent lists each host’s PCI and USB devices and disks, and prepares the devices you give to VMs. Install it once per cluster:
          </span>
          <Box component="code" sx={{ fontFamily: t.font.mono, fontSize: 12.5, background: t.hover, px: 1, py: 0.5, borderRadius: 1, color: t.text }}>
            kubectl apply -k hangar/distribution/node-agent
          </Box>
        </>
      )}
    </Box>
  );
}
