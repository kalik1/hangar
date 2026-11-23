/* Rename an image, set its OS and kind, add notes. */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { editImage } from '../../api/library';
import { LibraryItem, Media } from '../../model/library';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { OS_CHOICES } from '../../wizard/catalog';

export function EditImageDialog({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const [name, setName] = React.useState(item.displayName);
  const [os, setOs] = React.useState(item.os);
  const [media, setMedia] = React.useState<Media>(item.media);
  const [desc, setDesc] = React.useState(item.description ?? '');
  const problem = name.trim() ? null : 'Give the image a name.';
  const submit = () => {
    if (problem) return;
    editImage(item, { displayName: name, os, description: desc, media: media !== item.media ? media : undefined }).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-edit-image-title">
      <DialogTitle id="hangar-edit-image-title" sx={{ fontSize: 18 }}>
        Edit image
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
          {k8s && <K8sName>{item.dv ? 'DataVolume' : 'PVC'} {item.namespace}/{item.name}</K8sName>}
          <TextField label="Name" size="small" value={name} onChange={e => setName(e.target.value)} error={!!problem} helperText={problem ?? 'Shown in Hangar; the disk keeps its Kubernetes name.'} />
          <TextField select label="Guest OS" size="small" value={os || 'other'} onChange={e => setOs(e.target.value === 'other' ? '' : e.target.value)}>
            {OS_CHOICES.map(o => (
              <MenuItem key={o.id} value={o.id}>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                  <Icon icon={o.icon} width={16} style={{ color: t.muted }} />
                  {o.label}
                </Box>
              </MenuItem>
            ))}
          </TextField>
          <Box>
            <Typography id="hangar-edit-kind" sx={{ fontSize: 13, color: t.muted }}>
              Kind
            </Typography>
            <RadioGroup row aria-labelledby="hangar-edit-kind" value={media} onChange={e => setMedia(e.target.value as Media)}>
              <FormControlLabel value="disk" control={<Radio size="small" />} label="Disk image" />
              <FormControlLabel value="iso" control={<Radio size="small" />} label="ISO" />
            </RadioGroup>
          </Box>
          <TextField label="Notes" size="small" value={desc} onChange={e => setDesc(e.target.value)} multiline minRows={2} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!!problem}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
