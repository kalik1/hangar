/*
 * Take a snapshot of a VM, revert a VM to one, and what the cluster is
 * missing when it cannot. Used by the Snapshots tab and by the "Take
 * snapshot…" action of the VM menus (useTakeSnapshot).
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
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData, useHangar } from '../../api/data';
import { probeSnapshotGate, revertToSnapshot, takeSnapshot } from '../../api/snapshots';
import {
  defaultSnapshotLabel,
  diskCoverage,
  featureGate,
  GateState,
  revertInProgress,
  snapshotName,
  snapshotSupport,
  SnapshotView,
  Support,
} from '../../model/snapshots';
import { Obj } from '../../model/types';
import { formatAge } from '../../model/units';
import { guestAgent, key, powerState } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { openDialog } from '../../ui/dialogs';
import { K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';

export interface SnapshotSupportState extends Support {
  /** The feature gate check is still running. */
  checking: boolean;
  /** The user may not create snapshots here. */
  denied?: string;
}

/** What the cluster lacks for snapshots of this VM; probes the feature gate once a minute at most. */
export function useSnapshotSupport(vm: Obj): SnapshotSupportState {
  const d = useHangar();
  const vmApi = d.has.vmSnapshots ?? d.has.snapshots;
  const volApi = d.has.volumeSnapshots ?? d.has.snapshots;
  const written = featureGate(d.kubevirt, 'Snapshot');
  const [probe, setProbe] = React.useState<{ state: GateState; message?: string } | null>(null);
  const ns = vm.metadata.namespace;
  React.useEffect(() => {
    if (!vmApi || written === 'on') return;
    let alive = true;
    probeSnapshotGate(vm, d.cluster).then(r => alive && setProbe(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmApi, written, ns, d.cluster]);
  const gate: GateState = written === 'on' ? 'on' : probe?.state ?? 'unknown';
  const s = snapshotSupport({
    vmSnapshotApi: vmApi,
    volumeSnapshotApi: volApi,
    gate,
    gateMessage: probe?.state === 'off' ? probe.message : undefined,
    vm,
    pvcs: d.idx.pvc,
    storageClasses: d.storageClasses,
    snapshotClasses: d.snapshotClasses,
  });
  const denied = probe?.state === 'unknown' && /^Not allowed/.test(probe.message ?? '') ? 'Your role does not allow snapshots in this folder.' : undefined;
  return { ...s, ok: s.ok && !denied, checking: vmApi && written !== 'on' && !probe, denied };
}

export function MissingList({ s }: { s: SnapshotSupportState }) {
  const t = useTokens();
  return (
    <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', display: 'grid', gap: 1.25 }}>
      {s.denied && (
        <Box component="li" sx={{ fontSize: 14 }}>
          <b>{s.denied}</b>
        </Box>
      )}
      {s.missing.map(m => (
        <Box component="li" key={m.title} sx={{ display: 'flex', gap: 1 }}>
          <Icon icon="mdi:alert-outline" width={18} style={{ color: '#B7791F', flex: 'none', marginTop: 2 }} />
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{m.title}</Typography>
            <Typography sx={{ fontSize: 13, color: t.muted }}>{m.fix}</Typography>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** How consistent a snapshot taken now would be, in words. */
export function consistencyNow(vm: Obj, d: HangarData): { tone: 'ok' | 'warn'; text: string } {
  const vmi = d.idx.vmi.get(key(vm));
  const p = powerState(vm, vmi);
  if (p.kind === 'off') return { tone: 'ok', text: 'The VM is powered off: the snapshot is consistent.' };
  if (p.kind === 'paused')
    return { tone: 'warn', text: 'The VM is suspended: the snapshot is crash-consistent (the guest cannot flush its file systems while suspended).' };
  if (guestAgent(vmi))
    return { tone: 'ok', text: 'The guest agent freezes the file systems for a moment while the snapshot is taken: the snapshot is consistent.' };
  return {
    tone: 'warn',
    text: 'The VM runs without a guest agent: the snapshot is crash-consistent, like pulling the power cord. Install qemu-guest-agent in the guest, or shut it down first, for a clean snapshot.',
  };
}

function Coverage({ vm }: { vm: Obj }) {
  const t = useTokens();
  const cov = diskCoverage(vm);
  return (
    <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', display: 'grid', gap: 0.5, fontSize: 13.5 }}>
      {cov.map(c => (
        <Box component="li" key={c.disk} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
          <Icon
            icon={c.included ? 'mdi:check' : 'mdi:minus-circle-outline'}
            width={16}
            style={{ color: c.included ? '#2FBF71' : t.muted, flex: 'none', alignSelf: 'center' }}
            aria-label={c.included ? 'Included' : 'Not included'}
          />
          <b>{c.disk}</b>
          <Box component="span" sx={{ color: t.muted }}>
            {c.included ? 'included' : c.reason}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function SnapshotDialog({ vm, onClose }: { vm: Obj; onClose: () => void }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const s = useSnapshotSupport(vm);
  const [label, setLabel] = React.useState(() => defaultSnapshotLabel());
  const [desc, setDesc] = React.useState('');
  const taken = new Set(d.snapshots.filter(x => x.metadata.namespace === vm.metadata.namespace).map(x => x.metadata.name));
  const name = snapshotName(vm.metadata.name, label, taken);
  const c = consistencyNow(vm, d);
  const problem = label.trim() ? null : 'Give the snapshot a name.';
  const submit = () => {
    if (problem || !s.ok) return;
    takeSnapshot(vm, name, label.trim(), desc).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-snap-title">
      <DialogTitle id="hangar-snap-title" sx={{ fontSize: 18 }}>
        Take snapshot of {vm.metadata.name}
      </DialogTitle>
      <DialogContent>
        {!s.ok && !s.checking ? (
          <Box sx={{ display: 'grid', gap: 1.5, pt: 1 }}>
            <Typography sx={{ fontSize: 14 }}>This VM cannot have snapshots yet:</Typography>
            <MissingList s={s} />
          </Box>
        ) : (
          <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
            <Box>
              <TextField label="Name" size="small" fullWidth value={label} onChange={e => setLabel(e.target.value)} error={!!problem} helperText={problem ?? ' '} />
              {k8s && <K8sName>VirtualMachineSnapshot {vm.metadata.namespace}/{name}</K8sName>}
            </Box>
            <TextField label="Description" size="small" value={desc} onChange={e => setDesc(e.target.value)} multiline minRows={2} placeholder="Before the upgrade to…" />
            <Note
              tone={c.tone === 'warn' ? 'warn' : undefined}
              icon={<Icon icon={c.tone === 'warn' ? 'mdi:alert-outline' : 'mdi:check-circle-outline'} width={18} style={{ color: c.tone === 'warn' ? '#B7791F' : '#2FBF71', flex: 'none', marginTop: 1 }} />}
            >
              {c.text}
            </Note>
            <Box>
              <Typography sx={{ fontSize: 13, color: t.muted, mb: 0.75 }}>Disks in the snapshot</Typography>
              <Coverage vm={vm} />
            </Box>
            <Typography sx={{ fontSize: 13, color: t.muted }}>
              The disks and the VM settings are saved, not the memory: after a revert the VM boots from the saved disks.
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          {s.ok || s.checking ? 'Cancel' : 'Close'}
        </Button>
        {(s.ok || s.checking) && (
          <Button variant="contained" onClick={submit} disabled={!!problem || !s.ok}>
            {s.checking ? 'Checking…' : 'Take snapshot'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export function openTakeSnapshot(vm: Obj) {
  openDialog(close => <SnapshotDialog vm={vm} onClose={close} />);
}

export function RevertDialog({ vm, snap, onClose }: { vm: Obj; snap: SnapshotView; onClose: () => void }) {
  const d = useHangar();
  const t = useTokens();
  const live = d.idx.vm.get(key(vm)) ?? vm;
  const p = powerState(live, d.idx.vmi.get(key(vm)));
  const running = p.kind === 'on' || p.kind === 'paused';
  const busy = !running && p.kind !== 'off';
  const inProgress = revertInProgress(live, d.restores);
  const [stop, setStop] = React.useState<'shutdown' | 'force'>('shutdown');
  const [powerOn, setPowerOn] = React.useState(running);
  const [saveFirst, setSaveFirst] = React.useState(false);
  const excluded = diskCoverage(live).filter(c => !snap.included.includes(c.disk) && !c.config);
  const blocked = !snap.ready
    ? 'The snapshot is not ready.'
    : inProgress
    ? 'A revert of this VM is already running.'
    : busy
    ? `The VM is ${p.label.toLowerCase()}: wait until it is on or off.`
    : null;
  const submit = () => {
    if (blocked) return;
    const taken = new Set(d.snapshots.filter(x => x.metadata.namespace === vm.metadata.namespace).map(x => x.metadata.name));
    const label = `Before reverting to ${snap.displayName}`;
    revertToSnapshot(live, snap, {
      stop: running ? stop : undefined,
      powerOn,
      saveFirst: saveFirst ? { name: snapshotName(vm.metadata.name, `before-revert-${Date.now().toString(36)}`, taken), displayName: label } : undefined,
    }).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-revert-title">
      <DialogTitle id="hangar-revert-title" sx={{ fontSize: 18 }}>
        Revert {vm.metadata.name} to “{snap.displayName}”?
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 1.5, pt: 0.5, fontSize: 14, lineHeight: 1.55, '& p': { m: 0 } }}>
          <p>
            Taken {snap.created ? `${new Date(snap.created).toLocaleString()} (${formatAge(snap.created)} ago)` : 'at an unknown time'}.
          </p>
          <p>
            <b>Lost:</b> everything written to {snap.included.length === 1 ? `the disk ${snap.included[0]}` : `its disks (${snap.included.join(', ')})`} since then,
            and the VM settings changed since then (CPU, memory, devices, networks).
          </p>
          {excluded.length > 0 && (
            <p>
              <b>Not changed:</b> {excluded.map(e => e.disk).join(', ')}, not in the snapshot.
            </p>
          )}
          <p style={{ color: t.muted }}>The other snapshots stay: you can revert to any of them later.</p>
          {blocked ? (
            <Note tone="warn">{blocked}</Note>
          ) : (
            <>
              {running && (
                <Box>
                  <Typography id="hangar-revert-stop" sx={{ fontSize: 14, fontWeight: 600 }}>
                    The VM is {p.label.toLowerCase()}: it must be off to revert.
                  </Typography>
                  <RadioGroup aria-labelledby="hangar-revert-stop" value={stop} onChange={e => setStop(e.target.value as 'shutdown' | 'force')}>
                    <FormControlLabel value="shutdown" control={<Radio size="small" />} label="Shut down the guest first" />
                    <FormControlLabel value="force" control={<Radio size="small" />} label="Power off at once (unsaved data in the guest is lost)" />
                  </RadioGroup>
                </Box>
              )}
              <FormControlLabel
                control={<Checkbox checked={saveFirst} onChange={e => setSaveFirst(e.target.checked)} />}
                label="Take a snapshot of the current state first, to come back to it"
              />
              <FormControlLabel control={<Checkbox checked={powerOn} onChange={e => setPowerOn(e.target.checked)} />} label="Power on when the revert is done" />
            </>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" color="error" onClick={submit} disabled={!!blocked}>
          Revert
        </Button>
      </DialogActions>
    </Dialog>
  );
}
