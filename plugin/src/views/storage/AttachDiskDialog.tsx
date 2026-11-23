/*
 * Attach an unattached disk to a VM of its folder (a disk lives in one
 * folder: a VM elsewhere cannot use it). The change applies at the VM's
 * next power-on when it is running, like other edits.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { HangarData } from '../../api/data';
import * as E from '../../model/edit';
import { DiskRow } from '../../model/storage';
import { formatBytes } from '../../model/units';
import { isTemplate, key, powerState } from '../../model/vm';
import { useTokens } from '../../ui/useTokens';

export function AttachDiskDialog({ row, d, onClose }: { row: DiskRow; d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const vms = d.vms.filter(v => v.metadata.namespace === row.namespace).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  // No VM preselected: attaching to the wrong one is easy to miss.
  const [vmKey, setVmKey] = React.useState('');
  const [bus, setBus] = React.useState('virtio');
  const vm = vms.find(v => key(v) === vmKey);
  const running = vm ? powerState(vm, d.idx.vmi.get(key(vm))).kind !== 'off' : false;
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-attach-title">
      <DialogTitle id="hangar-attach-title" sx={{ fontSize: 18 }}>
        Attach {row.name} to a VM
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <Typography sx={{ fontSize: 13.5, color: t.muted }}>
          {formatBytes(row.sizeBytes)} on {row.datastore ?? 'an unknown datastore'}, in folder {row.namespace}. Only VMs of that folder can use it.
        </Typography>
        {vms.length ? (
          <TextField
            select
            size="small"
            label="VM"
            value={vmKey}
            onChange={e => setVmKey(e.target.value)}
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
          >
            <MenuItem value="" disabled>
              Choose a VM
            </MenuItem>
            {vms.map(v => (
              <MenuItem key={key(v)} value={key(v)}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                  <span>{v.metadata.name}</span>
                  <Box component="span" sx={{ color: t.muted, fontSize: 13 }}>
                    {isTemplate(v) ? 'template' : powerState(v, d.idx.vmi.get(key(v))).label.toLowerCase()}
                  </Box>
                </Box>
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Typography sx={{ fontSize: 14 }}>Folder {row.namespace} has no VM.</Typography>
        )}
        <TextField select size="small" label="Bus" value={bus} onChange={e => setBus(e.target.value)} helperText="VirtIO is fastest; SATA for guests without VirtIO drivers.">
          <MenuItem value="virtio">VirtIO</MenuItem>
          <MenuItem value="sata">SATA</MenuItem>
          <MenuItem value="scsi">SCSI</MenuItem>
        </TextField>
        {running && <Typography sx={{ fontSize: 13, color: t.muted }}>The VM is running: the disk appears at its next power-on.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!vm}
          onClick={() => {
            if (vm) A.updateVm(vm, `Attach disk ${row.name}`, E.attachDisk(vm, row.name, bus).vm).catch(() => undefined);
            onClose();
          }}
        >
          Attach
        </Button>
      </DialogActions>
    </Dialog>
  );
}
