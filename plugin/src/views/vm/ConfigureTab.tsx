/*
 * Configure: the VM's virtual hardware and options, edited in place like a
 * classic "Edit settings". Each panel saves on its own; changes a running VM
 * cannot take live wait for a restart (the VM page says so).
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { datastores } from '../../model/capacity';
import * as E from '../../model/edit';
import { KIND_CLUSTER, KIND_NS, setCpuModel, setFlavor } from '../../model/flavors';
import { hostState } from '../../model/inventory';
import { preferredDatastore } from '../../model/placement';
import { Obj } from '../../model/types';
import { formatBytes, GiB, parseQuantity } from '../../model/units';
import { disks, EVICTION_LABELS, hardware, isTemplate, key, nics, powerState, RUN_STRATEGIES, runStrategy, tags } from '../../model/vm';
import { useK8s, useSettings } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { libraryImages, sizeProfiles } from '../../wizard/catalog';
import { CpuModelSelect, FlavorSelect, useFlavorFamilies } from '../flavors/parts';
import { datastoreItems, renderDatastore } from '../storage/DatastorePick';
import { ClipboardPanel } from './ClipboardPanel';
import { HostDevicesPanel } from './DevicesSection';
import { DnsPanel } from './DnsPanel';
import { MoveDiskDialog } from './MoveDiskDialog';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

function Row({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' } }}>
      <Box sx={{ width: 170, flex: 'none', color: t.muted, fontSize: 13.5 }}>{label}</Box>
      <Box sx={{ flex: 1, minWidth: 0, fontSize: 14, ...tabular }}>{children}</Box>
      {action}
    </Box>
  );
}

function Later({ running }: { running: boolean }) {
  const t = useTokens();
  return running ? (
    <Tooltip title="The VM is running: KubeVirt applies what it can at once and asks for a restart for the rest.">
      <Box component="span" sx={{ fontSize: 12.5, color: t.muted, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
        <Icon icon="mdi:restart" width={14} /> Some changes need a restart
      </Box>
    </Tooltip>
  ) : null;
}

/* ------------------------------------------------------------- dialogs */

function ComputeDialog({ vm, d, onClose }: { vm: Obj; d: HangarData; onClose: () => void }) {
  const vmi = d.idx.vmi.get(key(vm));
  const hw = hardware(vm, vmi, d.instancetypes);
  const profiles = sizeProfiles(d.instancetypes);
  const [mode, setMode] = React.useState<'custom' | 'profile'>(hw.instancetype ? 'profile' : 'custom');
  const [profile, setProfile] = React.useState(hw.instancetype?.name ?? 'u1.small');
  const [profileKind, setProfileKind] = React.useState(hw.instancetype?.kind ?? KIND_CLUSTER);
  const ownModel: string = vm.spec?.template?.spec?.domain?.cpu?.model ?? '';
  const [cpuModel, setCpuModelState] = React.useState(ownModel);
  const flavorObjs = useFlavorFamilies(vm.metadata.namespace as string).all;
  const chosen = flavorObjs.find(o => o.metadata.name === profile && (profileKind === KIND_NS ? o.metadata.namespace === vm.metadata.namespace : !o.metadata.namespace));
  const flavorModel: string | undefined = mode === 'profile' ? chosen?.spec?.cpu?.model : undefined;
  const [sockets, setSockets] = React.useState(hw.sockets);
  const [cores, setCores] = React.useState(hw.cores);
  const [threads, setThreads] = React.useState(hw.threads);
  const [mem, setMem] = React.useState(String(+(hw.memoryBytes / GiB).toFixed(2)));
  const [fw, setFw] = React.useState<'bios' | 'uefi' | 'uefi-secure'>(hw.firmware === 'BIOS' ? 'bios' : hw.firmware === 'UEFI' ? 'uefi' : 'uefi-secure');
  const [tpm, setTpm] = React.useState(hw.tpm);
  const memBytes = Number(mem) * GiB;
  const ok = mode === 'profile' ? !!profile : sockets >= 1 && cores >= 1 && threads >= 1 && memBytes >= 128 * 2 ** 20;
  const save = () => {
    let next = mode === 'profile' ? setFlavor(vm, { kind: profileKind, name: profile }) : E.setCompute(vm, { sockets, cores, threads, memoryBytes: memBytes });
    next = E.setFirmware(next, fw, tpm);
    // A flavor that sets the CPU model forbids the VM's own (KubeVirt rejects the conflict).
    next = setCpuModel(next, flavorModel ? '' : cpuModel);
    quiet(A.updateVm(vm, 'Change CPU and memory', next));
    onClose();
  };
  const num = (label: string, v: number, set: (n: number) => void) => (
    <TextField type="number" size="small" label={label} value={v} onChange={e => set(Math.max(1, Math.round(Number(e.target.value) || 1)))} sx={{ width: 100 }} inputProps={{ min: 1 }} />
  );
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-compute-title">
      <DialogTitle id="hangar-compute-title" sx={{ fontSize: 18 }}>
        CPU, memory and firmware of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} aria-label="Sizing">
          <ToggleButton value="custom" sx={{ textTransform: 'none' }}>
            Custom
          </ToggleButton>
          <ToggleButton value="profile" sx={{ textTransform: 'none' }} disabled={!profiles.length}>
            Flavor
          </ToggleButton>
        </ToggleButtonGroup>
        {mode === 'custom' ? (
          <>
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
              {num('Sockets', sockets, setSockets)}
              {num('Cores', cores, setCores)}
              {num('Threads', threads, setThreads)}
              <Box sx={{ fontSize: 14 }}>= {sockets * cores * threads} vCPU</Box>
            </Box>
            <TextField type="number" size="small" label="Memory (GiB)" value={mem} onChange={e => setMem(e.target.value)} sx={{ width: 160 }} inputProps={{ min: 0.125, step: 0.5 }} />
          </>
        ) : (
          <FlavorSelect
            value={`${profileKind}/${profile}`}
            onChange={(kind, name) => {
              setProfileKind(kind);
              setProfile(name);
            }}
            namespace={vm.metadata.namespace as string}
            nodes={d.nodes}
          />
        )}
        <CpuModelSelect
          value={cpuModel}
          onChange={setCpuModelState}
          nodes={d.nodes}
          clusterDefault={d.kubevirt?.spec?.configuration?.cpuModel}
          lockedBy={flavorModel ? { flavor: profile, model: flavorModel } : undefined}
        />
        {(cpuModel !== ownModel || !!flavorModel) && d.idx.vmi.get(key(vm)) && (
          <Typography sx={{ fontSize: 13, color: '#B7791F' }}>The running VM keeps its CPU: the new model applies at the next power-on.</Typography>
        )}
        <Box>
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 0.75 }}>Firmware</Typography>
          <ToggleButtonGroup size="small" exclusive value={fw} onChange={(_, v) => v && setFw(v)} aria-label="Firmware">
            <ToggleButton value="bios" sx={{ textTransform: 'none' }}>
              BIOS
            </ToggleButton>
            <ToggleButton value="uefi" sx={{ textTransform: 'none' }}>
              UEFI
            </ToggleButton>
            <ToggleButton value="uefi-secure" sx={{ textTransform: 'none' }}>
              UEFI, Secure Boot
            </ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel sx={{ display: 'flex', mt: 1 }} control={<Checkbox checked={tpm} onChange={e => setTpm(e.target.checked)} />} label="Virtual TPM" />
          {fw !== (hw.firmware === 'BIOS' ? 'bios' : hw.firmware === 'UEFI' ? 'uefi' : 'uefi-secure') && (
            <Typography sx={{ fontSize: 13, color: '#B7791F' }}>Changing the firmware of an installed guest usually stops it from booting.</Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!ok} onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AddDiskDialog({ vm, d, onClose, libraryNs }: { vm: Obj; d: HangarData; onClose: () => void; libraryNs: string }) {
  const ns = vm.metadata.namespace as string;
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  const used = new Set(d.vms.flatMap(v => disks(v).map(x => `${v.metadata.namespace}/${x.claimName}`)));
  const free = d.pvcs.filter(
    p =>
      p.metadata.namespace === ns &&
      !used.has(`${ns}/${p.metadata.name}`) &&
      !p.metadata.name.startsWith('prime-') &&
      !p.metadata.name.endsWith('-scratch') &&
      p.metadata.labels?.['hangar.magesgate.com/image'] !== 'true'
  );
  const isos = libraryImages(d.dvs, d.pvcs, libraryNs).filter(i => i.media === 'iso' && i.ready);
  const [kind, setKind] = React.useState<'new' | 'existing' | 'iso'>('new');
  const [size, setSize] = React.useState('10');
  const [sc, setSc] = React.useState(preferredDatastore(ds, d.nodes.length)?.name ?? '');
  const tk = useTokens();
  const [bus, setBus] = React.useState('virtio');
  const [claim, setClaim] = React.useState(free[0]?.metadata.name ?? '');
  const [iso, setIso] = React.useState(isos[0] ? `${isos[0].namespace}/${isos[0].name}` : '');
  const [boot, setBoot] = React.useState(false);
  const ok = kind === 'new' ? Number(size) >= 1 : kind === 'existing' ? !!claim : !!iso;
  const save = () => {
    if (kind === 'new') quiet(A.updateVm(vm, 'Add disk', E.addBlankDisk(vm, { sizeBytes: Number(size) * GiB, storageClass: sc, bus }).vm));
    else if (kind === 'existing') quiet(A.updateVm(vm, 'Attach disk', E.attachDisk(vm, claim, bus).vm));
    else {
      const i = isos.find(x => `${x.namespace}/${x.name}` === iso)!;
      quiet(A.updateVm(vm, 'Insert ISO', E.insertIso(vm, i, boot)));
    }
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-adddisk-title">
      <DialogTitle id="hangar-adddisk-title" sx={{ fontSize: 18 }}>
        Add a disk to {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={kind} onChange={(_, v) => v && setKind(v)} aria-label="Kind of disk">
          <ToggleButton value="new" sx={{ textTransform: 'none' }}>
            New disk
          </ToggleButton>
          <ToggleButton value="existing" sx={{ textTransform: 'none' }} disabled={!free.length}>
            Existing disk
          </ToggleButton>
          <ToggleButton value="iso" sx={{ textTransform: 'none' }} disabled={!isos.length}>
            CD/DVD from an ISO
          </ToggleButton>
        </ToggleButtonGroup>
        {kind === 'new' && (
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <TextField type="number" size="small" label="Size (GiB)" value={size} onChange={e => setSize(e.target.value)} sx={{ width: 130 }} inputProps={{ min: 1 }} />
            <TextField
              select
              size="small"
              label="Datastore"
              value={sc}
              onChange={e => setSc(e.target.value)}
              sx={{ minWidth: 260 }}
              SelectProps={{ renderValue: renderDatastore(ds, d.nodes.length) }}
            >
              {datastoreItems(ds, d.nodes.length, tk)}
            </TextField>
          </Box>
        )}
        {kind === 'existing' && (
          <TextField select size="small" label="Unattached disk in this folder" value={claim} onChange={e => setClaim(e.target.value)}>
            {free.map(p => (
              <MenuItem key={p.metadata.name} value={p.metadata.name}>
                {p.metadata.name} · {formatBytes(parseQuantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage))}
              </MenuItem>
            ))}
          </TextField>
        )}
        {kind === 'iso' && (
          <>
            <TextField select size="small" label="ISO" value={iso} onChange={e => setIso(e.target.value)}>
              {isos.map(i => (
                <MenuItem key={`${i.namespace}/${i.name}`} value={`${i.namespace}/${i.name}`}>
                  {i.displayName}
                </MenuItem>
              ))}
            </TextField>
            <FormControlLabel control={<Checkbox checked={boot} onChange={e => setBoot(e.target.checked)} />} label="Boot from it first" />
          </>
        )}
        {kind !== 'iso' && (
          <TextField select size="small" label="Bus" value={bus} onChange={e => setBus(e.target.value)} sx={{ width: 160 }}>
            <MenuItem value="virtio">VirtIO</MenuItem>
            <MenuItem value="scsi">SCSI</MenuItem>
            <MenuItem value="sata">SATA</MenuItem>
          </TextField>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!ok} onClick={save}>
          {kind === 'iso' ? 'Insert ISO' : kind === 'existing' ? 'Attach disk' : 'Add disk'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ExpandDialog({ vm, claim, current, onClose }: { vm: Obj; claim: string; current: number; onClose: () => void }) {
  const [size, setSize] = React.useState(String(Math.ceil(current / GiB) + 10));
  const bytes = Number(size) * GiB;
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="hangar-expand-title">
      <DialogTitle id="hangar-expand-title" sx={{ fontSize: 18 }}>
        Expand disk
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.5 }}>
        <Typography sx={{ fontSize: 14 }}>
          Now {formatBytes(current)}. Disks only grow: grow the partition and filesystem in the guest afterwards.
        </Typography>
        <TextField type="number" size="small" label="New size (GiB)" value={size} onChange={e => setSize(e.target.value)} inputProps={{ min: Math.ceil(current / GiB) + 1 }} />
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!(bytes > current)}
          onClick={() => {
            quiet(A.expandDisk(vm.metadata.namespace as string, claim, bytes, vm.metadata.name));
            onClose();
          }}
        >
          Expand
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- tab */

export function ConfigureTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const [settings] = useSettings();
  const vmi = d.idx.vmi.get(key(vm));
  const p = powerState(vm, vmi);
  const running = p.kind !== 'off';
  const hw = hardware(vm, vmi, d.instancetypes);
  const ds = disks(vm);
  const ns = nics(vm, vmi);
  const nads = d.nads.filter(n => n.metadata.namespace === vm.metadata.namespace || n.metadata.namespace === 'default');
  const tpl = isTemplate(vm);
  const vmNs = vm.metadata.namespace as string;
  const pvc = (c?: string) => (c ? d.idx.pvc.get(`${vmNs}/${c}`) : undefined);
  const size = (c?: string) => parseQuantity(pvc(c)?.status?.capacity?.storage ?? pvc(c)?.spec?.resources?.requests?.storage);
  const sc = (c?: string) => d.storageClasses.find(s => s.metadata.name === pvc(c)?.spec?.storageClassName);

  /* boot order */
  const bootables = [...ds.filter(x => !x.config).map(x => ({ name: x.name, kind: x.device === 'cdrom' ? 'CD/DVD' : 'Disk' })), ...ns.map(n => ({ name: n.name, kind: 'Network (PXE)' }))];
  const currentOrder = [
    ...ds.filter(x => x.bootOrder !== undefined).map(x => [x.name, x.bootOrder as number] as [string, number]),
    ...((vm.spec?.template?.spec?.domain?.devices?.interfaces ?? []) as any[]).filter(i => i.bootOrder).map(i => [i.name, i.bootOrder] as [string, number]),
  ]
    .sort((a, b) => a[1] - b[1])
    .map(x => x[0]);
  const [order, setOrder] = React.useState<string[]>(currentOrder);
  const orderChanged = order.join() !== currentOrder.join();

  /* policies */
  const spec = vm.spec?.template?.spec ?? {};
  const aff = E.hostAffinity(vm);
  const [pol, setPol] = React.useState({
    eviction: spec.evictionStrategy ?? '',
    grace: String(spec.terminationGracePeriodSeconds ?? 180),
    host: aff?.host ?? '',
    required: aff?.required ?? false,
  });
  const polChanged =
    pol.eviction !== (spec.evictionStrategy ?? '') ||
    Number(pol.grace) !== (spec.terminationGracePeriodSeconds ?? 180) ||
    pol.host !== (aff?.host ?? '') ||
    (!!pol.host && pol.required !== (aff?.required ?? false));

  /* cloud-init */
  const ci = E.cloudInitOf(vm);
  const [ciText, setCiText] = React.useState(ci ?? '');

  /* tags */
  const userTags = tags(vm);
  const [tagText, setTagText] = React.useState(userTags.map(([k, v]) => `${k}=${v}`).join(', '));

  const removeDisk = async (name: string, claim?: string) => {
    const r = E.removeDisk(vm, name);
    const ok = await confirm({
      title: `Remove ${name} from ${vm.metadata.name}?`,
      body: <p>{claim ? 'The disk is detached from the VM.' : 'The device is removed.'}</p>,
      confirm: 'Remove',
      danger: true,
      option: claim ? { label: 'Also delete the disk and its data', help: 'Otherwise it stays in the folder, unattached.', initial: false } : undefined,
    });
    if (!ok) return;
    await A.updateVm(vm, 'Remove disk', r.vm).catch(() => undefined);
    // A disk the VM created is deleted by KubeVirt with its template; delete others only if asked.
    if (claim && ok.option && !r.owned) quiet(A.deleteClaim(vmNs, claim));
  };

  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: 'minmax(0,1.3fr) minmax(0,1fr)' }, alignItems: 'start' }}>
      <Box sx={{ display: 'grid', gap: 2 }}>
        <Panel
          title="Virtual hardware"
          icon="mdi:chip"
          actions={
            <>
              <Later running={running} />
              <Button size="small" onClick={() => openDialog(close => <ComputeDialog vm={vm} d={d} onClose={close} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:pencil-outline" width={16} />}>
                Edit
              </Button>
            </>
          }
        >
          <Row label="CPU">
            {hw.vcpus} vCPU ({hw.sockets} × {hw.cores} × {hw.threads}){hw.cpuModel ? `, model ${hw.cpuModel}` : ''}
            {hw.dedicatedCpus && <Tag>dedicated</Tag>}
          </Row>
          <Row label="Memory">{formatBytes(hw.memoryBytes)}</Row>
          <Row label="Sizing">
            {hw.instancetype ? (
              <>
                Size profile {hw.instancetype.name} {k8s && <K8sName>{hw.instancetype.kind}</K8sName>}
              </>
            ) : (
              'Custom'
            )}
          </Row>
          <Row label="Firmware">
            {hw.firmware}
            {hw.tpm ? ', TPM' : ''}
          </Row>
          {hw.preference && (
            <Row label="Guest OS tuning">
              {hw.preference.name} {k8s && <K8sName>preference</K8sName>}
            </Row>
          )}
        </Panel>

        <Panel
          title="Disks and CD/DVD"
          icon="mdi:harddisk"
          dense
          actions={
            <>
              <Later running={running} />
              <Button size="small" onClick={() => openDialog(close => <AddDiskDialog vm={vm} d={d} onClose={close} libraryNs={settings.libraryNamespace} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={16} />}>
                Add
              </Button>
            </>
          }
        >
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, ...tabular, '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 2, py: 0.75 }, '& td': { px: 2, py: 0.75, borderTop: `1px solid ${t.rule}` } }}>
            <thead>
              <tr>
                <th>Device</th>
                <th>Bus</th>
                <th>Size</th>
                <th>{k8s ? 'StorageClass' : 'Datastore'}</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {ds.map(x => (
                <tr key={x.name}>
                  <td>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Icon icon={x.config ? 'mdi:file-cog-outline' : x.device === 'cdrom' ? 'mdi:disc' : 'mdi:harddisk'} width={16} style={{ color: t.muted }} />
                      <span>{x.config ? (x.sourceKind === 'cloudInit' ? 'Guest customization (cloud-init)' : `${x.name} (${x.sourceKind})`) : x.name}</span>
                      {x.device === 'cdrom' && <Tag>CD/DVD</Tag>}
                    </Box>
                    {k8s && x.claimName && <K8sName>pvc/{x.claimName}</K8sName>}
                  </td>
                  <td>{x.bus}</td>
                  <td>{x.claimName ? formatBytes(size(x.claimName)) : '—'}</td>
                  <td>{pvc(x.claimName)?.spec?.storageClassName ?? (x.sourceKind === 'containerDisk' ? 'Image (ephemeral)' : '—')}</td>
                  <Box component="td" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {x.claimName && x.device === 'disk' && (
                      <IconAction
                        icon="mdi:arrow-expand-horizontal"
                        label={sc(x.claimName)?.allowVolumeExpansion ? 'Expand' : 'This datastore cannot expand disks'}
                        disabled={!sc(x.claimName)?.allowVolumeExpansion}
                        onClick={() => openDialog(close => <ExpandDialog vm={vm} claim={x.claimName!} current={size(x.claimName)} onClose={close} />)}
                      />
                    )}
                    {x.claimName && x.device === 'disk' && (
                      <IconAction
                        icon="mdi:database-arrow-right-outline"
                        label="Move to another datastore"
                        onClick={() => openDialog(close => <MoveDiskDialog vm={vm} only={x.name} onClose={close} />)}
                      />
                    )}
                    {!x.config && <IconAction icon={x.device === 'cdrom' ? 'mdi:eject-outline' : 'mdi:link-off'} label={x.device === 'cdrom' ? 'Eject and remove' : 'Remove from VM'} onClick={() => removeDisk(x.name, x.claimName)} />}
                  </Box>
                </tr>
              ))}
            </tbody>
          </Box>
        </Panel>

        <Panel
          title="Network adapters"
          icon="mdi:ethernet"
          dense
          actions={
            <>
              <Later running={running} />
              <Button
                size="small"
                sx={{ textTransform: 'none' }}
                startIcon={<Icon icon="mdi:plus" width={16} />}
                disabled={!nads.length && ns.some(n => n.isPodNetwork)}
                onClick={() => {
                  const free = nads.find(x => !ns.some(n => n.network === `${x.metadata.namespace}/${x.metadata.name}`));
                  quiet(A.updateVm(vm, 'Add network adapter', E.addNic(vm, free ? `${free.metadata.namespace}/${free.metadata.name}` : '', 'virtio').vm));
                }}
              >
                Add
              </Button>
            </>
          }
        >
          {ns.length === 0 && <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>No network adapters: the VM is isolated.</Box>}
          {ns.map(n => (
            <Box key={n.name} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, borderTop: `1px solid ${t.rule}`, flexWrap: 'wrap' }}>
              <Icon icon="mdi:ethernet" width={18} style={{ color: t.muted }} />
              <Box sx={{ width: 90, fontWeight: 600, fontSize: 14 }}>{n.name}</Box>
              <TextField
                select
                size="small"
                value={n.isPodNetwork ? '' : n.network}
                onChange={e => quiet(A.updateVm(vm, 'Change network', E.setNic(vm, n.name, { network: e.target.value })))}
                sx={{ minWidth: 220 }}
                inputProps={{ 'aria-label': `Network of ${n.name}` }}
                SelectProps={{ displayEmpty: true }}
              >
                <MenuItem value="">Pod network (NAT)</MenuItem>
                {nads.map(x => (
                  <MenuItem key={`${x.metadata.namespace}/${x.metadata.name}`} value={`${x.metadata.namespace}/${x.metadata.name}`}>
                    {x.metadata.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select size="small" value={n.model} onChange={e => quiet(A.updateVm(vm, 'Change adapter type', E.setNic(vm, n.name, { model: e.target.value })))} sx={{ width: 140 }} inputProps={{ 'aria-label': `Adapter type of ${n.name}` }}>
                <MenuItem value="virtio">VirtIO</MenuItem>
                <MenuItem value="e1000e">Intel e1000e</MenuItem>
                <MenuItem value="rtl8139">Realtek 8139</MenuItem>
              </TextField>
              <Box sx={{ fontSize: 13, color: t.muted, ...tabular, minWidth: 130 }}>{n.mac ?? 'MAC assigned at start'}</Box>
              {!n.isPodNetwork && (
                <FormControlLabel
                  sx={{ m: 0 }}
                  control={<Switch size="small" checked={n.linkState !== 'down'} onChange={e => quiet(A.updateVm(vm, e.target.checked ? 'Connect adapter' : 'Disconnect adapter', E.setNic(vm, n.name, { linkDown: !e.target.checked })))} />}
                  label={<Box sx={{ fontSize: 13 }}>Connected</Box>}
                />
              )}
              <Box sx={{ flex: 1 }} />
              <IconAction
                icon="mdi:delete-outline"
                label="Remove adapter"
                onClick={async () => {
                  const ok = await confirm({ title: `Remove ${n.name}?`, body: <p>The VM loses this network connection.</p>, confirm: 'Remove', danger: true });
                  if (ok) quiet(A.updateVm(vm, 'Remove network adapter', E.removeNic(vm, n.name)));
                }}
              />
            </Box>
          ))}
        </Panel>

        <DnsPanel vm={vm} />

        <ClipboardPanel vm={vm} />

        <HostDevicesPanel vm={vm} later={<Later running={running} />} />
      </Box>

      <Box sx={{ display: 'grid', gap: 2 }}>
        <Panel
          title="Boot order"
          icon="mdi:sort-numeric-ascending"
          actions={
            orderChanged ? (
              <>
                <Button size="small" color="inherit" onClick={() => setOrder(currentOrder)} sx={{ textTransform: 'none' }}>
                  Undo
                </Button>
                <Button size="small" variant="contained" disableElevation onClick={() => quiet(A.updateVm(vm, 'Change boot order', E.setBootOrder(vm, order)))} sx={{ textTransform: 'none' }}>
                  Save
                </Button>
              </>
            ) : undefined
          }
        >
          {bootables.length === 0 && <Box sx={{ color: t.muted, fontSize: 14 }}>No bootable devices.</Box>}
          {[...order.filter(n => bootables.some(b => b.name === n)), ...bootables.map(b => b.name).filter(n => !order.includes(n))].map(name => {
            const b = bootables.find(x => x.name === name)!;
            const i = order.indexOf(name);
            const on = i >= 0;
            return (
              <Box key={name} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25, opacity: on ? 1 : 0.6 }}>
                <Checkbox
                  size="small"
                  checked={on}
                  onChange={e => setOrder(e.target.checked ? [...order, name] : order.filter(x => x !== name))}
                  inputProps={{ 'aria-label': `Boot from ${name}` }}
                />
                <Box sx={{ width: 22, fontSize: 13, color: t.muted, ...tabular }}>{on ? i + 1 : ''}</Box>
                <Box sx={{ flex: 1, fontSize: 14 }}>
                  {name} <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>{b.kind}</Box>
                </Box>
                <IconAction icon="mdi:arrow-up" label={`Move ${name} up`} disabled={!on || i === 0} onClick={() => setOrder(o => { const n = [...o]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })} />
                <IconAction icon="mdi:arrow-down" label={`Move ${name} down`} disabled={!on || i === order.length - 1} onClick={() => setOrder(o => { const n = [...o]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })} />
              </Box>
            );
          })}
        </Panel>

        {!tpl && (
          <Panel title="Power and availability" icon="mdi:power-settings">
            <Box sx={{ display: 'grid', gap: 2 }}>
              <TextField select size="small" label="Power policy" value={runStrategy(vm)} onChange={e => quiet(A.setRunStrategy(vm, e.target.value))} helperText={RUN_STRATEGIES.find(r => r.value === runStrategy(vm))?.help}>
                {RUN_STRATEGIES.map(r => (
                  <MenuItem key={r.value} value={r.value}>
                    {r.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select size="small" label="On host maintenance" value={pol.eviction} onChange={e => setPol({ ...pol, eviction: e.target.value })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
                <MenuItem value="">Cluster default ({EVICTION_LABELS[d.kubevirt?.spec?.configuration?.evictionStrategy ?? 'None']?.toLowerCase()})</MenuItem>
                {Object.entries(EVICTION_LABELS).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              <TextField type="number" size="small" label="Shutdown timeout (seconds)" value={pol.grace} onChange={e => setPol({ ...pol, grace: e.target.value })} helperText="How long a guest shutdown may take before the VM is powered off." inputProps={{ min: 0 }} />
              <Box>
                <TextField select size="small" fullWidth label="Host" value={pol.host} onChange={e => setPol({ ...pol, host: e.target.value })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
                  <MenuItem value="">Any host</MenuItem>
                  {d.nodes.map(n => (
                    <MenuItem key={n.metadata.name} value={n.metadata.name}>
                      {n.metadata.name} {hostState(n).ready ? '' : '(not responding)'}
                    </MenuItem>
                  ))}
                </TextField>
                {pol.host && (
                  <FormControlLabel control={<Checkbox checked={pol.required} onChange={e => setPol({ ...pol, required: e.target.checked })} />} label="Only on this host (otherwise preferred)" />
                )}
              </Box>
              {polChanged && (
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                  <Button
                    variant="contained"
                    disableElevation
                    onClick={() =>
                      quiet(
                        A.updateVm(
                          vm,
                          'Change policies',
                          E.setPolicies(vm, {
                            eviction: pol.eviction || null,
                            graceSeconds: pol.grace === '' ? null : Math.max(0, Number(pol.grace)),
                            hostAffinity: pol.host ? { host: pol.host, required: pol.required } : null,
                          })
                        )
                      )
                    }
                    sx={{ textTransform: 'none' }}
                  >
                    Save policies
                  </Button>
                </Box>
              )}
            </Box>
          </Panel>
        )}

        <Panel title="Tags" icon="mdi:tag-outline">
          <TextField fullWidth size="small" value={tagText} onChange={e => setTagText(e.target.value)} placeholder="app=shop, tier=web" helperText="key=value, separated by commas. Tags group VMs in searches." inputProps={{ 'aria-label': 'Tags' }} />
          {tagText !== userTags.map(([k, v]) => `${k}=${v}`).join(', ') && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
              <Button
                variant="contained"
                disableElevation
                sx={{ textTransform: 'none' }}
                onClick={() => {
                  const map: Record<string, string> = {};
                  for (const part of tagText.split(/[,\s]+/).filter(Boolean)) {
                    const [k, v = ''] = part.split(/[=:]/);
                    if (k) map[k] = v;
                  }
                  const userKeys = new Set(userTags.map(([k]) => k));
                  quiet(A.updateVm(vm, 'Change tags', E.setTags(vm, map, k => !userKeys.has(k))));
                }}
              >
                Save tags
              </Button>
            </Box>
          )}
        </Panel>

        {ci !== undefined && (
          <Panel title="Guest customization" icon="mdi:file-cog-outline">
            <Typography sx={{ fontSize: 13, color: t.muted, mb: 1 }}>
              cloud-init user data. Most images read it only at their first boot.
            </Typography>
            <TextField fullWidth multiline minRows={6} maxRows={18} size="small" value={ciText} onChange={e => setCiText(e.target.value)} inputProps={{ 'aria-label': 'cloud-init user data', style: { fontFamily: t.font.mono, fontSize: 12.5 } }} />
            {ciText !== ci && (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
                <Button variant="contained" disableElevation sx={{ textTransform: 'none' }} onClick={() => quiet(A.updateVm(vm, 'Change guest customization', E.setCloudInit(vm, ciText)))}>
                  Save
                </Button>
              </Box>
            )}
          </Panel>
        )}
      </Box>
    </Box>
  );
}
