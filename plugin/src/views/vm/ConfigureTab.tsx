/*
 * Configure: the VM's virtual hardware and options, edited in place like a
 * classic "Edit settings". Each panel saves on its own; changes a running VM
 * cannot take live wait for a restart (the VM page says so).
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
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { useGate } from '../../api/gates';
import { useNetFacts } from '../../api/podnet';
import { datastores } from '../../model/capacity';
import * as E from '../../model/edit';
import { hostCpus, KIND_CLUSTER, KIND_NS, setCpuModel, setFlavor, vendors } from '../../model/flavors';
import { clusterSettings, HOTPLUG_DECLARATIVE, vmStateAccess, vmStateDatastore } from '../../model/gates';
import { hostState } from '../../model/inventory';
import { preferredDatastore } from '../../model/placement';
import { freeVmCidr, podNetIssues, setVmNetworkCidr, vmNetworkCidrOf } from '../../model/podnet';
import { isProtected } from '../../model/protection';
import { classifyDisk } from '../../model/storage';
import { Obj } from '../../model/types';
import { formatBytes, GiB, parseQuantity } from '../../model/units';
import { disks, EVICTION_LABELS, hardware, isTemplate, key, liveMigratable, nics, powerState, RUN_STRATEGIES, runStrategy, tags } from '../../model/vm';
import * as O from '../../model/vmoptions';
import { useK8s, useSettings } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { libraryImages, sizeProfiles } from '../../wizard/catalog';
import { CpuModelSelect, FlavorSelect, useFlavorFamilies } from '../flavors/parts';
import { GateHint } from '../settings/GateHint';
import { datastoreItems, renderDatastore } from '../storage/DatastorePick';
import { Note } from '../storage/parts';
import { ClipboardPanel } from './ClipboardPanel';
import { Help, Later, quiet, Row, saveVm } from './configParts';
import { DevicesPanel } from './DevicesPanel';
import { HostDevicesPanel } from './DevicesSection';
import { DnsPanel } from './DnsPanel';
import { CpuFlagsDialog, DiskIoDialog, DiskSettingsDialog, flagsSummary, ioSummary, MachineDialog, ReservationDialog, reservationSummary } from './hardwareDialogs';
import { MoveDiskDialog } from './MoveDiskDialog';
import { OptionsPanel } from './OptionsPanel';
import { PortsPanel } from './PortsPanel';
import { SharedFoldersPanel } from './SharedFoldersPanel';

/* ------------------------------------------------------------- dialogs */

function verdictText(v: 'same' | 'live' | 'restart', what: string): string {
  return v === 'live' ? `${what}: changes now, while the VM runs (hot-plug)` : `${what}: at the next restart`;
}

/** A whole-number field you can clear and retype; reports only valid values (≥ 1). */
function IntField({ label, value, onValue }: { label: string; value: number; onValue: (n: number) => void }) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TextField
      type="number"
      size="small"
      label={label}
      value={text}
      onChange={e => {
        setText(e.target.value);
        const n = Math.round(Number(e.target.value));
        if (e.target.value !== '' && n >= 1) onValue(n);
      }}
      onBlur={() => setText(String(value))}
      sx={{ width: 100 }}
      inputProps={{ min: 1 }}
    />
  );
}

function ComputeDialog({ vm, d, onClose }: { vm: Obj; d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const vmi = d.idx.vmi.get(key(vm));
  const hw = hardware(vm, vmi, d.instancetypes);
  const profiles = sizeProfiles(d.instancetypes);
  const [mode, setMode] = React.useState<'custom' | 'profile'>(hw.instancetype ? 'profile' : 'custom');
  const [profile, setProfile] = React.useState(hw.instancetype?.name ?? 'u1.small');
  const [profileKind, setProfileKind] = React.useState(hw.instancetype?.kind ?? KIND_CLUSTER);
  const ownModel: string = vm.spec?.template?.spec?.domain?.cpu?.model ?? '';
  const [cpuModel, setCpuModelState] = React.useState(ownModel);
  const flavorObjs = useFlavorFamilies(vm.metadata.namespace as string).all;
  const chosen = flavorObjs.find(o => o.metadata.name === profile && (profileKind === KIND_NS ? o.metadata.namespace === vm.metadata.namespace : !o.metadata.namespace));
  const flavorModel: string | undefined = mode === 'profile' ? chosen?.spec?.cpu?.model : undefined;
  const [sockets, setSockets] = React.useState(hw.sockets);
  const [cores, setCores] = React.useState(hw.cores);
  const [threads, setThreads] = React.useState(hw.threads);
  const [mem, setMem] = React.useState(String(+(hw.memoryBytes / GiB).toFixed(2)));
  const fwNow: 'bios' | 'uefi' | 'uefi-secure' = hw.firmware === 'BIOS' ? 'bios' : hw.firmware === 'UEFI' ? 'uefi' : 'uefi-secure';
  const [fw, setFw] = React.useState<'bios' | 'uefi' | 'uefi-secure'>(fwNow);
  const [tpm, setTpm] = React.useState(hw.tpm);
  const persist = O.persistenceOf(vm);
  const [efiKeep, setEfiKeep] = React.useState(persist.efi);
  const [tpmKeep, setTpmKeep] = React.useState(hw.tpm ? persist.tpm : true);
  const limits = O.hotAddLimitsOf(vm);
  const [maxSockets, setMaxSockets] = React.useState(limits.maxSockets ? String(limits.maxSockets) : '');
  const [maxGuest, setMaxGuest] = React.useState(limits.maxGuest ? String(+(parseQuantity(limits.maxGuest) / GiB).toFixed(2)) : '');
  const cs = clusterSettings(d.kubevirt);
  const stateDs = vmStateDatastore(d.kubevirt, d.storageClasses);
  const stateAccess = vmStateAccess(d.kubevirt, d.storageProfiles, stateDs.name);
  const effModel = cpuModel || vmi?.spec?.domain?.cpu?.model || d.kubevirt?.spec?.configuration?.cpuModel || 'host-model';
  const mixedMakers = vendors(hostCpus(d.nodes)).length > 1 && effModel !== 'host-model' && effModel !== 'host-passthrough';
  const memBytes = Number(mem) * GiB;
  const maxGuestBytes = maxGuest.trim() ? Number(maxGuest) * GiB : null;
  const limitsBad =
    (maxSockets.trim() !== '' && !(Number(maxSockets) >= sockets)) || (maxGuestBytes !== null && !(maxGuestBytes >= memBytes && maxGuestBytes % (2 * 2 ** 20) === 0));
  const ok = mode === 'profile' ? !!profile : sockets >= 1 && cores >= 1 && threads >= 1 && memBytes >= 128 * 2 ** 20 && !limitsBad;
  const live =
    vmi && mode === 'custom' && !hw.instancetype
      ? O.liveCompute(vmi, { sockets, cores, threads, memoryBytes: memBytes }, { liveUpdate: cs.rollout === 'LiveUpdate', liveMigrateUpdates: cs.liveMigrateUpdates, migratable: liveMigratable(vm, vmi) })
      : null;
  const save = () => {
    // Touch only what changed: any other edit of the template (even writing the
    // BIOS default) makes KubeVirt ask for a restart and skip the hot-add.
    const sizeChanged =
      mode === 'profile'
        ? !hw.instancetype || hw.instancetype.name !== profile || hw.instancetype.kind !== profileKind
        : !!hw.instancetype || sockets !== hw.sockets || cores !== hw.cores || threads !== hw.threads || Math.abs(memBytes - hw.memoryBytes) >= 1;
    let next = !sizeChanged ? vm : mode === 'profile' ? setFlavor(vm, { kind: profileKind, name: profile }) : E.setCompute(vm, { sockets, cores, threads, memoryBytes: memBytes });
    if (fw !== fwNow || tpm !== hw.tpm) next = E.setFirmware(next, fw, tpm);
    if ((fw !== 'bios' && efiKeep) !== persist.efi || (tpm && tpmKeep) !== persist.tpm) next = O.setPersistence(next, { efi: fw !== 'bios' && efiKeep, tpm: tpmKeep });
    const newMaxSockets = maxSockets.trim() ? Number(maxSockets) : null;
    if (mode === 'custom' && (newMaxSockets !== (limits.maxSockets ?? null) || maxGuestBytes !== (limits.maxGuest ? parseQuantity(limits.maxGuest) : null)))
      next = O.setHotAddLimits(next, { maxSockets: newMaxSockets, maxGuestBytes });
    // A flavor that sets the CPU model forbids the VM's own (KubeVirt rejects the conflict).
    const model = flavorModel ? '' : cpuModel;
    if (model !== ownModel) next = setCpuModel(next, model);
    quiet(saveVm(vm, 'Change CPU and memory', next));
    onClose();
  };
  const num = (label: string, v: number, set: (n: number) => void) => <IntField label={label} value={v} onValue={set} />;
  const step = cores * threads;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-compute-title">
      <DialogTitle id="hangar-compute-title" sx={{ fontSize: 18 }}>
        CPU, memory and firmware of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} aria-label="Sizing">
          <ToggleButton value="custom" sx={{ textTransform: 'none' }}>
            Custom
          </ToggleButton>
          <ToggleButton value="profile" sx={{ textTransform: 'none' }} disabled={!profiles.length}>
            Flavor
          </ToggleButton>
        </ToggleButtonGroup>
        {mode === 'custom' ? (
          <>
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
              {num('Sockets', sockets, setSockets)}
              {num('Cores', cores, setCores)}
              {num('Threads', threads, setThreads)}
              <Box sx={{ fontSize: 14 }}>= {sockets * cores * threads} vCPU</Box>
            </Box>
            <TextField type="number" size="small" label="Memory (GiB)" value={mem} onChange={e => setMem(e.target.value)} sx={{ width: 160 }} inputProps={{ min: 0.125, step: 0.5 }} />
            <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: 1, p: 1.5, display: 'grid', gap: 1.25 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>Hot-add: how far it can grow while running</Typography>
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                <TextField
                  type="number"
                  size="small"
                  label="Up to sockets"
                  value={maxSockets}
                  onChange={e => setMaxSockets(e.target.value)}
                  placeholder={String(cs.maxCpuSockets ?? sockets * cs.maxHotplugRatio)}
                  InputLabelProps={{ shrink: true }}
                  sx={{ width: 140 }}
                  inputProps={{ min: sockets }}
                />
                <TextField
                  type="number"
                  size="small"
                  label="Up to memory (GiB)"
                  value={maxGuest}
                  onChange={e => setMaxGuest(e.target.value)}
                  placeholder={String(+((memBytes * cs.maxHotplugRatio) / GiB).toFixed(1))}
                  InputLabelProps={{ shrink: true }}
                  sx={{ width: 170 }}
                  inputProps={{ min: Number(mem), step: 0.5 }}
                />
              </Box>
              <Help>
                Empty: KubeVirt&apos;s default, {cs.maxHotplugRatio}× the size at power-on. CPUs are added a socket at a time ({step} vCPU each with {cores} core{cores > 1 ? 's' : ''} × {threads} thread{threads > 1 ? 's' : ''}); memory needs at least 1 GiB.
                {!cs.liveMigrateUpdates && ' KubeVirt may not move running VMs here (no LiveMigrate update method): hot-add waits for a restart.'} New limits apply from the next power-on.
              </Help>
              {limitsBad && <Help tone="warn">The limits cannot be below the current size; memory goes in 2 MiB steps.</Help>}
            </Box>
            {live && (live.cpu !== 'same' || live.memory !== 'same') && (
              <Box sx={{ display: 'grid', gap: 0.25 }}>
                {live.cpu !== 'same' && <Typography sx={{ fontSize: 13, color: live.cpu === 'live' ? '#2F855A' : '#B7791F' }}>{verdictText(live.cpu, 'CPUs')}</Typography>}
                {live.memory !== 'same' && <Typography sx={{ fontSize: 13, color: live.memory === 'live' ? '#2F855A' : '#B7791F' }}>{verdictText(live.memory, 'Memory')}</Typography>}
                {live.why.map(w => (
                  <Help key={w}>{w}</Help>
                ))}
                {live.cpu === 'live' && (
                  <Help>
                    The guest gets the new CPUs at once; some Linux guests (Fedora cloud images, for one) still have to bring them online: echo 1 &gt;
                    /sys/devices/system/cpu/cpuN/online. Windows and RHEL do it themselves.
                  </Help>
                )}
                {(live.cpu === 'live' || live.memory === 'live') && mixedMakers && (
                  <Help tone="warn">
                    KubeVirt grows a running VM by moving it live to another host. This datacenter mixes Intel and AMD hosts: with a CPU model both makers offer, the move may cross makers, which QEMU does not support (the guest can freeze). Pin the VM to one maker&apos;s hosts first, or restart instead.
                  </Help>
                )}
              </Box>
            )}
          </>
        ) : (
          <FlavorSelect
            value={`${profileKind}/${profile}`}
            onChange={(kind, name) => {
              setProfileKind(kind);
              setProfile(name);
            }}
            namespace={vm.metadata.namespace as string}
            nodes={d.nodes}
          />
        )}
        <CpuModelSelect
          value={cpuModel}
          onChange={setCpuModelState}
          nodes={d.nodes}
          clusterDefault={d.kubevirt?.spec?.configuration?.cpuModel}
          lockedBy={flavorModel ? { flavor: profile, model: flavorModel } : undefined}
        />
        {(cpuModel !== ownModel || !!flavorModel) && d.idx.vmi.get(key(vm)) && (
          <Typography sx={{ fontSize: 13, color: '#B7791F' }}>The running VM keeps its CPU: the new model applies at the next power-on.</Typography>
        )}
        <Box>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 0.75 }}>Firmware</Typography>
          <ToggleButtonGroup size="small" exclusive value={fw} onChange={(_, v) => v && setFw(v)} aria-label="Firmware">
            <ToggleButton value="bios" sx={{ textTransform: 'none' }}>
              BIOS
            </ToggleButton>
            <ToggleButton value="uefi" sx={{ textTransform: 'none' }}>
              UEFI
            </ToggleButton>
            <ToggleButton value="uefi-secure" sx={{ textTransform: 'none' }}>
              UEFI, Secure Boot
            </ToggleButton>
          </ToggleButtonGroup>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, mt: 1 }}>
            {fw !== 'bios' && <FormControlLabel control={<Checkbox checked={efiKeep} onChange={e => setEfiKeep(e.target.checked)} />} label="Keep UEFI variables (boot entries)" />}
            <FormControlLabel control={<Checkbox checked={tpm} onChange={e => setTpm(e.target.checked)} />} label="Virtual TPM" />
            {tpm && <FormControlLabel control={<Checkbox checked={tpmKeep} onChange={e => setTpmKeep(e.target.checked)} />} label="Keep the TPM state" />}
          </Box>
          {((fw !== 'bios' && efiKeep) || (tpm && tpmKeep)) && (
            <Help>
              {stateDs.how === 'none' ? (
                <>KubeVirt keeps them on a small disk, but this datacenter has no VM state datastore and no default datastore: the VM cannot start.</>
              ) : (
                <>
                  KubeVirt keeps them on a small disk on <b>{stateDs.name}</b> ({stateDs.how === 'set' ? 'the VM state datastore' : 'the default datastore: no VM state datastore is set'}),{' '}
                  {stateAccess === 'RWX'
                    ? 'shared (RWX): hosts reach it while the VM moves.'
                    : 'one host at a time (RWO): during a live move KubeVirt copies the state to a new disk on the target host.'}{' '}
                  Without it, BitLocker keys and boot entries are lost at every power-off.
                </>
              )}
            </Help>
          )}
          {fw !== (hw.firmware === 'BIOS' ? 'bios' : hw.firmware === 'UEFI' ? 'uefi' : 'uefi-secure') && (
            <Typography sx={{ fontSize: 13, color: '#B7791F' }}>Changing the firmware of an installed guest usually stops it from booting.</Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!ok} onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AddDiskDialog({ vm, d, onClose, libraryNs, preset }: { vm: Obj; d: HangarData; onClose: () => void; libraryNs: string; preset?: { kind: 'iso'; drive: string } }) {
  const ns = vm.metadata.namespace as string;
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  const used = new Set(d.vms.flatMap(v => disks(v).map(x => `${v.metadata.namespace}/${x.claimName}`)));
  const free = d.pvcs.filter(
    p =>
      p.metadata.namespace === ns &&
      !used.has(`${ns}/${p.metadata.name}`) &&
      !p.metadata.name.startsWith('prime-') &&
      !p.metadata.name.endsWith('-scratch') &&
      p.metadata.labels?.['hangar.magesgate.com/image'] !== 'true' &&
      // CDI's internals and KubeVirt's VM state (TPM, UEFI) are not disks.
      classifyDisk(p, d.idx.dv.get(key(p)), undefined, libraryNs) !== 'internal'
  );
  const isos = libraryImages(d.dvs, d.pvcs, libraryNs).filter(i => i.media === 'iso' && i.ready);
  const vmi = d.idx.vmi.get(key(vm));
  const running = !!vmi;
  const hot = useGate(HOTPLUG_DECLARATIVE);
  const live = running && hot.on !== false;
  const emptyDrives = disks(vm).filter(x => x.device === 'cdrom' && x.sourceKind === 'empty');
  const [kind, setKind] = React.useState<'new' | 'existing' | 'iso' | 'drive'>(preset?.kind ?? 'new');
  const [size, setSize] = React.useState('10');
  const [sc, setSc] = React.useState(preferredDatastore(ds, d.nodes.length)?.name ?? '');
  const tk = useTokens();
  const [bus, setBus] = React.useState('virtio');
  const [claim, setClaim] = React.useState(free[0]?.metadata.name ?? '');
  const [iso, setIso] = React.useState(isos[0] ? `${isos[0].namespace}/${isos[0].name}` : '');
  const [drive, setDrive] = React.useState(preset?.drive ?? emptyDrives[0]?.name ?? '');
  const [boot, setBoot] = React.useState(false);
  const busLive = !live || E.HOTPLUG_BUSES.includes(bus);
  const ok = kind === 'new' ? Number(size) >= 1 && busLive : kind === 'existing' ? !!claim && busLive : kind === 'iso' ? !!iso : hot.on !== false;
  const isoLive = live && !!drive;
  const bootBack = !!claim && E.isFormerBootDisk(vm, claim);
  const save = () => {
    if (kind === 'new') quiet(saveVm(vm, live ? 'Add disk (hot-plug)' : 'Add disk', E.addBlankDisk(vm, { sizeBytes: Number(size) * GiB, storageClass: sc, bus, hotplug: live }).vm));
    else if (kind === 'existing') {
      const r = E.attachDisk(vm, claim, bus, live);
      quiet(saveVm(vm, live && r.bootOrder === undefined ? 'Attach disk (hot-plug)' : 'Attach disk', r.vm));
    }
    else if (kind === 'drive') quiet(saveVm(vm, 'Add CD/DVD drive', E.addCdromDrive(vm).vm));
    else {
      const i = isos.find(x => `${x.namespace}/${x.name}` === iso)!;
      quiet(saveVm(vm, isoLive ? 'Insert ISO (hot-plug)' : 'Insert ISO', E.insertIso(vm, i, boot, { drive: drive || undefined, hotplug: isoLive })));
    }
    onClose();
  };
  const when = (liveNow: boolean) =>
    !running ? null : liveNow ? (
      <Typography sx={{ fontSize: 13, color: '#2F855A' }}>The running VM gets it at once (hot-plug).</Typography>
    ) : (
      <Typography sx={{ fontSize: 13, color: '#B7791F' }}>The running VM gets it at the next restart.</Typography>
    );
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-adddisk-title">
      <DialogTitle id="hangar-adddisk-title" sx={{ fontSize: 18 }}>
        Add a disk to {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={kind} onChange={(_, v) => v && setKind(v)} aria-label="Kind of disk" sx={{ flexWrap: 'wrap' }}>
          <ToggleButton value="new" sx={{ textTransform: 'none' }}>
            New disk
          </ToggleButton>
          <ToggleButton value="existing" sx={{ textTransform: 'none' }} disabled={!free.length}>
            Existing disk
          </ToggleButton>
          <ToggleButton value="iso" sx={{ textTransform: 'none' }} disabled={!isos.length}>
            CD/DVD from an ISO
          </ToggleButton>
          <ToggleButton value="drive" sx={{ textTransform: 'none' }}>
            Empty CD/DVD drive
          </ToggleButton>
        </ToggleButtonGroup>
        {kind === 'new' && (
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <TextField type="number" size="small" label="Size (GiB)" value={size} onChange={e => setSize(e.target.value)} sx={{ width: 130 }} inputProps={{ min: 1 }} />
            <TextField
              select
              size="small"
              label="Datastore"
              value={sc}
              onChange={e => setSc(e.target.value)}
              sx={{ minWidth: 260 }}
              SelectProps={{ renderValue: renderDatastore(ds, d.nodes.length) }}
            >
              {datastoreItems(ds, d.nodes.length, tk)}
            </TextField>
          </Box>
        )}
        {kind === 'existing' && (
          <TextField select size="small" label="Unattached disk in this folder" value={claim} onChange={e => setClaim(e.target.value)}>
            {free.map(p => (
              <MenuItem key={p.metadata.name} value={p.metadata.name}>
                {p.metadata.name} · {formatBytes(parseQuantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage))}
                {E.isFormerBootDisk(vm, p.metadata.name) ? ' · its boot disk' : ''}
              </MenuItem>
            ))}
          </TextField>
        )}
        {kind === 'existing' && bootBack && (
          <Help>It was this VM&apos;s boot disk: it gets its boot order back{running ? ', and is not hot-plugged, so that the VM can start from it' : ''}.</Help>
        )}
        {kind === 'iso' && (
          <>
            <TextField select size="small" label="ISO" value={iso} onChange={e => setIso(e.target.value)}>
              {isos.map(i => (
                <MenuItem key={`${i.namespace}/${i.name}`} value={`${i.namespace}/${i.name}`}>
                  {i.displayName}
                </MenuItem>
              ))}
            </TextField>
            <TextField select size="small" label="Drive" value={drive} onChange={e => setDrive(e.target.value)} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
              {emptyDrives.map(x => (
                <MenuItem key={x.name} value={x.name}>
                  Empty drive {x.name}
                </MenuItem>
              ))}
              <MenuItem value="">A new drive</MenuItem>
            </TextField>
            <FormControlLabel control={<Checkbox checked={boot} onChange={e => setBoot(e.target.checked)} />} label="Boot from it first" />
            {when(isoLive)}
            {running && !drive && hot.on !== false && <Help>Media go into a running VM only through an empty drive that was there at power-on: add one now and use it after the next restart.</Help>}
          </>
        )}
        {kind === 'drive' && (
          <>
            <Typography sx={{ fontSize: 14 }}>A SATA CD/DVD drive with no media: ISOs can then be inserted and ejected while the VM runs, like a physical drive.</Typography>
            {hot.on === false ? <GateHint gate={HOTPLUG_DECLARATIVE}>An empty drive needs KubeVirt&apos;s {HOTPLUG_DECLARATIVE} feature, off in this datacenter.</GateHint> : when(false)}
          </>
        )}
        {(kind === 'new' || kind === 'existing') && (
          <>
            <TextField select size="small" label="Bus" value={bus} onChange={e => setBus(e.target.value)} sx={{ width: 160 }}>
              <MenuItem value="virtio">VirtIO</MenuItem>
              <MenuItem value="scsi">SCSI</MenuItem>
              <MenuItem value="sata" disabled={live}>
                SATA{live ? ' (not while running)' : ''}
              </MenuItem>
            </TextField>
            {when(live && !(kind === 'existing' && bootBack))}
          </>
        )}
        {running && hot.on === false && kind !== 'drive' && <GateHint gate={HOTPLUG_DECLARATIVE}>Adding disks to a running VM needs KubeVirt&apos;s {HOTPLUG_DECLARATIVE} feature, off in this datacenter.</GateHint>}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!ok} onClick={save}>
          {kind === 'iso' ? 'Insert ISO' : kind === 'existing' ? 'Attach disk' : kind === 'drive' ? 'Add drive' : 'Add disk'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ExpandDialog({ vm, claim, current, running, onClose }: { vm: Obj; claim: string; current: number; running: boolean; onClose: () => void }) {
  const [size, setSize] = React.useState(String(Math.ceil(current / GiB) + 10));
  const bytes = Number(size) * GiB;
  const expand = useGate('ExpandDisks');
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-expand-title">
      <DialogTitle id="hangar-expand-title" sx={{ fontSize: 18 }}>
        Expand disk
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5 }}>
        <Typography sx={{ fontSize: 14 }}>
          Now {formatBytes(current)}. Disks only grow: grow the partition and filesystem in the guest afterwards.
        </Typography>
        {running &&
          (expand.on === false ? (
            <GateHint gate="ExpandDisks">The running guest sees the new size after a restart: seeing it at once needs KubeVirt&apos;s ExpandDisks feature, off in this datacenter.</GateHint>
          ) : (
            <Typography sx={{ fontSize: 13, color: '#2F855A' }}>The running guest sees the new size at once (when the datastore can grow disks in use).</Typography>
          ))}
        <TextField type="number" size="small" label="New size (GiB)" value={size} onChange={e => setSize(e.target.value)} inputProps={{ min: Math.ceil(current / GiB) + 1 }} />
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!(bytes > current)}
          onClick={() => {
            quiet(A.expandDisk(vm.metadata.namespace as string, claim, bytes, vm.metadata.name));
            onClose();
          }}
        >
          Expand
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- tab */

export function ConfigureTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const [settings] = useSettings();
  const vmi = d.idx.vmi.get(key(vm));
  const p = powerState(vm, vmi);
  const running = p.kind !== 'off';
  const hw = hardware(vm, vmi, d.instancetypes);
  const ds = disks(vm);
  const ns = nics(vm, vmi);
  const nads = d.nads.filter(n => n.metadata.namespace === vm.metadata.namespace || n.metadata.namespace === 'default');
  const tpl = isTemplate(vm);
  const vmNs = vm.metadata.namespace as string;
  const pvc = (c?: string) => (c ? d.idx.pvc.get(`${vmNs}/${c}`) : undefined);
  const size = (c?: string) => parseQuantity(pvc(c)?.status?.capacity?.storage ?? pvc(c)?.spec?.resources?.requests?.storage);
  const sc = (c?: string) => d.storageClasses.find(s => s.metadata.name === pvc(c)?.spec?.storageClassName);
  const hotGate = useGate(HOTPLUG_DECLARATIVE);
  const netFacts = useNetFacts(d.nodes);
  const netIssues = netFacts ? podNetIssues(vm, netFacts) : [];
  const issueOf = (nic: string) => netIssues.find(i => i.nic === nic);
  const freeCidr = netFacts ? freeVmCidr(netFacts) : null;
  const persist = O.persistenceOf(vm);
  const lim = O.hotAddLimitsOf(vm);
  const cs = clusterSettings(d.kubevirt);
  const vmiCpu = vmi?.spec?.domain?.cpu;
  const vmiMax = vmi?.spec?.domain?.memory?.maxGuest;
  const growOff = !(cs.liveMigrateUpdates && cs.rollout === 'LiveUpdate');
  const hotAddText = hw.instancetype
    ? 'From the flavor'
    : `Up to ${vmiCpu?.maxSockets ?? lim.maxSockets ?? cs.maxCpuSockets ?? hw.sockets * cs.maxHotplugRatio} sockets and ${
        vmiMax ?? lim.maxGuest ?? formatBytes(hw.memoryBytes * cs.maxHotplugRatio)
      } of memory while running${growOff ? ' (needs LiveMigrate updates: Settings)' : ''}`;
  const mq = O.deviceOptions(vm).nicMultiQueue;

  /* boot order */
  const bootables = [...ds.filter(x => !x.config).map(x => ({ name: x.name, kind: x.device === 'cdrom' ? 'CD/DVD' : 'Disk' })), ...ns.map(n => ({ name: n.name, kind: 'Network (PXE)' }))];
  const currentOrder = [
    ...ds.filter(x => x.bootOrder !== undefined).map(x => [x.name, x.bootOrder as number] as [string, number]),
    ...((vm.spec?.template?.spec?.domain?.devices?.interfaces ?? []) as any[]).filter(i => i.bootOrder).map(i => [i.name, i.bootOrder] as [string, number]),
  ]
    .sort((a, b) => a[1] - b[1])
    .map(x => x[0]);
  // An edit holds while the VM's own order is the one it started from: when the VM changes (a disk comes back with its boot order), it starts over.
  const currentKey = currentOrder.join();
  const [orderEdit, setOrderEdit] = React.useState<{ from: string; order: string[] } | null>(null);
  const order = orderEdit && orderEdit.from === currentKey ? orderEdit.order : currentOrder;
  const setOrder = (next: string[] | ((o: string[]) => string[])) => setOrderEdit({ from: currentKey, order: typeof next === 'function' ? next(order) : next });
  const orderChanged = order.join() !== currentKey;
  const saveOrder = async () => {
    const r = E.setBootOrder(vm, order);
    const warn = E.bootOrderWarning(vm, r.vm);
    if (r.dropped.length || warn) {
      const ok = await confirm({
        title: `Change the boot order of ${vm.metadata.name}?`,
        body: (
          <>
            {r.dropped.length > 0 && (
              <p>
                No longer in the boot order: <b>{r.dropped.join(', ')}</b>.
              </p>
            )}
            {warn && <p>{warn}</p>}
          </>
        ),
        confirm: 'Save',
      });
      if (!ok) return;
    }
    quiet(A.updateVm(vm, 'Change boot order', r.vm));
  };

  /* policies */
  const spec = vm.spec?.template?.spec ?? {};
  const aff = E.hostAffinity(vm);
  const [pol, setPol] = React.useState({
    eviction: spec.evictionStrategy ?? '',
    grace: String(spec.terminationGracePeriodSeconds ?? 180),
    host: aff?.host ?? '',
    required: aff?.required ?? false,
  });
  const polChanged =
    pol.eviction !== (spec.evictionStrategy ?? '') ||
    Number(pol.grace) !== (spec.terminationGracePeriodSeconds ?? 180) ||
    pol.host !== (aff?.host ?? '') ||
    (!!pol.host && pol.required !== (aff?.required ?? false));

  /* cloud-init */
  const ci = E.cloudInitOf(vm);
  const [ciText, setCiText] = React.useState(ci ?? '');

  /* tags */
  const userTags = tags(vm);
  const [tagText, setTagText] = React.useState(userTags.map(([k, v]) => `${k}=${v}`).join(', '));

  const prot = isProtected(vm);
  const hotOn = hotGate.on !== false;
  const removeDisk = async (name: string, claim?: string) => {
    const hp = E.isHotpluggable(vm, name);
    const r = hp || !running ? { ...E.removeDisk(E.forHotplug(vm), name) } : E.removeDisk(vm, name);
    const bootWarn = E.bootOrderWarning(vm, r.vm);
    const ok = await confirm({
      title: `Remove ${name} from ${vm.metadata.name}?`,
      body: (
        <>
          <p>{claim ? 'The disk is detached from the VM.' : 'The device is removed.'}</p>
          {running && <p>{hp && hotOn ? 'The running VM loses it at once (hot-unplug).' : 'The running VM keeps it until the next restart.'}</p>}
          {claim && E.isFormerBootDisk(r.vm, claim) && <p>It is the VM&apos;s boot disk. Attached again, it boots first again.</p>}
          {bootWarn && <p>{bootWarn}</p>}
          {claim && prot && <p>The VM is protected from deletion: the disk stays in the folder, still protected. Remove its protection in Storage → Disks to delete it.</p>}
        </>
      ),
      confirm: 'Remove',
      danger: true,
      option: claim && !prot ? { label: 'Also delete the disk and its data', help: 'Otherwise it stays in the folder, unattached.', initial: false } : undefined,
    });
    if (!ok) return;
    try {
      await saveVm(vm, hp && running ? 'Remove disk (hot-unplug)' : 'Remove disk', r.vm, { bootWarned: true });
    } catch {
      return;
    }
    if (!claim || prot) return;
    // KubeVirt keeps a disk it created after its template goes (owned by the VM, deleted with it): delete it now, or let it go for good.
    if (ok.option) quiet(A.deleteClaim(vmNs, claim));
    else if (r.owned) quiet(A.releaseClaim(vmNs, claim));
  };
  const eject = async (name: string) => {
    const hp = E.isHotpluggable(vm, name);
    const ok = await confirm({
      title: `Eject the CD/DVD of ${vm.metadata.name}?`,
      body: (
        <>
          <p>{hotOn ? 'The drive stays, empty: insert another ISO later.' : 'The drive is removed with its media.'}</p>
          {running && <p>{hp && hotOn ? 'The running VM loses the media at once.' : 'The running VM keeps the media until the next restart.'}</p>}
        </>
      ),
      confirm: 'Eject',
    });
    if (!ok) return;
    const r = E.ejectCdrom(vm, name, hotOn);
    try {
      await saveVm(vm, hp && running ? 'Eject CD/DVD (hot-unplug)' : 'Eject CD/DVD', r.vm);
    } catch {
      return;
    }
    // The media was this VM's copy of a library ISO.
    if (r.claim && r.owned) quiet(A.deleteClaim(vmNs, r.claim));
  };

  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: 'minmax(0,1.3fr) minmax(0,1fr)' }, alignItems: 'start' }}>
      <Box sx={{ display: 'grid', gap: 2 }}>
        <Panel
          title="Virtual hardware"
          icon="mdi:chip"
          actions={
            <>
              <Later running={running} />
              <Button size="small" onClick={() => openDialog(close => <ComputeDialog vm={vm} d={d} onClose={close} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:pencil-outline" width={16} />}>
                Edit
              </Button>
            </>
          }
        >
          <Row label="CPU">
            {hw.vcpus} vCPU ({hw.sockets} × {hw.cores} × {hw.threads}){hw.cpuModel ? `, model ${hw.cpuModel}` : ''}
            {hw.dedicatedCpus && <Tag>dedicated</Tag>}
          </Row>
          <Row label="Memory">{formatBytes(hw.memoryBytes)}</Row>
          <Row label="Hot-add">{hotAddText}</Row>
          <Row label="CPU flags" action={<IconAction icon="mdi:pencil-outline" label="Change CPU flags" onClick={() => openDialog(close => <CpuFlagsDialog vm={vm} d={d} onClose={close} />)} />}>
            {flagsSummary(vm)}
          </Row>
          <Row label="Reservation and limits" action={<IconAction icon="mdi:pencil-outline" label="Change reservation and limits" onClick={() => openDialog(close => <ReservationDialog vm={vm} d={d} onClose={close} />)} />}>
            {reservationSummary(vm)}
          </Row>
          <Row label="Sizing">
            {hw.instancetype ? (
              <>
                Size profile {hw.instancetype.name} {k8s && <K8sName>{hw.instancetype.kind}</K8sName>}
              </>
            ) : (
              'Custom'
            )}
          </Row>
          <Row label="Machine type" action={<IconAction icon="mdi:pencil-outline" label="Change the machine type" onClick={() => openDialog(close => <MachineDialog vm={vm} d={d} onClose={close} />)} />}>
            {O.machineTypeOf(vm) ?? `Datacenter default (${O.clusterMachines(d.kubevirt).default})`}
            {vmi?.status?.machine?.type && vmi.status.machine.type !== O.machineTypeOf(vm) ? `, running as ${vmi.status.machine.type}` : ''}
          </Row>
          <Row label="Firmware">
            {hw.firmware}
            {hw.firmware !== 'BIOS' && persist.efi ? ', UEFI variables kept' : ''}
            {hw.tpm ? (persist.tpm ? ', TPM (state kept)' : ', TPM (cleared at power-off)') : ''}
          </Row>
          {hw.preference && (
            <Row label="Guest OS tuning">
              {hw.preference.name} {k8s && <K8sName>preference</K8sName>}
            </Row>
          )}
        </Panel>

        <Panel
          title="Disks and CD/DVD"
          icon="mdi:harddisk"
          dense
          actions={
            <>
              <Later running={running} />
              <Button size="small" onClick={() => openDialog(close => <AddDiskDialog vm={vm} d={d} onClose={close} libraryNs={settings.libraryNamespace} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={16} />}>
                Add
              </Button>
            </>
          }
        >
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, ...tabular, '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 2, py: 0.75 }, '& td': { px: 2, py: 0.75, borderTop: `1px solid ${t.rule}` } }}>
            <thead>
              <tr>
                <th>Device</th>
                <th>Bus</th>
                <th>Size</th>
                <th>{k8s ? 'StorageClass' : 'Datastore'}</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {ds.map(x => (
                <tr key={x.name}>
                  <td>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                      <Icon icon={x.config ? 'mdi:file-cog-outline' : x.device === 'cdrom' ? 'mdi:disc' : 'mdi:harddisk'} width={16} style={{ color: t.muted }} />
                      <span>{x.config ? (x.sourceKind === 'cloudInit' ? 'Guest customization (cloud-init)' : `${x.name} (${x.sourceKind})`) : x.name}</span>
                      {x.device === 'cdrom' && <Tag>{x.sourceKind === 'empty' ? 'CD/DVD, empty' : 'CD/DVD'}</Tag>}
                      {x.hotplug && <Tag tone="accent">hot-plugged</Tag>}
                    </Box>
                    {k8s && x.claimName && <K8sName>pvc/{x.claimName}</K8sName>}
                  </td>
                  <td>{x.bus}</td>
                  <td>{x.claimName ? formatBytes(size(x.claimName)) : '—'}</td>
                  <td>{pvc(x.claimName)?.spec?.storageClassName ?? (x.sourceKind === 'containerDisk' ? 'Image (ephemeral)' : '—')}</td>
                  <Box component="td" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {x.device === 'disk' && !x.config && (
                      <IconAction icon="mdi:tune-variant" label={`Settings of ${x.name}`} onClick={() => openDialog(close => <DiskSettingsDialog vm={vm} name={x.name} bus={x.bus} running={running} onClose={close} />)} />
                    )}
                    {x.claimName && x.device === 'disk' && (
                      <IconAction
                        icon="mdi:arrow-expand-horizontal"
                        label={sc(x.claimName)?.allowVolumeExpansion ? 'Expand' : 'This datastore cannot expand disks'}
                        disabled={!sc(x.claimName)?.allowVolumeExpansion}
                        onClick={() => openDialog(close => <ExpandDialog vm={vm} claim={x.claimName!} current={size(x.claimName)} running={running} onClose={close} />)}
                      />
                    )}
                    {x.claimName && x.device === 'disk' && (
                      <IconAction
                        icon="mdi:database-arrow-right-outline"
                        label="Move to another datastore"
                        onClick={() => openDialog(close => <MoveDiskDialog vm={vm} only={x.name} onClose={close} />)}
                      />
                    )}
                    {x.device === 'cdrom' && x.sourceKind === 'empty' && (
                      <IconAction
                        icon="mdi:disc-player"
                        label={`Insert an ISO into ${x.name}`}
                        onClick={() => openDialog(close => <AddDiskDialog vm={vm} d={d} onClose={close} libraryNs={settings.libraryNamespace} preset={{ kind: 'iso', drive: x.name }} />)}
                      />
                    )}
                    {x.device === 'cdrom' && x.sourceKind !== 'empty' && <IconAction icon="mdi:eject-outline" label={hotOn ? 'Eject' : 'Eject and remove the drive'} onClick={() => eject(x.name)} />}
                    {!x.config && (x.device !== 'cdrom' || x.sourceKind === 'empty') && (
                      <IconAction icon="mdi:link-off" label={x.device === 'cdrom' ? 'Remove the drive' : 'Remove from VM'} onClick={() => removeDisk(x.name, x.claimName)} />
                    )}
                  </Box>
                </tr>
              ))}
            </tbody>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, borderTop: `1px solid ${t.rule}`, fontSize: 13 }}>
            <Box sx={{ color: t.muted, width: 80, flex: 'none' }}>Disk I/O</Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>{ioSummary(vm)}</Box>
            <IconAction icon="mdi:pencil-outline" label="Change disk I/O" onClick={() => openDialog(close => <DiskIoDialog vm={vm} running={running} onClose={close} />)} />
          </Box>
          {running && (
            <Box sx={{ px: 2, pb: 1 }}>
              {hotOn ? (
                <Help>Disks added now (VirtIO or SCSI) and ISOs inserted into an empty drive reach the running VM at once.</Help>
              ) : (
                <GateHint gate={HOTPLUG_DECLARATIVE}>Disks and ISOs reach a running VM at its next restart: hot-plug needs KubeVirt&apos;s {HOTPLUG_DECLARATIVE} feature.</GateHint>
              )}
            </Box>
          )}
        </Panel>

        <Panel
          title="Network adapters"
          icon="mdi:ethernet"
          dense
          actions={
            <>
              <Later running={running} />
              <Button
                size="small"
                sx={{ textTransform: 'none' }}
                startIcon={<Icon icon="mdi:plus" width={16} />}
                disabled={!nads.length && ns.some(n => n.isPodNetwork)}
                onClick={() => {
                  const free = nads.find(x => !ns.some(n => n.network === `${x.metadata.namespace}/${x.metadata.name}`));
                  quiet(A.updateVm(vm, 'Add network adapter', E.addNic(vm, free ? `${free.metadata.namespace}/${free.metadata.name}` : '', 'virtio').vm));
                }}
              >
                Add
              </Button>
            </>
          }
        >
          {ns.length === 0 && <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>No network adapters: the VM is isolated.</Box>}
          {ns.map(n => (
            <React.Fragment key={n.name}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, borderTop: `1px solid ${t.rule}`, flexWrap: 'wrap' }}>
              <Icon icon="mdi:ethernet" width={18} style={{ color: t.muted }} />
              <Box sx={{ width: 90, fontWeight: 600, fontSize: 14 }}>{n.name}</Box>
              <TextField
                select
                size="small"
                value={n.isPodNetwork ? '' : n.network}
                onChange={e => quiet(A.updateVm(vm, 'Change network', E.setNic(vm, n.name, { network: e.target.value })))}
                sx={{ minWidth: 220 }}
                inputProps={{ 'aria-label': `Network of ${n.name}` }}
                SelectProps={{ displayEmpty: true }}
              >
                <MenuItem value="">Pod network (NAT)</MenuItem>
                {nads.map(x => (
                  <MenuItem key={`${x.metadata.namespace}/${x.metadata.name}`} value={`${x.metadata.namespace}/${x.metadata.name}`}>
                    {x.metadata.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select size="small" value={n.model} onChange={e => quiet(A.updateVm(vm, 'Change adapter type', E.setNic(vm, n.name, { model: e.target.value })))} sx={{ width: 140 }} inputProps={{ 'aria-label': `Adapter type of ${n.name}` }}>
                <MenuItem value="virtio">VirtIO</MenuItem>
                <MenuItem value="e1000e">Intel e1000e</MenuItem>
                <MenuItem value="rtl8139">Realtek 8139</MenuItem>
              </TextField>
              <Box sx={{ fontSize: 13, color: t.muted, ...tabular, minWidth: 130 }}>{n.mac ?? 'MAC assigned at start'}</Box>
              {n.binding !== 'SR-IOV' && (
                <FormControlLabel
                  title="Like plugging or pulling the cable: applies at once, also while the VM runs"
                  sx={{ m: 0 }}
                  control={<Switch size="small" checked={n.linkState !== 'down'} onChange={e => quiet(A.updateVm(vm, e.target.checked ? 'Connect adapter' : 'Disconnect adapter', E.setNic(vm, n.name, { linkDown: !e.target.checked })))} />}
                  label={<Box sx={{ fontSize: 13 }}>Connected</Box>}
                />
              )}
              <Box sx={{ flex: 1 }} />
              <IconAction
                icon="mdi:delete-outline"
                label="Remove adapter"
                onClick={async () => {
                  const ok = await confirm({ title: `Remove ${n.name}?`, body: <p>The VM loses this network connection.</p>, confirm: 'Remove', danger: true });
                  if (ok) quiet(A.updateVm(vm, 'Remove network adapter', E.removeNic(vm, n.name)));
                }}
              />
            </Box>
            {issueOf(n.name) && (
              <Box sx={{ px: 2, pb: 1 }}>
                <Note tone="warn" icon={<Icon icon="mdi:lan-disconnect" width={16} style={{ marginTop: 2 }} />}>
                  The NAT range of {n.name}, {issueOf(n.name)!.cidr}
                  {issueOf(n.name)!.isDefault ? " (KubeVirt's default)" : ''}, is also {issueOf(n.name)!.conflicts.join(' and ')}: the VM cannot reach those addresses.{' '}
                  {freeCidr ? (
                    <>
                      <Button
                        size="small"
                        sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }}
                        onClick={() => quiet(saveVm(vm, `Use ${freeCidr} as NAT range`, setVmNetworkCidr(vm, freeCidr, n.name)))}
                      >
                        Use {freeCidr}
                      </Button>{' '}
                      (applies at the next power-on).
                    </>
                  ) : (
                    'No free /24 found in 172.31.239.0–172.31.254.0.'
                  )}
                </Note>
              </Box>
            )}
            {k8s && n.isPodNetwork && !issueOf(n.name) && (
              <Box sx={{ px: 2, pb: 1, mt: -0.5 }}>
                <K8sName>vmNetworkCIDR {vmNetworkCidrOf(vm, n.name)}</K8sName>
              </Box>
            )}
            </React.Fragment>
          ))}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, borderTop: `1px solid ${t.rule}`, fontSize: 13 }}>
            <Box sx={{ color: t.muted, flex: 1 }}>Multi-queue: one queue per vCPU on VirtIO adapters (faster networking on VMs with several vCPU)</Box>
            <Switch size="small" checked={mq} onChange={e => quiet(saveVm(vm, e.target.checked ? 'Turn on network multi-queue' : 'Turn off network multi-queue', O.setDevices(vm, { nicMultiQueue: e.target.checked })))} inputProps={{ 'aria-label': 'Network multi-queue' }} />
          </Box>
        </Panel>

        {!tpl && <PortsPanel vm={vm} />}

        <DevicesPanel vm={vm} />

        <SharedFoldersPanel vm={vm} />

        <DnsPanel vm={vm} />

        <ClipboardPanel vm={vm} />

        <HostDevicesPanel vm={vm} later={<Later running={running} />} />
      </Box>

      <Box sx={{ display: 'grid', gap: 2 }}>
        <OptionsPanel vm={vm} />

        <Panel
          title="Boot order"
          icon="mdi:sort-numeric-ascending"
          actions={
            orderChanged ? (
              <>
                <Button size="small" color="inherit" onClick={() => setOrderEdit(null)} sx={{ textTransform: 'none' }}>
                  Undo
                </Button>
                <Button size="small" variant="contained" disableElevation onClick={saveOrder} sx={{ textTransform: 'none' }}>
                  Save
                </Button>
              </>
            ) : undefined
          }
        >
          {bootables.length === 0 && <Box sx={{ color: t.muted, fontSize: 14 }}>No bootable devices.</Box>}
          {[...order.filter(n => bootables.some(b => b.name === n)), ...bootables.map(b => b.name).filter(n => !order.includes(n))].map(name => {
            const b = bootables.find(x => x.name === name)!;
            const i = order.indexOf(name);
            const on = i >= 0;
            return (
              <Box key={name} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25, opacity: on ? 1 : 0.6 }}>
                <Checkbox
                  size="small"
                  checked={on}
                  onChange={e => setOrder(e.target.checked ? [...order, name] : order.filter(x => x !== name))}
                  inputProps={{ 'aria-label': `Boot from ${name}` }}
                />
                <Box sx={{ width: 22, fontSize: 13, color: t.muted, ...tabular }}>{on ? i + 1 : ''}</Box>
                <Box sx={{ flex: 1, fontSize: 14 }}>
                  {name} <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>{b.kind}</Box>
                </Box>
                <IconAction icon="mdi:arrow-up" label={`Move ${name} up`} disabled={!on || i === 0} onClick={() => setOrder(o => { const n = [...o]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })} />
                <IconAction icon="mdi:arrow-down" label={`Move ${name} down`} disabled={!on || i === order.length - 1} onClick={() => setOrder(o => { const n = [...o]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })} />
              </Box>
            );
          })}
        </Panel>

        {!tpl && (
          <Panel title="Power and availability" icon="mdi:power-settings">
            <Box sx={{ display: 'grid', gap: 2 }}>
              <TextField select size="small" label="Power policy" value={runStrategy(vm)} onChange={e => quiet(A.setRunStrategy(vm, e.target.value))} helperText={RUN_STRATEGIES.find(r => r.value === runStrategy(vm))?.help}>
                {RUN_STRATEGIES.map(r => (
                  <MenuItem key={r.value} value={r.value}>
                    {r.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select size="small" label="On host maintenance" value={pol.eviction} onChange={e => setPol({ ...pol, eviction: e.target.value })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
                <MenuItem value="">Cluster default ({EVICTION_LABELS[d.kubevirt?.spec?.configuration?.evictionStrategy ?? 'None']?.toLowerCase()})</MenuItem>
                {Object.entries(EVICTION_LABELS).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              <TextField type="number" size="small" label="Shutdown timeout (seconds)" value={pol.grace} onChange={e => setPol({ ...pol, grace: e.target.value })} helperText="How long a guest shutdown may take before the VM is powered off." inputProps={{ min: 0 }} />
              <Box>
                <TextField select size="small" fullWidth label="Host" value={pol.host} onChange={e => setPol({ ...pol, host: e.target.value })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
                  <MenuItem value="">Any host</MenuItem>
                  {d.nodes.map(n => (
                    <MenuItem key={n.metadata.name} value={n.metadata.name}>
                      {n.metadata.name} {hostState(n).ready ? '' : '(not responding)'}
                    </MenuItem>
                  ))}
                </TextField>
                {pol.host && (
                  <FormControlLabel control={<Checkbox checked={pol.required} onChange={e => setPol({ ...pol, required: e.target.checked })} />} label="Only on this host (otherwise preferred)" />
                )}
              </Box>
              {polChanged && (
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                  <Button
                    variant="contained"
                    disableElevation
                    onClick={() =>
                      quiet(
                        A.updateVm(
                          vm,
                          'Change policies',
                          E.setPolicies(vm, {
                            eviction: pol.eviction || null,
                            graceSeconds: pol.grace === '' ? null : Math.max(0, Number(pol.grace)),
                            hostAffinity: pol.host ? { host: pol.host, required: pol.required } : null,
                          })
                        )
                      )
                    }
                    sx={{ textTransform: 'none' }}
                  >
                    Save policies
                  </Button>
                </Box>
              )}
            </Box>
          </Panel>
        )}

        <Panel title="Tags" icon="mdi:tag-outline">
          <TextField fullWidth size="small" value={tagText} onChange={e => setTagText(e.target.value)} placeholder="app=shop, tier=web" helperText="key=value, separated by commas. Tags group VMs in searches." inputProps={{ 'aria-label': 'Tags' }} />
          {tagText !== userTags.map(([k, v]) => `${k}=${v}`).join(', ') && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
              <Button
                variant="contained"
                disableElevation
                sx={{ textTransform: 'none' }}
                onClick={() => {
                  const map: Record<string, string> = {};
                  for (const part of tagText.split(/[,\s]+/).filter(Boolean)) {
                    const [k, v = ''] = part.split(/[=:]/);
                    if (k) map[k] = v;
                  }
                  const userKeys = new Set(userTags.map(([k]) => k));
                  quiet(A.updateVm(vm, 'Change tags', E.setTags(vm, map, k => !userKeys.has(k))));
                }}
              >
                Save tags
              </Button>
            </Box>
          )}
        </Panel>

        {ci !== undefined && (
          <Panel title="Guest customization" icon="mdi:file-cog-outline">
            <Typography sx={{ fontSize: 13, color: t.muted, mb: 1 }}>
              cloud-init user data. Most images read it only at their first boot.
            </Typography>
            <TextField fullWidth multiline minRows={6} maxRows={18} size="small" value={ciText} onChange={e => setCiText(e.target.value)} inputProps={{ 'aria-label': 'cloud-init user data', style: { fontFamily: t.font.mono, fontSize: 12.5 } }} />
            {ciText !== ci && (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
                <Button variant="contained" disableElevation sx={{ textTransform: 'none' }} onClick={() => quiet(A.updateVm(vm, 'Change guest customization', E.setCloudInit(vm, ciText)))}>
                  Save
                </Button>
              </Box>
            )}
          </Panel>
        )}
      </Box>
    </Box>
  );
}
