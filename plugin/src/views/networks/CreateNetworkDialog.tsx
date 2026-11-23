/*
 * Create a VM network on a host bridge (OVS or Linux), optionally on a
 * VLAN. Offers only the bridge types and bridges the hosts have.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { HangarData } from '../../api/data';
import { createNetwork } from '../../api/networks';
import { folders } from '../../model/inventory';
import { cniOffers, mtuProblem, nadManifest, vlanProblem } from '../../model/networks';
import { nameProblem } from '../../model/vmspec';
import { useK8s, useSettings } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';

const ALL = '__all__';

export function CreateNetworkDialog({ d, onClose }: { d: HangarData; onClose: () => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const [settings] = useSettings();
  const offers = cniOffers(d.nodeNetworkStates, d.nodes, !!d.has.nmstate);
  const first = offers.find(o => o.available);
  const [kind, setKind] = React.useState<'ovs' | 'linux-bridge'>(first?.kind ?? 'ovs');
  const offer = offers.find(o => o.kind === kind)!;
  const blind = !d.has.nmstate && !offer.bridges.length;
  const [bridge, setBridge] = React.useState(offer.bridges[0]?.name ?? '');
  const [name, setName] = React.useState('');
  const [vlan, setVlan] = React.useState('');
  const [mtu, setMtu] = React.useState('');
  const [scope, setScope] = React.useState(ALL);
  const [desc, setDesc] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    const o = offers.find(x => x.kind === kind);
    if (o && !o.bridges.some(b => b.name === bridge)) setBridge(o.bridges[0]?.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const namespace = scope === ALL ? 'default' : scope;
  const taken = d.nads.some(n => n.metadata.namespace === namespace && n.metadata.name === name);
  const errs = {
    name: nameProblem(name) ?? (taken ? `A network named ${name} already exists ${scope === ALL ? 'for all folders' : `in ${scope}`}.` : null),
    bridge: bridge.trim() ? null : 'Pick the host bridge.',
    vlan: vlanProblem(vlan),
    mtu: mtuProblem(mtu),
  };
  const ok = offer.available && !errs.name && !errs.bridge && !errs.vlan && !errs.mtu;
  const picked = offer.bridges.find(b => b.name === bridge);
  const folderNames = folders(d.vms, d.namespaces, d.vmis, settings.libraryNamespace).map(f => f.name);
  const input = {
    name,
    namespace,
    kind,
    bridge: bridge.trim(),
    vlan: vlan.trim() ? Number(vlan) : undefined,
    mtu: mtu.trim() ? Number(mtu) : undefined,
    description: desc,
    marked: !!picked?.marked,
  };
  const submit = () => {
    setTouched(true);
    if (!ok) return;
    createNetwork(input).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-net-title">
      <DialogTitle id="hangar-net-title" sx={{ fontSize: 18 }}>
        Create network
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
          <TextField
            label="Name"
            size="small"
            value={name}
            onChange={e => setName(e.target.value)}
            error={touched && !!errs.name}
            helperText={(touched && errs.name) || 'Lowercase, like vlan-10 or storage-lan. VMs refer to the network by this name.'}
          />
          <Box>
            <Typography id="hangar-net-kind" sx={{ fontSize: 13, color: t.muted }}>
              Connect VMs through
            </Typography>
            <RadioGroup aria-labelledby="hangar-net-kind" value={kind} onChange={e => setKind(e.target.value as 'ovs' | 'linux-bridge')}>
              {offers.map(o => (
                <FormControlLabel
                  key={o.kind}
                  value={o.kind}
                  disabled={!o.available}
                  control={<Radio size="small" />}
                  label={
                    <Box>
                      <Typography sx={{ fontSize: 14 }}>{o.label}</Typography>
                      {!o.available && o.note && <Typography sx={{ fontSize: 12.5, color: t.muted }}>{o.note}</Typography>}
                    </Box>
                  }
                  sx={{ alignItems: 'flex-start', '& .MuiRadio-root': { pt: 0.5 } }}
                />
              ))}
            </RadioGroup>
          </Box>
          {blind ? (
            <>
              <Note>{offer.note}</Note>
              <TextField
                label="Host bridge"
                size="small"
                value={bridge}
                onChange={e => setBridge(e.target.value)}
                error={touched && !!errs.bridge}
                helperText={(touched && errs.bridge) || ' '}
              />
            </>
          ) : (
            <TextField
              select
              label="Host bridge"
              size="small"
              value={offer.bridges.some(b => b.name === bridge) ? bridge : ''}
              onChange={e => setBridge(e.target.value)}
              disabled={!offer.available}
              error={touched && !!errs.bridge}
              helperText={
                (touched && errs.bridge) ||
                (picked && picked.hosts.length < d.nodes.length
                  ? `Only ${picked.hosts.length} of ${d.nodes.length} hosts have it: VMs on this network run only there.`
                  : 'Traffic leaves through the bridge\'s uplink to your physical network.')
              }
            >
              {offer.bridges.map(b => (
                <MenuItem key={b.name} value={b.name}>
                  <Box>
                    <Box>{b.name}</Box>
                    <Box sx={{ fontSize: 12.5, color: t.muted }}>
                      {b.ports.length ? `Uplink ${b.ports.join(', ')}` : 'No uplink seen'}, on {b.hosts.length} of {d.nodes.length} host{d.nodes.length === 1 ? '' : 's'}
                    </Box>
                  </Box>
                </MenuItem>
              ))}
            </TextField>
          )}
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: '1fr 1fr' }}>
            <TextField
              label="VLAN ID"
              size="small"
              value={vlan}
              onChange={e => setVlan(e.target.value)}
              error={!!errs.vlan}
              helperText={errs.vlan ?? 'Empty: untagged'}
              inputProps={{ inputMode: 'numeric' }}
            />
            <TextField
              label="MTU"
              size="small"
              value={mtu}
              onChange={e => setMtu(e.target.value)}
              error={!!errs.mtu}
              helperText={errs.mtu ?? 'Empty: the bridge\'s'}
              inputProps={{ inputMode: 'numeric' }}
            />
          </Box>
          <TextField select label="Available to" size="small" value={scope} onChange={e => setScope(e.target.value)}>
            <MenuItem value={ALL}>All folders</MenuItem>
            {folderNames.map(f => (
              <MenuItem key={f} value={f}>
                Only the folder {f}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Notes" size="small" value={desc} onChange={e => setDesc(e.target.value)} />
          {k8s && name && !errs.name && (
            <Box sx={{ fontSize: 12, fontFamily: t.font.mono, color: t.muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              <K8sName>
                NetworkAttachmentDefinition {namespace}/{name}
              </K8sName>
              <Box sx={{ mt: 0.5 }}>{nadManifest(input).spec.config}</Box>
            </Box>
          )}
          <Typography sx={{ fontSize: 13, color: t.muted }}>
            The guests get their addresses from your network (DHCP or static), as on a physical port. Add an adapter on this network in a VM's
            settings.
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!offer.available || (touched && !ok)}>
          Create network
        </Button>
      </DialogActions>
    </Dialog>
  );
}
