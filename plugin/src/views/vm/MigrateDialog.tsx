/*
 * Migrate a VM, like vMotion: every host with its verdict and the reason.
 * Live when KubeVirt can move it while it runs (shared disks, compatible
 * CPU, no host devices); otherwise "powered off": the guest shuts down and
 * starts again on the chosen host. A powered-off VM is just placed.
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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { coldMove } from '../../api/move';
import { hostState } from '../../model/inventory';
import { cpuVendor, deviceLabel, hostModel, HostVerdict, localityLabel } from '../../model/placement';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { key, powerState } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { openDialog } from '../../ui/dialogs';
import { K8sName, Tag } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { MoveDiskDialog } from './MoveDiskDialog';
import { useVmPlacement } from './useVmPlacement';

type Mode = 'live' | 'cold';

export function MigrateDialog({ vm, onClose }: { vm: Obj; data?: HangarData; onClose: () => void }) {
  const t = useTokens();
  const d = useHangar();
  const k8s = useK8s();
  const p = useVmPlacement(vm);
  const vmi = d.idx.vmi.get(key(vm));
  const power = powerState(d.idx.vm.get(key(vm)) ?? vm, vmi);
  const others = p.hosts.filter(h => !h.current);
  const anyLive = others.some(h => h.live.ok);
  const anyCold = others.some(h => h.cold.ok);
  const [mode, setMode] = React.useState<Mode>(p.running && (anyLive || !anyCold) ? 'live' : 'cold');
  const [keepPin, setKeepPin] = React.useState(false);
  const [choice, setChoice] = React.useState<string>(p.running && anyLive ? '' : others.find(h => h.cold.ok)?.host ?? '');
  const verdict = (h: HostVerdict) => (mode === 'live' ? h.live : h.cold);
  const usable = others.filter(h => verdict(h).ok);
  const chosen = others.find(h => h.host === choice);
  const canGo = mode === 'live' ? (choice ? !!chosen?.live.ok : anyLive) : !!chosen?.cold.ok;
  const localDisks = p.disks.filter(x => x.locality.kind === 'local');
  const canMoveDisks = p.disks.some(x => x.claim);

  const go = () => {
    if (mode === 'live') A.migrate(vm, { host: choice || undefined }).catch(() => undefined);
    else if (chosen) coldMove(vm, chosen.host, { running: p.running, keepPin }).catch(() => undefined);
    onClose();
  };
  const openDisks = () => {
    onClose();
    openDialog(close => <MoveDiskDialog vm={vm} onClose={close} />);
  };

  const row = (value: string, title: React.ReactNode, sub: React.ReactNode, ok: boolean, current = false) => (
    <Box
      component="label"
      key={value || 'auto'}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        px: 1,
        py: 0.75,
        borderRadius: 1,
        cursor: ok ? 'pointer' : 'default',
        background: choice === value && ok ? t.selected : 'transparent',
        borderTop: `1px solid ${t.rule}`,
      }}
    >
      <Radio size="small" checked={choice === value && ok} disabled={!ok} onChange={() => setChoice(value)} sx={{ mt: -0.5 }} inputProps={{ 'aria-label': typeof title === 'string' ? title : value || 'Let the cluster choose' }} />
      <Box sx={{ minWidth: 0, flex: 1, opacity: ok || current ? 1 : 0.85 }}>
        <Box sx={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>{title}</Box>
        <Box sx={{ fontSize: 12.5, color: t.muted, ...tabular }}>{sub}</Box>
      </Box>
    </Box>
  );

  const hostLine = (h: HostVerdict) => {
    const v = verdict(h);
    const st = hostState(h.node);
    const cpu = [cpuVendor(h.node), hostModel(h.node)].filter(Boolean).join(' ');
    const facts = [
      `${formatBytes(Math.max(0, h.memFree))} memory free`,
      cpu ? `CPU ${cpu}` : '',
      ...h.devices.map(x => `${x.free} of ${x.total} ${deviceLabel(x.resource)} free`),
    ].filter(Boolean);
    return row(
      h.host,
      <>
        <Led tone={h.current ? st.tone : v.ok ? st.tone : 'off'} />
        <b style={{ fontWeight: 600 }}>{h.host}</b>
        {h.current ? <Tag>runs here</Tag> : v.ok ? <Tag tone="accent">{mode === 'live' ? 'can take it live' : 'can take it'}</Tag> : null}
      </>,
      <>
        {!h.current && !v.ok && (
          <Box component="span" sx={{ display: 'block', color: '#B7791F' }}>
            {v.reasons[0]}
            {v.reasons.length > 1 && <span title={v.reasons.slice(1).join('\n')}> (+{v.reasons.length - 1} more)</span>}
          </Box>
        )}
        {facts.join(', ')}
      </>,
      !h.current && v.ok,
      h.current
    );
  };

  const title = p.running ? `Migrate ${vm.metadata.name}` : `Move ${vm.metadata.name}`;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-migrate-title">
      <DialogTitle id="hangar-migrate-title" sx={{ fontSize: 18 }}>
        {title}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14, mb: 1.5, flexWrap: 'wrap' }}>
          <Led tone={power.tone} />
          {p.source ? (
            <span>
              Runs on <b>{p.source}</b>
            </span>
          ) : (
            power.label
          )}
          <Box sx={{ flex: 1 }} />
          {p.running && (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={mode}
              onChange={(_, v) => {
                if (!v) return;
                setMode(v);
                setChoice(v === 'live' ? '' : others.find(h => h.cold.ok)?.host ?? '');
              }}
              aria-label="How to move"
            >
              <ToggleButton value="live" sx={{ textTransform: 'none', px: 1.5 }}>
                <Icon icon="mdi:transit-transfer" width={16} style={{ marginRight: 6 }} />
                While running
              </ToggleButton>
              <ToggleButton value="cold" sx={{ textTransform: 'none', px: 1.5 }}>
                <Icon icon="mdi:power" width={16} style={{ marginRight: 6 }} />
                Powered off
              </ToggleButton>
            </ToggleButtonGroup>
          )}
        </Box>

        {mode === 'live' && p.running && (
          <Typography sx={{ fontSize: 13.5, mb: 1.5, color: t.muted }}>
            The VM keeps running while its memory is copied to the other host; the guest pauses for a moment at the end.
          </Typography>
        )}
        {mode === 'cold' && (
          <Typography sx={{ fontSize: 13.5, mb: 1.5, color: t.muted }}>
            {p.running
              ? 'The guest shuts down and the VM starts again on the host you pick. It is down for about a restart.'
              : 'The VM is pinned to the host you pick and starts there when you power it on; Configure → Policies lifts the pin.'}
          </Typography>
        )}

        {mode === 'live' && p.running && !p.live.ok && (
          <Box sx={{ p: 1.5, mb: 1.5, borderRadius: 1, border: '1px solid #E8A33D', fontSize: 13.5, display: 'grid', gap: 1 }}>
            <Box>
              <b>It cannot move while running.</b> {p.live.why}
              {k8s && p.live.reason && <K8sName> LiveMigratable: {p.live.reason}</K8sName>}
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {anyCold && (
                <Button size="small" variant="outlined" onClick={() => { setMode('cold'); setChoice(others.find(h => h.cold.ok)?.host ?? ''); }} sx={{ textTransform: 'none' }}>
                  Move it powered off instead
                </Button>
              )}
              {p.live.reason === 'DisksNotLiveMigratable' && canMoveDisks && (
                <Button size="small" variant="outlined" onClick={openDisks} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:database-arrow-right-outline" width={16} />}>
                  Move its disks to shared storage…
                </Button>
              )}
            </Box>
          </Box>
        )}

        <Box sx={{ borderBottom: `1px solid ${t.rule}` }}>
          {mode === 'live' && p.running && row('', 'Let the cluster choose', `${usable.length} of ${others.length} host${others.length === 1 ? '' : 's'} can take it live`, anyLive)}
          {p.hosts.map(hostLine)}
        </Box>
        {others.length === 0 && (
          <Typography sx={{ fontSize: 14, color: t.muted, mt: 1 }}>This datacenter has one host: there is nowhere to move to.</Typography>
        )}

        <Box sx={{ mt: 2, fontSize: 13 }}>
          <Box sx={{ fontWeight: 600, mb: 0.5 }}>Disks</Box>
          {p.disks.filter(x => x.locality.kind !== 'none').length === 0 && <Box sx={{ color: t.muted }}>No disks on a datastore: they go with the VM.</Box>}
          {p.disks
            .filter(x => x.locality.kind !== 'none')
            .map(x => (
              <Box key={x.name} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', ...tabular }}>
                <Icon icon={x.locality.kind === 'shared' ? 'mdi:database-sync-outline' : x.locality.kind === 'local' ? 'mdi:harddisk' : 'mdi:database-outline'} width={15} style={{ alignSelf: 'center', color: t.muted }} />
                <span>{x.name}</span>
                <Box component="span" sx={{ color: t.muted }}>
                  {x.datastore ? `${x.datastore}, ` : ''}
                  {localityLabel(x.locality, d.nodes.length)}
                </Box>
              </Box>
            ))}
          {localDisks.length > 0 && canMoveDisks && (
            <Button size="small" onClick={openDisks} sx={{ textTransform: 'none', mt: 0.5, px: 0 }} startIcon={<Icon icon="mdi:database-arrow-right-outline" width={16} />}>
              Move disks to another datastore…
            </Button>
          )}
        </Box>
        {mode === 'cold' && p.running && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox size="small" checked={keepPin} onChange={e => setKeepPin(e.target.checked)} />}
            label={<Typography sx={{ fontSize: 13.5 }}>Keep it on {chosen?.host ?? 'that host'} (pin it; Configure → Policies lifts the pin)</Typography>}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={go} disabled={!canGo}>
          {mode === 'live' ? 'Migrate' : p.running ? 'Move powered off' : 'Place it there'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
