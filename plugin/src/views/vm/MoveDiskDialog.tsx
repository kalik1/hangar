/*
 * Move a VM's disks to another datastore (storage migration). Live when
 * the VM runs and another host can take it (KubeVirt copies the disks while
 * it migrates the VM); powered off otherwise (a copy, then the VM uses it:
 * a running VM is shut down for it and started again). The typical move:
 * from disks local to one host to shared storage, after which the VM can
 * move between hosts live.
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
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData, useHangar } from '../../api/data';
import { diskNames, moveDisks, putOldDisksBack } from '../../api/move';
import { datastores } from '../../model/capacity';
import { diskMoveMode, StuckDiskMove, stuckDiskMove } from '../../model/move';
import { liveGate, localityLabel, preferredDatastore, storageLiveMigratable, vmDiskPlaces } from '../../model/placement';
import { claimSize } from '../../model/storage';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { key, powerState } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { confirm } from '../../ui/dialogs';
import { K8sName } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { datastoreItems, renderDatastore } from '../storage/DatastorePick';
import { useVmPlacement } from './useVmPlacement';

/** KubeVirt's settings that live disk moves need: LiveUpdate rollout (the default) and the LiveMigrate workload update method. */
export function liveDiskMovesEnabled(kubevirt: Obj | null): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const rollout = kubevirt?.spec?.configuration?.vmRolloutStrategy;
  // Unset means LiveUpdate since KubeVirt 1.5.
  if (rollout && rollout !== 'LiveUpdate') missing.push('configuration.vmRolloutStrategy: LiveUpdate');
  const methods: string[] = kubevirt?.spec?.workloadUpdateStrategy?.workloadUpdateMethods ?? [];
  if (!methods.includes('LiveMigrate')) missing.push('workloadUpdateStrategy.workloadUpdateMethods: [LiveMigrate]');
  return { ok: missing.length === 0, missing };
}

export function MoveDiskDialog({ vm, onClose, only }: { vm: Obj; onClose: () => void; only?: string }) {
  const t = useTokens();
  const d = useHangar();
  const k8s = useK8s();
  const live = d.idx.vm.get(key(vm)) ?? vm;
  const vmi = d.idx.vmi.get(key(vm)) ?? null;
  const power = powerState(live, vmi);
  const ns = vm.metadata.namespace as string;
  const places = vmDiskPlaces(live, d.idx.pvc, d.idx.pv, d.nodes).filter(x => x.claim);
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  const hosts = d.nodes.length;
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(places.filter(x => (only ? x.name === only : x.locality.kind !== 'shared')).map(x => x.name)));
  const firstOther = preferredDatastore(
    ds.filter(x => !places.some(p => selected.has(p.name) && p.datastore === x.name)),
    Math.max(hosts, 2)
  );
  const [target, setTarget] = React.useState<string>(firstOther?.name ?? '');
  const [deleteOld, setDeleteOld] = React.useState(true);

  const kv = liveDiskMovesEnabled(d.kubevirt);
  const verdicts = useVmPlacement(vm);
  const how = diskMoveMode({
    power: power.kind,
    powerLabel: power.label,
    storageLive: storageLiveMigratable(vmi),
    liveReason: liveGate(vmi).reason,
    kubevirtMissing: kv.missing,
    hosts: verdicts.hosts,
  });
  const mode = how.mode;
  const restart = how.mode === 'offline' && how.restart;

  const rows = places.map(p => {
    const pvc = d.idx.pvc.get(`${ns}/${p.claim}`);
    const dv = d.idx.dv.get(`${ns}/${p.claim}`);
    return { ...p, size: claimSize(pvc, dv) };
  });
  const chosen = rows.filter(r => selected.has(r.name));
  const tgt = ds.find(x => x.name === target);
  const same = chosen.filter(r => r.datastore === target);
  const need = chosen.reduce((s, r) => s + r.size, 0);
  const space = tgt?.freeBytes !== undefined && tgt.freeBytes < need ? `${target} reports ${formatBytes(tgt.freeBytes)} free, the disks need ${formatBytes(need)}` : '';
  const ok = mode !== 'blocked' && chosen.length > 0 && !!tgt && same.length === 0 && !space;

  const go = () => {
    const { taken, roots } = diskNames(ns, d.pvcs, d.dvs);
    moveDisks({
      vm: live,
      moves: chosen.map(r => ({ volume: r.name, claim: r.claim as string, datastore: target, sizeBytes: r.size })),
      live: mode === 'live',
      restart,
      deleteOld,
      taken,
      roots,
    }).catch(() => undefined);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-movedisk-title">
      <DialogTitle id="hangar-movedisk-title" sx={{ fontSize: 18 }}>
        Move disks of {vm.metadata.name}
      </DialogTitle>
      <DialogContent>
        {restart && how.why && (
          <Typography sx={{ fontSize: 13.5, mb: 1 }}>
            <b>It cannot move its disks while running.</b> {how.why}
          </Typography>
        )}
        <Typography sx={{ fontSize: 13.5, color: t.muted, mb: 1.5 }}>
          {how.mode === 'live'
            ? `The VM keeps running: KubeVirt copies the disks to the new datastore while it moves the VM to ${how.targets.length === 1 ? how.targets[0] : 'another host'}, then the VM uses them.`
            : how.mode === 'offline'
            ? how.restart
              ? 'Hangar shuts the guest down, copies the disks to the new datastore, and starts the VM again on the copies. It is down while the disks are copied.'
              : 'Hangar copies the disks to the new datastore; the VM uses the copies once they are complete. Keep it powered off meanwhile.'
            : how.why}
        </Typography>
        {k8s && restart && kv.missing.length > 0 && <K8sName>KubeVirt CR needs {kv.missing.join(', ')}</K8sName>}

        <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: 1, mb: 2 }}>
          {rows.length === 0 && <Box sx={{ p: 1.5, color: t.muted, fontSize: 13.5 }}>This VM has no disks on a datastore.</Box>}
          {rows.map(r => (
            <Box key={r.name} component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 0 }, cursor: 'pointer' }}>
              <Checkbox
                size="small"
                checked={selected.has(r.name)}
                onChange={e => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(r.name);
                  else next.delete(r.name);
                  setSelected(next);
                }}
                inputProps={{ 'aria-label': `Move ${r.name}` }}
              />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ fontSize: 14, fontWeight: 600 }}>{r.name}</Box>
                <Box sx={{ fontSize: 12.5, color: t.muted, ...tabular }}>
                  {formatBytes(r.size)} on {r.datastore ?? '—'}, {lowerFirst(localityLabel(r.locality, hosts))}
                  {k8s && <K8sName> {r.claim}</K8sName>}
                </Box>
              </Box>
            </Box>
          ))}
        </Box>

        <TextField
          select
          fullWidth
          size="small"
          label="Move to datastore"
          value={target}
          onChange={e => setTarget(e.target.value)}
          SelectProps={{ renderValue: renderDatastore(ds, Math.max(hosts, 2)) }}
        >
          {datastoreItems(ds, Math.max(hosts, 2), t)}
        </TextField>
        {same.length > 0 && <Typography sx={{ color: '#B7791F', fontSize: 13, mt: 0.75 }}>{same.map(r => r.name).join(', ')} already {same.length === 1 ? 'is' : 'are'} on {target}.</Typography>}
        {space && <Typography sx={{ color: '#B7791F', fontSize: 13, mt: 0.75 }}>{space}.</Typography>}
        {tgt && !tgt.shared && hosts > 1 && (
          <Typography sx={{ color: t.muted, fontSize: 12.5, mt: 0.75 }}>
            <Icon icon="mdi:information-outline" width={14} style={{ verticalAlign: '-2px' }} /> On {target} the VM still cannot move between hosts while running.
          </Typography>
        )}
        <FormControlLabel
          sx={{ mt: 1 }}
          control={<Checkbox size="small" checked={deleteOld} onChange={e => setDeleteOld(e.target.checked)} />}
          label={<Typography sx={{ fontSize: 13.5 }}>Delete the old disks when the move is done</Typography>}
        />
        {deleteOld && (
          <Typography sx={{ fontSize: 12.5, color: t.muted, ml: 4 }}>Hangar deletes them while this page stays open; otherwise they stay as unattached disks in Storage.</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={go} disabled={!ok}>
          {mode === 'live' ? 'Move while running' : restart ? 'Shut down and move' : 'Move disks'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

/** A live disk move of the VM that cannot end (left by Hangar 0.1.x), or null. */
export function stuckMoveOf(vm: Obj, d: HangarData): StuckDiskMove | null {
  return stuckDiskMove(vm, d.idx.vmi.get(key(vm)), d.idx.migrations.get(key(vm)) ?? []);
}

/** "Put the old disk back": asks, then reverts the move; the new, blank disks go unless kept. */
export async function confirmPutOldDisksBack(vm: Obj, stuck: StuckDiskMove, d: HangarData) {
  const one = stuck.volumes.length === 1;
  const r = await confirm({
    title: `Put the old disk${one ? '' : 's'} of ${vm.metadata.name} back?`,
    body: (
      <>
        <p>
          The move to the new disk{one ? '' : 's'} cannot end: KubeVirt copies the disks of a running VM while it moves it to another host, and no host can take it.
          Meanwhile the VM names {one ? 'a new disk that is' : 'new disks that are'} still empty, while the guest runs on the old {one ? 'one' : 'ones'}: a restart now
          would start from the empty disk{one ? '' : 's'}.
        </p>
        <p>
          {stuck.volumes.map(v => `${v.volume}: back to ${v.oldClaim} (instead of ${v.newClaim})`).join('; ')}. KubeVirt then calls the copy off
          {stuck.migrations.length ? `, and Hangar deletes its waiting migration${stuck.migrations.length === 1 ? '' : 's'}` : ''}. The guest keeps running.
        </p>
        <p>To move the disks, use Move disks again: it shuts the VM down when it cannot copy them while it runs.</p>
      </>
    ),
    confirm: 'Put back',
    option: { label: `Delete the new disk${one ? '' : 's'} (${stuck.volumes.map(v => v.newClaim).join(', ')})`, help: 'Nothing was copied to them.', initial: true },
  });
  if (r) putOldDisksBack(vm, stuck, d.idx.dv, { deleteNew: r.option }).catch(() => undefined);
}
