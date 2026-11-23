/*
 * Maintenance mode for a host: the plan first (which running VMs leave
 * while running, where they can go, which cannot move and why), then the
 * host is cordoned and the movable VMs are migrated away.
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
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { last, useMetrics } from '../../api/metrics';
import { coldMove, usePodMemoryRequests } from '../../api/move';
import { evacuationPlan } from '../../model/placement';
import { Obj } from '../../model/types';
import { key } from '../../model/vm';
import { openDialog } from '../../ui/dialogs';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { MigrateDialog } from '../vm/MigrateDialog';

export function useEvacuationPlan(host: string) {
  const d = useHangar();
  const m = useMetrics();
  const podMemRequests = usePodMemoryRequests();
  const memUsed = new Map<string, number>();
  for (const n of d.nodes) {
    const u = last(m.hosts.get(n.metadata.name));
    if (u) memUsed.set(n.metadata.name, u.mem);
  }
  return evacuationPlan(host, d.vms, d.idx.vmi, {
    nodes: d.nodes,
    launchers: d.launchers,
    pvcs: d.idx.pvc,
    pvs: d.idx.pv,
    instancetypes: d.instancetypes,
    memUsed,
    podMemRequests,
    clusterCpuModel: d.kubevirt?.spec?.configuration?.cpuModel,
  });
}

export function openMaintenance(host: string) {
  openDialog(close => <MaintenanceDialog host={host} onClose={close} />);
}

function MaintenanceDialog({ host, onClose }: { host: string; onClose: () => void }) {
  const t = useTokens();
  const d: HangarData = useHangar();
  const plan = useEvacuationPlan(host);
  const others = d.nodes.filter(n => n.metadata.name !== host && !n.spec?.unschedulable);
  const moving = plan.filter(r => r.live);
  const stuck = plan.filter(r => !r.live);
  const coldable = stuck.filter(r => r.coldTargets.length);
  const [cold, setCold] = React.useState(false);
  const go = () => {
    A.enterMaintenance(
      host,
      plan.map(r => ({ namespace: r.vm.metadata.namespace as string, name: r.vm.metadata.name, migratable: r.live }))
    )
      .then(() => {
        if (cold) for (const r of coldable) coldMove(r.vm, r.coldTargets[0], { running: true }).catch(() => undefined);
      })
      .catch(() => undefined);
    onClose();
  };
  const vmRow = (vm: Obj, right: React.ReactNode, action?: React.ReactNode) => (
    <Box key={key(vm)} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', py: 0.5, borderTop: `1px solid ${t.rule}`, fontSize: 13.5, ...tabular }}>
      <Box sx={{ fontWeight: 600, minWidth: 120 }}>{vm.metadata.name}</Box>
      <Box sx={{ color: t.muted, flex: 1, minWidth: 0 }}>{right}</Box>
      {action}
    </Box>
  );
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-maint-title">
      <DialogTitle id="hangar-maint-title" sx={{ fontSize: 18 }}>
        Put {host} in maintenance mode?
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 14, mb: 1.5 }}>No new VM starts on this host.{others.length === 0 ? ' There is no other host: its VMs keep running here.' : ''}</Typography>
        {others.length > 0 && moving.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ fontWeight: 600, fontSize: 13.5, mb: 0.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Icon icon="mdi:transit-transfer" width={16} /> Move to other hosts while running ({moving.length})
            </Box>
            {moving.map(r => vmRow(r.vm, r.targets.length === 1 ? `to ${r.targets[0]}` : `to one of ${r.targets.length} hosts`))}
          </Box>
        )}
        {others.length > 0 && stuck.length > 0 && (
          <Box sx={{ mb: 1 }}>
            <Box sx={{ fontWeight: 600, fontSize: 13.5, mb: 0.5, display: 'flex', alignItems: 'center', gap: 0.75, color: '#B7791F' }}>
              <Icon icon="mdi:alert-outline" width={16} /> Stay until you shut them down or move them powered off ({stuck.length})
            </Box>
            {stuck.map(r =>
              vmRow(
                r.vm,
                r.why,
                <Button size="small" onClick={() => openDialog(close => <MigrateDialog vm={r.vm} onClose={close} />)} sx={{ textTransform: 'none', flex: 'none' }}>
                  Migrate…
                </Button>
              )
            )}
          </Box>
        )}
        {others.length > 0 && coldable.length > 0 && (
          <FormControlLabel
            sx={{ mt: 0.5 }}
            control={<Checkbox size="small" checked={cold} onChange={e => setCold(e.target.checked)} />}
            label={
              <Typography sx={{ fontSize: 13.5 }}>
                Also move {coldable.length === stuck.length ? 'them' : `${coldable.map(r => r.vm.metadata.name).join(', ')}`} powered off (each shuts down and
                starts on another host)
              </Typography>
            }
          />
        )}
        {plan.length === 0 && <Typography sx={{ fontSize: 13.5, color: t.muted }}>No VM runs on this host.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={go}>
          Enter maintenance mode
        </Button>
      </DialogActions>
    </Dialog>
  );
}
