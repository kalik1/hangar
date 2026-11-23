/* Import an image into the library from a URL or a container registry. */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { importImage } from '../../api/library';
import { guessFromName, imageDataVolume, REGISTRY_SUGGESTIONS, slugName, urlProblem } from '../../model/library';
import { GiB } from '../../model/units';
import { useTokens } from '../../ui/useTokens';
import { defaultStorageClass, fieldProblems, ImageFields, ImageFieldsValue, takenNames } from './fields';

export type ImportKind = 'http' | 'registry';

export function ImportDialog({ d, namespace, kind: initial, onClose }: { d: HangarData; namespace: string; kind: ImportKind; onClose: () => void }) {
  const t = useTokens();
  const [kind, setKind] = React.useState<ImportKind>(initial);
  const [url, setUrl] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const [v, setV] = React.useState<ImageFieldsValue>({
    displayName: '',
    os: '',
    media: 'disk',
    sizeGiB: '10',
    storageClass: defaultStorageClass(d),
    description: '',
  });
  const [nameEdited, setNameEdited] = React.useState(false);
  const onUrl = (s: string) => {
    setUrl(s);
    if (nameEdited) return;
    if (kind === 'http') {
      const g = guessFromName(s);
      setV(p => ({ ...p, displayName: g.displayName, os: g.os || p.os, media: g.media, sizeGiB: g.media === 'iso' ? (g.os === 'windows' ? '8' : '4') : p.sizeGiB }));
    } else {
      const sug = REGISTRY_SUGGESTIONS.find(x => x.ref === s.trim());
      const repo = s.trim().split('/').pop() ?? '';
      setV(p => ({ ...p, displayName: sug?.label ?? repo.replace(':', ' '), os: sug?.os || guessFromName(repo).os || p.os, media: 'disk' }));
    }
  };
  const urlErr = urlProblem(kind, url);
  const problems = fieldProblems(v);
  const ok = !urlErr && !problems.displayName && !problems.size;
  const submit = () => {
    setTouched(true);
    if (!ok) return;
    const name = slugName(v.displayName, takenNames(d, namespace));
    const dv = imageDataVolume({
      namespace,
      name,
      displayName: v.displayName,
      os: v.os,
      media: kind === 'registry' ? 'disk' : v.media,
      sizeBytes: Math.round(Number(v.sizeGiB) * GiB),
      source: kind === 'http' ? { http: url } : { registry: url },
      storageClass: v.storageClass || undefined,
      description: v.description,
    });
    importImage(dv, `Import ${v.media === 'iso' && kind === 'http' ? 'ISO' : 'image'} ${v.displayName}`).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-import-title">
      <DialogTitle id="hangar-import-title" sx={{ fontSize: 18 }}>
        Import image
      </DialogTitle>
      <Box sx={{ px: 3, borderBottom: `1px solid ${t.rule}` }}>
        <Tabs value={kind} onChange={(_, k) => setKind(k)} aria-label="Import from" sx={{ minHeight: 40, '& .MuiTab-root': { minHeight: 40, textTransform: 'none', px: 1.5 } }}>
          <Tab value="http" label="From a URL" />
          <Tab value="registry" label="From a container registry" />
        </Tabs>
      </Box>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 2, pt: 1.5 }}>
          {kind === 'http' ? (
            <TextField
              label="Image URL"
              size="small"
              placeholder="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
              value={url}
              onChange={e => onUrl(e.target.value)}
              error={touched && !!urlErr}
              helperText={(touched && urlErr) || 'A qcow2 or raw disk image, or an ISO; .gz and .xz are unpacked. The cluster downloads it, not your browser.'}
            />
          ) : (
            <Box>
              <TextField
                label="Image reference"
                size="small"
                fullWidth
                placeholder="quay.io/containerdisks/fedora:latest"
                value={url}
                onChange={e => onUrl(e.target.value)}
                error={touched && !!urlErr}
                helperText={(touched && urlErr) || 'A container disk image: a disk packed as a container image. The cluster pulls it.'}
              />
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1 }} aria-label="Well-known images">
                {REGISTRY_SUGGESTIONS.map(s => (
                  <Chip key={s.ref} size="small" label={s.label} variant={url === s.ref ? 'filled' : 'outlined'} onClick={() => onUrl(s.ref)} />
                ))}
              </Box>
            </Box>
          )}
          <ImageFields
            value={v}
            onChange={nv => {
              if (nv.displayName !== v.displayName) setNameEdited(true);
              setV(nv);
            }}
            d={d}
            namespace={namespace}
            lockMedia={kind === 'registry'}
            showErrors={touched || !!url.trim()}
            sizeHelp={
              v.media === 'iso' && kind === 'http'
                ? 'At least the ISO file size.'
                : 'At least the image\'s virtual size. VMs made from it can have bigger disks.'
            }
          />
          <Typography sx={{ fontSize: 13, color: t.muted }}>
            The import runs in the cluster: follow it in Recent tasks. Every folder can make VMs from library images.
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={touched && !ok}>
          Import image
        </Button>
      </DialogActions>
    </Dialog>
  );
}
