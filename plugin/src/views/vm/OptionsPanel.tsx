/*
 * Configure → Options, Proxmox's Options tab: delete protection, start
 * paused, the guest clock, the pointer, ACPI, SMBIOS and the guest OS
 * tuning (KubeVirt preference).
 */

import { Icon } from '@iconify/react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { useFolderFlavors } from '../../api/flavors';
import { useK4allMetadata } from '../../api/k4all';
import { NOT_ALLOWED, useVmPerms } from '../../api/permissions';
import { setVmProtection, useProtectionPolicy } from '../../api/protection';
import { chassisAssetWarning } from '../../model/metadata';
import { isProtected, PROTECTED_LABEL } from '../../model/protection';
import { Obj } from '../../model/types';
import { formatBytes, parseQuantity } from '../../model/units';
import { hardware, key, powerState } from '../../model/vm';
import * as O from '../../model/vmoptions';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { Help, Later, NotInKubevirt, quiet, Row, saveVm } from './configParts';

const KIND_PREF = 'VirtualMachineClusterPreference';
const KIND_PREF_NS = 'VirtualMachinePreference';

const FALLBACK_ZONES = ['Europe/Rome', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Sydney', 'UTC'];

function timeZones(): string[] {
  try {
    const z = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
    return z?.length ? z : FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

function offsetLabel(sec: number): string {
  if (!isFinite(sec)) return '';
  const sign = sec < 0 ? '−' : '+';
  const a = Math.abs(Math.round(sec));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function clockText(c: O.ClockSetting): string {
  switch (c.mode) {
    case 'timezone':
      return `Time zone ${c.timezone}`;
    case 'offset':
      return `${offsetLabel(c.offsetSeconds ?? 0)}, kept by the guest across reboots`;
    case 'utc':
      return 'UTC';
    default:
      return 'UTC (KubeVirt default)';
  }
}

function ClockDialog({ vm, onClose }: { vm: Obj; onClose: () => void }) {
  const cur = O.clockOf(vm);
  const [mode, setMode] = React.useState<O.ClockMode>(cur.mode);
  const [tz, setTz] = React.useState<string>(cur.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [off, setOff] = React.useState(String(cur.offsetSeconds ?? 0));
  const zones = React.useMemo(timeZones, []);
  const ok = mode !== 'timezone' || !!tz;
  const save = () => {
    quiet(saveVm(vm, 'Change guest clock', O.setClock(vm, { mode, timezone: tz, offsetSeconds: Number(off) || 0 })));
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-clock-title">
      <DialogTitle id="hangar-clock-title" sx={{ fontSize: 18 }}>
        Guest clock of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <TextField select size="small" label="The guest's hardware clock runs on" value={mode} onChange={e => setMode(e.target.value as O.ClockMode)}>
          <MenuItem value="default">KubeVirt default (UTC)</MenuItem>
          <MenuItem value="utc">UTC</MenuItem>
          <MenuItem value="timezone">A time zone (local time, e.g. Windows)</MenuItem>
          <MenuItem value="offset">UTC with an offset</MenuItem>
        </TextField>
        {mode === 'timezone' && (
          <Autocomplete
            size="small"
            options={zones}
            value={tz}
            onChange={(_, v) => v && setTz(v)}
            renderInput={p => <TextField {...p} label="Time zone" />}
          />
        )}
        {mode === 'offset' && (
          <TextField
            type="number"
            size="small"
            label="Offset in seconds"
            value={off}
            onChange={e => setOff(e.target.value)}
            helperText={`${offsetLabel(Number(off))}. The guest keeps its own clock changes across reboots.`}
          />
        )}
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
          A fixed start date (a clock that starts at a chosen day) is not possible in KubeVirt: the guest clock follows the host&apos;s.
        </Typography>
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

function newUuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function SmbiosDialog({ vm, onClose }: { vm: Obj; onClose: () => void }) {
  const d = useHangar();
  const [s, setS] = React.useState<O.Smbios>(() => O.smbiosOf(vm));
  const cluster = d.kubevirt?.spec?.configuration?.smbios ?? {};
  const uuidBad = !!s.uuid.trim() && !O.UUID_RE.test(s.uuid.trim());
  const running = !!d.idx.vmi.get(key(vm));
  const k4 = useK4allMetadata();
  const assetWarning = k4.on ? chassisAssetWarning(s.chassis.asset, vm, k4.metadata) : null;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-smbios-title">
      <DialogTitle id="hangar-smbios-title" sx={{ fontSize: 18 }}>
        SMBIOS of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
          What the guest reads with dmidecode or in its system information: licences and asset tools often key on the UUID and serial.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <TextField
            size="small"
            fullWidth
            label="System UUID"
            value={s.uuid}
            onChange={e => setS({ ...s, uuid: e.target.value })}
            error={uuidBad}
            helperText={uuidBad ? 'A UUID looks like 9854a2a1-749a-4343-8f4d-781c36dd2599.' : 'Empty: KubeVirt derives one from the VM.'}
          />
          <Button size="small" sx={{ textTransform: 'none', mt: 0.5, flex: 'none' }} onClick={() => setS({ ...s, uuid: newUuid() })}>
            New UUID
          </Button>
        </Box>
        <TextField size="small" label="System serial number" value={s.serial} onChange={e => setS({ ...s, serial: e.target.value })} />
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          {O.CHASSIS_FIELDS.map(f => (
            <TextField key={f.key} size="small" label={f.label} value={s.chassis[f.key]} onChange={e => setS({ ...s, chassis: { ...s.chassis, [f.key]: e.target.value } })} />
          ))}
        </Box>
        {assetWarning && (
          <Typography role="status" sx={{ fontSize: 13, color: '#B7791F' }}>
            {assetWarning}
          </Typography>
        )}
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
          Manufacturer, product, version and family of the system are the same for every VM of this datacenter
          {cluster.manufacturer || cluster.product ? ` (${[cluster.manufacturer, cluster.product, cluster.version].filter(Boolean).join(', ')})` : ' (KubeVirt’s defaults)'}: they are set in the KubeVirt resource (spec.configuration.smbios).
        </Typography>
        {running && <Typography sx={{ fontSize: 13, color: '#B7791F' }}>The running VM keeps its SMBIOS until it restarts.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={uuidBad}
          onClick={() => {
            quiet(saveVm(vm, 'Change SMBIOS', O.setSmbios(vm, s)));
            onClose();
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ProtectionRow({ vm }: { vm: Obj }) {
  const t = useTokens();
  const { state } = useProtectionPolicy();
  const perms = useVmPerms(vm.metadata.namespace as string);
  const on = isProtected(vm);
  const [busy, setBusy] = React.useState(false);
  const installed = state === 'installed';
  // Turning it off stays possible without the policy (it only removes a label).
  const why = !perms.edit ? NOT_ALLOWED : !installed && !on ? 'Needs the delete protection policy' : undefined;
  const toggle = async (next: boolean) => {
    const ok = await confirm({
      title: next ? `Protect ${vm.metadata.name} from deletion?` : `Remove delete protection from ${vm.metadata.name}?`,
      body: next ? (
        <p>Nobody can delete the VM or its disks (from Hangar, kubectl or anything else) until protection is turned off again. Power operations and edits stay possible.</p>
      ) : (
        <p>The VM and its disks can be deleted again.</p>
      ),
      confirm: next ? 'Protect' : 'Remove protection',
      danger: !next,
    });
    if (!ok) return;
    setBusy(true);
    await setVmProtection(vm, next).catch(() => undefined);
    setBusy(false);
  };
  return (
    <Row
      label="Protection"
      align="flex-start"
      action={
        <Tooltip title={why ?? ''}>
          <span>
            <Switch checked={on} disabled={!!why || busy || state === null} onChange={e => toggle(e.target.checked)} inputProps={{ 'aria-label': 'Protect from deletion' }} />
          </span>
        </Tooltip>
      }
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        {on && <Icon icon="mdi:shield-lock" width={16} style={{ color: t.accent }} />}
        {on ? 'Protected from deletion, with its disks' : 'Off'}
      </Box>
      {state === 'missing' || state === 'unbound' || state === 'unknown' ? (
        <Help tone={on ? 'warn' : undefined}>
          {on ? 'Labelled, but the delete protection policy is not enforced: nothing stops a delete. ' : 'Needs the delete protection policy, not installed in this datacenter. '}
          <Box component={RouterLink} to={hrefFor('settings', 'protection')} sx={{ color: t.accent }}>
            How to install it
          </Box>
        </Help>
      ) : (
        <Help>Like Proxmox&apos;s Protection: deleting the VM or its disks is refused, for everyone.</Help>
      )}
    </Row>
  );
}

/** A preference by its display name, with its name (several share a display name: desktop, DPDK…). */
function PrefLabel({ p, unmet }: { p: Obj; unmet?: string }) {
  const display = p.metadata.annotations?.['openshift.io/display-name'];
  return (
    <Box component="span" sx={{ display: 'inline-flex', gap: 1, alignItems: 'baseline' }}>
      {display ?? p.metadata.name}
      {display && (
        <Box component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
          {p.metadata.name}
        </Box>
      )}
      {unmet && (
        <Box component="span" sx={{ fontSize: 12, color: '#B7791F' }}>
          {unmet}
        </Box>
      )}
    </Box>
  );
}

/** What a preference requires that the VM lacks (KubeVirt refuses the change otherwise). */
function prefUnmet(p: Obj, vcpus: number, memBytes: number): string | undefined {
  const r = p.spec?.requirements ?? {};
  const out: string[] = [];
  if (r.cpu?.guest && vcpus < r.cpu.guest) out.push(`${r.cpu.guest} vCPU`);
  const m = parseQuantity(r.memory?.guest);
  if (isFinite(m) && memBytes < m) out.push(formatBytes(m));
  return out.length ? `needs ${out.join(' and ')}` : undefined;
}

export function OptionsPanel({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const folder = useFolderFlavors();
  const k4 = useK4allMetadata();
  const vmi = d.idx.vmi.get(key(vm));
  const running = powerState(vm, vmi).kind !== 'off';
  const hw = hardware(vm, vmi, d.instancetypes);
  const paused = O.startPaused(vm);
  const clock = O.clockOf(vm);
  const tablet = O.tabletOf(vm);
  const acpi = O.acpiOf(vm);
  const smb = O.smbiosOf(vm);
  const pref = vm.spec?.preference as { kind?: string; name: string } | undefined;
  const ns = vm.metadata.namespace as string;
  const nsPrefs = folder.preferences.filter(p => p.metadata.namespace === ns);
  const prefValue = pref ? `${pref.kind ?? KIND_PREF}/${pref.name}` : '';
  const setAcpi = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({
        title: 'Turn ACPI off?',
        body: <p>The guest gets no power button: &quot;Shut down guest&quot; and graceful restarts stop working, only power off does. Very old guests may need it off; most need it on.</p>,
        confirm: 'Turn off',
        danger: true,
      });
      if (!ok) return;
    }
    quiet(saveVm(vm, on ? 'Turn ACPI on' : 'Turn ACPI off', O.setAcpi(vm, on)));
  };
  const assetWarning = k4.on ? chassisAssetWarning(smb.chassis.asset, vm, k4.metadata) : null;
  const smbText = [smb.uuid && `UUID ${smb.uuid}`, smb.serial && `serial ${smb.serial}`, ...O.CHASSIS_FIELDS.filter(f => smb.chassis[f.key]).map(f => `${f.label.toLowerCase()} ${smb.chassis[f.key]}`)].filter(Boolean).join(', ');
  return (
    <Panel title="Options" icon="mdi:cog-outline" actions={<Later running={running} />}>
      <ProtectionRow vm={vm} />
      <Row
        label="Start paused"
        align="flex-start"
        action={<Switch checked={paused} onChange={e => quiet(saveVm(vm, e.target.checked ? 'Start paused' : 'Start running', O.setStartPaused(vm, e.target.checked)))} inputProps={{ 'aria-label': 'Start paused' }} />}
      >
        {paused ? 'On: power-on leaves the VM suspended' : 'Off'}
        <Help>Useful to attach the console before the guest boots: power on, open the console, then resume.</Help>
      </Row>
      <Row label="Clock" action={<IconAction icon="mdi:pencil-outline" label="Change the guest clock" onClick={() => openDialog(close => <ClockDialog vm={vm} onClose={close} />)} />}>
        {clockText(clock)}
      </Row>
      <Row
        label="Pointer"
        align="flex-start"
        action={<Switch checked={tablet} onChange={e => quiet(saveVm(vm, e.target.checked ? 'Use a tablet pointer' : 'Use a relative mouse', O.setTablet(vm, e.target.checked)))} inputProps={{ 'aria-label': 'Tablet pointer' }} />}
      >
        {tablet ? 'USB tablet: the console pointer follows the mouse' : 'Relative mouse: the console pointer may lag'}
      </Row>
      <Row label="ACPI" align="flex-start" action={<Switch checked={acpi} onChange={e => setAcpi(e.target.checked)} inputProps={{ 'aria-label': 'ACPI' }} />}>
        {acpi ? 'On' : 'Off: the guest cannot be shut down gracefully'}
      </Row>
      <Row label="SMBIOS" action={<IconAction icon="mdi:pencil-outline" label="Edit SMBIOS" onClick={() => openDialog(close => <SmbiosDialog vm={vm} onClose={close} />)} />}>
        <Box sx={{ overflowWrap: 'anywhere' }}>{smbText || 'KubeVirt defaults'}</Box>
        {assetWarning && <Box sx={{ fontSize: 12.5, color: '#B7791F', mt: 0.5 }}>{assetWarning}</Box>}
      </Row>
      <Row label="Guest OS tuning">
        <TextField
          select
          size="small"
          fullWidth
          value={prefValue}
          onChange={e => {
            const v = e.target.value;
            const [kind, name] = v.split('/');
            quiet(saveVm(vm, 'Change guest OS tuning', O.setPreference(vm, v ? { kind, name } : null)));
          }}
          SelectProps={{ displayEmpty: true, MenuProps: { PaperProps: { sx: { maxHeight: 420 } } } }}
          inputProps={{ 'aria-label': 'Guest OS tuning' }}
        >
          <MenuItem value="">None (KubeVirt defaults)</MenuItem>
          {nsPrefs.length > 0 && <ListSubheader>This folder</ListSubheader>}
          {nsPrefs.map(p => (
            <MenuItem key={`ns/${p.metadata.name}`} value={`${KIND_PREF_NS}/${p.metadata.name}`} disabled={!!prefUnmet(p, hw.vcpus, hw.memoryBytes)}>
              <PrefLabel p={p} unmet={prefUnmet(p, hw.vcpus, hw.memoryBytes)} />
            </MenuItem>
          ))}
          <ListSubheader>Datacenter</ListSubheader>
          {d.preferences.map(p => (
            <MenuItem key={p.metadata.name} value={`${KIND_PREF}/${p.metadata.name}`} disabled={!!prefUnmet(p, hw.vcpus, hw.memoryBytes)}>
              <PrefLabel p={p} unmet={prefUnmet(p, hw.vcpus, hw.memoryBytes)} />
            </MenuItem>
          ))}
          {pref && !d.preferences.some(p => p.metadata.name === pref.name) && !nsPrefs.some(p => p.metadata.name === pref.name) && (
            <MenuItem value={prefValue}>{pref.name} (not found)</MenuItem>
          )}
        </TextField>
        <Help>Devices and settings tuned for the guest OS (bus types, clock, Hyper-V for Windows). Applies at the next power-on.</Help>
      </Row>
      <Box sx={{ pt: 1, borderTop: `1px solid ${t.rule}` }}>
        <NotInKubevirt>
          Not in KubeVirt: start and shutdown order and delays between VMs (each VM has its own power policy), KVM on or off per VM (always on), hibernation to a
          state disk (suspend keeps the VM in memory).
        </NotInKubevirt>
      </Box>
      {k8s && (
        <Box sx={{ mt: 1, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          <K8sName>{PROTECTED_LABEL}</K8sName>
          <K8sName>startStrategy</K8sName>
          <K8sName>domain.clock</K8sName>
          <K8sName>devices.inputs</K8sName>
          <K8sName>features.acpi</K8sName>
          <K8sName>firmware.uuid/serial, domain.chassis</K8sName>
          <K8sName>spec.preference</K8sName>
        </Box>
      )}
    </Panel>
  );
}
