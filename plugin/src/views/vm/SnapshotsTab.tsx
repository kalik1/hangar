/*
 * A VM's snapshots as a timeline, newest first, with the reverts between
 * them: what each holds, how consistent it is, revert and delete. When the
 * cluster cannot take snapshots, it says exactly what is missing.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { deleteRevert, deleteSnapshot } from '../../api/snapshots';
import { CONSISTENCY_LABELS, diskCoverage, SnapshotView, timeline, TimelineEntry } from '../../model/snapshots';
import { Obj } from '../../model/types';
import { formatAge, formatBytes } from '../../model/units';
import { key, powerState } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { Empty, IconAction, K8sName, Panel, Tag } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { LedTone, tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';
import { consistencyNow, MissingList, openTakeSnapshot, RevertDialog, useSnapshotSupport } from './SnapshotDialog';

export function SnapshotsTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const s = useSnapshotSupport(vm);
  const location = useLocation();
  const history = useHistory();
  const vmi = d.idx.vmi.get(key(vm));
  const p = powerState(vm, vmi);
  const entries = timeline(vm, d.snapshots, d.restores, d.volumeSnapshots);
  const snaps = entries.filter(e => e.kind === 'snapshot');
  const c = consistencyNow(vm, d);
  const cov = diskCoverage(vm);

  // "Take snapshot…" from a menu may land here with ?take=1.
  React.useEffect(() => {
    if (new URLSearchParams(location.search).get('take') === '1') {
      history.replace(location.pathname);
      openTakeSnapshot(vm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const take = (
    <Button
      size="small"
      variant="contained"
      sx={{ textTransform: 'none' }}
      startIcon={<Icon icon="mdi:camera-plus-outline" width={18} />}
      disabled={!s.ok}
      onClick={() => openTakeSnapshot(vm)}
    >
      Take snapshot
    </Button>
  );

  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 360px' }, alignItems: 'start' }}>
      <Panel title={`Snapshots (${snaps.length})`} icon="mdi:camera-outline" actions={take} dense>
        {entries.length === 0 ? (
          <Empty icon="mdi:camera-outline" title="No snapshots yet" action={s.ok ? take : undefined}>
            A snapshot saves the VM's disks and settings, so you can go back to that moment: take one before an upgrade or a risky
            change.
          </Empty>
        ) : (
          <Box component="ol" aria-label="Snapshot timeline" sx={{ listStyle: 'none', m: 0, p: 0, position: 'relative' }}>
            <Box aria-hidden sx={{ position: 'absolute', left: 27, top: 24, bottom: 24, width: '2px', background: t.rule }} />
            <NowItem label={p.label} tone={p.tone} />
            {entries.map(e =>
              e.kind === 'snapshot' ? <SnapItem key={e.snap.name} vm={vm} v={e.snap} /> : <RevertItem key={e.restore.metadata.name} vm={vm} e={e} />
            )}
          </Box>
        )}
      </Panel>
      <Box sx={{ display: 'grid', gap: 2 }}>
        {!s.ok && !s.checking && (
          <Panel title="Snapshots are not available" icon="mdi:alert-outline">
            <MissingList s={s} />
          </Panel>
        )}
        {s.ok && s.missing.length > 0 && (
          <Panel title="Some disks are left out" icon="mdi:alert-outline">
            <MissingList s={{ ...s, denied: undefined }} />
          </Panel>
        )}
        <Panel title="What a snapshot holds" icon="mdi:information-outline">
          <Box sx={{ display: 'grid', gap: 1.5, fontSize: 13.5 }}>
            <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', display: 'grid', gap: 0.5 }}>
              {cov.map(x => (
                <Box component="li" key={x.disk} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                  <Icon
                    icon={x.included ? 'mdi:check' : 'mdi:minus-circle-outline'}
                    width={16}
                    style={{ color: x.included ? '#2FBF71' : t.muted, flex: 'none', alignSelf: 'center' }}
                    aria-label={x.included ? 'Included' : 'Not included'}
                  />
                  <b>{x.disk}</b>
                  <Box component="span" sx={{ color: t.muted }}>
                    {x.included ? 'included' : x.reason}
                  </Box>
                </Box>
              ))}
            </Box>
            <Note tone={c.tone === 'warn' ? 'warn' : undefined}>{c.text}</Note>
            <Typography sx={{ fontSize: 13, color: t.muted }}>
              Disks and settings are saved, not the memory: after a revert the VM boots from the saved disks. Snapshots stay on the same
              datastore as the disks: they are not a backup.
            </Typography>
          </Box>
        </Panel>
      </Box>
    </Box>
  );
}

function Rail({ tone, icon, hollow }: { tone?: LedTone; icon?: string; hollow?: boolean }) {
  const t = useTokens();
  return (
    <Box sx={{ width: 56, flex: 'none', display: 'flex', justifyContent: 'center', pt: 0.4, position: 'relative', zIndex: 1 }}>
      {icon ? (
        <Box sx={{ width: 22, height: 22, borderRadius: '50%', background: t.surface, border: `2px solid ${t.rule}`, display: 'grid', placeItems: 'center' }}>
          <Icon icon={icon} width={13} style={{ color: t.muted }} />
        </Box>
      ) : (
        <Box sx={{ width: 22, height: 22, borderRadius: '50%', background: t.surface, display: 'grid', placeItems: 'center' }}>
          {hollow ? <Box sx={{ width: 12, height: 12, borderRadius: '50%', border: `2px solid ${t.accent}` }} /> : <Led tone={tone ?? 'on'} size={10} />}
        </Box>
      )}
    </Box>
  );
}

function NowItem({ label, tone }: { label: string; tone: LedTone }) {
  const t = useTokens();
  return (
    <Box component="li" sx={{ display: 'flex', py: 1.5, pr: 2, borderBottom: `1px solid ${t.rule}` }}>
      <Rail hollow />
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>Now</Typography>
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 13, color: t.muted }}>
            <Led tone={tone} size={8} /> {label}
          </Box>
        </Box>
        <Typography sx={{ fontSize: 13, color: t.muted }}>The current state of the VM. Changes since the last snapshot are not saved anywhere.</Typography>
      </Box>
    </Box>
  );
}

function SnapItem({ vm, v }: { vm: Obj; v: SnapshotView }) {
  const t = useTokens();
  const k8s = useK8s();
  const cons = CONSISTENCY_LABELS[v.consistency];
  const remove = async () => {
    const ok = await confirm({
      title: `Delete snapshot “${v.displayName}”?`,
      body: (
        <>
          <p>You can no longer revert {vm.metadata.name} to it.</p>
          <p>The VM and its disks do not change.</p>
        </>
      ),
      confirm: 'Delete snapshot',
      danger: true,
    });
    if (ok) deleteSnapshot(vm, v).catch(() => undefined);
  };
  return (
    <Box component="li" sx={{ display: 'flex', py: 1.5, pr: 1.5, borderBottom: `1px solid ${t.rule}`, '&:last-of-type': { borderBottom: 'none' } }}>
      <Rail tone={v.state.tone} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography component="h3" sx={{ fontWeight: 600, fontSize: 14.5 }}>
            {v.displayName}
          </Typography>
          {!v.ready && <Tag tone={v.state.tone === 'fault' ? 'warn' : 'muted'}>{v.state.label}</Tag>}
          {v.consistency !== 'unknown' && (
            <Box component="span" title={cons.help}>
              <Tag tone={v.consistency === 'crash' ? 'warn' : 'muted'}>{cons.label}</Tag>
            </Box>
          )}
          {v.online && v.consistency !== 'crash' && <Tag>Taken while running</Tag>}
        </Box>
        <Typography sx={{ fontSize: 13, color: t.muted, ...tabular }}>
          {v.created ? `${new Date(v.created).toLocaleString()}, ${formatAge(v.created)} ago` : '—'}
          {v.sizeBytes !== undefined ? ` · ${formatBytes(v.sizeBytes)} of disks` : ''}
          {v.included.length ? ` · ${v.included.join(', ')}` : ''}
          {v.excluded.length ? ` · without ${v.excluded.join(', ')}` : ''}
        </Typography>
        {v.description && <Typography sx={{ fontSize: 13.5, mt: 0.5, whiteSpace: 'pre-wrap' }}>{v.description}</Typography>}
        {v.error && <Typography sx={{ fontSize: 13, color: '#E5484D', mt: 0.5 }}>{v.error}</Typography>}
        {k8s && (
          <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            <K8sName>VirtualMachineSnapshot {v.name}</K8sName>
            {v.contentName && <K8sName>{v.contentName}</K8sName>}
            {v.volumeSnapshots.map(n => (
              <K8sName key={n}>VolumeSnapshot {n}</K8sName>
            ))}
          </Box>
        )}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, flex: 'none' }}>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          sx={{ textTransform: 'none' }}
          startIcon={<Icon icon="mdi:backup-restore" width={16} />}
          disabled={!v.ready}
          onClick={() => openDialog(close => <RevertDialog vm={vm} snap={v} onClose={close} />)}
          aria-label={`Revert to ${v.displayName}`}
        >
          Revert
        </Button>
        <IconAction icon="mdi:delete-outline" label={`Delete snapshot ${v.displayName}`} onClick={remove} />
      </Box>
    </Box>
  );
}

function RevertItem({ vm, e }: { vm: Obj; e: Extract<TimelineEntry, { kind: 'revert' }> }) {
  const t = useTokens();
  const k8s = useK8s();
  const d = useHangar();
  const snap = d.snapshots.find(s => s.metadata.namespace === e.restore.metadata.namespace && s.metadata.name === e.snapshot);
  const name = snap?.metadata.annotations?.['hangar.magesgate.com/display-name'] || e.snapshot;
  const state = e.failed ? 'Failed' : e.complete ? 'Done' : 'Reverting';
  return (
    <Box component="li" sx={{ display: 'flex', py: 1.25, pr: 2, borderBottom: `1px solid ${t.rule}`, '&:last-of-type': { borderBottom: 'none' } }}>
      <Rail icon="mdi:backup-restore" />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 13.5 }}>
          Reverted to <b>“{name}”</b>
          {!snap && <Box component="span" sx={{ color: t.muted }}> (snapshot deleted since)</Box>}
          {state !== 'Done' && (
            <Box component="span" sx={{ ml: 1 }}>
              <Tag tone={e.failed ? 'warn' : 'muted'}>{state}</Tag>
            </Box>
          )}
        </Typography>
        <Typography sx={{ fontSize: 13, color: t.muted, ...tabular }}>{e.time ? `${new Date(e.time).toLocaleString()}, ${formatAge(e.time)} ago` : '—'}</Typography>
        {e.failed && <Typography sx={{ fontSize: 13, color: '#E5484D' }}>{e.failed}</Typography>}
        {k8s && <K8sName>VirtualMachineRestore {e.restore.metadata.name}</K8sName>}
      </Box>
      <Box sx={{ flex: 1 }} />
      {(e.complete || e.failed) && (
        <IconAction icon="mdi:close" label={`Remove this revert from the history`} onClick={() => deleteRevert(vm, e.restore).catch(() => undefined)} />
      )}
    </Box>
  );
}
