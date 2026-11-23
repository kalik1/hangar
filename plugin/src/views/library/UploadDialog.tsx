/*
 * Upload a file from this computer into the library. The browser sends it
 * straight to CDI's upload proxy: the dialog checks first that the browser
 * can reach it, and says how to fix it when it cannot.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { checkProxy, startUpload } from '../../api/upload';
import { FORMAT_LABELS, guessFromName, imageDataVolume, ImageInfo, LibraryItem, slugName, SNIFF_BYTES, sniffImage, suggestedSize } from '../../model/library';
import { formatBytes, GiB } from '../../model/units';
import { proxyTarget } from '../../model/upload';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';
import { defaultStorageClass, fieldProblems, ImageFields, ImageFieldsValue, takenNames } from './fields';

type Reach = 'checking' | 'ok' | 'no';

export function UploadDialog({ d, namespace, onClose, into }: { d: HangarData; namespace: string; onClose: () => void; into?: LibraryItem }) {
  const t = useTokens();
  const target = proxyTarget(d.cdiConfig, window.location.protocol);
  const [reach, setReach] = React.useState<Reach>('checking');
  const [file, setFile] = React.useState<File | null>(null);
  const [info, setInfo] = React.useState<ImageInfo | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [v, setV] = React.useState<ImageFieldsValue>({
    displayName: into?.displayName ?? '',
    os: into?.os ?? '',
    media: into?.media ?? 'disk',
    sizeGiB: into ? String(Math.round((into.sizeBytes / GiB) * 100) / 100) : '1',
    storageClass: defaultStorageClass(d),
    description: '',
  });
  const inputRef = React.useRef<HTMLInputElement>(null);

  const check = React.useCallback(() => {
    if (!target.base) return setReach('no');
    setReach('checking');
    checkProxy(target.base).then(ok => setReach(ok ? 'ok' : 'no'));
  }, [target.base]);
  React.useEffect(check, [check]);

  const pick = async (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    const head = new Uint8Array(await f.slice(0, SNIFF_BYTES).arrayBuffer());
    const i = sniffImage(head, f.size);
    setInfo(i);
    if (into) return;
    const g = guessFromName(f.name);
    const media = i.format === 'iso' || g.media === 'iso' ? 'iso' : 'disk';
    setV(p => ({
      ...p,
      displayName: p.displayName || g.displayName,
      os: p.os || g.os,
      media,
      sizeGiB: String(suggestedSize(i, f.size) / GiB),
    }));
  };

  const minBytes = into ? 0 : Math.max(info?.virtualSize ?? 0, info?.format === 'qcow2' ? 0 : file?.size ?? 0);
  const problems = fieldProblems(v, minBytes);
  const ok = !!file && !problems.displayName && !problems.size && reach === 'ok' && !!target.base && !target.problem;
  const fitsInto = !into || !file || info?.virtualSize === undefined || info.virtualSize <= into.sizeBytes;

  const submit = () => {
    if (!ok || !file || !target.base || !fitsInto) return;
    const name = into?.name ?? slugName(v.displayName, takenNames(d, namespace));
    const dv = into?.dv ?? imageDataVolume({
      namespace,
      name,
      displayName: v.displayName,
      os: v.os,
      media: v.media,
      sizeBytes: Math.round(Number(v.sizeGiB) * GiB),
      source: { upload: true },
      storageClass: v.storageClass || undefined,
      description: v.description,
    });
    startUpload({ file, dataVolume: dv, create: !into, base: target.base, title: `Upload ${v.media === 'iso' ? 'ISO' : 'image'} ${v.displayName || file.name}` });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-upload-title">
      <DialogTitle id="hangar-upload-title" sx={{ fontSize: 18 }}>
        {into ? `Upload a file into ${into.displayName}` : 'Upload a file'}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
          {target.problem ? (
            <Note tone="warn" icon={<Icon icon="mdi:alert-outline" width={18} style={{ color: '#B7791F', flex: 'none' }} />}>
              <b>Uploads cannot work here.</b> {target.problem}
            </Note>
          ) : reach === 'no' ? (
            <Note tone="warn" icon={<Icon icon="mdi:alert-outline" width={18} style={{ color: '#B7791F', flex: 'none' }} />}>
              <b>This browser cannot reach the upload proxy</b> at {target.base}. The file goes straight from your browser to it, over
              HTTPS. If it uses a certificate your browser does not trust,{' '}
              <Link href={`${target.base}/healthz`} target="_blank" rel="noopener noreferrer">
                open it in a new tab
              </Link>
              , accept the certificate, then{' '}
              <Link component="button" type="button" onClick={check} sx={{ verticalAlign: 'baseline' }}>
                check again
              </Link>
              . For good: give the proxy's Ingress a trusted certificate.
            </Note>
          ) : (
            <Typography sx={{ fontSize: 13, color: t.muted, display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Icon icon={reach === 'ok' ? 'mdi:check-circle-outline' : 'mdi:progress-upload'} width={16} style={{ color: reach === 'ok' ? '#2FBF71' : t.muted }} />
              {reach === 'ok' ? `Upload proxy reachable: ${target.base}` : `Checking the upload proxy at ${target.base}…`}
            </Typography>
          )}

          <Box
            onDragOver={e => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => {
              e.preventDefault();
              setDrag(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            sx={{
              border: `1.5px dashed ${drag ? t.accent : t.rule}`,
              borderRadius: `${t.radius.panel}px`,
              background: drag ? t.selected : t.hover,
              p: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Icon icon={file ? (info?.format === 'iso' ? 'mdi:disc' : 'mdi:harddisk') : 'mdi:tray-arrow-up'} width={32} style={{ color: t.muted, flex: 'none' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {file ? (
                <>
                  <Typography sx={{ fontWeight: 600, fontSize: 14, overflowWrap: 'anywhere' }}>{file.name}</Typography>
                  <Typography sx={{ fontSize: 13, color: t.muted }}>
                    {formatBytes(file.size)}
                    {info ? `, ${FORMAT_LABELS[info.format]}` : ''}
                    {info?.virtualSize && info.virtualSize !== file.size ? `, ${formatBytes(info.virtualSize)} disk` : ''}
                  </Typography>
                </>
              ) : (
                <Typography sx={{ fontSize: 14, color: t.muted }}>Drop an ISO or a disk image here (qcow2, raw, vmdk; .gz or .xz).</Typography>
              )}
            </Box>
            <Button variant="outlined" size="small" sx={{ textTransform: 'none', flex: 'none' }} onClick={() => inputRef.current?.click()}>
              {file ? 'Choose another' : 'Choose file'}
            </Button>
            <input
              ref={inputRef}
              type="file"
              hidden
              aria-label="File to upload"
              accept=".iso,.img,.qcow2,.raw,.vmdk,.vhd,.vhdx,.gz,.xz,application/x-iso9660-image"
              onChange={e => pick(e.target.files?.[0])}
            />
          </Box>
          {into && !fitsInto && (
            <Note tone="warn">
              This image needs {formatBytes(info?.virtualSize)}, more than the {formatBytes(into.sizeBytes)} disk prepared for it. Delete the empty image and upload
              it as a new one.
            </Note>
          )}

          {!into && (
            <ImageFields
              value={v}
              onChange={setV}
              d={d}
              namespace={namespace}
              minBytes={minBytes}
              showErrors={!!file}
              sizeHelp={info?.format === 'qcow2' ? 'At least the image\'s disk size. VMs made from it can have bigger disks.' : 'At least the file size.'}
            />
          )}
          <Typography sx={{ fontSize: 13, color: t.muted }}>
            Keep this page open until the upload ends (Recent tasks shows its progress); Hangar can be used meanwhile. Closing or reloading the
            page stops it.
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!ok || !fitsInto}>
          {v.media === 'iso' ? 'Upload ISO' : 'Upload image'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
