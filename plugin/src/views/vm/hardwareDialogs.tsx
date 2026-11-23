/*
 * Dialogs for a VM's finer hardware in Configure: CPU flags, CPU and memory
 * reservation and limits, a disk's settings, and disk I/O for the whole VM.
 */

import Autocomplete from '@mui/material/Autocomplete';
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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { hardware, key } from '../../model/vm';
import * as O from '../../model/vmoptions';
import { IconAction } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { NotInKubevirt, quiet, saveVm } from './configParts';

function Actions({ onClose, onSave, ok = true, label = 'Save' }: { onClose: () => void; onSave: () => void; ok?: boolean; label?: string }) {
  return (
    <DialogActions>
      <Button color="inherit" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="contained" disableElevation disabled={!ok} onClick={onSave}>
        {label}
      </Button>
    </DialogActions>
  );
}

const RestartNote = ({ show }: { show: boolean }) =>
  show ? <Typography sx={{ fontSize: 13, color: '#B7791F' }}>The VM is running: this applies at the next power-on.</Typography> : null;

/* -------------------------------------------------------------- CPU flags */

export function CpuFlagsDialog({ vm, d, onClose }: { vm: Obj; d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const [flags, setFlags] = React.useState<O.CpuFlag[]>(() => O.cpuFlagsOf(vm));
  const [input, setInput] = React.useState('');
  const hosts = React.useMemo(() => O.hostFlags(d.nodes), [d.nodes]);
  const total = d.nodes.length;
  const options = React.useMemo(() => {
    const names = new Set([...Object.keys(O.KNOWN_FLAGS), ...hosts.keys()]);
    // Flags with words first, then the rest by name.
    return [...names].sort((a, b) => Number(!O.KNOWN_FLAGS[a]) - Number(!O.KNOWN_FLAGS[b]) || a.localeCompare(b));
  }, [hosts]);
  const add = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n || flags.some(f => f.name === n)) return;
    setFlags([...flags, { name: n, policy: 'require' }]);
    setInput('');
  };
  const running = !!d.idx.vmi.get(key(vm));
  const model = hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes).cpuModel ?? d.kubevirt?.spec?.configuration?.cpuModel ?? 'host-model';
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-flags-title">
      <DialogTitle id="hangar-flags-title" sx={{ fontSize: 18 }}>
        CPU flags of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          On top of the CPU model ({model}): <b>Require</b> adds an instruction set (the VM then runs only on hosts that have it), <b>Disable</b> hides one from the guest.
        </Typography>
        <Autocomplete
          size="small"
          freeSolo
          value={null}
          blurOnSelect
          options={options}
          inputValue={input}
          onInputChange={(_, v) => setInput(v)}
          onChange={(_, v) => v && add(String(v))}
          renderOption={(p, o) => (
            <Box component="li" {...p} key={o} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
              <Box sx={{ fontFamily: t.font.mono, fontSize: 13, minWidth: 110 }}>{o}</Box>
              <Box sx={{ fontSize: 12.5, color: t.muted, flex: 1 }}>{O.KNOWN_FLAGS[o] ?? ''}</Box>
              <Box sx={{ fontSize: 12, color: t.muted, ...tabular }}>{hosts.get(o)?.length ?? 0}/{total} hosts</Box>
            </Box>
          )}
          renderInput={p => <TextField {...p} label="Add a flag" placeholder="vmx, avx2, pcid…" onKeyDown={e => e.key === 'Enter' && add(input)} />}
        />
        {flags.length === 0 && <Typography sx={{ fontSize: 13.5, color: 'text.secondary' }}>No flags: the guest sees exactly the CPU model.</Typography>}
        {flags.map((f, i) => {
          const have = hosts.get(f.name)?.length ?? 0;
          return (
            <Box key={f.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', py: 0.5, borderTop: `1px solid ${t.rule}` }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ fontFamily: t.font.mono, fontSize: 13.5 }}>{f.name}</Box>
                <Box sx={{ fontSize: 12.5, color: f.policy === 'require' && have < total ? '#B7791F' : t.muted }}>
                  {O.KNOWN_FLAGS[f.name] ? `${O.KNOWN_FLAGS[f.name]}. ` : ''}
                  {f.policy === 'require' ? (have === total ? 'Every host has it.' : have ? `Only ${have} of ${total} hosts have it.` : 'No host reports it: the VM cannot start.') : 'Hidden from the guest.'}
                </Box>
              </Box>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={f.policy === 'require' || f.policy === 'force' ? 'require' : 'disable'}
                onChange={(_, v) => v && setFlags(flags.map((x, j) => (j === i ? { ...x, policy: v } : x)))}
                aria-label={`Policy for ${f.name}`}
              >
                <ToggleButton value="require" sx={{ textTransform: 'none', py: 0.25 }}>
                  Require
                </ToggleButton>
                <ToggleButton value="disable" sx={{ textTransform: 'none', py: 0.25 }}>
                  Disable
                </ToggleButton>
              </ToggleButtonGroup>
              <IconAction icon="mdi:close" label={`Remove ${f.name}`} onClick={() => setFlags(flags.filter((_, j) => j !== i))} />
            </Box>
          );
        })}
        <RestartNote show={running} />
      </DialogContent>
      <Actions
        onClose={onClose}
        onSave={() => {
          quiet(saveVm(vm, 'Change CPU flags', O.setCpuFlags(vm, flags)));
          onClose();
        }}
      />
    </Dialog>
  );
}

/* ------------------------------------------------- reservation and limits */

export function ReservationDialog({ vm, d, onClose }: { vm: Obj; d: HangarData; onClose: () => void }) {
  const hw = hardware(vm, d.idx.vmi.get(key(vm)), d.instancetypes);
  const [r, setR] = React.useState<O.Reservation>(() => O.reservationOf(vm));
  const problem = O.reservationProblem(r, hw.memoryBytes);
  const ratio = Number(d.kubevirt?.spec?.configuration?.developerConfiguration?.cpuAllocationRatio) || 10;
  const running = !!d.idx.vmi.get(key(vm));
  const field = (k: keyof O.Reservation, label: string, help: string, placeholder: string) => (
    <TextField size="small" label={label} value={r[k]} onChange={e => setR({ ...r, [k]: e.target.value })} helperText={help} placeholder={placeholder} InputLabelProps={{ shrink: true }} />
  );
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-res-title">
      <DialogTitle id="hangar-res-title" sx={{ fontSize: 18 }}>
        Reservation and limits of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', gridColumn: '1 / -1' }}>
          The VM has {hw.vcpus} vCPU and {formatBytes(hw.memoryBytes)}. A reservation is what its host keeps for it; a limit is the most it may use. Leave a field empty for KubeVirt&apos;s default.
        </Typography>
        {field('cpuRequest', 'CPU reservation', `Default ${(hw.vcpus / ratio).toFixed(2).replace(/\.?0+$/, '')} cores (1/${ratio} per vCPU).`, `${hw.vcpus / ratio}`)}
        {field('cpuLimit', 'CPU limit', 'Cores the VM may burn at most (throttled above).', 'no limit')}
        {field('memoryRequest', 'Memory reservation', 'Below the VM memory: overcommit (the host may run short).', 'VM memory + overhead')}
        {field('memoryLimit', 'Memory limit', 'At least the VM memory plus room for QEMU.', 'no limit')}
        {problem && <Typography sx={{ fontSize: 13, color: '#E5484D', gridColumn: '1 / -1' }}>{problem}</Typography>}
        <Box sx={{ gridColumn: '1 / -1' }}>
          <NotInKubevirt>Like Proxmox&apos;s CPU units and limit and VMware&apos;s reservations; shares between VMs (CPU weight) are not in KubeVirt.</NotInKubevirt>
          <RestartNote show={running} />
        </Box>
      </DialogContent>
      <Actions
        ok={!problem}
        onClose={onClose}
        onSave={() => {
          quiet(saveVm(vm, 'Change reservation and limits', O.setReservation(vm, r)));
          onClose();
        }}
      />
    </Dialog>
  );
}

/* --------------------------------------------------------- disk settings */

export function DiskSettingsDialog({ vm, name, bus, running, onClose }: { vm: Obj; name: string; bus: string; running: boolean; onClose: () => void }) {
  const t = useTokens();
  const [s, setS] = React.useState<O.DiskSettings>(() => O.diskSettingsOf(vm, name)!);
  const problem = O.diskSettingsProblem(s, bus);
  const set = (p: Partial<O.DiskSettings>) => setS({ ...s, ...p });
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-disk-title">
      <DialogTitle id="hangar-disk-title" sx={{ fontSize: 18 }}>
        Settings of disk {name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, pt: '8px !important' }}>
        <TextField select size="small" label="Cache" value={s.cache} onChange={e => set({ cache: e.target.value as O.DiskCache })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">Default (none if the storage allows direct I/O)</MenuItem>
          <MenuItem value="none">None: no host cache</MenuItem>
          <MenuItem value="writethrough">Write through: host reads cached, writes safe</MenuItem>
          <MenuItem value="writeback">Write back: fastest, data at risk if the host fails</MenuItem>
        </TextField>
        <TextField select size="small" label="Async I/O" value={s.io} onChange={e => set({ io: e.target.value as O.DiskIo })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">Default (native on block disks with no cache)</MenuItem>
          <MenuItem value="native">Native (Linux AIO, needs cache none)</MenuItem>
          <MenuItem value="threads">Threads</MenuItem>
        </TextField>
        <TextField select size="small" label="On a write error" value={s.errorPolicy} onChange={e => set({ errorPolicy: e.target.value as O.ErrorPolicy })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">Default (pause the VM)</MenuItem>
          <MenuItem value="stop">Pause the VM</MenuItem>
          <MenuItem value="report">Report it to the guest</MenuItem>
          <MenuItem value="ignore">Ignore it</MenuItem>
          <MenuItem value="enospace">Pause only when the disk is full</MenuItem>
        </TextField>
        <TextField size="small" label="Serial number" value={s.serial} onChange={e => set({ serial: e.target.value })} helperText="What the guest sees in /dev/disk/by-id." InputLabelProps={{ shrink: true }} />
        <Box sx={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', columnGap: 3 }}>
          <FormControlLabel control={<Checkbox checked={s.dedicatedIOThread} disabled={bus !== 'virtio'} onChange={e => set({ dedicatedIOThread: e.target.checked })} />} label="Own I/O thread (VirtIO only)" />
          <FormControlLabel control={<Checkbox checked={s.readonly} disabled={bus === 'sata'} onChange={e => set({ readonly: e.target.checked })} />} label="Read-only" />
          <FormControlLabel control={<Checkbox checked={s.shareable} onChange={e => set({ shareable: e.target.checked, ...(e.target.checked && s.cache && s.cache !== 'none' ? { cache: 'none' as O.DiskCache } : {}) })} />} label="Shareable between VMs" />
        </Box>
        <Box sx={{ gridColumn: '1 / -1' }}>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 0.75 }}>Block size seen by the guest</Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
            <ToggleButtonGroup size="small" exclusive value={s.blockSize.mode} onChange={(_, v) => v && set({ blockSize: v === 'custom' ? { mode: 'custom', logical: s.blockSize.logical ?? 512, physical: s.blockSize.physical ?? 4096 } : { mode: v } })} aria-label="Block size">
              <ToggleButton value="default" sx={{ textTransform: 'none' }}>
                Default (512 B)
              </ToggleButton>
              <ToggleButton value="match" sx={{ textTransform: 'none' }}>
                Like the storage
              </ToggleButton>
              <ToggleButton value="custom" sx={{ textTransform: 'none' }}>
                Custom
              </ToggleButton>
            </ToggleButtonGroup>
            {s.blockSize.mode === 'custom' && (
              <>
                <TextField type="number" size="small" label="Logical" value={s.blockSize.logical ?? ''} onChange={e => set({ blockSize: { ...s.blockSize, logical: Number(e.target.value) } })} sx={{ width: 110 }} />
                <TextField type="number" size="small" label="Physical" value={s.blockSize.physical ?? ''} onChange={e => set({ blockSize: { ...s.blockSize, physical: Number(e.target.value) } })} sx={{ width: 110 }} />
              </>
            )}
          </Box>
        </Box>
        {s.shareable && <Typography sx={{ fontSize: 12.5, color: t.muted, gridColumn: '1 / -1' }}>Several VMs may write it at once: they need a cluster filesystem (GFS2, OCFS2) or a cluster-aware application. The datastore must be RWX.</Typography>}
        {problem && <Typography sx={{ fontSize: 13, color: '#E5484D', gridColumn: '1 / -1' }}>{problem}</Typography>}
        <Box sx={{ gridColumn: '1 / -1', display: 'grid', gap: 0.5 }}>
          <NotInKubevirt>Bandwidth and IOPS limits and SSD emulation are not in KubeVirt: set QoS on the datastore (StorageClass parameters of its driver).</NotInKubevirt>
          <RestartNote show={running} />
        </Box>
      </DialogContent>
      <Actions
        ok={!problem}
        onClose={onClose}
        onSave={() => {
          quiet(saveVm(vm, `Change settings of disk ${name}`, O.setDiskSettings(vm, name, s)));
          onClose();
        }}
      />
    </Dialog>
  );
}

/* --------------------------------------------------------------- disk I/O */

export function DiskIoDialog({ vm, running, onClose }: { vm: Obj; running: boolean; onClose: () => void }) {
  const o = O.deviceOptions(vm);
  const [policy, setPolicy] = React.useState<O.IoThreadsPolicy>(o.ioThreadsPolicy);
  const [count, setCount] = React.useState(String(o.ioThreadsCount ?? 2));
  const [mq, setMq] = React.useState(o.blockMultiQueue);
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-io-title">
      <DialogTitle id="hangar-io-title" sx={{ fontSize: 18 }}>
        Disk I/O of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <TextField select size="small" label="I/O threads" value={policy} onChange={e => setPolicy(e.target.value as O.IoThreadsPolicy)} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">None: disks share QEMU&apos;s main loop</MenuItem>
          <MenuItem value="shared">One thread for all disks</MenuItem>
          <MenuItem value="auto">A pool sized by KubeVirt</MenuItem>
          <MenuItem value="supplementalPool">A pool of a chosen size (VirtIO disks)</MenuItem>
        </TextField>
        {policy === 'supplementalPool' && <TextField type="number" size="small" label="Threads in the pool" value={count} onChange={e => setCount(e.target.value)} inputProps={{ min: 1 }} />}
        <FormControlLabel control={<Checkbox checked={mq} onChange={e => setMq(e.target.checked)} />} label="Multi-queue: one queue per vCPU (VirtIO disks)" />
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>Disks with their own I/O thread (disk settings) get it on top of these.</Typography>
        <RestartNote show={running} />
      </DialogContent>
      <Actions
        ok={policy !== 'supplementalPool' || Number(count) >= 1}
        onClose={onClose}
        onSave={() => {
          quiet(saveVm(vm, 'Change disk I/O', O.setDevices(vm, { ioThreadsPolicy: policy, ioThreadsCount: Number(count) || 1, blockMultiQueue: mq })));
          onClose();
        }}
      />
    </Dialog>
  );
}

export function ioSummary(vm: Obj): string {
  const o = O.deviceOptions(vm);
  const pol =
    o.ioThreadsPolicy === 'shared'
      ? 'one I/O thread'
      : o.ioThreadsPolicy === 'auto'
      ? 'I/O thread pool (auto)'
      : o.ioThreadsPolicy === 'supplementalPool'
      ? `I/O thread pool of ${o.ioThreadsCount ?? '?'}`
      : 'no I/O threads';
  return `${pol}, multi-queue ${o.blockMultiQueue ? 'on' : 'off'}`;
}

export function flagsSummary(vm: Obj): string {
  const f = O.cpuFlagsOf(vm);
  if (!f.length) return 'None';
  return f.map(x => `${x.policy === 'disable' || x.policy === 'forbid' ? '−' : '+'}${x.name}`).join(' ');
}

export function reservationSummary(vm: Obj): string {
  const r = O.reservationOf(vm);
  const parts = [r.cpuRequest && `CPU ${r.cpuRequest} reserved`, r.cpuLimit && `CPU ≤ ${r.cpuLimit}`, r.memoryRequest && `memory ${r.memoryRequest} reserved`, r.memoryLimit && `memory ≤ ${r.memoryLimit}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'KubeVirt defaults';
}

/* ------------------------------------------------------------ machine type */

export function MachineDialog({ vm, d, onClose }: { vm: Obj; d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const cm = O.clusterMachines(d.kubevirt, vm.spec?.template?.spec?.architecture || 'amd64');
  const choices = O.machineChoices(d.kubevirt, d.nodes, vm.spec?.template?.spec?.architecture || 'amd64').filter(c => c.allowed);
  const current = O.machineTypeOf(vm) ?? '';
  const [type, setType] = React.useState(current);
  const vmi = d.idx.vmi.get(key(vm));
  const runningOn: string | undefined = vmi?.status?.machine?.type;
  const total = d.nodes.length;
  // A type no host offers, or KubeVirt does not accept, is still shown (the VM has it), not offered.
  const inList = !type || choices.some(c => c.type === type);
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-machine-title">
      <DialogTitle id="hangar-machine-title" sx={{ fontSize: 18 }}>
        Machine type of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          The virtual chipset and its version. <b>q35</b> means the newest version the host offers when the VM powers on; a version keeps the VM on that
          chipset across power-ons (some guests, such as Windows, notice a new one).
        </Typography>
        <TextField select size="small" label="Machine type" value={type} onChange={e => setType(e.target.value)} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">Datacenter default ({cm.default})</MenuItem>
          {choices.map(c => (
            <MenuItem key={c.type} value={c.type}>
              <Box sx={{ display: 'flex', gap: 1, width: '100%', alignItems: 'baseline' }}>
                <span>{c.type}</span>
                {c.type === cm.default && <Box component="span" sx={{ fontSize: 12, color: t.muted }}>datacenter default</Box>}
                <Box component="span" sx={{ flex: 1 }} />
                <Box component="span" sx={{ fontSize: 12, color: c.hosts.length < total ? '#B7791F' : t.muted, ...tabular }}>
                  {c.hosts.length === total ? 'every host' : `${c.hosts.length} of ${total} hosts`}
                </Box>
              </Box>
            </MenuItem>
          ))}
          {!inList && <MenuItem value={type}>{type} (not offered by the hosts or not accepted)</MenuItem>}
        </TextField>
        <Typography sx={{ fontSize: 12.5, color: t.muted }}>
          KubeVirt accepts {cm.emulated.join(', ')}
          {cm.from === 'kubevirt' ? ' (its defaults: the KubeVirt resource sets none)' : ' (set in the KubeVirt resource)'}; a VM without a machine type gets {cm.default}.
          {runningOn ? ` The running VM uses ${runningOn}.` : ''} A running VM keeps its machine type when it moves: KubeVirt moves it only to hosts that offer it.
        </Typography>
        <RestartNote show={!!vmi} />
      </DialogContent>
      <Actions
        ok={type !== current}
        onClose={onClose}
        onSave={() => {
          quiet(saveVm(vm, 'Change machine type', O.setMachineType(vm, type)));
          onClose();
        }}
      />
    </Dialog>
  );
}
