/*
 * Flavor dialogs: a new family (a ladder of sizes from a purpose, with the
 * knobs KubeVirt instancetypes offer) and the edit of a single flavor.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { createFlavors, updateFlavor } from '../../api/flavors';
import { useK4all } from '../../api/k4all';
import {
  bestCommonModel,
  Family,
  familyIdProblem,
  familyLadder,
  Flavor,
  FlavorDef,
  flavorFrom,
  flavorRequirements,
  hostCpus,
  nodeSettingsWords,
  PURPOSES,
  SIZE_LADDER,
} from '../../model/flavors';
import { mappingsOf } from '../../model/hardware';
import { formatBytes, GiB } from '../../model/units';
import { slugify } from '../../model/vmspec';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { K4allNodesHint } from '../settings/K4allManaged';
import { CpuModelSelect } from './parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

interface Knobs {
  cpuModel: string;
  dedicated: boolean;
  isolateEmulatorThread: boolean;
  hugepages: string;
  numa: boolean;
  overcommitPercent: number;
  ioThreadsPolicy: string;
  gpu: string;
}

function knobsOf(f?: Flavor): Knobs {
  return {
    cpuModel: f?.cpuModel ?? '',
    dedicated: !!f?.dedicated,
    isolateEmulatorThread: !!f?.isolateEmulatorThread,
    hugepages: f?.hugepages ?? '',
    numa: !!f?.numa,
    overcommitPercent: f?.overcommitPercent ?? 0,
    ioThreadsPolicy: f?.ioThreadsPolicy ?? '',
    gpu: f?.devices[0] ?? '',
  };
}

/** The knobs block shared by both dialogs, with what each needs from the hosts. */
function KnobFields({ k, set, d, memBytes }: { k: Knobs; set: (p: Partial<Knobs>) => void; d: HangarData; memBytes: number }) {
  const k4all = useK4all();
  const t = useTokens();
  const k8s = useK8s();
  const gpus = mappingsOf(d.kubevirt);
  const probe = flavorFrom({
    metadata: { name: 'probe' },
    spec: {
      cpu: { guest: 1, model: k.cpuModel || undefined, dedicatedCPUPlacement: k.dedicated, numa: k.numa ? { guestMappingPassthrough: {} } : undefined },
      memory: { guest: `${Math.max(1, Math.round(memBytes / 2 ** 20))}Mi`, hugepages: k.hugepages ? { pageSize: k.hugepages } : undefined },
      gpus: k.gpu ? [{ name: 'gpu1', deviceName: k.gpu }] : undefined,
    },
  } as any);
  const unmet = flavorRequirements(probe, d.nodes).filter(r => r.hosts.length === 0);
  return (
    <Box sx={{ display: 'grid', gap: 1.75 }}>
      <CpuModelSelect value={k.cpuModel} onChange={cpuModel => set({ cpuModel })} nodes={d.nodes} clusterDefault={d.kubevirt?.spec?.configuration?.cpuModel} label="CPU model (empty: the VM or the cluster decides)" />
      <Box>
        <FormControlLabel
          control={<Checkbox checked={k.dedicated} onChange={e => set({ dedicated: e.target.checked, ...(e.target.checked ? {} : { isolateEmulatorThread: false, numa: false }) })} />}
          label="Dedicated physical CPUs"
        />
        {k.dedicated && (
          <FormControlLabel sx={{ ml: 3, display: 'flex' }} control={<Checkbox checked={k.isolateEmulatorThread} onChange={e => set({ isolateEmulatorThread: e.target.checked })} />} label="Keep the emulator on its own CPU" />
        )}
        <FormControlLabel
          sx={{ display: 'flex' }}
          control={<Checkbox checked={k.numa} disabled={!k.dedicated || !k.hugepages} onChange={e => set({ numa: e.target.checked })} />}
          label="Pass the host's NUMA layout to the guest (needs dedicated CPUs and huge pages)"
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        <TextField select size="small" label="Huge pages" value={k.hugepages} onChange={e => set({ hugepages: e.target.value, ...(e.target.value ? {} : { numa: false }) })} sx={{ width: 170 }} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">None</MenuItem>
          <MenuItem value="2Mi">2 MiB pages</MenuItem>
          <MenuItem value="1Gi">1 GiB pages</MenuItem>
        </TextField>
        <TextField
          type="number"
          size="small"
          label="Memory overcommit (%)"
          value={k.overcommitPercent}
          onChange={e => set({ overcommitPercent: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })}
          sx={{ width: 190 }}
          helperText="The host reserves this much less."
          inputProps={{ min: 0, max: 100 }}
          disabled={!!k.hugepages}
        />
        <TextField select size="small" label="Disk I/O threads" value={k.ioThreadsPolicy} onChange={e => set({ ioThreadsPolicy: e.target.value })} sx={{ width: 190 }} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">KubeVirt default</MenuItem>
          <MenuItem value="shared">One shared thread</MenuItem>
          <MenuItem value="auto">One per disk (auto)</MenuItem>
        </TextField>
      </Box>
      {gpus.length > 0 && (
        <TextField select size="small" label="GPU / device" value={k.gpu} onChange={e => set({ gpu: e.target.value })} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}>
          <MenuItem value="">None</MenuItem>
          {gpus.map(m => (
            <MenuItem key={m.resourceName} value={m.resourceName}>
              {m.label} {k8s && <K8sName>{m.resourceName}</K8sName>}
            </MenuItem>
          ))}
        </TextField>
      )}
      {unmet.length > 0 && (
        <Typography role="alert" sx={{ fontSize: 13, color: '#B7791F' }}>
          No host has {unmet.map(u => u.what.charAt(0).toLowerCase() + u.what.slice(1)).join(', ')} today: VMs of this flavor will wait until one does.
        </Typography>
      )}
      {k4all && nodeSettingsWords(unmet) && <K4allNodesHint what={nodeSettingsWords(unmet)!} />}
      <Typography sx={{ fontSize: 12.5, color: t.muted }}>Hugepage memory cannot be overcommitted, so overcommit is off with huge pages.</Typography>
    </Box>
  );
}

function knobDef(k: Knobs): Partial<FlavorDef> {
  return {
    cpuModel: k.cpuModel || undefined,
    dedicated: k.dedicated,
    isolateEmulatorThread: k.dedicated && k.isolateEmulatorThread,
    hugepages: k.hugepages || undefined,
    numa: k.numa && k.dedicated && !!k.hugepages,
    overcommitPercent: k.hugepages ? undefined : k.overcommitPercent || undefined,
    ioThreadsPolicy: k.ioThreadsPolicy || undefined,
    gpu: k.gpu || undefined,
  };
}

/** New family: a purpose, a memory-per-vCPU ratio, the sizes, the knobs, the scope. */
export function NewFamilyDialog({ d, existing, from, onClose }: { d: HangarData; existing: Family[]; from?: Family; onClose: () => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const portable = bestCommonModel(hostCpus(d.nodes)) ?? '';
  const seed = from?.flavors.find(f => !f.size.endsWith('1gi'));
  const seedRatio = seed && seed.vcpus ? seed.memBytes / seed.vcpus / GiB : 4;
  const [purpose, setPurpose] = React.useState(from ? 'custom' : 'balanced');
  const [label, setLabel] = React.useState(from ? `${from.label} (custom)` : 'Balanced');
  const [id, setId] = React.useState(from ? `${from.id.split('.')[0].slice(0, 6)}-c` : 'bal');
  const [idTouched, setIdTouched] = React.useState(!!from);
  const [ratio, setRatio] = React.useState(String(+seedRatio.toFixed(2)));
  const [sizes, setSizes] = React.useState<string[]>(['medium', 'large', 'xlarge', '2xlarge']);
  const [k, setK] = React.useState<Knobs>(knobsOf(seed));
  const [scope, setScope] = React.useState('');
  const [description, setDescription] = React.useState(from?.purpose ?? '');
  const set = (p: Partial<Knobs>) => setK(x => ({ ...x, ...p }));
  const choosePurpose = (pid: string) => {
    const p = PURPOSES.find(x => x.id === pid)!;
    setPurpose(pid);
    if (pid !== 'custom') {
      setLabel(p.label);
      if (!idTouched) setId(slugify(p.label).replace(/-/g, '').slice(0, 6) || 'fam');
      setRatio(String(p.memPerVcpuGiB));
      setDescription(p.help);
      setK(x => ({ ...x, cpuModel: p.portable ? portable : x.cpuModel, overcommitPercent: p.overcommitPercent ?? 0, dedicated: !!p.dedicated, hugepages: p.hugepages ?? '' }));
    }
  };
  const ids = existing.filter(f => f.namespace === scope).map(f => f.id);
  const idProblem = familyIdProblem(id, ids);
  const memPerVcpu = Number(ratio) * GiB;
  const defs = familyLadder(
    { familyId: id, familyLabel: label.trim() || id, description: description.trim() || undefined, purpose, namespace: scope || undefined, ...knobDef(k) } as any,
    memPerVcpu,
    sizes
  );
  const ok = !idProblem && memPerVcpu >= 0.25 * GiB && defs.length > 0 && label.trim().length > 0;
  const folders = d.namespaces.map(n => n.metadata.name).sort();
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth aria-labelledby="hangar-newfamily-title">
      <DialogTitle id="hangar-newfamily-title" sx={{ fontSize: 18 }}>
        {from ? `New family from ${from.label}` : 'New flavor family'}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2.25, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, alignItems: 'start' }}>
        <Box sx={{ display: 'grid', gap: 1.75, pt: 1 }}>
          {!from && (
            <Box>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 0.75 }}>Purpose</Typography>
              <ToggleButtonGroup size="small" exclusive value={purpose} onChange={(_, v) => v && choosePurpose(v)} aria-label="Purpose" sx={{ flexWrap: 'wrap' }}>
                {PURPOSES.map(p => (
                  <ToggleButton key={p.id} value={p.id} sx={{ textTransform: 'none' }}>
                    {p.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.5 }}>{PURPOSES.find(p => p.id === purpose)?.help}</Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <TextField size="small" label="Name" value={label} onChange={e => setLabel(e.target.value)} sx={{ flex: 1 }} />
            <TextField
              size="small"
              label="Short id"
              value={id}
              onChange={e => {
                setId(e.target.value.toLowerCase());
                setIdTouched(true);
              }}
              sx={{ width: 130 }}
              error={!!idProblem}
              helperText={idProblem ?? `Flavors: ${id}.large…`}
            />
          </Box>
          <TextField size="small" label="Description" value={description} onChange={e => setDescription(e.target.value)} multiline minRows={2} />
          <TextField type="number" size="small" label="Memory per vCPU (GiB)" value={ratio} onChange={e => setRatio(e.target.value)} inputProps={{ min: 0.25, step: 0.5 }} sx={{ width: 220 }} />
          <Box>
            <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>Sizes</Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
              {SIZE_LADDER.map(s => (
                <FormControlLabel
                  key={s.size}
                  control={<Checkbox size="small" checked={sizes.includes(s.size)} onChange={e => setSizes(x => (e.target.checked ? [...x, s.size] : x.filter(y => y !== s.size)))} />}
                  label={<Box sx={{ fontSize: 13 }}>{s.size}</Box>}
                />
              ))}
            </Box>
          </Box>
          <TextField select size="small" label="Available in" value={scope} onChange={e => setScope(e.target.value)} SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }} helperText={k8s ? <K8sName>{scope ? 'VirtualMachineInstancetype (namespaced)' : 'VirtualMachineClusterInstancetype'}</K8sName> : undefined}>
            <MenuItem value="">Every folder</MenuItem>
            {folders.map(f => (
              <MenuItem key={f} value={f}>
                Only folder {f}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
          <KnobFields k={k} set={set} d={d} memBytes={memPerVcpu} />
          <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.small}px` }}>
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, ...tabular, '& td, & th': { px: 1.25, py: 0.5, textAlign: 'left' }, '& th': { color: t.muted, fontWeight: 600 } }}>
              <thead>
                <tr>
                  <th>Flavor</th>
                  <th>vCPU</th>
                  <th>Memory</th>
                </tr>
              </thead>
              <tbody>
                {defs.map(x => (
                  <tr key={x.name}>
                    <td>{x.name}</td>
                    <td>{x.vcpus}</td>
                    <td>{formatBytes(x.memBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!ok}
          onClick={() => {
            quiet(createFlavors(defs, `Create flavor family ${label.trim() || id}`));
            onClose();
          }}
        >
          Create {defs.length} flavor{defs.length === 1 ? '' : 's'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Edit one of Hangar's flavors, or add a size to its family (`add`). */
export function FlavorDialog({ d, flavor, family, add, onClose }: { d: HangarData; flavor?: Flavor; family: Family; add?: boolean; onClose: () => void }) {
  const t = useTokens();
  const base = flavor ?? family.flavors[family.flavors.length - 1];
  const [size, setSize] = React.useState(add ? '' : base?.size ?? '');
  const [vcpus, setVcpus] = React.useState(String(add ? (base?.vcpus ?? 1) * 2 : base?.vcpus ?? 1));
  const [mem, setMem] = React.useState(String(+(((add ? (base?.memBytes ?? GiB) * 2 : base?.memBytes ?? GiB) / GiB)).toFixed(2)));
  const [k, setK] = React.useState<Knobs>(knobsOf(base));
  const set = (p: Partial<Knobs>) => setK(x => ({ ...x, ...p }));
  const name = add ? `${family.id}.${size}` : flavor!.name;
  const taken = add && family.flavors.some(f => f.size === size);
  const memBytes = Number(mem) * GiB;
  const ok = !!size && /^[a-z0-9][a-z0-9-]*$/.test(size) && !taken && Number(vcpus) >= 1 && memBytes >= 128 * 2 ** 20;
  const def: FlavorDef = {
    name,
    namespace: family.namespace || undefined,
    familyId: family.id,
    familyLabel: family.label,
    description: base?.description,
    size,
    vcpus: Math.round(Number(vcpus)),
    memBytes,
    ...knobDef(k),
  };
  const users = flavor ? d.vms.filter(v => v.spec?.instancetype?.name === flavor.name).length : 0;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-flavor-title">
      <DialogTitle id="hangar-flavor-title" sx={{ fontSize: 18 }}>
        {add ? `Add a size to ${family.label}` : `Flavor ${flavor!.name}`}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2 }}>
        <Box sx={{ display: 'flex', gap: 1.5, pt: 1, flexWrap: 'wrap' }}>
          <TextField size="small" label="Size" value={size} onChange={e => setSize(e.target.value.toLowerCase())} disabled={!add} sx={{ width: 140 }} error={taken} helperText={taken ? 'This size exists' : add ? `Flavor ${name}` : undefined} />
          <TextField type="number" size="small" label="vCPU" value={vcpus} onChange={e => setVcpus(e.target.value)} sx={{ width: 110 }} inputProps={{ min: 1 }} />
          <TextField type="number" size="small" label="Memory (GiB)" value={mem} onChange={e => setMem(e.target.value)} sx={{ width: 150 }} inputProps={{ min: 0.125, step: 0.5 }} />
        </Box>
        <KnobFields k={k} set={set} d={d} memBytes={memBytes} />
        {!add && users > 0 && (
          <Typography sx={{ fontSize: 13, color: t.muted }}>
            {users} VM{users === 1 ? '' : 's'} use{users === 1 ? 's' : ''} it: they keep the values they were sized with until they are sized again; new VMs get the new values.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!ok}
          onClick={() => {
            quiet(add ? createFlavors([def], `Add flavor ${name}`) : updateFlavor(flavor!.obj, def));
            onClose();
          }}
        >
          {add ? 'Add' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
