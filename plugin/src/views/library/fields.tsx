/* The fields every new library image has: name, OS, kind, size, datastore, notes. */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { datastores } from '../../model/capacity';
import { Media, slugName } from '../../model/library';
import { GiB } from '../../model/units';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { OS_CHOICES } from '../../wizard/catalog';

export interface ImageFieldsValue {
  displayName: string;
  os: string;
  media: Media;
  sizeGiB: string;
  storageClass: string;
  description: string;
}

export function defaultStorageClass(d: HangarData): string {
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  return (ds.find(x => x.isDefault) ?? ds[0])?.name ?? '';
}

export function takenNames(d: HangarData, ns: string): Set<string> {
  return new Set([...d.dvs, ...d.pvcs].filter(o => o.metadata.namespace === ns).map(o => o.metadata.name));
}

export function fieldProblems(v: ImageFieldsValue, minBytes = 0): { displayName?: string; size?: string } {
  const out: { displayName?: string; size?: string } = {};
  if (!v.displayName.trim()) out.displayName = 'Give the image a name.';
  const n = Number(v.sizeGiB);
  if (!v.sizeGiB.trim() || !isFinite(n) || n <= 0) out.size = 'Enter a size in GiB.';
  else if (minBytes && n * GiB < minBytes) out.size = `The image needs at least ${Math.ceil((minBytes / GiB) * 10) / 10} GiB.`;
  return out;
}

export function ImageFields({
  value,
  onChange,
  d,
  namespace,
  lockMedia,
  sizeHelp,
  minBytes,
  showErrors = true,
}: {
  value: ImageFieldsValue;
  onChange: (v: ImageFieldsValue) => void;
  d: HangarData;
  namespace: string;
  lockMedia?: boolean;
  sizeHelp?: string;
  minBytes?: number;
  /** Show problems (after a first try, or once there is something to check). */
  showErrors?: boolean;
}) {
  const t = useTokens();
  const k8s = useK8s();
  const set = (p: Partial<ImageFieldsValue>) => onChange({ ...value, ...p });
  const problems = showErrors ? fieldProblems(value, minBytes) : {};
  const name = slugName(value.displayName || 'image', takenNames(d, namespace));
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box>
        <TextField
          label="Name"
          size="small"
          fullWidth
          value={value.displayName}
          onChange={e => set({ displayName: e.target.value })}
          error={!!problems.displayName}
          helperText={problems.displayName ?? (k8s ? undefined : ' ')}
        />
        {k8s && (
          <Box sx={{ mt: 0.5 }}>
            <K8sName>
              DataVolume {namespace}/{name}
            </K8sName>
          </Box>
        )}
      </Box>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        <TextField select label="Guest OS" size="small" value={value.os || 'other'} onChange={e => set({ os: e.target.value === 'other' ? '' : e.target.value })}>
          {OS_CHOICES.map(o => (
            <MenuItem key={o.id} value={o.id}>
              <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                <Icon icon={o.icon} width={16} style={{ color: t.muted }} />
                {o.label}
              </Box>
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Disk size"
          size="small"
          value={value.sizeGiB}
          onChange={e => set({ sizeGiB: e.target.value })}
          error={!!problems.size}
          helperText={problems.size ?? sizeHelp ?? ' '}
          inputProps={{ inputMode: 'decimal' }}
          InputProps={{ endAdornment: <InputAdornment position="end">GiB</InputAdornment> }}
        />
      </Box>
      {!lockMedia && (
        <Box>
          <Typography id="hangar-image-kind" sx={{ fontSize: 13, color: t.muted }}>
            Kind
          </Typography>
          <RadioGroup row aria-labelledby="hangar-image-kind" value={value.media} onChange={e => set({ media: e.target.value as Media })}>
            <FormControlLabel value="disk" control={<Radio size="small" />} label="Disk image (boots as the VM's disk)" />
            <FormControlLabel value="iso" control={<Radio size="small" />} label="ISO (installer, attached as CD-ROM)" />
          </RadioGroup>
        </Box>
      )}
      <TextField select label="Datastore" size="small" value={value.storageClass} onChange={e => set({ storageClass: e.target.value })}>
        {d.storageClasses.map(sc => (
          <MenuItem key={sc.metadata.name} value={sc.metadata.name}>
            {sc.metadata.name}
          </MenuItem>
        ))}
      </TextField>
      <TextField label="Notes" size="small" value={value.description} onChange={e => set({ description: e.target.value })} multiline minRows={1} />
    </Box>
  );
}
