/*
 * Pieces shared by the Flavors view, the New VM wizard and Configure:
 * the CPU model choice with its portability verdict, and flavor pickers
 * grouped by family.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHangar } from '../../api/data';
import { useFolderFlavors } from '../../api/flavors';
import { cpuPresets, cpuVerdict, families, Family, Flavor, flavorHosts, flavorRequirements, hostCpus, KIND_CLUSTER, modelMatrix } from '../../model/flavors';
import { Obj } from '../../model/types';
import { formatBytes } from '../../model/units';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

export const TONE: Record<string, string> = { good: '#2FBF71', ok: '#3D8BFD', warn: '#B7791F', bad: '#E5484D' };

/** Cluster flavors plus the folder's own (when a folder is given). */
export function useFlavorFamilies(namespace?: string): { all: Obj[]; fams: Family[] } {
  const d = useHangar();
  const folder = useFolderFlavors();
  const all = React.useMemo(
    () => [...(folder.cluster ?? d.instancetypes), ...folder.instancetypes.filter(o => !namespace || o.metadata.namespace === namespace)],
    [d.instancetypes, folder.cluster, folder.instancetypes, namespace]
  );
  return { all, fams: React.useMemo(() => families(all), [all]) };
}

/** One line: what this CPU model means for where the VM runs and moves. */
export function CpuVerdictLine({ model, nodes }: { model: string; nodes: Obj[] }) {
  const t = useTokens();
  const v = cpuVerdict(model, hostCpus(nodes));
  const icon = v.live === 'all' ? 'mdi:swap-horizontal' : v.live === 'none' ? 'mdi:close-circle-outline' : v.live === 'same-cpu' ? 'mdi:lock-outline' : 'mdi:swap-horizontal-variant';
  return (
    <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start', fontSize: 13, color: t.text }}>
      <Icon icon={icon} width={17} style={{ color: TONE[v.tone], flex: 'none', marginTop: 1 }} />
      <span>{v.text}</span>
    </Box>
  );
}

/**
 * CPU model select: cluster default, presets (portable…), host model,
 * passthrough, then every model a host offers. `value` '' means "not set
 * on the VM" (the flavor's or the cluster default applies).
 */
export function CpuModelSelect({
  value,
  onChange,
  nodes,
  clusterDefault,
  lockedBy,
  label = 'CPU model',
  allowUnset = true,
  unsetLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  nodes: Obj[];
  clusterDefault?: string;
  /** The flavor sets the model: the VM cannot. */
  lockedBy?: { flavor: string; model: string };
  label?: string;
  allowUnset?: boolean;
  /** Text of the empty choice (default: "Cluster default (…)"). */
  unsetLabel?: string;
}) {
  const k8s = useK8s();
  const cpus = hostCpus(nodes);
  const presets = cpuPresets(cpus);
  const rows = modelMatrix(cpus);
  const effective = lockedBy?.model || value || clusterDefault || 'host-model';
  const presetFor = (m: string) => presets.find(p => p.model === m);
  if (lockedBy) {
    return (
      <Box sx={{ display: 'grid', gap: 0.75 }}>
        <TextField size="small" label={label} value={lockedBy.model} disabled helperText={`Set by the flavor ${lockedBy.flavor}.`} />
        <CpuVerdictLine model={lockedBy.model} nodes={nodes} />
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      <TextField
        select
        size="small"
        label={label}
        value={value}
        onChange={e => onChange(e.target.value)}
        SelectProps={{ displayEmpty: true, MenuProps: { PaperProps: { sx: { maxHeight: 420 } } } }}
        InputLabelProps={{ shrink: true }}
        helperText={k8s ? <K8sName>spec.template.spec.domain.cpu.model</K8sName> : undefined}
      >
        {allowUnset && <MenuItem value="">{unsetLabel ?? `Cluster default (${clusterDefault ? clusterDefault : 'host model'})`}</MenuItem>}
        <ListSubheader>Recommended</ListSubheader>
        {presets.map(p => (
          <MenuItem key={p.id} value={p.model}>
            <Box>
              <Box sx={{ fontSize: 14 }}>
                {p.label}
                {p.model !== 'host-model' && p.model !== 'host-passthrough' && (
                  <Box component="span" sx={{ color: 'text.secondary', ml: 0.75, fontSize: 12.5 }}>
                    {p.model}
                  </Box>
                )}
              </Box>
              <Box sx={{ fontSize: 12, color: 'text.secondary' }}>{p.help}</Box>
            </Box>
          </MenuItem>
        ))}
        <ListSubheader>Every model the hosts offer</ListSubheader>
        {rows
          .filter(r => !presetFor(r.model))
          .map(r => (
            <MenuItem key={r.model} value={r.model}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', width: '100%' }}>
                <span>{r.model}</span>
                <Box component="span" sx={{ color: 'text.secondary', fontSize: 12 }}>
                  {r.isa ?? ''}
                </Box>
                <Box component="span" sx={{ flex: 1 }} />
                <Box component="span" sx={{ color: 'text.secondary', fontSize: 12, ...tabular }}>
                  {r.everywhere ? 'every host' : `${r.hosts.length} of ${cpus.length} hosts`}
                </Box>
              </Box>
            </MenuItem>
          ))}
      </TextField>
      <CpuVerdictLine model={effective} nodes={nodes} />
    </Box>
  );
}

function flavorExtras(f: Flavor): string[] {
  const out: string[] = [];
  if (f.dedicated) out.push('dedicated CPUs');
  if (f.hugepages) out.push(`huge pages ${f.hugepages}`);
  if (f.overcommitPercent) out.push(`${f.overcommitPercent}% overcommit`);
  if (f.cpuModel) out.push(`CPU ${f.cpuModel}`);
  if (f.devices.length) out.push('GPU');
  return out;
}

/** Compact select (Configure): flavors grouped by family. Value is "kind/name". */
export function FlavorSelect({ value, onChange, namespace, nodes }: { value: string; onChange: (kind: string, name: string) => void; namespace?: string; nodes: Obj[] }) {
  const { fams } = useFlavorFamilies(namespace);
  return (
    <TextField
      select
      size="small"
      label="Flavor"
      value={value}
      onChange={e => {
        const [kind, name] = e.target.value.split('/');
        onChange(kind, name);
      }}
      SelectProps={{ MenuProps: { PaperProps: { sx: { maxHeight: 440 } } } }}
    >
      {fams.flatMap(fam => [
        <ListSubheader key={`h-${fam.namespace}/${fam.id}`}>
          {fam.label}
          {fam.namespace ? ` — folder ${fam.namespace}` : ''}
        </ListSubheader>,
        ...fam.flavors
          .filter(f => !f.size.endsWith('1gi'))
          .map(f => {
            const runs = flavorHosts(f, nodes).length;
            return (
              <MenuItem key={`${f.kind}/${f.name}`} value={`${f.kind}/${f.name}`} disabled={runs === 0}>
                <Box sx={{ display: 'flex', gap: 1, width: '100%', alignItems: 'baseline' }}>
                  <b>{f.size}</b>
                  <span>
                    {f.vcpus} vCPU, {formatBytes(f.memBytes)}
                  </span>
                  <Box component="span" sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {flavorExtras(f).join(', ')}
                  </Box>
                  <Box component="span" sx={{ flex: 1 }} />
                  <Box component="span" sx={{ color: runs ? 'text.secondary' : '#E5484D', fontSize: 12 }}>
                    {runs ? f.name : 'no host can run it'}
                  </Box>
                </Box>
              </MenuItem>
            );
          }),
      ])}
    </TextField>
  );
}

/** Wizard: families as rows of size buttons, with what each family needs from the hosts. */
export function FlavorPicker({
  value,
  onChange,
  namespace,
  nodes,
}: {
  value: { kind: string; name: string } | undefined;
  onChange: (v: { kind: string; name: string }) => void;
  namespace?: string;
  nodes: Obj[];
}) {
  const t = useTokens();
  const { fams } = useFlavorFamilies(namespace);
  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      {fams.map(fam => {
        const flavors = fam.flavors.filter(f => !f.size.endsWith('1gi'));
        if (!flavors.length) return null;
        const unmet = flavorRequirements(flavors[0], nodes).filter(r => r.hosts.length === 0);
        return (
          <Box key={`${fam.namespace}/${fam.id}`}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              {fam.label}
              {fam.namespace && <Box component="span" sx={{ color: t.muted, fontWeight: 400 }}> · folder {fam.namespace}</Box>}{' '}
              <Box component="span" sx={{ color: t.muted, fontWeight: 400 }}>
                {fam.purpose}
              </Box>
            </Typography>
            {unmet.length > 0 && (
              <Typography sx={{ fontSize: 12.5, color: '#B7791F' }}>No host has {unmet.map(u => u.what.charAt(0).toLowerCase() + u.what.slice(1)).join(' or ')}: these sizes cannot start here.</Typography>
            )}
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
              {flavors.map(f => {
                const on = value?.name === f.name && (value?.kind ?? KIND_CLUSTER) === f.kind;
                const can = flavorHosts(f, nodes).length > 0;
                return (
                  <Box
                    key={`${f.kind}/${f.name}`}
                    component="button"
                    disabled={!can}
                    onClick={() => onChange({ kind: f.kind, name: f.name })}
                    aria-pressed={on}
                    title={f.name}
                    sx={{
                      all: 'unset',
                      cursor: can ? 'pointer' : 'not-allowed',
                      opacity: can ? 1 : 0.45,
                      px: 1.25,
                      py: 0.75,
                      border: `1px solid ${on ? t.meterUsed : t.rule}`,
                      background: on ? t.selected : 'transparent',
                      borderRadius: `${t.radius.small}px`,
                      fontSize: 13,
                      ...tabular,
                      '&:focus-visible': { outline: `2px solid ${t.meterUsed}` },
                    }}
                  >
                    <b>{f.size}</b> {f.vcpus} vCPU, {formatBytes(f.memBytes)}
                    {f.cpuModel && (
                      <Box component="span" sx={{ color: t.muted, ml: 0.5 }}>
                        · {f.cpuModel}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
