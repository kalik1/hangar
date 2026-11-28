/*
 * Publish ports: which ports (presets, a list or a range, TCP or UDP), how
 * (inside the cluster, on every host's port, on an address of its own, or
 * a web address through the ingress), and the details of each way. It only builds the request: the Published ports
 * panel runs it and shows its progress on a row.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';
import { useHangar } from '../../api/data';
import { useK4all } from '../../api/k4all';
import { PublishRequest, servicesForNodePorts } from '../../api/ports';
import { WebRequest, WebWorld } from '../../api/web';
import {
  autoPool,
  conflictOf,
  ipProblem,
  LbChoice,
  missingFromList,
  Mode,
  MODES,
  needsTemplateLabel,
  nodePortProblem,
  noPoolHelp,
  parsePorts,
  poolUses,
  portName,
  presetName,
  presetsFor,
  Proto,
  serviceName,
  ServicePortIn,
} from '../../model/ports';
import { Obj, VM } from '../../model/types';
import { webPortProblem } from '../../model/web';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { Note } from '../storage/parts';
import { Help } from './configParts';
import { VmPorts } from './portParts';
import { WebChoice, WebFields } from './WebFields';

/** What the panel runs: Services (req) or a web address (web). */
export interface PublishSubmit {
  req?: PublishRequest;
  web?: WebRequest;
  /** "SSH (22/TCP)", "51 ports (10000-10050/UDP)", "https://web1-lab.192.0.2.10.nip.io/". */
  label: string;
}

/** A way of publishing: a Service type, or a web address through the ingress. */
type Way = Mode | 'web';

const MODE_HELP: Record<Way, string> = {
  cluster: 'Other pods and VMs of the cluster reach it by a DNS name. Not from outside.',
  host: 'Any host of the cluster answers on a port from 30000 to 32767 and passes the traffic to the VM, wherever it runs.',
  address: 'The VM gets an address of its own on the LAN, from an address pool, with the guest\'s own port numbers.',
  web: "An HTTP port of the guest at https://<name>/ through the cluster's ingress, with a certificate.",
};

export function PublishDialog({
  vm,
  ports,
  web,
  canWeb,
  canEditVm,
  onClose,
  onSubmit,
}: {
  vm: VM;
  ports: VmPorts;
  /** The folder's web addresses and choices; undefined without the web way. */
  web?: WebWorld;
  /** Why the user may not make a web address; null when they may. */
  canWeb?: string | null;
  canEditVm: boolean;
  onClose: () => void;
  onSubmit: (s: PublishSubmit) => void;
}) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const k4all = useK4all();
  const presets = presetsFor(vmOs(vm, d).id);
  const vmNs = vm.metadata.namespace as string;
  const nsLabels = d.namespaces.find(n => n.metadata.name === vmNs)?.metadata.labels ?? {};
  const uses = poolUses(ports.pools, vm, nsLabels);
  const usable = uses.filter(u => u.ok);
  const poolsDenied = ports.poolsWorld.metallb.denied || ports.poolsWorld.cilium.denied;
  const metallbServed = ports.poolsWorld.metallb.served;
  const lbOff = ports.poolsWorld.loaded && !usable.length && !poolsDenied;
  const existing = (m: Mode) => ports.world.services.find(s => s.metadata.name === serviceName(vm.metadata.name, m) && s.metadata.namespace === vmNs);

  const [preset, setPreset] = React.useState(presets[0].id);
  const [text, setText] = React.useState(presets[0].ports.map(p => p.port).join(', '));
  const [proto, setProto] = React.useState<Proto>('TCP');
  const [name, setName] = React.useState('');
  const [way, setWay] = React.useState<Way>(usable.length ? 'address' : 'host');
  // A web address is served by the VM's ClusterIP Service.
  const mode: Mode = way === 'web' ? 'cluster' : way;
  const [webChoice, setWebChoice] = React.useState<{ choice: WebChoice | null; problem: string | null }>({ choice: null, problem: null });
  const [outside, setOutside] = React.useState('');
  const [nodeAuto, setNodeAuto] = React.useState(true);
  const [nodePort, setNodePort] = React.useState('');
  const [pool, setPool] = React.useState('auto');
  const [ipAuto, setIpAuto] = React.useState(true);
  const [ip, setIp] = React.useState('');
  const [keepSrc, setKeepSrc] = React.useState<boolean | null>(null);
  const [nodeServices, setNodeServices] = React.useState<{ items: Obj[]; scope: 'cluster' | 'folder' } | null>(null);
  React.useEffect(() => {
    let alive = true;
    servicesForNodePorts(vmNs).then(r => alive && setNodeServices(r));
    return () => {
      alive = false;
    };
  }, [vmNs]);

  const parsed = parsePorts(text, proto);
  const single = parsed.ports.length === 1;
  const svcNow = existing(mode);
  const keep = keepSrc ?? svcNow?.spec?.externalTrafficPolicy === 'Local';
  const outsideN = outside.trim() ? Number(outside) : NaN;
  const clusterSvc = existing('cluster');
  // The guest port the ClusterIP Service already carries (named): a web address reuses it.
  const reuse = way === 'web' && single ? ((clusterSvc?.spec?.ports ?? []) as any[]).find(x => Number(x.targetPort ?? x.port) === parsed.ports[0].port && (x.protocol ?? 'TCP') === 'TCP' && x.name) : undefined;
  const nameIn = (p: { port: number; protocol: Proto }) => {
    const n = single && name.trim() ? portName(p, name.trim()) : portName(p, presetName(p.port));
    // A web address needs a named port: never one the Service already has for another guest port.
    return way === 'web' && ((clusterSvc?.spec?.ports ?? []) as any[]).some(x => x.name === n) ? portName(p) : n;
  };
  const portsIn: ServicePortIn[] = parsed.ports.map(p => ({
    name: nameIn(p),
    port: single && mode !== 'host' && way !== 'web' && outside.trim() ? outsideN : p.port,
    targetPort: p.port,
    protocol: p.protocol,
    ...(mode === 'host' && single && !nodeAuto && nodePort.trim() ? { nodePort: Number(nodePort) } : {}),
  }));
  const chosenPool = pool === 'auto' ? autoPool(uses) : uses.find(u => `${u.pool.kind}/${u.pool.name}` === pool)?.pool ?? null;
  const guestWants = parsed.ports;
  const missing = missingFromList(ports.access.list, guestWants);
  const templateLabel = needsTemplateLabel(vm, ports.selector);

  const webBlocked = way === 'web' ? canWeb ?? (single ? webPortProblem(parsed.ports[0].port, parsed.ports[0].protocol) : 'A web address is one port of the guest') : null;
  let problem: string | null = parsed.error ?? null;
  if (!problem && webBlocked) problem = webBlocked;
  if (!problem && single && mode !== 'host' && way !== 'web' && outside.trim() && !(Number.isInteger(outsideN) && outsideN >= 1 && outsideN <= 65535)) problem = 'The outside port goes from 1 to 65535';
  if (!problem && mode === 'host' && single && !nodeAuto) problem = nodePortProblem(Number(nodePort), nodeServices?.items ?? []);
  if (!problem && !reuse) problem = conflictOf(portsIn, mode, [...ports.services, ...(svcNow && !ports.services.includes(svcNow) ? [svcNow] : [])], vm.metadata.name);
  if (!problem && way === 'web') problem = webChoice.problem ?? (webChoice.choice ? null : 'Choose the web address');
  if (!problem && mode === 'address' && !svcNow) {
    if (lbOff) problem = 'No address pool serves VMs';
    else if (!ipAuto) problem = ipProblem(ip.trim(), chosenPool, ports.world.services);
  }

  const lb = (): LbChoice | undefined => {
    if (mode !== 'address' || svcNow) return undefined;
    if (!chosenPool) return ipAuto ? undefined : { ip: ip.trim() };
    return {
      controller: chosenPool.kind,
      pool: chosenPool.kind === 'metallb' ? chosenPool.name : undefined,
      ip: ipAuto ? undefined : ip.trim(),
      // With MetalLB running too, Cilium's class keeps MetalLB from fighting over the Service.
      ciliumClass: chosenPool.kind === 'cilium' && metallbServed,
    };
  };

  const label = (() => {
    const ps = parsed.ports;
    if (!ps.length) return '';
    const preName = presets.find(p => p.id === preset && p.ports.length === ps.length && p.ports.every((x, i) => x.port === ps[i].port));
    const what = preName ? preName.label : single && name.trim() ? name.trim() : '';
    const range = single ? `${ps[0].port}/${ps[0].protocol}` : `${ps[0].port}–${ps[ps.length - 1].port}`;
    return what ? `${what} (${single ? range : ps.map(p => p.port).join(', ')})` : single ? `port ${range}` : `${ps.length} ports (${range})`;
  })();

  const submit = () => {
    if (problem || !parsed.ports.length) return;
    const listAdd = missing.length && canEditVm && ports.access.nic ? { nic: ports.access.nic, ports: missing } : undefined;
    if (way === 'web' && webChoice.choice) {
      const c = webChoice.choice;
      onSubmit({
        label: `https://${c.host}/`,
        web: {
          vm,
          port: reuse ? { ...portsIn[0], name: reuse.name } : portsIn[0],
          selector: ports.selector,
          listAdd,
          templateLabel: templateLabel && canEditVm,
          host: c.host,
          className: c.className,
          traefik: c.traefik,
          issuer: c.issuer,
          what: label,
        },
      });
      onClose();
      return;
    }
    onSubmit({
      label,
      req: {
        vm,
        mode,
        ports: portsIn,
        selector: ports.selector,
        lb: lb(),
        keepSourceIp: mode === 'cluster' ? undefined : keep,
        listAdd,
        templateLabel: templateLabel && canEditVm,
        what: label,
      },
    });
    onClose();
  };

  const pick = (id: string) => {
    setPreset(id);
    const p = presets.find(x => x.id === id);
    if (p) {
      setText(p.ports.map(x => x.port).join(', '));
      setProto('TCP');
      setName('');
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-publish-title">
      <DialogTitle id="hangar-publish-title" sx={{ fontSize: 18 }}>
        Publish ports of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '4px !important' }}>
        <Box>
          <Box sx={{ fontSize: 13, color: t.muted, mb: 0.75 }}>Ports</Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {presets.map(p => (
              <Chip
                key={p.id}
                label={`${p.label} ${p.ports.map(x => x.port).join('/')}`}
                size="small"
                color={preset === p.id ? 'primary' : 'default'}
                variant={preset === p.id ? 'filled' : 'outlined'}
                onClick={() => pick(p.id)}
              />
            ))}
            <Chip label="Custom" size="small" color={preset === 'custom' ? 'primary' : 'default'} variant={preset === 'custom' ? 'filled' : 'outlined'} onClick={() => setPreset('custom')} />
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <TextField
            size="small"
            label="Guest port, list or range"
            value={text}
            onChange={e => {
              setText(e.target.value);
              setPreset('custom');
            }}
            error={!!parsed.error}
            helperText={parsed.error ?? (parsed.ports.length > 1 ? `${parsed.ports.length} ports: one Service entry each` : 'e.g. 22, 80,443 or 10000-10050/udp')}
            sx={{ flex: '1 1 220px' }}
            inputProps={{ ...tabular }}
          />
          <ToggleButtonGroup size="small" exclusive value={proto} onChange={(_, v) => v && setProto(v)} aria-label="Protocol">
            <ToggleButton value="TCP" sx={{ textTransform: 'none', px: 1.5 }}>
              TCP
            </ToggleButton>
            <ToggleButton value="UDP" sx={{ textTransform: 'none', px: 1.5 }}>
              UDP
            </ToggleButton>
          </ToggleButtonGroup>
          {single && (
            <TextField size="small" label="Name (optional)" value={name} onChange={e => setName(e.target.value)} sx={{ width: 160 }} helperText={portsIn[0] ? `Service port ${portsIn[0].name}` : ' '} />
          )}
        </Box>

        <Box>
          <Box sx={{ fontSize: 13, color: t.muted, mb: 0.5 }}>How</Box>
          <RadioGroup value={way} onChange={e => setWay(e.target.value as Way)}>
            {[...MODES.map(m => ({ way: m.mode as Way, label: m.label, type: m.type })), ...(web ? [{ way: 'web' as Way, label: 'Web address (through the ingress)', type: 'Ingress' }] : [])].map(m => {
              const off = m.way === 'address' && lbOff && !existing('address');
              const webOff = m.way === 'web' ? canWeb ?? (single ? webPortProblem(parsed.ports[0].port, parsed.ports[0].protocol) : parsed.ports.length ? 'A web address is one port of the guest' : null) : null;
              return (
                <Box key={m.way} sx={{ mb: 0.5 }}>
                  <FormControlLabel
                    value={m.way}
                    disabled={off || !!webOff}
                    control={<Radio size="small" />}
                    label={
                      <Box>
                        <Box sx={{ fontSize: 14 }}>
                          {m.label} {k8s && <K8sName>{m.type}</K8sName>}
                        </Box>
                        <Box sx={{ fontSize: 12.5, color: t.muted }}>{webOff ?? MODE_HELP[m.way]}</Box>
                      </Box>
                    }
                    sx={{ alignItems: 'flex-start', '& .MuiRadio-root': { mt: -0.5 } }}
                  />
                  {off && (
                    <Box sx={{ ml: 4 }}>
                      <Note tone="warn">{noPoolHelp({ cilium: ports.poolsWorld.cilium.served, metallb: metallbServed, k4all })}</Note>
                    </Box>
                  )}
                </Box>
              );
            })}
          </RadioGroup>
        </Box>

        {way === 'web' && web && !webBlocked && <WebFields vm={vm} web={web} onChange={(choice, problem) => setWebChoice({ choice, problem })} />}

        {way === 'cluster' && single && (
          <TextField size="small" label="Port in the cluster" placeholder={String(parsed.ports[0].port)} value={outside} onChange={e => setOutside(e.target.value)} helperText="Same as the guest's when empty" sx={{ width: 220 }} />
        )}

        {mode === 'host' && (
          <Box sx={{ display: 'grid', gap: 1 }}>
            {single ? (
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <TextField select size="small" label="Host port" value={nodeAuto ? 'auto' : 'pick'} onChange={e => setNodeAuto(e.target.value === 'auto')} sx={{ width: 200 }}>
                  <MenuItem value="auto">Automatic (free port)</MenuItem>
                  <MenuItem value="pick">Choose</MenuItem>
                </TextField>
                {!nodeAuto && (
                  <TextField
                    size="small"
                    label="30000–32767"
                    value={nodePort}
                    onChange={e => setNodePort(e.target.value)}
                    error={!!nodePort && !!nodePortProblem(Number(nodePort), nodeServices?.items ?? [])}
                    helperText={
                      nodeServices?.scope === 'folder' ? "Checked against this folder's Services; the cluster refuses a port taken elsewhere" : 'Checked against every Service'
                    }
                    sx={{ width: 220 }}
                    inputProps={{ ...tabular }}
                  />
                )}
              </Box>
            ) : (
              <Help>Each port gets a free host port. Each one uses up a port of the cluster's 30000–32767.</Help>
            )}
          </Box>
        )}

        {mode === 'address' &&
          (svcNow ? (
            <Note>
              The VM already has its own address ({(svcNow.status?.loadBalancer?.ingress ?? [])[0]?.ip ?? 'being assigned'}
              {k8s ? `, Service ${svcNow.metadata.name}` : ''}): these ports join it.
            </Note>
          ) : (
            !lbOff && (
              <Box sx={{ display: 'grid', gap: 1.25 }}>
                {poolsDenied ? (
                  <Help tone="warn">Your role cannot read the address pools: the address comes from whatever pool the cluster assigns.</Help>
                ) : (
                  <TextField select size="small" label="Address pool" value={pool} onChange={e => setPool(e.target.value)} sx={{ maxWidth: 420 }}>
                    <MenuItem value="auto">Automatic{autoPool(uses) ? ` (${autoPool(uses)!.name})` : ''}</MenuItem>
                    {uses.map(u => (
                      <MenuItem key={`${u.pool.kind}/${u.pool.name}`} value={`${u.pool.kind}/${u.pool.name}`} disabled={!u.ok}>
                        <Box sx={{ display: 'flex', gap: 1, width: '100%', ...tabular }}>
                          <Box sx={{ flex: 1 }}>
                            {u.pool.name} <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>{u.pool.kind === 'cilium' ? 'Cilium' : 'MetalLB'}</Box>
                          </Box>
                          <Box sx={{ color: t.muted, fontSize: 12.5 }}>{u.ok ? (u.pool.free === null ? u.pool.addresses.join(', ') : `${u.pool.free} free${u.pool.total ? ` of ${u.pool.total}` : ''}`) : u.why}</Box>
                        </Box>
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <TextField select size="small" label="Address" value={ipAuto ? 'auto' : 'pick'} onChange={e => setIpAuto(e.target.value === 'auto')} sx={{ width: 200 }}>
                    <MenuItem value="auto">Automatic</MenuItem>
                    <MenuItem value="pick">Choose</MenuItem>
                  </TextField>
                  {!ipAuto && (
                    <TextField
                      size="small"
                      label="IPv4 address"
                      value={ip}
                      onChange={e => setIp(e.target.value)}
                      error={!!ip && !!ipProblem(ip.trim(), chosenPool, ports.world.services)}
                      helperText={chosenPool ? chosenPool.addresses.join(', ') : ' '}
                      sx={{ width: 240 }}
                      inputProps={{ ...tabular }}
                    />
                  )}
                </Box>
                {single && (
                  <TextField size="small" label="Port on the address" placeholder={String(parsed.ports[0].port)} value={outside} onChange={e => setOutside(e.target.value)} helperText="Same as the guest's when empty" sx={{ width: 220 }} />
                )}
              </Box>
            )
          ))}

        {mode !== 'cluster' && (
          <FormControlLabel
            sx={{ alignItems: 'flex-start', m: 0 }}
            control={<Checkbox size="small" checked={keep} onChange={e => setKeepSrc(e.target.checked)} sx={{ mt: -0.5 }} />}
            label={
              <Box>
                <Box sx={{ fontSize: 14 }}>
                  Keep the client's address {k8s && <K8sName>externalTrafficPolicy: Local</K8sName>}
                </Box>
                <Box sx={{ fontSize: 12.5, color: t.muted }}>
                  The guest sees who connects. Only the host the VM runs on answers:{' '}
                  {mode === 'host' ? "use that host's address, which changes when the VM moves." : 'the address is announced from that host and follows the VM when it moves.'}
                  {svcNow ? ' It applies to every port published this way.' : ''}
                </Box>
              </Box>
            }
          />
        )}

        {missing.length > 0 && (
          <Note tone="warn">
            {canEditVm ? (
              <>
                <b>{ports.access.nic} forwards only the ports in its list.</b> Hangar adds {missing.length === 1 ? `${missing[0].port}/${missing[0].protocol}` : `${missing.length} ports`} to it. That
                changes the VM: the guest gets {missing.length === 1 ? 'it' : 'them'} at its next restart.
              </>
            ) : (
              <>
                <b>{ports.access.nic} forwards only the ports in its list</b>, and your role cannot change the VM: ask an admin to add {missing.map(p => `${p.port}/${p.protocol}`).join(', ')} to it, or the
                guest does not get {missing.length === 1 ? 'it' : 'them'}.
              </>
            )}
          </Note>
        )}
        {templateLabel && (
          <Note tone="warn">
            This KubeVirt (before v1.7) does not label the VM's pod with a name a Service can select: Hangar adds its own label to the VM, which reaches the pod at the VM's next start.
            {!canEditVm && ' Your role cannot change the VM: an admin must add the label hangar.magesgate.com/vm to its template.'}
          </Note>
        )}
        <Help>The guest must listen on the port and its firewall allow it: Hangar cannot see inside the guest.</Help>
      </DialogContent>
      <DialogActions>
        <Box sx={{ flex: 1, pl: 2, fontSize: 13, color: problem ? '#C53030' : t.muted }} role={problem ? 'alert' : undefined}>
          {problem ?? (k8s ? `Service ${serviceName(vm.metadata.name, mode)}` : '')}
        </Box>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!!problem || !parsed.ports.length} onClick={submit}>
          {parsed.ports.length > 1 ? `Publish ${parsed.ports.length} ports` : 'Publish'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
