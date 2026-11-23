/*
 * Add device: the way into device mappings from the datacenter. Pick the
 * kind of device, then the exact devices on the hosts (from the node
 * agents' live inventory, each with its state and why it cannot be given
 * when it cannot), then the mapping (new, or the one identical devices
 * already share), and review. It runs the same flow as a host's Hardware
 * tab, on every chosen host at once.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import * as H from '../../api/hardware';
import {
  AddKind,
  addKindOf,
  candidateKey,
  canJoinSelection,
  diskFree,
  HostDisk,
  HostInventory,
  Mapping,
  mappingForMdev,
  mappingForUsb,
  MdevType,
  newResourceName,
  PciCandidate,
  pciCandidates,
  PciDevice,
  pciId,
  pciKindLabel,
  pciName,
  pciState,
  pciVendor,
  pvForDisk,
  selectionGroups,
  UsbDevice,
  usbName,
  usbVendor,
} from '../../model/hardware';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';
import { DeviceStateLabel, NoAgent, suggestLabel } from './parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

const KINDS: { kind: AddKind; label: string; icon: string; help: string }[] = [
  { kind: 'gpu', label: 'GPU or accelerator', icon: 'mdi:expansion-card', help: 'Graphics cards, their virtual functions (SR-IOV), compute accelerators' },
  { kind: 'storage', label: 'Storage controller', icon: 'mdi:harddisk', help: 'SAS, SATA, NVMe and RAID controllers, with the disks behind them' },
  { kind: 'network', label: 'Network controller', icon: 'mdi:ethernet', help: 'Whole network cards or their virtual functions (SR-IOV)' },
  { kind: 'pci', label: 'Other PCI device', icon: 'mdi:chip', help: 'USB controllers, audio and video capture, serial cards, anything else' },
  { kind: 'usb', label: 'USB device', icon: 'mdi:usb', help: 'A key, a dongle, a UPS: VMs get it by vendor and product' },
  { kind: 'mdev', label: 'vGPU profile', icon: 'mdi:expansion-card-variant', help: 'A slice of a GPU (mediated device): NVIDIA vGPU, Intel GVT-g' },
  { kind: 'disk', label: 'Host disk', icon: 'mdi:harddisk-plus', help: 'A whole disk of a host, given to one VM' },
];

interface UsbCandidate {
  host: string;
  u: UsbDevice;
  ok: boolean;
  why?: string;
  mapping?: Mapping;
}
interface MdevCandidate {
  host: string;
  parent: PciDevice;
  type: MdevType;
  ok: boolean;
  why?: string;
  mapping?: Mapping;
}
interface DiskCandidate {
  host: string;
  b: HostDisk;
  ok: boolean;
  why?: string;
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th>{children}</th>;
}

function Rows({ head, children, label }: { head: React.ReactNode[]; children: React.ReactNode; label: string }) {
  const t = useTokens();
  return (
    <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.small}px`, maxHeight: 380, overflow: 'auto' }}>
      <Box
        component="table"
        aria-label={label}
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13.5,
          ...tabular,
          '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 1.25, py: 0.75, position: 'sticky', top: 0, background: t.surface, zIndex: 1 },
          '& td': { px: 1.25, py: 0.75, borderTop: `1px solid ${t.rule}`, verticalAlign: 'top' },
          '& tr[aria-disabled=true] td': { color: t.muted },
        }}
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              <Th key={i}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </Box>
    </Box>
  );
}

function Two({ a, b, mono }: { a: React.ReactNode; b?: React.ReactNode; mono?: boolean }) {
  const t = useTokens();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={mono ? { fontFamily: t.font.mono, fontSize: 12.5, whiteSpace: 'nowrap' } : undefined}>{a}</Box>
      {b && <Box sx={{ fontSize: 12, color: t.muted }}>{b}</Box>}
    </Box>
  );
}

const short = (h: string) => h.split('.')[0];

export function AddDeviceWizard({
  d,
  kv,
  mappings,
  preset,
  onClose,
}: {
  d: HangarData;
  kv: Obj;
  mappings: Mapping[];
  /** "Add another host's device" to this mapping. */
  preset?: Mapping;
  onClose: () => void;
}) {
  const t = useTokens();
  const k8s = useK8s();
  const agents = H.useInventories(15000);
  const pvs = H.useHostDiskVolumes(true);
  const hosts: HostInventory[] = [...agents.hosts.entries()].flatMap(([host, r]) => (r.inv ? [{ host, inv: r.inv }] : [])).sort((a, b) => a.host.localeCompare(b.host));

  const presetKind = (): AddKind | undefined => {
    if (!preset || preset.kind !== 'pci') return undefined;
    for (const h of hosts) {
      const p = h.inv.pci.find(x => pciId(x) === preset.selector);
      if (p) return addKindOf(p) ?? 'pci';
    }
    return preset.gpu ? 'gpu' : 'pci';
  };
  const [kind, setKind] = React.useState<AddKind | undefined>(presetKind);
  React.useEffect(() => {
    if (preset && !kind && hosts.length) setKind(presetKind());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts.length]);
  const [step, setStep] = React.useState(preset ? 1 : 0);
  const [hostFilter, setHostFilter] = React.useState<string>('');
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [one, setOne] = React.useState<string>('');
  const [label, setLabel] = React.useState('');
  const [gpu, setGpu] = React.useState(true);
  const [vm, setVm] = React.useState('');
  const [bus, setBus] = React.useState('virtio');

  const shown = hosts.filter(h => !hostFilter || h.host === hostFilter);

  // Candidates of the chosen kind.
  const pciAll: PciCandidate[] = kind && ['gpu', 'storage', 'network', 'pci'].includes(kind) ? pciCandidates(shown, kind, mappings) : [];
  const pciRows = preset ? pciAll.filter(c => pciId(c.p) === preset.selector) : pciAll;
  const usbRows: UsbCandidate[] =
    kind === 'usb'
      ? shown.flatMap(({ host, inv }) =>
          inv.usb.map(u => {
            const mapping = mappingForUsb(mappings, u);
            const why = u.usedBy ? `In use by ${u.usedBy}` : mapping ? `Already offered (${mapping.label})` : undefined;
            return { host, u, ok: !why, why, mapping };
          })
        )
      : [];
  const mdevRows: MdevCandidate[] =
    kind === 'mdev'
      ? shown.flatMap(({ host, inv }) =>
          inv.pci.flatMap(parent =>
            parent.mdevTypes.map(type => {
              const mapping = mappingForMdev(mappings, type.name || type.id);
              const why = mapping ? `Already offered (${mapping.label})` : undefined;
              return { host, parent, type, ok: !why, why, mapping };
            })
          )
        )
      : [];
  const diskRows: DiskCandidate[] =
    kind === 'disk'
      ? shown.flatMap(({ host, inv }) =>
          inv.disks
            .filter(b => b.transport !== 'cdrom')
            .map(b => {
              const pv = pvForDisk(pvs, host, b);
              const free = diskFree(b);
              const why = pv ? `Already given to a VM (${pv.spec?.claimRef?.namespace}/${pv.spec?.claimRef?.name})` : free.why;
              return { host, b, ok: !why, why };
            })
        )
      : [];

  const chosenPci = pciAll.filter(c => sel.has(candidateKey(c)));
  const chosenUsb = usbRows.find(c => `${c.host}|${c.u.path}` === one);
  const chosenMdev = mdevRows.find(c => `${c.host}|${c.parent.address}|${c.type.id}` === one);
  const chosenDisk = diskRows.find(c => `${c.host}|${c.b.name}` === one);
  const isPci = !!kind && ['gpu', 'storage', 'network', 'pci'].includes(kind);
  const existing = isPci && chosenPci[0] ? mappings.find(m => m.kind === 'pci' && m.selector === pciId(chosenPci[0].p)) : undefined;
  const groups = selectionGroups(chosenPci);
  const deviceCount = groups.reduce((n, g) => n + g.devices.length, 0);

  // Suggest a name when the selection changes.
  const firstKey = chosenPci[0] ? pciId(chosenPci[0].p) : chosenUsb ? chosenUsb.u.path : chosenMdev ? chosenMdev.type.id : '';
  React.useEffect(() => {
    if (chosenPci[0]) {
      setLabel(suggestLabel(chosenPci[0].p));
      setGpu(kind === 'gpu');
    } else if (chosenUsb) setLabel(usbName(chosenUsb.u));
    else if (chosenMdev) setLabel(chosenMdev.type.name || chosenMdev.type.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey]);

  const counts = (k: AddKind): string => {
    if (['gpu', 'storage', 'network', 'pci'].includes(k)) {
      const all = pciCandidates(hosts, k, mappings);
      const free = all.filter(c => c.ok).length;
      return all.length ? `${free} of ${all.length} free` : 'None on the hosts';
    }
    if (k === 'usb') {
      const n = hosts.reduce((s, h) => s + h.inv.usb.length, 0);
      return n ? `${n} plugged in` : 'None plugged in';
    }
    if (k === 'mdev') {
      const n = hosts.reduce((s, h) => s + h.inv.pci.reduce((x, p) => x + p.mdevTypes.length, 0), 0);
      return n ? `${n} profiles` : 'No GPU offers them';
    }
    const n = hosts.reduce((s, h) => s + h.inv.disks.filter(b => b.transport !== 'cdrom' && diskFree(b).ok).length, 0);
    return n ? `${n} free` : 'No free disk';
  };

  const picked = isPci ? chosenPci.length > 0 : kind === 'usb' ? !!chosenUsb : kind === 'mdev' ? !!chosenMdev : kind === 'disk' ? !!chosenDisk : false;
  const mappingOk = kind === 'disk' ? !!vm : isPci && existing ? true : label.trim().length > 1;

  const finish = () => {
    if (isPci && chosenPci.length) {
      const id = pciId(chosenPci[0].p);
      const mapping = existing ?? { kind: 'pci' as const, resourceName: newResourceName(label, mappings), label: label.trim(), gpu, selector: id };
      quiet(H.givePciToVmsOnHosts({ kv, groups: groups.map(g => ({ host: g.host, devices: g.devices })), mapping, isNew: !existing, label: existing?.label ?? label.trim() }));
    } else if (kind === 'usb' && chosenUsb) {
      quiet(H.createMapping(kv, { kind: 'usb', resourceName: newResourceName(label, mappings), label: label.trim(), gpu: false, usb: [{ vendor: chosenUsb.u.vendor, product: chosenUsb.u.product }] }, chosenUsb.host));
    } else if (kind === 'mdev' && chosenMdev) {
      const name = chosenMdev.type.name || chosenMdev.type.id;
      quiet(H.createMapping(kv, { kind: 'mdev', resourceName: newResourceName(label, mappings), label: label.trim(), gpu: true, selector: name, mdevTypeId: chosenMdev.type.id }, chosenMdev.host));
    } else if (kind === 'disk' && chosenDisk) {
      const target = d.vms.find(v => `${v.metadata.namespace}/${v.metadata.name}` === vm);
      if (target) quiet(H.giveDiskToVm({ host: chosenDisk.host, disk: chosenDisk.b, vm: target, bus }));
    }
    onClose();
  };

  const toggle = (c: PciCandidate) => {
    const k = candidateKey(c);
    const next = new Set(sel);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSel(next);
  };
  const sameModelFree = chosenPci[0] ? pciRows.filter(c => c.ok && pciId(c.p) === pciId(chosenPci[0].p)) : [];

  const steps = ['Kind', 'Devices', kind === 'disk' ? 'VM' : 'Mapping', 'Review'];
  const next = () => setStep(s => Math.min(3, s + 1));
  const back = () => setStep(s => Math.max(preset ? 1 : 0, s - 1));
  const canNext = step === 0 ? !!kind : step === 1 ? picked : step === 2 ? mappingOk : true;

  const hostChips = (
    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
      <Typography sx={{ fontSize: 13, color: t.muted, mr: 0.5 }}>Hosts</Typography>
      <Chip size="small" label="All" color={hostFilter ? 'default' : 'primary'} variant={hostFilter ? 'outlined' : 'filled'} onClick={() => setHostFilter('')} />
      {hosts.map(h => (
        <Chip key={h.host} size="small" label={short(h.host)} color={hostFilter === h.host ? 'primary' : 'default'} variant={hostFilter === h.host ? 'filled' : 'outlined'} onClick={() => setHostFilter(h.host)} />
      ))}
      {[...agents.hosts.entries()].filter(([, r]) => !r.inv).map(([h]) => (
        <Tooltip key={h} title="Its agent does not answer: its devices are not listed">
          <Chip size="small" label={`${short(h)}: no inventory`} variant="outlined" icon={<Icon icon="mdi:alert-outline" width={14} />} />
        </Tooltip>
      ))}
    </Box>
  );

  const body = () => {
    if (!agents.loaded) return <Box sx={{ color: t.muted, fontSize: 14 }}>Reading the hosts…</Box>;
    if (agents.missing || agents.denied) return <NoAgent denied={agents.denied} />;
    if (step > 0 && !kind) return <Box sx={{ color: t.muted, fontSize: 14 }}>Reading the hosts…</Box>;
    if (step === 0)
      return (
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }} role="radiogroup" aria-label="Kind of device">
          {KINDS.map(k => {
            const on = kind === k.kind;
            return (
              <Box
                key={k.kind}
                role="radio"
                aria-checked={on}
                tabIndex={0}
                onClick={() => (setKind(k.kind), setSel(new Set()), setOne(''))}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (setKind(k.kind), setSel(new Set()), setOne(''))}
                sx={{
                  display: 'flex',
                  gap: 1.25,
                  p: 1.25,
                  cursor: 'pointer',
                  border: `1px solid ${on ? t.accent : t.rule}`,
                  background: on ? t.selected : 'transparent',
                  borderRadius: `${t.radius.small}px`,
                  '&:hover': { background: on ? t.selected : t.hover },
                  '&:focus-visible': { outline: `2px solid ${t.accent}`, outlineOffset: 1 },
                }}
              >
                <Icon icon={k.icon} width={22} style={{ color: on ? t.accent : t.muted, flex: 'none', marginTop: 1 }} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                    <Box sx={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{k.label}</Box>
                    <Box sx={{ fontSize: 12, color: t.muted, whiteSpace: 'nowrap', ...tabular }}>{counts(k.kind)}</Box>
                  </Box>
                  <Box sx={{ fontSize: 12.5, color: t.muted }}>{k.help}</Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      );

    if (step === 1) {
      if (isPci)
        return (
          <Box sx={{ display: 'grid', gap: 1.25 }}>
            {hostChips}
            {preset && (
              <Typography sx={{ fontSize: 13.5 }}>
                Devices that match <b>{preset.label}</b> ({preset.selector}). Pick the ones to add on any host.
              </Typography>
            )}
            {pciRows.length === 0 ? (
              <Note>No host has a device of this kind{preset ? ' and model' : ''}.</Note>
            ) : (
              <Rows label="Devices" head={['', 'Device', 'Host', 'Address', 'Driver', 'State']}>
                {pciRows.map(c => {
                  const k = candidateKey(c);
                  const on = sel.has(k);
                  const join = canJoinSelection(chosenPci, c);
                  const disabled = !on && !join.ok;
                  const s = pciState(c.p);
                  return (
                    <tr key={k} aria-disabled={disabled}>
                      <td>
                        <Tooltip title={disabled ? join.why ?? '' : ''}>
                          <span>
                            <Checkbox size="small" sx={{ p: 0.25 }} checked={on} disabled={disabled} onChange={() => toggle(c)} inputProps={{ 'aria-label': `${c.p.address} on ${c.host}` }} />
                          </span>
                        </Tooltip>
                      </td>
                      <td>
                        <Two a={pciName(c.p)} b={`${pciVendor(c.p)} · ${pciKindLabel(c.p)}${c.p.physfn ? ` · VF of ${c.p.physfn}` : ''}`} />
                      </td>
                      <td>{short(c.host)}</td>
                      <td>
                        <Two mono a={c.p.address} b={pciId(c.p)} />
                      </td>
                      <td>
                        <Two a={c.p.driver ?? '—'} b={c.p.iommuGroup !== null ? `IOMMU group ${c.p.iommuGroup}` : 'No IOMMU group'} />
                      </td>
                      <td>
                        <DeviceStateLabel state={s} sub={c.ok ? (c.mapping ? `Joins ${c.mapping.label}` : undefined) : s.kind === 'assigned' ? undefined : c.why} />
                      </td>
                    </tr>
                  );
                })}
              </Rows>
            )}
            {pciRows.length > 0 && !pciRows.some(c => c.ok) && (
              <Note>
                None of them can be added now: they are in use, already given to VMs or kept for their host.
                {preset && hosts.filter(h => !pciRows.some(c => c.host === h.host)).length > 0
                  ? ` No device of this model on ${hosts.filter(h => !pciRows.some(c => c.host === h.host)).map(h => short(h.host)).join(', ')}.`
                  : ''}
              </Note>
            )}
            {chosenPci.length > 0 && sameModelFree.length > chosenPci.length && (
              <Box>
                <Button size="small" sx={{ textTransform: 'none' }} onClick={() => setSel(new Set(sameModelFree.map(candidateKey)))}>
                  Select every free {pciName(chosenPci[0].p)} ({sameModelFree.length}){hostFilter ? '' : ' on all hosts'}
                </Button>
              </Box>
            )}
          </Box>
        );
      if (kind === 'usb')
        return (
          <Box sx={{ display: 'grid', gap: 1.25 }}>
            {hostChips}
            {usbRows.length === 0 ? (
              <Note>No USB device is plugged into {hostFilter ? short(hostFilter) : 'the hosts'}.</Note>
            ) : (
              <Rows label="USB devices" head={['', 'Device', 'Host', 'Port', 'Kind', 'State']}>
                {usbRows.map(c => {
                  const k = `${c.host}|${c.u.path}`;
                  return (
                    <tr key={k} aria-disabled={!c.ok}>
                      <td>
                        <Tooltip title={c.ok ? '' : c.why ?? ''}>
                          <span>
                            <Radio size="small" sx={{ p: 0.25 }} checked={one === k} disabled={!c.ok} onChange={() => setOne(k)} inputProps={{ 'aria-label': `${usbName(c.u)} on ${c.host}` }} />
                          </span>
                        </Tooltip>
                      </td>
                      <td>
                        <Two a={usbName(c.u)} b={`${usbVendor(c.u)}${c.u.serial ? ` · serial ${c.u.serial}` : ''}`} />
                      </td>
                      <td>{short(c.host)}</td>
                      <td>
                        <Two mono a={c.u.path} b={`${c.u.vendor}:${c.u.product}`} />
                      </td>
                      <td>{c.u.interfaceClassNames.join(', ') || c.u.className || '—'}</td>
                      <td>
                        {c.u.usedBy ? (
                          <DeviceStateLabel state={{ kind: 'assigned', vm: c.u.usedBy, label: '' }} />
                        ) : c.mapping ? (
                          <DeviceStateLabel state={{ kind: 'ready', label: `Offered as ${c.mapping.label}` }} />
                        ) : (
                          <DeviceStateLabel state={{ kind: 'host', label: c.u.drivers.length ? `Host driver ${c.u.drivers.join(', ')}` : 'Host', driver: '' }} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Rows>
            )}
          </Box>
        );
      if (kind === 'mdev')
        return (
          <Box sx={{ display: 'grid', gap: 1.25 }}>
            {hostChips}
            {mdevRows.length === 0 ? (
              <Note>
                No GPU on {hostFilter ? short(hostFilter) : 'the hosts'} offers vGPU profiles. They come from GPUs with vGPU drivers (NVIDIA vGPU, Intel GVT-g); a GPU
                split with SR-IOV shows its virtual functions under GPU or accelerator instead.
              </Note>
            ) : (
              <Rows label="vGPU profiles" head={['', 'Profile', 'GPU', 'Host', 'Free']}>
                {mdevRows.map(c => {
                  const k = `${c.host}|${c.parent.address}|${c.type.id}`;
                  return (
                    <tr key={k} aria-disabled={!c.ok}>
                      <td>
                        <Radio size="small" sx={{ p: 0.25 }} checked={one === k} disabled={!c.ok} onChange={() => setOne(k)} inputProps={{ 'aria-label': `${c.type.name} on ${c.host}` }} />
                      </td>
                      <td>
                        <Two a={c.type.name || c.type.id} b={c.why ?? c.type.description} />
                      </td>
                      <td>
                        <Two a={pciName(c.parent)} b={c.parent.address} />
                      </td>
                      <td>{short(c.host)}</td>
                      <td>{c.type.available ?? '—'}</td>
                    </tr>
                  );
                })}
              </Rows>
            )}
          </Box>
        );
      return (
        <Box sx={{ display: 'grid', gap: 1.25 }}>
          {hostChips}
          <Rows label="Disks" head={['', 'Disk', 'Host', 'Size', 'Connection', 'State']}>
            {diskRows.map(c => {
              const k = `${c.host}|${c.b.name}`;
              return (
                <tr key={k} aria-disabled={!c.ok}>
                  <td>
                    <Radio size="small" sx={{ p: 0.25 }} checked={one === k} disabled={!c.ok} onChange={() => setOne(k)} inputProps={{ 'aria-label': `${c.b.name} on ${c.host}` }} />
                  </td>
                  <td>
                    <Two a={c.b.name} b={[c.b.vendor, c.b.model].filter(Boolean).join(' ') + (c.b.serial ? ` · serial ${c.b.serial}` : '')} />
                  </td>
                  <td>{short(c.host)}</td>
                  <td>{formatBytes(c.b.sizeBytes ?? 0)}</td>
                  <td>{c.b.transport}</td>
                  <td>
                    {c.ok ? <DeviceStateLabel state={{ kind: 'idle', label: 'Free' }} /> : <DeviceStateLabel state={{ kind: 'host', label: 'Not available', driver: '' }} sub={c.why} />}
                  </td>
                </tr>
              );
            })}
          </Rows>
        </Box>
      );
    }

    if (step === 2) {
      if (kind === 'disk' && chosenDisk) {
        const vms = [...d.vms].sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`));
        return (
          <Box sx={{ display: 'grid', gap: 1.75 }}>
            <Typography sx={{ fontSize: 14 }}>
              The VM gets the whole disk {chosenDisk.b.name} of {short(chosenDisk.host)} as it is (Hangar does not format it), and from then on runs only on that host.
            </Typography>
            <TextField select size="small" label="VM" value={vm} onChange={e => setVm(e.target.value)}>
              {vms.map(v => (
                <MenuItem key={`${v.metadata.namespace}/${v.metadata.name}`} value={`${v.metadata.namespace}/${v.metadata.name}`}>
                  {v.metadata.name}{' '}
                  <Box component="span" sx={{ color: t.muted, ml: 1 }}>
                    {v.metadata.namespace}
                  </Box>
                </MenuItem>
              ))}
            </TextField>
            <TextField select size="small" label="Bus" value={bus} onChange={e => setBus(e.target.value)} sx={{ width: 160 }}>
              <MenuItem value="virtio">VirtIO</MenuItem>
              <MenuItem value="scsi">SCSI</MenuItem>
              <MenuItem value="sata">SATA</MenuItem>
            </TextField>
          </Box>
        );
      }
      if (isPci && existing)
        return (
          <Box sx={{ display: 'grid', gap: 1.25, fontSize: 14 }}>
            <Typography sx={{ fontSize: 14 }}>
              These devices join the mapping <b>{existing.label}</b>
              {k8s && (
                <>
                  {' '}
                  <K8sName>{existing.resourceName}</K8sName>
                </>
              )}
              : VMs that ask for it can get them.
            </Typography>
            <Typography sx={{ fontSize: 13, color: t.muted }}>
              Identical devices always share one mapping: KubeVirt matches PCI devices by vendor and device ID ({existing.selector}).
            </Typography>
          </Box>
        );
      return (
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Typography sx={{ fontSize: 14 }}>
            {isPci
              ? 'A new mapping: what VMs ask for. Identical devices you give to VMs later, on any host, join it.'
              : kind === 'usb'
              ? 'VMs ask for it by vendor and product ID, so any host with the same device offers it too. The host keeps using it until a VM that has it powers on.'
              : 'KubeVirt creates the profile on every host with this GPU, and each VM that asks for one gets its own.'}
          </Typography>
          <TextField size="small" label="Mapping name" value={label} onChange={e => setLabel(e.target.value)} />
          {isPci && <FormControlLabel control={<Checkbox checked={gpu} onChange={e => setGpu(e.target.checked)} />} label="Pass it as a GPU (display device)" />}
          {k8s && (
            <K8sName>
              resource {newResourceName(label, mappings)}
              {isPci && chosenPci[0] ? `, pciVendorSelector ${pciId(chosenPci[0].p)}` : ''}
            </K8sName>
          )}
        </Box>
      );
    }

    // Review
    return (
      <Box sx={{ display: 'grid', gap: 1.5, fontSize: 14 }}>
        {isPci && (
          <>
            <Typography sx={{ fontSize: 14 }}>
              {deviceCount} device{deviceCount === 1 ? '' : 's'} on {groups.length} host{groups.length === 1 ? '' : 's'} {deviceCount === 1 ? 'goes' : 'go'} to VMs, in the mapping{' '}
              <b>{existing?.label ?? label.trim()}</b>
              {existing ? '' : ' (new)'}. The host lets go of {deviceCount === 1 ? 'it' : 'them'} (its own drivers) and keeps {deviceCount === 1 ? 'it' : 'them'} for VMs, also after a reboot.
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.5 }}>
              {groups.map(g => (
                <li key={g.host}>
                  <b>{short(g.host)}</b>: {g.devices.filter(x => !g.mates.includes(x)).map(x => x.address).join(', ')}
                  {g.mates.length > 0 && (
                    <Box component="span" sx={{ color: t.muted }}>
                      {' '}
                      + {g.mates.map(m => `${m.address} (${pciName(m)})`).join(', ')}, same IOMMU group
                    </Box>
                  )}
                </li>
              ))}
            </Box>
            {kind === 'network' && <Note tone="warn">Those hosts lose these network ports. Hangar refuses ports that carry a host's own addresses.</Note>}
            {chosenPci.some(c => c.p.bootVga) && <Note tone="warn">A host shows its local console on one of these GPUs: that screen goes dark.</Note>}
            <Typography sx={{ fontSize: 12.5, color: t.muted }}>
              Progress is in Recent tasks, one line per host{existing ? "; each host's KubeVirt agent restarts to see the new devices (running VMs are not affected)" : ''}.
              VMs with a host device run only where a free one is, and cannot move while running.
            </Typography>
          </>
        )}
        {kind === 'usb' && chosenUsb && (
          <Typography sx={{ fontSize: 14 }}>
            VMs can ask for <b>{label.trim()}</b>: {usbName(chosenUsb.u)} ({chosenUsb.u.vendor}:{chosenUsb.u.product}), on any host that has one.
          </Typography>
        )}
        {kind === 'mdev' && chosenMdev && (
          <Typography sx={{ fontSize: 14 }}>
            VMs can ask for <b>{label.trim()}</b>: the vGPU profile {chosenMdev.type.name || chosenMdev.type.id} of {pciName(chosenMdev.parent)}.
          </Typography>
        )}
        {kind === 'disk' && chosenDisk && (
          <>
            <Typography sx={{ fontSize: 14 }}>
              {vm.split('/')[1]} gets disk {chosenDisk.b.name} of {short(chosenDisk.host)} ({formatBytes(chosenDisk.b.sizeBytes ?? 0)}) on its {bus} bus.
            </Typography>
            <Note tone="warn">Whatever is on the disk now belongs to the VM. Take it back from the host's Hardware tab when the VM no longer has it.</Note>
          </>
        )}
      </Box>
    );
  };

  const finishLabel = isPci ? `Give ${deviceCount} device${deviceCount === 1 ? '' : 's'} to VMs` : kind === 'disk' ? 'Give to VM' : 'Offer to VMs';

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth aria-labelledby="hangar-adddevice-title">
      <DialogTitle id="hangar-adddevice-title" sx={{ fontSize: 18, pb: 1 }}>
        {preset ? `Add devices to ${preset.label}` : 'Add a device for VMs'}
      </DialogTitle>
      <Box sx={{ px: 3, pb: 1.5 }}>
        <Stepper activeStep={step} sx={{ '& .MuiStepLabel-label': { fontSize: 13 } }}>
          {steps.map((s, i) => (
            <Step key={s} completed={i < step} disabled={!!preset && i === 0}>
              <StepLabel>{s}</StepLabel>
            </Step>
          ))}
        </Stepper>
      </Box>
      <DialogContent sx={{ minHeight: 300 }}>{body()}</DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        {step > (preset ? 1 : 0) && (
          <Button color="inherit" onClick={back}>
            Back
          </Button>
        )}
        {step < 3 ? (
          <Button variant="contained" disableElevation disabled={!canNext} onClick={next}>
            Next
          </Button>
        ) : (
          <Button variant="contained" disableElevation onClick={finish}>
            {finishLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
