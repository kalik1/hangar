/*
 * New datastore: a StorageClass made from an existing one of the same
 * driver, so its secrets and tuning come along. The user picks what makes
 * the new one different — the Ceph pool, the TopoLVM device class — and
 * the policies, in plain words; the YAML is one click away in Kubernetes
 * mode.
 */

import { EditorDialog } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
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
import { HangarData } from '../../api/data';
import { createDatastore, setDefaultDatastore } from '../../api/datastores';
import { datastoreNameProblem, isRbd, isTopolvm, NewDatastoreInput, storageClassFrom, topolvmDeviceClasses } from '../../model/datastoreSpec';
import { storageKind } from '../../model/storage';
import { Obj } from '../../model/types';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { cephUrl, useCephRoutes } from './cephLinks';
import { Note } from './parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

export function NewDatastoreDialog({ d, from, onClose }: { d: HangarData; from?: string; onClose: () => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const ceph = useCephRoutes();
  const bases = d.storageClasses;
  const [baseName, setBaseName] = React.useState(from ?? bases.find(s => isRbd(s))?.metadata.name ?? bases[0]?.metadata.name ?? '');
  const base = bases.find(s => s.metadata.name === baseName);
  const rbd = isRbd(base);
  const lvm = isTopolvm(base);
  const clusterNs = base?.parameters?.clusterID;
  const pools = d.cephPools.filter(p => !clusterNs || p.metadata.namespace === clusterNs);
  const deviceClasses = topolvmDeviceClasses(d.nodes);
  const taken = bases.map(s => s.metadata.name);

  const [name, setName] = React.useState('');
  const [pool, setPool] = React.useState('');
  const [deviceClass, setDeviceClass] = React.useState('');
  const [reclaim, setReclaim] = React.useState<'Delete' | 'Retain'>('Delete');
  const [expansion, setExpansion] = React.useState(true);
  const [binding, setBinding] = React.useState<'Immediate' | 'WaitForFirstConsumer'>('Immediate');
  const [description, setDescription] = React.useState('');
  const [makeDefault, setMakeDefault] = React.useState(false);
  const [yaml, setYaml] = React.useState(false);

  // Follow the base: its pool, device class and policies are the starting point.
  React.useEffect(() => {
    if (!base) return;
    setPool(base.parameters?.pool ?? pools[0]?.spec?.name ?? pools[0]?.metadata.name ?? '');
    setDeviceClass(base.parameters?.['topolvm.io/device-class'] ?? '');
    setReclaim(base.reclaimPolicy === 'Retain' ? 'Retain' : 'Delete');
    setExpansion(!!base.allowVolumeExpansion);
    setBinding(base.volumeBindingMode === 'WaitForFirstConsumer' ? 'WaitForFirstConsumer' : 'Immediate');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseName]);

  const nameProblem = name ? datastoreNameProblem(name, taken) : null;
  const ok = !!base && !!name && !nameProblem && (!rbd || !!pool);
  const input = (): NewDatastoreInput => ({
    name,
    base: base as Obj,
    pool: rbd ? pool : undefined,
    deviceClass: lvm ? deviceClass : undefined,
    reclaim,
    expansion,
    binding,
    description: description.trim() || undefined,
  });
  const create = (sc: Obj) => {
    const p = createDatastore(sc);
    if (makeDefault) quiet(p.then(() => setDefaultDatastore([...d.storageClasses, sc], sc.metadata.name)));
    quiet(p.then(() => d.refresh()));
    onClose();
  };
  const poolUrl = cephUrl(ceph.overview);

  return (
    <>
      <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-newds-title">
        <DialogTitle id="hangar-newds-title" sx={{ fontSize: 18 }}>
          New datastore
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
          <TextField
            select
            size="small"
            label="Same storage as"
            value={baseName}
            onChange={e => setBaseName(e.target.value)}
            helperText="The new datastore uses this one's storage driver and its connection settings."
          >
            {bases.map(s => (
              <MenuItem key={s.metadata.name} value={s.metadata.name}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                  <span>{s.metadata.name}</span>
                  <Box component="span" sx={{ color: t.muted, fontSize: 13 }}>
                    {storageKind(s.provisioner).label}
                  </Box>
                </Box>
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Name"
            value={name}
            onChange={e => setName(e.target.value.toLowerCase())}
            error={!!nameProblem}
            helperText={nameProblem ?? 'What VMs and disks show as their datastore.'}
            autoComplete="off"
          />
          {rbd && (
            <TextField
              select
              size="small"
              label="Ceph pool"
              value={pool}
              onChange={e => setPool(e.target.value)}
              helperText={
                pools.length ? (
                  <>
                    Disks become RBD images in this pool: its replicas and failure domain decide how safe they are.{' '}
                    {poolUrl && (
                      <Box component={RouterLink} to={poolUrl} sx={{ color: t.accent }} onClick={onClose}>
                        Create a pool in Ceph
                      </Box>
                    )}
                  </>
                ) : (
                  'No block pool found in this Ceph cluster.'
                )
              }
            >
              {pools.map(p => {
                const pn = p.spec?.name ?? p.metadata.name;
                const ec = p.spec?.erasureCoded?.dataChunks;
                return (
                  <MenuItem key={pn} value={pn}>
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                      <span>{pn}</span>
                      <Box component="span" sx={{ color: t.muted, fontSize: 13 }}>
                        {ec ? `erasure coded ${ec}+${p.spec.erasureCoded.codingChunks ?? 0}` : `${p.spec?.replicated?.size ?? '?'} copies`}
                        {p.spec?.failureDomain ? `, across ${p.spec.failureDomain}s` : ''}
                        {p.status?.phase && p.status.phase !== 'Ready' ? `, ${p.status.phase.toLowerCase()}` : ''}
                      </Box>
                    </Box>
                  </MenuItem>
                );
              })}
            </TextField>
          )}
          {lvm && (
            <TextField
              select
              size="small"
              label="Disk group on each host"
              value={deviceClass}
              onChange={e => setDeviceClass(e.target.value)}
              helperText="TopoLVM device class: the volume group (or thin pool) the disks are carved from."
              SelectProps={{ displayEmpty: true }}
              InputLabelProps={{ shrink: true }}
            >
              <MenuItem value="">The default class</MenuItem>
              {deviceClasses.map(dc => (
                <MenuItem key={dc} value={dc}>
                  {dc}
                </MenuItem>
              ))}
            </TextField>
          )}
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <TextField select size="small" label="When a disk is deleted" value={reclaim} onChange={e => setReclaim(e.target.value as 'Delete' | 'Retain')}>
              <MenuItem value="Delete">Free its space</MenuItem>
              <MenuItem value="Retain">Keep the volume (admin cleans up)</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label="Create disks"
              value={binding}
              onChange={e => setBinding(e.target.value as 'Immediate' | 'WaitForFirstConsumer')}
              helperText={binding === 'WaitForFirstConsumer' ? 'Local storage: the disk is made on the host the VM lands on.' : undefined}
            >
              <MenuItem value="Immediate">Right away</MenuItem>
              <MenuItem value="WaitForFirstConsumer">When a VM first uses them</MenuItem>
            </TextField>
          </Box>
          <TextField size="small" label="Description (optional)" value={description} onChange={e => setDescription(e.target.value)} />
          <Box sx={{ display: 'grid' }}>
            <FormControlLabel control={<Checkbox checked={expansion} onChange={e => setExpansion(e.target.checked)} />} label="Disks can be expanded" />
            <FormControlLabel control={<Checkbox checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />} label="Make it the default for new VMs" />
          </Box>
          {base && !rbd && !lvm && (
            <Note>
              Hangar copies {base.metadata.name}'s settings as they are: to change the driver's parameters, review the YAML
              {k8s ? '' : ' (turn on the Kubernetes switch)'}.
            </Note>
          )}
          {k8s && base && (
            <Typography sx={{ fontSize: 12.5, color: t.muted }}>
              <K8sName>StorageClass {name || '…'}</K8sName> provisioner <K8sName>{base.provisioner}</K8sName>
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          {k8s && (
            <Button disabled={!ok} onClick={() => setYaml(true)} sx={{ mr: 'auto' }}>
              Review YAML
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="contained" disableElevation disabled={!ok} onClick={() => create(storageClassFrom(input()))}>
            Create datastore
          </Button>
        </DialogActions>
      </Dialog>
      {yaml && ok && (
        <EditorDialog
          open
          item={storageClassFrom(input())}
          onClose={() => setYaml(false)}
          onSave={(items: any) => {
            setYaml(false);
            create(Array.isArray(items) ? items[0] : items);
          }}
          saveLabel="Create"
          title="StorageClass to create"
        />
      )}
    </>
  );
}
