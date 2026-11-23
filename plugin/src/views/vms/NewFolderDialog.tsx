/* New folder: a namespace marked as a Hangar folder, so it shows even while empty. */
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { runTask } from '../../api/actions';
import { kpost } from '../../api/client';
import { useHangar } from '../../api/data';
import { L_FOLDER } from '../../model/inventory';
import { nameProblem } from '../../model/vmspec';

export function NewFolderDialog({ onClose }: { onClose: () => void }) {
  const d = useHangar();
  const [name, setName] = React.useState('');
  const exists = d.namespaces.some(n => n.metadata.name === name);
  const problem = name ? nameProblem(name) ?? (exists ? 'This name is taken.' : null) : null;
  const create = () => {
    runTask({ title: 'Create folder', target: { kind: 'folder', name } }, () =>
      kpost('/api/v1/namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { [L_FOLDER]: 'true' } } })
    ).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-folder-title">
      <DialogTitle id="hangar-folder-title" sx={{ fontSize: 18 }}>
        New folder
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1 }}>
        <Typography sx={{ fontSize: 14 }}>
          Folders group VMs and decide who may use them. Each folder is a Kubernetes namespace.
        </Typography>
        <TextField
          size="small"
          label="Name"
          value={name}
          onChange={e => setName(e.target.value.toLowerCase())}
          error={!!problem}
          helperText={problem ?? ' '}
          onKeyDown={e => e.key === 'Enter' && name && !problem && create()}
        />
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!name || !!problem} onClick={create}>
          Create folder
        </Button>
      </DialogActions>
    </Dialog>
  );
}
