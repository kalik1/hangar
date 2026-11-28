/*
 * The VM summary's "Reachable at": every address the VM answers on, with a
 * copy button: its published ports (the line to type: ssh -p 30022 …,
 * http://…/, the cluster DNS name) and its own addresses on secondary
 * networks. Managed in Configure → Published ports.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { accessProblem, hostAddresses, PortRow } from '../../model/ports';
import { VM } from '../../model/types';
import { hrefFor } from '../../shell/nav';
import { Panel } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { CopyButton, LiveLabel, MODE_ICON, rowCopyLine, rowLive, useVmPorts } from './portParts';

interface Line {
  key: string;
  icon: string;
  text: string;
  /** What it is: "SSH, port 30022 on every host". */
  what: string;
  live?: React.ReactNode;
}

export function ReachableCard({ vm }: { vm: VM }) {
  const d = useHangar();
  const t = useTokens();
  const ports = useVmPorts(vm);
  const lines: Line[] = [];
  const byGuest = (r: PortRow) => `${r.name ?? `port ${r.guest}`} (${r.guest}/${r.protocol})`;
  for (const r of ports.rows) {
    const live = rowLive(r, ports.world, ports.pools, ports.vmOn);
    const copy = rowCopyLine(r, d.nodes, live.lb, ports.user, ports.access.ipv6);
    const label = <LiveLabel tone={live.tone}>{live.text}</LiveLabel>;
    if (r.mode === 'cluster') lines.push({ key: r.key, icon: MODE_ICON.cluster, text: copy as string, what: `${byGuest(r)}, inside the cluster`, live: label });
    else if (r.mode === 'host') {
      const hosts = hostAddresses(d.nodes, ports.access.ipv6);
      lines.push({
        key: r.key,
        icon: MODE_ICON.host,
        text: copy ?? 'Host port being allocated',
        what: `${byGuest(r)}, on every host's port${hosts.length > 1 ? ` (any of ${hosts.length} host addresses)` : ''}`,
        live: label,
      });
    } else lines.push({ key: r.key, icon: MODE_ICON.address, text: copy ?? 'Waiting for its address', what: `${byGuest(r)}, on its own address`, live: label });
  }
  for (const s of ports.access.secondary)
    for (const ip of s.ips) lines.push({ key: `${s.nic}/${ip}`, icon: 'mdi:lan', text: ip, what: `Directly on ${s.network.split('/').pop()} (${s.nic})` });
  const problem = ports.access.state !== 'ok' && ports.access.state !== 'secondary-only' ? accessProblem(ports.access) : null;
  return (
    <Panel
      title="Reachable at"
      icon="mdi:door-open"
      dense
      actions={
        <Button size="small" component={RouterLink} to={hrefFor('vm', vm.metadata.namespace, vm.metadata.name, 'configure')} sx={{ textTransform: 'none' }}>
          Publish ports
        </Button>
      }
    >
      {lines.map(l => (
        <Box key={l.key} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 0.75, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' } }}>
          <Icon icon={l.icon} width={16} style={{ color: t.muted, flex: 'none' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box component="code" sx={{ fontFamily: t.font.mono, fontSize: 13, overflowWrap: 'anywhere' }}>
              {l.text}
            </Box>
            <Box sx={{ fontSize: 12.5, color: t.muted, ...tabular }}>
              {l.what}
              {l.live && <Box component="span" sx={{ ml: 1 }}>{l.live}</Box>}
            </Box>
          </Box>
          {!/being allocated|Waiting/.test(l.text) && <CopyButton text={l.text} label={`Copy ${l.text}`} />}
        </Box>
      ))}
      {!lines.length && (
        <Box sx={{ px: 2, py: 1.5, fontSize: 14, color: t.muted }}>
          {problem ?? 'Nothing published: the VM is reachable only from its own pod. Publish SSH, RDP or a web port in Configure → Published ports.'}
        </Box>
      )}
      {lines.some(l => l.icon !== 'mdi:lan') && (
        <Box sx={{ px: 2, py: 0.75, borderTop: `1px solid ${t.rule}`, fontSize: 12.5, color: t.muted }}>
          The guest must listen on these ports and its firewall allow them.
          {ports.rows.some(r => Number(r.guest) === 22) && !ports.user ? ' Replace "user" with a user of the guest.' : ''}
        </Box>
      )}
    </Panel>
  );
}
