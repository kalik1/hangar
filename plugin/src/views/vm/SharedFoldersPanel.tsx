/*
 * Configure → Shared folders: virtiofs shares, like a VMware shared folder
 * or a Proxmox virtiofs directory mapping. A share is a disk (PVC) of the
 * folder, or a ConfigMap or Secret (read-only), mounted in the guest by its
 * tag (the share's name). KubeVirt gates: EnableVirtioFsStorageVolumes
 * (disks), EnableVirtioFsConfigVolumes (ConfigMaps, Secrets).
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { kreq } from '../../api/client';
import { HangarData, useHangar } from '../../api/data';
import { useGate } from '../../api/gates';
import { writeHostClipboard } from '../../console/ClipboardTray';
import { Obj } from '../../model/types';
import { formatBytes, parseQuantity } from '../../model/units';
import { disks, key, powerState } from '../../model/vm';
import * as O from '../../model/vmoptions';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { GateHint } from '../settings/GateHint';
import { Later, quiet, saveVm } from './configParts';

type Kind = 'pvc' | 'configMap' | 'secret';

function useNames(ns: string, what: 'configmaps' | 'secrets'): string[] | null {
  const [names, setNames] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    let alive = true;
    kreq<any>(`/api/v1/namespaces/${ns}/${what}`)
      .then(r => alive && setNames(((r?.items ?? []) as Obj[]).map(o => o.metadata.name).filter(n => !n.startsWith('kube-root-ca') && !n.startsWith('hangar-'))))
      .catch(() => alive && setNames(null));
    return () => {
      alive = false;
    };
  }, [ns, what]);
  return names;
}

function AddShareDialog({ vm, d, onClose }: { vm: Obj; d: HangarData; onClose: () => void }) {
  const ns = vm.metadata.namespace as string;
  const storage = useGate('EnableVirtioFsStorageVolumes');
  const config = useGate('EnableVirtioFsConfigVolumes');
  const [kind, setKind] = React.useState<Kind>(storage.on !== false ? 'pvc' : 'configMap');
  const [name, setName] = React.useState('');
  const [src, setSrc] = React.useState('');
  const cms = useNames(ns, 'configmaps');
  const secrets = useNames(ns, 'secrets');
  const used = new Set(d.vms.filter(v => v.metadata.namespace === ns).flatMap(v => disks(v).map(x => x.claimName)));
  const pvcs = d.pvcs.filter(
    p => p.metadata.namespace === ns && !p.metadata.name.startsWith('prime-') && !p.metadata.name.endsWith('-scratch') && p.metadata.labels?.['hangar.magesgate.com/image'] !== 'true' && (p.spec?.volumeMode ?? 'Filesystem') === 'Filesystem'
  );
  const existing = new Set([...O.sharesOf(vm).map(s => s.name), ...(vm.spec?.template?.spec?.volumes ?? []).map((v: any) => v.name)]);
  const nameBad = !!name && (!O.SHARE_NAME_RE.test(name) || name.length > 36 || existing.has(name));
  const gate = kind === 'pvc' ? storage : config;
  const list = kind === 'pvc' ? pvcs.map(p => p.metadata.name) : kind === 'configMap' ? cms : secrets;
  const ok = !!name && !nameBad && !!src && gate.on !== false;
  const running = !!d.idx.vmi.get(key(vm));
  const save = () => {
    const source: O.ShareSource = kind === 'pvc' ? { kind: 'pvc', claimName: src } : kind === 'configMap' ? { kind: 'configMap', name: src } : { kind: 'secret', name: src };
    quiet(saveVm(vm, `Share ${src} as ${name}`, O.addShare(vm, name, source as Exclude<O.ShareSource, { kind: 'other' }>)));
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-share-title">
      <DialogTitle id="hangar-share-title" sx={{ fontSize: 18 }}>
        Share a folder with {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <ToggleButtonGroup size="small" exclusive value={kind} onChange={(_, v) => v && (setKind(v), setSrc(''))} aria-label="What to share">
          <ToggleButton value="pvc" sx={{ textTransform: 'none' }}>
            A disk
          </ToggleButton>
          <ToggleButton value="configMap" sx={{ textTransform: 'none' }}>
            A ConfigMap
          </ToggleButton>
          <ToggleButton value="secret" sx={{ textTransform: 'none' }}>
            A Secret
          </ToggleButton>
        </ToggleButtonGroup>
        {gate.on === false ? (
          <GateHint gate={kind === 'pvc' ? 'EnableVirtioFsStorageVolumes' : 'EnableVirtioFsConfigVolumes'} />
        ) : (
          <>
            {list === null ? (
              <TextField size="small" label={kind === 'secret' ? 'Secret name' : 'ConfigMap name'} value={src} onChange={e => setSrc(e.target.value)} helperText="Your role cannot list them here: type the name." />
            ) : (
              <TextField select size="small" label={kind === 'pvc' ? 'Disk of this folder (filesystem mode)' : kind === 'configMap' ? 'ConfigMap' : 'Secret'} value={src} onChange={e => setSrc(e.target.value)} disabled={!list.length} helperText={!list.length ? 'None in this folder.' : undefined}>
                {list.map(n => {
                  const p = kind === 'pvc' ? pvcs.find(x => x.metadata.name === n) : undefined;
                  return (
                    <MenuItem key={n} value={n}>
                      {n}
                      {p && (
                        <Box component="span" sx={{ color: 'text.secondary', fontSize: 12.5, ml: 1 }}>
                          {formatBytes(parseQuantity(p.status?.capacity?.storage))} {(p.spec?.accessModes ?? []).includes('ReadWriteMany') ? '· shared (RWX)' : '· one host (RWO)'}
                          {used.has(n) ? ' · a VM disk' : ''}
                        </Box>
                      )}
                    </MenuItem>
                  );
                })}
              </TextField>
            )}
            <TextField
              size="small"
              label="Tag (the name the guest mounts)"
              value={name}
              onChange={e => setName(e.target.value.toLowerCase())}
              error={nameBad}
              helperText={nameBad ? 'Lowercase letters, digits and hyphens, unique in the VM.' : name ? O.mountCommand(name) : 'For example: data, config'}
            />
            {kind !== 'pvc' && <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>ConfigMaps and Secrets are shared read-only; changes reach the guest after a while.</Typography>}
            {kind === 'pvc' && <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>To share one disk between VMs it must be RWX (a shared datastore).</Typography>}
          </>
        )}
        {running && <Typography sx={{ fontSize: 13, color: '#B7791F' }}>The VM is running: the share appears at the next power-on.</Typography>}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!ok} onClick={save}>
          Share
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function SharedFoldersPanel({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const shares = O.sharesOf(vm);
  const storage = useGate('EnableVirtioFsStorageVolumes');
  const config = useGate('EnableVirtioFsConfigVolumes');
  const running = powerState(vm, d.idx.vmi.get(key(vm))).kind !== 'off';
  const bothOff = storage.on === false && config.on === false;
  const remove = async (name: string) => {
    const ok = await confirm({ title: `Stop sharing ${name}?`, body: <p>The guest loses the folder at the next power-on. The disk, ConfigMap or Secret itself stays.</p>, confirm: 'Stop sharing', danger: true });
    if (ok) quiet(saveVm(vm, `Stop sharing ${name}`, O.removeShare(vm, name)));
  };
  return (
    <Panel
      title="Shared folders"
      icon="mdi:folder-network-outline"
      dense
      actions={
        <>
          <Later running={running} />
          <Button size="small" disabled={bothOff} onClick={() => openDialog(close => <AddShareDialog vm={vm} d={d} onClose={close} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={16} />}>
            Add
          </Button>
        </>
      }
    >
      {shares.length === 0 && (
        <Box sx={{ p: 2, fontSize: 14, color: t.muted }}>
          No shared folders. Share a disk, a ConfigMap or a Secret with the guest through virtiofs.
          {bothOff && <GateHint gate="EnableVirtioFsStorageVolumes" sx={{ mt: 1 }} />}
        </Box>
      )}
      {shares.map(s => {
        const cmd = O.mountCommand(s.name);
        const src = s.source.kind === 'pvc' ? `Disk ${s.source.claimName}` : s.source.kind === 'configMap' ? `ConfigMap ${s.source.name} (read-only)` : s.source.kind === 'secret' ? `Secret ${s.source.name} (read-only)` : s.source.what;
        const g = s.source.kind === 'other' ? null : O.shareGate(s.source);
        const off = g === 'EnableVirtioFsStorageVolumes' ? storage.on === false : g ? config.on === false : false;
        return (
          <Box key={s.name} sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Icon icon="mdi:folder-outline" width={18} style={{ color: t.muted }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ fontSize: 14, fontWeight: 600 }}>{s.name}</Box>
                <Box sx={{ fontSize: 12.5, color: t.muted }}>{src}</Box>
              </Box>
              <IconAction icon="mdi:content-copy" label={`Copy the mount command for ${s.name}`} onClick={() => quiet(writeHostClipboard(cmd))} />
              <IconAction icon="mdi:delete-outline" label={`Stop sharing ${s.name}`} onClick={() => remove(s.name)} />
            </Box>
            <Box component="code" sx={{ display: 'block', mt: 0.5, ml: 4, fontFamily: t.font.mono, fontSize: 12, color: t.muted, overflowWrap: 'anywhere' }}>
              {cmd}
            </Box>
            {off && g && <GateHint gate={g} sx={{ ml: 4, mt: 0.5 }}>The VM cannot power on while {g} is off.</GateHint>}
          </Box>
        );
      })}
      {k8s && (
        <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
          <K8sName>devices.filesystems[].virtiofs</K8sName>
        </Box>
      )}
    </Panel>
  );
}
