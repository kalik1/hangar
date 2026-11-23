/* Expand a disk: a bigger size, what the guest has to do, nothing is lost. */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { expandDisk } from '../../api/storage';
import { featureGate } from '../../model/snapshots';
import { DiskRow } from '../../model/storage';
import { formatBytes, GiB } from '../../model/units';
import { key } from '../../model/vm';
import { useTokens } from '../../ui/useTokens';

export function ExpandDiskDialog({ row, d, onClose }: { row: DiskRow; d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const currentGiB = row.sizeBytes / GiB;
  const [value, setValue] = React.useState(String(Math.ceil(currentGiB) + (Number.isInteger(currentGiB) ? 5 : 4)));
  const n = Number(value);
  const bytes = Math.round(n * GiB);
  const problem = !value.trim() || !isFinite(n) ? 'Enter a size in GiB.' : bytes <= row.sizeBytes ? `Enter more than ${formatBytes(row.sizeBytes)}: disks cannot shrink.` : null;
  const running = row.uses.some(u => d.idx.vmi.get(key(u.vm)));
  const live = featureGate(d.kubevirt, 'ExpandDisks') === 'on';
  const thin = (d.storageClasses.find(s => s.metadata.name === row.datastore)?.provisioner ?? '') === 'topolvm.io';
  const submit = () => {
    if (problem) return;
    expandDisk(row, bytes).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-expand-title">
      <DialogTitle id="hangar-expand-title" sx={{ fontSize: 18 }}>
        Expand disk {row.name}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
          <Typography sx={{ fontSize: 14 }}>
            Now {formatBytes(row.sizeBytes)}
            {row.uses.length ? `, used by ${row.uses.map(u => u.vm.metadata.name).join(', ')}` : ''}.
          </Typography>
          <TextField
            label="New size"
            size="small"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            error={!!problem}
            helperText={problem ?? ' '}
            inputProps={{ inputMode: 'decimal' }}
            InputProps={{ endAdornment: <InputAdornment position="end">GiB</InputAdornment> }}
          />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {[5, 10, 20].map(add => (
              <Button key={add} size="small" variant="outlined" color="inherit" sx={{ textTransform: 'none' }} onClick={() => setValue(String(Math.ceil(currentGiB) + add))}>
                +{add} GiB
              </Button>
            ))}
            <Button size="small" variant="outlined" color="inherit" sx={{ textTransform: 'none' }} onClick={() => setValue(String(Math.ceil(currentGiB * 2)))}>
              Double
            </Button>
          </Box>
          <Box sx={{ fontSize: 13, color: t.muted, lineHeight: 1.55, '& p': { m: 0, mb: 0.75 } }}>
            <p>Nothing on the disk is lost, and the size cannot be reduced later.</p>
            {row.uses.length > 0 && (
              <p>
                {running
                  ? live
                    ? 'The running guest sees the bigger disk at once.'
                    : 'The running guest sees the bigger disk after a restart (live expansion needs the ExpandDisks feature of KubeVirt).'
                  : 'The guest sees the bigger disk at its next power-on.'}{' '}
                Then grow the partition and the file system inside the guest (growpart and xfs_growfs or resize2fs; Windows: Disk Management).
                Cloud images usually do it at boot.
              </p>
            )}
            {thin && <p>On a thin pool the extra space is not used until the guest writes to it.</p>}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem} onClick={submit}>
          Expand disk
        </Button>
      </DialogActions>
    </Dialog>
  );
}
