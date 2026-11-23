/*
 * DNS of a VM's pod network adapter: what the guest gets (servers and search
 * domains, through KubeVirt's DHCP) and the settings that shape it. The same
 * fields serve the New VM wizard.
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
import Typography from '@mui/material/Typography';
import React from 'react';
import * as A from '../../api/actions';
import { useHangar } from '../../api/data';
import { useClusterDns } from '../../api/dns';
import { ClusterDns, DNS_POLICIES, dnsOf, dnsProblems, DnsSettings, effectiveDns, hostSearchHint, isDefaultDns, setDns, splitList, usesPodNetwork } from '../../model/dns';
import { Obj } from '../../model/types';
import { key, pendingRestart } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { openDialog } from '../../ui/dialogs';
import { K8sName, Panel, Tag } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

const FROM: Record<'cluster' | 'host' | 'vm', string> = { cluster: 'cluster', host: 'host', vm: 'this VM' };

/** The resolver the guest ends up with, as two short lists. */
export function DnsResult({ s, namespace, cluster, hostSearch }: { s: DnsSettings; namespace: string; cluster: ClusterDns | null; hostSearch: string[] }) {
  const t = useTokens();
  const e = effectiveDns(s, namespace, cluster ?? { servers: [], domain: 'cluster.local' }, hostSearch);
  const row = (label: string, body: React.ReactNode) => (
    <Box sx={{ display: 'flex', gap: 2, py: 0.75, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' } }}>
      <Box sx={{ width: 130, flex: 'none', color: t.muted, fontSize: 13.5 }}>{label}</Box>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 0.75, fontSize: 14, ...tabular }}>{body}</Box>
    </Box>
  );
  const item = (text: string, from: 'cluster' | 'host' | 'vm') => (
    <Box key={text} component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.5 }}>
      <span>{text}</span>
      <Box component="span" sx={{ fontSize: 12, color: t.muted }}>
        {FROM[from]}
      </Box>
    </Box>
  );
  const clusterUnknown = s.policy === 'ClusterFirst' && !cluster?.servers.length;
  return (
    <Box>
      {row(
        'DNS servers',
        <>
          {e.servers.map(x => item(x.address, x.from))}
          {clusterUnknown && <Box component="span" sx={{ color: t.muted }}>the cluster DNS service</Box>}
          {s.policy === 'Default' && <Box component="span" sx={{ color: t.muted }}>{e.servers.length ? '+ ' : ''}the servers of the host it runs on</Box>}
          {!e.servers.length && !clusterUnknown && s.policy !== 'Default' && <Box component="span" sx={{ color: '#E5484D' }}>none</Box>}
        </>
      )}
      {row('Search domains', e.searches.length ? e.searches.map(x => item(x.domain, x.from)) : <Box component="span" sx={{ color: t.muted }}>none</Box>)}
      {e.dropped.length > 0 && (
        <Typography sx={{ fontSize: 12.5, color: '#B7791F', mt: 0.5 }}>Only three DNS servers reach the guest: {e.dropped.join(', ')} is left out.</Typography>
      )}
    </Box>
  );
}

/** Policy, extra servers and search domains: controlled fields. */
export function DnsFields({ value, onChange, clusterServers }: { value: DnsSettings; onChange: (s: DnsSettings) => void; clusterServers: number }) {
  const k8s = useK8s();
  const [servers, setServers] = React.useState(value.nameservers.join(', '));
  const [searches, setSearches] = React.useState(value.searches.join(', '));
  const policy = DNS_POLICIES.find(p => p.value === value.policy)!;
  const problems = dnsProblems(value, clusterServers || 1);
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <TextField
        select
        size="small"
        label="Name resolution"
        value={value.policy}
        onChange={e => onChange({ ...value, policy: e.target.value as DnsSettings['policy'] })}
        helperText={
          <>
            {policy.help} {k8s && <K8sName>dnsPolicy: {value.policy}</K8sName>}
          </>
        }
      >
        {DNS_POLICIES.map(p => (
          <MenuItem key={p.value} value={p.value}>
            {p.label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        label={value.policy === 'None' ? 'DNS servers' : 'Additional DNS servers'}
        placeholder={value.policy === 'None' ? '192.0.2.53, 1.1.1.1' : 'none'}
        value={servers}
        onChange={e => {
          setServers(e.target.value);
          onChange({ ...value, nameservers: splitList(e.target.value) });
        }}
        helperText={
          <>
            IP addresses, separated by commas. A guest gets at most three servers{value.policy === 'ClusterFirst' ? ', the cluster DNS included' : ''}.{' '}
            {k8s && <K8sName>dnsConfig.nameservers</K8sName>}
          </>
        }
        InputLabelProps={{ shrink: true }}
      />
      <TextField
        size="small"
        label="Additional search domains"
        placeholder="corp.example.com"
        value={searches}
        onChange={e => {
          setSearches(e.target.value);
          onChange({ ...value, searches: splitList(e.target.value) });
        }}
        helperText={
          <>
            Short names are tried with these domains appended. {k8s && <K8sName>dnsConfig.searches</K8sName>}
          </>
        }
        InputLabelProps={{ shrink: true }}
      />
      {problems.map(p => (
        <Typography key={p} role="alert" sx={{ fontSize: 13, color: '#E5484D' }}>
          {p}
        </Typography>
      ))}
    </Box>
  );
}

function DnsDialog({ vm, onClose }: { vm: Obj; onClose: () => void }) {
  const d = useHangar();
  const t = useTokens();
  const cluster = useClusterDns();
  const [s, setS] = React.useState<DnsSettings>(dnsOf(vm));
  const hostSearch = hostSearchHint(d.nodes);
  const ok = !dnsProblems(s, cluster?.servers.length || 1).length;
  const changed = JSON.stringify(s) !== JSON.stringify(dnsOf(vm));
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-dns-title">
      <DialogTitle id="hangar-dns-title" sx={{ fontSize: 18 }}>
        DNS of {vm.metadata.name}
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2.5 }}>
        <Box sx={{ pt: 1 }}>
          <DnsFields value={s} onChange={setS} clusterServers={cluster?.servers.length ?? 1} />
        </Box>
        <Box>
          <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>The guest will get</Typography>
          <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.small}px`, px: 1.5, py: 0.5 }}>
            <DnsResult s={s} namespace={vm.metadata.namespace as string} cluster={cluster} hostSearch={hostSearch} />
          </Box>
          <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.75 }}>
            Through DHCP on the pod network adapter, at the next power-on. A guest with a static network setup keeps its own resolver.
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!ok || !changed}
          onClick={() => {
            A.updateVm(vm, 'Change DNS', setDns(vm, s)).catch(() => undefined);
            onClose();
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Configure → DNS. */
export function DnsPanel({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const cluster = useClusterDns();
  const s = dnsOf(vm);
  const pod = usesPodNetwork(vm);
  const vmi = d.idx.vmi.get(key(vm));
  const running = !!vmi;
  const restart = running && pendingRestart(vm);
  return (
    <Panel
      title="DNS"
      icon="mdi:dns-outline"
      actions={
        <>
          {!isDefaultDns(s) && <Tag tone="accent">Custom</Tag>}
          {k8s && <K8sName>{s.policy}</K8sName>}
          <Button size="small" onClick={() => openDialog(close => <DnsDialog vm={vm} onClose={close} />)} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:pencil-outline" width={16} />}>
            Edit
          </Button>
        </>
      }
    >
      {pod ? (
        <>
          <DnsResult s={s} namespace={vm.metadata.namespace as string} cluster={cluster} hostSearch={hostSearchHint(d.nodes)} />
          <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 1 }}>
            {running ? (restart ? 'Changed: the guest gets it at the next power-on.' : 'Given to the guest by DHCP on the pod network adapter when the VM powered on.') : 'Given to the guest by DHCP on the pod network adapter at power-on.'}
          </Typography>
        </>
      ) : (
        <Typography sx={{ fontSize: 13.5, color: t.muted }}>
          This VM has no pod network adapter: its DNS comes from the DHCP server of the networks it is bridged to, or from the guest's own settings.
        </Typography>
      )}
    </Panel>
  );
}
