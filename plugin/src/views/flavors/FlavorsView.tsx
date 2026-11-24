/*
 * Flavors: what a VM can be sized and shaped as.
 *   VM flavors      — families of sizes (KubeVirt instancetypes): balanced,
 *                     CPU or memory intensive, burstable, portable…; KubeVirt's
 *                     own are read-only, Hangar's can be created and edited.
 *   CPU models      — which CPU models each host offers, which ones every
 *                     host shares (portable: VMs move between Intel and AMD),
 *                     the cluster default, templates' portability.
 *   Guest OS tuning — KubeVirt preferences (read-only).
 * Deep links: /hangar/flavors/<section>.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { deleteFlavors, setClusterCpuModel, useFolderFlavors } from '../../api/flavors';
import { useK4all } from '../../api/k4all';
import { NOT_ALLOWED, useCan } from '../../api/permissions';
import {
  bestCommonModel,
  cpuPresets,
  cpuVerdict,
  effectiveCpuModel,
  families,
  Family,
  Flavor,
  flavorHosts,
  flavorOfVm,
  flavorRequirements,
  hostCpus,
  modelMatrix,
  nodeSettingsWords,
  setCpuModel,
  vendors,
  vmsUsing,
} from '../../model/flavors';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { isTemplate } from '../../model/vm';
import { hrefFor, vmHref } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { K4allNodesHint } from '../settings/K4allManaged';
import { FlavorDialog, NewFamilyDialog } from './dialogs';
import { CpuModelSelect, TONE } from './parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

export const FLAVOR_SECTIONS = ['vm', 'cpu', 'tuning'] as const;
export type FlavorSection = (typeof FLAVOR_SECTIONS)[number];

const LABELS: Record<FlavorSection, { label: string; icon: string }> = {
  vm: { label: 'VM flavors', icon: 'mdi:resize' },
  cpu: { label: 'CPU models', icon: 'mdi:cpu-64-bit' },
  tuning: { label: 'Guest OS tuning', icon: 'mdi:tune-variant' },
};

export function flavorSection(a?: string): FlavorSection {
  return (FLAVOR_SECTIONS as readonly string[]).includes(a ?? '') ? (a as FlavorSection) : 'vm';
}

export function FlavorsView({ section: raw }: { section?: string }) {
  const d = useHangar();
  const t = useTokens();
  const history = useHistory();
  const folder = useFolderFlavors();
  const section = flavorSection(raw);
  const all = React.useMemo(() => [...(folder.cluster ?? d.instancetypes), ...folder.instancetypes], [d.instancetypes, folder.cluster, folder.instancetypes]);
  const fams = React.useMemo(() => families(all), [all]);
  const cpus = hostCpus(d.nodes);
  const portable = bestCommonModel(cpus);
  const counts: Record<FlavorSection, number> = {
    vm: fams.length,
    cpu: modelMatrix(cpus).length,
    tuning: d.preferences.length + folder.preferences.length,
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          <Icon icon="mdi:resize" width={22} style={{ verticalAlign: -3, marginRight: 8, color: t.muted }} />
          Flavors
        </Typography>
        <Typography sx={{ color: t.muted, fontSize: 14, ...tabular }}>
          {fams.length} famil{fams.length === 1 ? 'y' : 'ies'}, {all.length} flavors; {vendors(cpus).join(' and ')} hosts
          {portable ? `, portable CPU model ${portable}` : ''}
        </Typography>
      </Box>
      <Box sx={{ borderBottom: `1px solid ${t.rule}`, px: 1 }}>
        <Tabs
          value={section}
          onChange={(_, v: FlavorSection) => history.push(hrefFor('flavors', v))}
          aria-label="Flavor sections"
          variant="scrollable"
          scrollButtons={false}
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, textTransform: 'none', fontSize: 14, minWidth: 0, px: 2 } }}
        >
          {FLAVOR_SECTIONS.map(s => (
            <Tab
              key={s}
              value={s}
              id={`hangar-flavors-tab-${s}`}
              aria-controls={`hangar-flavors-panel-${s}`}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <Icon icon={LABELS[s].icon} width={17} />
                  {LABELS[s].label}
                  <Box component="span" sx={{ color: t.muted, fontSize: 12.5, ...tabular }}>
                    {counts[s]}
                  </Box>
                </Box>
              }
            />
          ))}
        </Tabs>
      </Box>
      <Box role="tabpanel" id={`hangar-flavors-panel-${section}`} aria-labelledby={`hangar-flavors-tab-${section}`} sx={{ p: 2, flex: 1 }}>
        {section === 'vm' && <VmFlavors d={d} fams={fams} />}
        {section === 'cpu' && <CpuModels d={d} all={all} />}
        {section === 'tuning' && <Tuning d={d} folderPrefs={folder.preferences} />}
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------ VM flavors */

function extras(f: Flavor): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (f.dedicated) out.push(<Tag key="d">dedicated CPUs</Tag>);
  if (f.isolateEmulatorThread) out.push(<Tag key="i">isolated emulator</Tag>);
  if (f.hugepages) out.push(<Tag key="h">huge pages {f.hugepages}</Tag>);
  if (f.numa) out.push(<Tag key="n">NUMA</Tag>);
  if (f.realtime) out.push(<Tag key="r">real time</Tag>);
  if (f.overcommitPercent) out.push(<Tag key="o">{f.overcommitPercent}% overcommit</Tag>);
  if (f.devices.length) out.push(<Tag key="g">GPU</Tag>);
  return out;
}

function VmFlavors({ d, fams }: { d: HangarData; fams: Family[] }) {
  const k4all = useK4all();
  const t = useTokens();
  const k8s = useK8s();
  const [q, setQ] = React.useState('');
  const [variants, setVariants] = React.useState(false);
  const canCreate = useCan({ verb: 'create', group: 'instancetype.kubevirt.io', resource: 'virtualmachineclusterinstancetypes' });
  const shown = fams
    .map(f => ({ ...f, flavors: f.flavors.filter(x => (variants || !x.size.endsWith('1gi')) && (!q || `${f.label} ${x.name} ${x.size}`.toLowerCase().includes(q.toLowerCase()))) }))
    .filter(f => f.flavors.length);
  const newFamily = (from?: Family) => openDialog(close => <NewFamilyDialog d={d} existing={fams} from={from} onClose={close} />);
  const deleteFamily = async (fam: Family) => {
    const used = fam.flavors.flatMap(f => vmsUsing(f, d.vms));
    if (used.length) {
      await confirm({
        title: `${fam.label} is in use`,
        body: (
          <p>
            {used.length} VM{used.length === 1 ? '' : 's'} use{used.length === 1 ? 's' : ''} it ({used.slice(0, 5).map(v => v.metadata.name).join(', ')}
            {used.length > 5 ? '…' : ''}). Size them with another flavor first.
          </p>
        ),
        confirm: 'OK',
      });
      return;
    }
    const ok = await confirm({
      title: `Delete the family ${fam.label}?`,
      body: <p>Its {fam.flavors.length} flavors are deleted. No VM uses them.</p>,
      confirm: 'Delete',
      danger: true,
      typeToConfirm: fam.id,
    });
    if (ok) quiet(deleteFlavors(fam.flavors.map(f => f.obj), `Delete flavor family ${fam.label}`));
  };
  const deleteOne = async (f: Flavor) => {
    const used = vmsUsing(f, d.vms);
    if (used.length) {
      await confirm({ title: `${f.name} is in use`, body: <p>Used by {used.map(v => v.metadata.name).join(', ')}.</p>, confirm: 'OK' });
      return;
    }
    const ok = await confirm({ title: `Delete the flavor ${f.name}?`, confirm: 'Delete', danger: true });
    if (ok) quiet(deleteFlavors([f.obj], `Delete flavor ${f.name}`));
  };
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="contained" disableElevation startIcon={<Icon icon="mdi:plus" width={18} />} onClick={() => newFamily()} disabled={!canCreate} title={canCreate ? undefined : NOT_ALLOWED} sx={{ textTransform: 'none' }}>
          New family
        </Button>
        <TextField size="small" placeholder="Search flavors" value={q} onChange={e => setQ(e.target.value)} inputProps={{ 'aria-label': 'Search flavors' }} sx={{ width: 260 }} />
        <FormControlLabel control={<Switch size="small" checked={variants} onChange={e => setVariants(e.target.checked)} />} label={<Box sx={{ fontSize: 13 }}>Show 1 GiB huge-page variants</Box>} />
      </Box>
      {shown.map(fam => {
        const first = fam.flavors[0];
        const unmet = flavorRequirements(first, d.nodes).filter(r => r.hosts.length < d.nodes.length);
        const users = fam.flavors.reduce((s, f) => s + vmsUsing(f, d.vms).length, 0);
        return (
          <Panel
            key={`${fam.namespace}/${fam.id}`}
            title={
              <Box component="span" sx={{ display: 'inline-flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                {fam.label}
                {fam.shipped ? <Tag>KubeVirt</Tag> : fam.ours ? <Tag tone="accent">Custom</Tag> : <Tag>Other</Tag>}
                {fam.namespace && <Tag>folder {fam.namespace}</Tag>}
                {k8s && <K8sName>{fam.id}</K8sName>}
              </Box>
            }
            icon={fam.icon}
            dense
            actions={
              <>
                {users > 0 && (
                  <Box component="span" sx={{ fontSize: 12.5, color: t.muted, ...tabular }}>
                    {users} VM{users === 1 ? '' : 's'}
                  </Box>
                )}
                {fam.ours ? (
                  <>
                    <Button size="small" sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={16} />} disabled={!canCreate} onClick={() => openDialog(close => <FlavorDialog d={d} family={fam} add onClose={close} />)}>
                      Add size
                    </Button>
                    <IconAction icon="mdi:delete-outline" label={`Delete the family ${fam.label}`} disabled={!canCreate} onClick={() => deleteFamily(fam)} />
                  </>
                ) : (
                  <Button size="small" sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:content-copy" width={15} />} disabled={!canCreate} onClick={() => newFamily(fam)}>
                    Make a custom copy
                  </Button>
                )}
              </>
            }
          >
            <Box sx={{ px: 2, pt: 1.25, pb: 0.5, fontSize: 13.5, color: t.muted }}>
              {fam.purpose}
              {unmet.map(u => (
                <Box key={u.what} sx={{ color: u.hosts.length ? t.muted : '#B7791F', mt: 0.5, display: 'flex', gap: 0.75, alignItems: 'center' }}>
                  <Icon icon={u.hosts.length ? 'mdi:information-outline' : 'mdi:alert-outline'} width={15} />
                  {u.hosts.length ? `${u.what}: on ${u.hosts.join(', ')} only.` : `${u.what}: no host has it, these VMs cannot start here.`}
                </Box>
              ))}
              {k4all && nodeSettingsWords(unmet) && <K4allNodesHint what={nodeSettingsWords(unmet)!} sx={{ display: 'block', mt: 0.5 }} />}
            </Box>
            <Box
              component="table"
              sx={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13.5,
                ...tabular,
                '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 2, py: 0.75 },
                '& td': { px: 2, py: 0.75, borderTop: `1px solid ${t.rule}`, verticalAlign: 'top' },
              }}
            >
              <thead>
                <tr>
                  <th>Size</th>
                  <th>vCPU</th>
                  <th>Memory</th>
                  <th>CPU model</th>
                  <th>Extras</th>
                  <th>Runs on</th>
                  <th>VMs</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {fam.flavors.map(f => {
                  const hosts = flavorHosts(f, d.nodes);
                  const used = vmsUsing(f, d.vms);
                  return (
                    <tr key={`${f.kind}/${f.namespace ?? ''}/${f.name}`}>
                      <td>
                        <b>{f.size}</b>
                        <Box component="span" sx={{ color: t.muted, ml: 1, fontSize: 12.5 }}>
                          {f.name}
                        </Box>
                      </td>
                      <td>{f.vcpus}</td>
                      <td>{formatBytes(f.memBytes)}</td>
                      <td>{f.cpuModel ?? <Box component="span" sx={{ color: t.muted }}>VM's choice</Box>}</td>
                      <td>
                        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>{extras(f).length ? extras(f) : <Box component="span" sx={{ color: t.muted }}>—</Box>}</Box>
                      </td>
                      <td>
                        <Box component="span" sx={{ color: hosts.length ? (hosts.length === d.nodes.length ? t.text : '#B7791F') : '#E5484D' }} title={hosts.join(', ')}>
                          {hosts.length === d.nodes.length ? 'every host' : hosts.length ? `${hosts.length} of ${d.nodes.length}` : 'none'}
                        </Box>
                      </td>
                      <td>
                        {used.length ? (
                          <Box component="span" title={used.map(v => `${v.metadata.namespace}/${v.metadata.name}`).join(', ')}>
                            {used.slice(0, 3).map((v, i) => (
                              <React.Fragment key={v.metadata.uid ?? v.metadata.name}>
                                {i > 0 && ', '}
                                <Box component={RouterLink} to={vmHref(v.metadata.namespace as string, v.metadata.name)} sx={{ color: 'inherit' }}>
                                  {v.metadata.name}
                                </Box>
                              </React.Fragment>
                            ))}
                            {used.length > 3 && ` +${used.length - 3}`}
                          </Box>
                        ) : (
                          <Box component="span" sx={{ color: t.muted }}>—</Box>
                        )}
                      </td>
                      <Box component="td" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {f.ours && (
                          <>
                            <IconAction icon="mdi:pencil-outline" label={`Edit ${f.name}`} disabled={!canCreate} onClick={() => openDialog(close => <FlavorDialog d={d} flavor={f} family={fam} onClose={close} />)} />
                            <IconAction icon="mdi:delete-outline" label={`Delete ${f.name}`} disabled={!canCreate} onClick={() => deleteOne(f)} />
                          </>
                        )}
                      </Box>
                    </tr>
                  );
                })}
              </tbody>
            </Box>
          </Panel>
        );
      })}
    </Box>
  );
}

/* ------------------------------------------------------------ CPU models */

function CpuModels({ d, all }: { d: HangarData; all: Obj[] }) {
  const t = useTokens();
  const k8s = useK8s();
  const cpus = hostCpus(d.nodes);
  const rows = modelMatrix(cpus);
  const presets = cpuPresets(cpus);
  const portable = bestCommonModel(cpus);
  const kv = d.kubevirt;
  const current: string = kv?.spec?.configuration?.cpuModel ?? '';
  const [def, setDef] = React.useState(current);
  React.useEffect(() => setDef(current), [current]);
  const [onlyCommon, setOnlyCommon] = React.useState(false);
  const canPatch = useCan(kv ? { verb: 'patch', group: 'kubevirt.io', resource: 'kubevirts', namespace: kv.metadata.namespace } : null);
  const canEditVms = useCan({ verb: 'update', group: 'kubevirt.io', resource: 'virtualmachines' });
  const templates = d.vms.filter(isTemplate);
  const shortHost = (h: string) => h.split('.')[0];
  const saveDefault = async () => {
    if (!kv) return;
    const ok = await confirm({
      title: def ? `Make ${def} the cluster default CPU model?` : 'Go back to KubeVirt\'s default (host model)?',
      body: (
        <>
          <p>VMs that do not choose their own model get it when they start next. Running VMs keep their CPU until they restart.</p>
          <p>{cpuVerdict(def || 'host-model', cpus).text}</p>
        </>
      ),
      confirm: 'Change default',
    });
    if (ok) quiet(setClusterCpuModel(kv, def));
  };
  const makePortable = async (vm: Obj) => {
    if (!portable) return;
    const ok = await confirm({
      title: `Make ${vm.metadata.name} portable?`,
      body: <p>VMs deployed from it get the CPU model {portable}: they can start on every host and move between them while running. Existing VMs do not change.</p>,
      confirm: 'Make portable',
    });
    if (ok) quiet(A.updateVm(vm, `CPU model ${portable}`, setCpuModel(vm, portable)));
  };
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: `repeat(${Math.min(cpus.length, 3)}, minmax(0,1fr))` } }}>
        {cpus.map(c => (
          <Box key={c.host} sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, p: 1.75, background: t.surface }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Icon icon="mdi:server" width={18} style={{ color: t.muted }} />
              <Box component={RouterLink} to={hrefFor('host', c.host)} sx={{ fontWeight: 600, fontSize: 14, color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                {c.host}
              </Box>
              <Box sx={{ flex: 1 }} />
              <Tag tone={c.vendor === 'AMD' ? 'warn' : 'accent'}>{c.vendor ?? 'unknown maker'}</Tag>
            </Box>
            <Box sx={{ mt: 1, fontSize: 13.5, ...tabular }}>
              Host model <b>{c.hostModel ?? '—'}</b>
              <Box component="span" sx={{ color: t.muted }}> · {c.models.size} named models</Box>
            </Box>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1.2fr) minmax(0,1fr)' }, alignItems: 'start' }}>
        <Panel title="What a VM's CPU can be" icon="mdi:swap-horizontal">
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            {presets.map(p => {
              const v = cpuVerdict(p.model, cpus);
              return (
                <Box key={p.id} sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}>
                  <Box sx={{ width: 10, height: 10, mt: 0.75, borderRadius: '50%', background: TONE[v.tone], flex: 'none' }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ fontWeight: 600, fontSize: 14 }}>
                      {p.label}
                      {p.model !== 'host-model' && p.model !== 'host-passthrough' && <Box component="span" sx={{ fontWeight: 400, color: t.muted, ml: 0.75 }}>{p.model}</Box>}
                    </Box>
                    <Box sx={{ fontSize: 13, color: t.muted }}>{p.help}</Box>
                    <Box sx={{ fontSize: 13 }}>{v.text}</Box>
                  </Box>
                </Box>
              );
            })}
            <Typography sx={{ fontSize: 12.5, color: t.muted }}>
              A named model hides the host's newer instructions from the guest: slightly slower, but the VM keeps the same CPU wherever it goes. Host model copies the starting host's CPU; host passthrough gives the exact CPU and every instruction.
            </Typography>
          </Box>
        </Panel>

        <Box sx={{ display: 'grid', gap: 2 }}>
          <Panel title="Cluster default" icon="mdi:cog-outline">
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              <Typography sx={{ fontSize: 13.5 }}>
                Today: <b>{current || 'Host model (KubeVirt\'s default)'}</b>. VMs and flavors that set their own model keep it.
                {k8s && (
                  <>
                    {' '}
                    <K8sName>kubevirt.spec.configuration.cpuModel</K8sName>
                  </>
                )}
              </Typography>
              <CpuModelSelect value={def} onChange={setDef} nodes={d.nodes} unsetLabel="Host model (KubeVirt's default)" label="Default CPU model" />
              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                {current && (
                  <Button size="small" color="inherit" sx={{ textTransform: 'none' }} disabled={!canPatch} onClick={() => setDef('')}>
                    Back to host model
                  </Button>
                )}
                <Button size="small" variant="contained" disableElevation sx={{ textTransform: 'none' }} disabled={!canPatch || def === current || (!def && !current)} title={canPatch ? undefined : NOT_ALLOWED} onClick={saveDefault}>
                  Save default
                </Button>
              </Box>
            </Box>
          </Panel>

          <Panel title="Templates" icon="mdi:file-document-outline" dense>
            {templates.length === 0 && <Box sx={{ p: 2, color: t.muted, fontSize: 13.5 }}>No templates yet.</Box>}
            {templates.map(vm => {
              const fl = flavorOfVm(vm, all);
              const own = vm.spec?.template?.spec?.domain?.cpu?.model as string | undefined;
              const model = effectiveCpuModel(own, fl?.spec?.cpu?.model, current);
              const v = cpuVerdict(model, cpus);
              const isPortable = v.live === 'all' && v.runsOn.length === cpus.length && model !== 'host-passthrough';
              return (
                <Box key={vm.metadata.uid ?? vm.metadata.name} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', background: TONE[isPortable ? 'good' : v.tone === 'bad' ? 'bad' : 'warn'], flex: 'none' }} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box component={RouterLink} to={vmHref(vm.metadata.namespace as string, vm.metadata.name, 'configure')} sx={{ fontWeight: 600, fontSize: 14, color: 'inherit' }}>
                      {vm.metadata.name}
                    </Box>
                    <Box sx={{ fontSize: 12.5, color: t.muted }}>
                      {model === 'host-model' ? 'Host model' : model}
                      {fl?.spec?.cpu?.model ? ` (from flavor ${fl.metadata.name})` : own ? '' : current ? ' (cluster default)' : ' (KubeVirt default)'} — {isPortable ? 'portable: every host, live' : v.text}
                    </Box>
                  </Box>
                  {!isPortable && portable && !fl?.spec?.cpu?.model && (
                    <Button size="small" sx={{ textTransform: 'none', whiteSpace: 'nowrap' }} disabled={!canEditVms} onClick={() => makePortable(vm)}>
                      Make portable
                    </Button>
                  )}
                </Box>
              );
            })}
          </Panel>
        </Box>
      </Box>

      <Panel
        title="Models by host"
        icon="mdi:table"
        dense
        actions={<FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={onlyCommon} onChange={e => setOnlyCommon(e.target.checked)} />} label={<Box sx={{ fontSize: 13 }}>Only models every host has</Box>} />}
      >
        <Box sx={{ overflowX: 'auto' }}>
          <Box
            component="table"
            sx={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13.5,
              ...tabular,
              '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 1.5, py: 0.75, whiteSpace: 'nowrap' },
              '& td': { px: 1.5, py: 0.5, borderTop: `1px solid ${t.rule}` },
            }}
          >
            <thead>
              <tr>
                <th>Model</th>
                <th>Maker</th>
                <th>Instructions</th>
                {cpus.map(c => (
                  <Box component="th" key={c.host} sx={{ textAlign: 'center !important' }} title={c.host}>
                    {shortHost(c.host)}
                    <Box sx={{ fontWeight: 400, fontSize: 11.5 }}>{c.vendor}</Box>
                  </Box>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows
                .filter(r => !onlyCommon || r.everywhere)
                .map(r => (
                  <tr key={r.model}>
                    <td>
                      {r.model}
                      {r.model === portable && <Box component="span" sx={{ ml: 1 }}><Tag tone="accent">portable</Tag></Box>}
                    </td>
                    <td>{r.vendor}</td>
                    <td>{r.isa ?? '—'}</td>
                    {cpus.map(c => (
                      <Box component="td" key={c.host} sx={{ textAlign: 'center' }}>
                        {c.models.has(r.model) ? <Icon icon="mdi:check" width={16} style={{ color: '#2FBF71' }} aria-label="available" /> : <Box component="span" sx={{ color: t.rule }}>·</Box>}
                      </Box>
                    ))}
                  </tr>
                ))}
            </tbody>
          </Box>
        </Box>
      </Panel>
    </Box>
  );
}

/* -------------------------------------------------------- Guest OS tuning */

function prefSummary(p: Obj): string[] {
  const s = p.spec ?? {};
  const out: string[] = [];
  if (s.firmware?.preferredUseSecureBoot) out.push('UEFI Secure Boot');
  else if (s.firmware?.preferredUseEfi || s.firmware?.preferredEfi) out.push('UEFI');
  if (s.devices?.preferredDiskBus) out.push(`disks ${s.devices.preferredDiskBus}`);
  if (s.devices?.preferredInterfaceModel) out.push(`network ${s.devices.preferredInterfaceModel}`);
  if (s.devices?.preferredTPM || s.devices?.preferredTPM === null) out.push('TPM');
  if (s.cpu?.preferredCPUTopology) out.push(`CPU as ${s.cpu.preferredCPUTopology.replace('preferred', '').toLowerCase()}`);
  if (s.requirements?.cpu?.guest) out.push(`≥ ${s.requirements.cpu.guest} vCPU`);
  if (s.requirements?.memory?.guest) out.push(`≥ ${s.requirements.memory.guest}`);
  return out;
}

function Tuning({ d, folderPrefs }: { d: HangarData; folderPrefs: Obj[] }) {
  const t = useTokens();
  const k8s = useK8s();
  const prefs = [...d.preferences, ...folderPrefs].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  const users = (p: Obj) => d.vms.filter(v => v.spec?.preference?.name === p.metadata.name && (!p.metadata.namespace || p.metadata.namespace === v.metadata.namespace)).length;
  return (
    <Panel title="Guest OS tuning" icon="mdi:tune-variant" dense>
      <Typography sx={{ px: 2, pt: 1.25, pb: 1, fontSize: 13.5, color: t.muted }}>
        Device and firmware defaults per guest OS, chosen by the wizard from the OS you pick. KubeVirt ships and updates them.
      </Typography>
      <Box
        component="table"
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13.5,
          ...tabular,
          '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 2, py: 0.75 },
          '& td': { px: 2, py: 0.6, borderTop: `1px solid ${t.rule}`, verticalAlign: 'top' },
        }}
      >
        <thead>
          <tr>
            <th>Guest OS</th>
            <th>Tuning</th>
            <th>VMs</th>
          </tr>
        </thead>
        <tbody>
          {prefs.map(p => (
            <tr key={`${p.metadata.namespace ?? ''}/${p.metadata.name}`}>
              <td>
                {p.metadata.annotations?.['openshift.io/display-name'] ?? p.metadata.annotations?.['instancetype.kubevirt.io/displayName'] ?? p.metadata.name}
                {(k8s || !p.metadata.annotations?.['openshift.io/display-name']) && (
                  <Box component="span" sx={{ ml: 1 }}>
                    <K8sName>{p.metadata.namespace ? `${p.metadata.namespace}/` : ''}{p.metadata.name}</K8sName>
                  </Box>
                )}
              </td>
              <td>{prefSummary(p).join(', ') || '—'}</td>
              <td>{users(p) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </Box>
    </Panel>
  );
}
