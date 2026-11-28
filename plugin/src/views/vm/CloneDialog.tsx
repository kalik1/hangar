/*
 * Copies of a VM: clone a VM, clone it to a template, or make a new VM from
 * a template. Every disk is copied (CDI clone), the copy gets new MAC
 * addresses and, when it uses cloud-init, its own hostname.
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
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { readCloudInitSecrets } from '../../api/cloudInit';
import { HangarData } from '../../api/data';
import { folders } from '../../model/inventory';
import { Obj } from '../../model/types';
import { formatBytes, parseQuantity } from '../../model/units';
import { claimNames, displayName } from '../../model/vm';
import { copyVm, nameProblem } from '../../model/vmspec';
import { useSettings } from '../../shell/settings';
import { useTokens } from '../../ui/useTokens';

function suggestName(src: string, mode: 'clone' | 'template' | 'deploy', taken: Set<string>): string {
  const base =
    mode === 'template' ? (/^(tpl|template)-/.test(src) ? `${src}-copy` : `tpl-${src}`) : mode === 'deploy' ? src.replace(/^tpl-/, '').replace(/^template-/, '') : `${src}-copy`;
  if (!taken.has(base) && mode !== 'deploy') return base;
  for (let i = 1; i < 100; i++) {
    const n = `${base}-${String(i).padStart(2, '0')}`;
    if (!taken.has(n)) return n;
  }
  return base;
}

export function CloneDialog({
  source,
  data: d,
  mode,
  onClose,
}: {
  source: Obj;
  data: HangarData;
  mode: 'clone' | 'template' | 'deploy';
  onClose: () => void;
}) {
  const t = useTokens();
  const [settings] = useSettings();
  const srcNs = source.metadata.namespace as string;
  const folderNames = folders(d.vms, d.namespaces, d.vmis, settings.libraryNamespace).map(f => f.name);
  const [ns, setNs] = React.useState(srcNs);
  const taken = new Set(d.vms.filter(v => v.metadata.namespace === ns).map(v => v.metadata.name));
  const [name, setName] = React.useState(() => suggestName(source.metadata.name, mode, taken));
  const [start, setStart] = React.useState(mode === 'deploy');
  const [desc, setDesc] = React.useState(mode === 'deploy' ? '' : source.metadata.annotations?.description ?? '');
  const problem = nameProblem(name) ?? (taken.has(name) ? 'A VM with this name is already in the folder.' : null);
  const claims = claimNames(source);
  const total = claims.reduce((s, c) => {
    const pvc = d.idx.pvc.get(`${srcNs}/${c}`);
    return s + (parseQuantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage) || 0);
  }, 0);
  const title =
    mode === 'clone' ? `Clone ${displayName(source)}` : mode === 'template' ? `Clone ${displayName(source)} to a template` : `New VM from ${displayName(source)}`;
  const action = mode === 'clone' ? 'Clone' : mode === 'template' ? 'Create template' : 'Create VM';
  const submit = async () => {
    onClose();
    const vm = copyVm(source, {
      name,
      namespace: ns,
      runStrategy: start ? 'Always' : 'Halted',
      pvcs: d.idx.pvc,
      asTemplate: mode === 'template',
      description: desc || undefined,
    });
    // User data kept in the source's Secret: the copy gets a Secret of its own.
    const copied = await readCloudInitSecrets(source);
    A.createVm(vm, mode === 'deploy' ? 'Deploy from template' : mode === 'template' ? 'Clone to template' : 'Clone VM', copied).catch(
      () => undefined
    );
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-clone-title">
      <DialogTitle id="hangar-clone-title" sx={{ fontSize: 18 }}>
        {title}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
          <TextField
            label="Name"
            size="small"
            value={name}
           
            onChange={e => setName(e.target.value)}
            error={!!problem}
            helperText={problem ?? ' '}
          />
          <Autocomplete
            freeSolo
            options={folderNames}
            value={ns}
            onInputChange={(_, v) => setNs(v)}
            renderInput={p => (
              <TextField
                {...p}
                size="small"
                label="Folder"
                helperText={ns !== srcNs ? `Copying to another folder needs permission to clone disks from ${srcNs}.` : ' '}
              />
            )}
          />
          <TextField label="Notes" size="small" value={desc} onChange={e => setDesc(e.target.value)} multiline minRows={2} />
          {mode !== 'template' && (
            <FormControlLabel
              control={<Checkbox checked={start} onChange={e => setStart(e.target.checked)} />}
              label="Power on when the disks are ready"
            />
          )}
          <Typography sx={{ fontSize: 13, color: t.muted }}>
            {claims.length === 0
              ? 'The source has no persistent disks: only its settings are copied.'
              : `${claims.length} disk${claims.length > 1 ? 's' : ''}, ${formatBytes(total)} in all, will be copied. Network adapters get new MAC addresses.`}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem || !ns} onClick={submit}>
          {action}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
