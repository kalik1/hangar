/*
 * The Summary's Guest panel: the quick info of the guest agent. OS, kernel
 * and architecture, host name, time zone, the agent's version and since
 * when it is connected, IPs per interface (said when they do not come from
 * the agent), the users logged in, filesystems at 85 % or more; through the
 * guest bridge, the load averages and a clock off by more than a few
 * seconds. Without an agent, how to install it for this OS; with an agent
 * that does not respond (the bridge's health), how to restart it.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { useGuestBridge, useKubevirtGuest } from '../../api/guest';
import { agentHealth, filesystemsFromKubevirt, guestOsId, GuestSection, installHint, quickInfo, restartLine } from '../../model/guestinfo';
import { Obj } from '../../model/types';
import { formatAge, formatBytes, pct } from '../../model/units';
import { guestAgent, key } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { KV, Meter, Panel } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { AgentNotResponding, InstallAgent, Note } from './guestParts';

/** What the Summary asks the guest bridge: the load averages and the guest's clock. */
const SUMMARY_SECTIONS: GuestSection[] = ['cpu', 'time'];

/** The guest's quick info: KubeVirt's report, the bridge's load and clock, and the agent's state. */
export function GuestSummary({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const vmi = d.idx.vmi.get(key(vm));
  const ns = vm.metadata.namespace as string;
  const os = vmOs(vm, d);
  const agent = guestAgent(vmi);
  const running = vmi?.status?.phase === 'Running' && !!vmi?.status?.nodeName;
  const kv = useKubevirtGuest(ns, vm.metadata.name, agent);
  const { state: bridge } = useGuestBridge({ namespace: ns, name: vm.metadata.name, running, sections: SUMMARY_SECTIONS });
  const info = bridge.kind === 'ok' ? bridge.info : undefined;
  const q = quickInfo(vmi, kv, bridge);
  const health = agentHealth(bridge, agent);
  const osId = guestOsId(info, kv, vmi, os.id);
  const filesystems = filesystemsFromKubevirt(kv?.filesystems);
  const users = q.users;
  const agentText =
    health === 'connected'
      ? [q.agentVersion ? `qemu-ga ${q.agentVersion}` : 'Running', q.connectedSince ? `connected ${formatAge(q.connectedSince)} ago` : ''].filter(Boolean).join(', ')
      : health === 'not-responding'
      ? 'Not responding'
      : health === 'unknown'
      ? 'Checking…'
      : running
      ? 'Not connected'
      : '—';
  return (
    <Panel
      title="Guest"
      icon="mdi:monitor"
      actions={
        vmi ? (
          <Button size="small" component={RouterLink} to={hrefFor('vm', ns, vm.metadata.name, 'guest')} sx={{ textTransform: 'none' }}>
            Guest tab
          </Button>
        ) : undefined
      }
    >
      <KV
        rows={[
          ['Operating system', q.os ?? os.name + (os.fromAgent ? '' : ' (from the settings)')],
          ['Kernel', q.kernel ? `${q.kernel}${q.arch ? ` (${q.arch})` : ''}` : os.kernel ?? '—'],
          ['Host name', q.hostName ?? '—'],
          ['Time zone', q.timezone ?? '—'],
          ['Guest agent', agentText],
          [
            'IP addresses',
            q.ips.length
              ? q.ips.map(x => (
                  <Box key={x.name}>
                    {x.name}: {x.ips.join(', ')}
                    {!x.fromAgent && <Box component="span" sx={{ color: t.muted }}> (from the network, not the agent)</Box>}
                  </Box>
                ))
              : '—',
          ],
          [
            'Logged-in users',
            users ? (
              users.length ? (
                <Tooltip title={users.map(u => (u.domain ? `${u.domain}\\${u.name}` : u.name)).join(', ')}>
                  <Box component="span" tabIndex={0} sx={{ borderBottom: `1px dotted ${t.muted}`, cursor: 'help' }}>
                    {users.length === 1 ? '1 user' : `${users.length} users`}
                  </Box>
                </Tooltip>
              ) : (
                'Nobody'
              )
            ) : (
              '—'
            ),
          ],
          ...(q.load ? ([['Load', `${q.load.load1.toFixed(2)} · ${q.load.load5.toFixed(2)} · ${q.load.load15.toFixed(2)}`]] as [React.ReactNode, React.ReactNode][]) : []),
        ]}
      />
      {(q.drift !== undefined || q.full.length > 0) && (
        <Box sx={{ mt: 1.5, display: 'grid', gap: 0.5 }}>
          {q.drift !== undefined && (
            <Note icon="mdi:clock-alert-outline" tone="warn">
              The guest’s clock is {Math.abs(q.drift).toFixed(1)} s {q.drift > 0 ? 'ahead of' : 'behind'} the host’s.
            </Note>
          )}
          {q.full.map(f => (
            <Note key={`${f.device}-${f.mountpoint}`} icon="mdi:harddisk-remove" tone="warn">
              {f.mountpoint} is {Math.round(pct(f.used, f.total))} % full ({formatBytes(f.used)} of {formatBytes(f.total)}).
            </Note>
          ))}
        </Box>
      )}
      {running && health === 'not-connected' && (
        <Box sx={{ mt: 1.5 }}>
          <InstallAgent hint={installHint(osId)} />
        </Box>
      )}
      {health === 'not-responding' && (
        <Box sx={{ mt: 1.5 }}>
          <AgentNotResponding message={info?.agent.message} restart={restartLine(osId)} />
        </Box>
      )}
      {filesystems.length > 0 && (
        <Box sx={{ mt: 2, display: 'grid', gap: 1.25 }}>
          {filesystems.map(f => (
            <Meter key={`${f.device}-${f.mountpoint}`} label={`${f.mountpoint} (${f.type})`} used={f.used} total={f.total} format={n => formatBytes(n)} />
          ))}
        </Box>
      )}
    </Panel>
  );
}

