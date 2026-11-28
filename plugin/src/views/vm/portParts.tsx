/*
 * What the published-port views share: one VM's ports with their live state
 * (useVmPorts), the words and LED of a row, the line to copy, and the
 * firewalld warning for host ports.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { useHangar } from '../../api/data';
import { useInventories } from '../../api/hardware';
import { useK4all } from '../../api/k4all';
import { PortsWorld, usePools, usePortsData } from '../../api/ports';
import { writeHostClipboard } from '../../console/ClipboardTray';
import { cloudInitOf } from '../../model/edit';
import {
  Behind,
  BEHIND_TEXT,
  behindState,
  CILIUM_L2_CLASS,
  cloudInitUser,
  connectLine,
  hostAddresses,
  LbPool,
  LbState,
  lbState,
  parsePools,
  PortRow,
  portRows,
  PublishAccess,
  publishAccess,
  VmSelector,
  vmSelector,
  vmServices,
} from '../../model/ports';
import { Obj, VM } from '../../model/types';
import { key, powerState } from '../../model/vm';
import { Led } from '../../ui/Led';
import { LedTone } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';

export interface VmPorts {
  world: PortsWorld;
  pools: LbPool[];
  poolsWorld: ReturnType<typeof usePools>;
  access: PublishAccess;
  selector: VmSelector;
  /** The Services that reach the VM (Hangar's and others'). */
  services: Obj[];
  rows: PortRow[];
  vmOn: boolean;
  user?: string;
}

/** One VM's published ports with what is needed to show their state. */
export function useVmPorts(vm: VM): VmPorts {
  const d = useHangar();
  const world = usePortsData(vm.metadata.namespace as string);
  const poolsWorld = usePools();
  const vmi = d.idx.vmi.get(key(vm));
  const launcher = d.idx.launcher.get(key(vm));
  const services = React.useMemo(() => vmServices(world.services, vm, launcher), [world.services, vm, launcher]);
  const rows = React.useMemo(() => portRows(services, vm.metadata.name), [services, vm.metadata.name]);
  const pools = React.useMemo(() => parsePools(poolsWorld.metallb.items, poolsWorld.cilium.items, world.services), [poolsWorld, world.services]);
  return {
    world,
    pools,
    poolsWorld,
    access: publishAccess(vm, vmi, d.kubevirt),
    selector: vmSelector(vm, d.kubevirt),
    services,
    rows,
    vmOn: powerState(vm, vmi).kind !== 'off',
    user: cloudInitUser(cloudInitOf(vm)),
  };
}

export interface RowLive {
  behind: Behind;
  lb?: LbState;
  tone: LedTone;
  /** The state in a few words. */
  text: string;
}

/** A row's state: the LoadBalancer's when it is not answering yet, else whether the VM is behind it. */
export function rowLive(row: PortRow, world: Pick<PortsWorld, 'slices' | 'events' | 'announcers'>, pools: LbPool[], vmOn: boolean): RowLive {
  const behind = behindState(row.service, world.slices, vmOn);
  const k = `${row.service.metadata.namespace}/${row.service.metadata.name}`;
  const lb = row.mode === 'address' ? lbState(row.service, { events: world.events, pools, ciliumLeaseHolder: world.announcers.get(k), metallbNode: world.announcers.get(k) }) : undefined;
  if (lb?.phase === 'failed') return { behind, lb, tone: 'fault', text: 'No address' };
  if (lb?.phase === 'waiting') return { behind, lb, tone: 'busy', text: 'Waiting for an address' };
  const b = BEHIND_TEXT[behind];
  return { behind, lb, tone: b.tone, text: b.text };
}

/** Where the port answers, in one line. */
export function whereText(row: PortRow, lb?: LbState): string {
  const svc = row.service;
  switch (row.mode) {
    case 'cluster':
      return `${svc.metadata.name}.${svc.metadata.namespace}.svc:${row.port}`;
    case 'host':
      return row.nodePort ? `Port ${row.nodePort} on every host` : 'Host port being allocated';
    default:
      return lb?.address ? `${lb.address}:${row.port}` : 'Its own address, once assigned';
  }
}

/** The LoadBalancer's state in words. */
export function lbWords(lb: LbState, svc?: Obj): string {
  const ctl = lb.controller === 'cilium' ? "Cilium's LB IPAM" : lb.controller === 'metallb' ? 'MetalLB' : 'the load balancer';
  switch (lb.phase) {
    case 'waiting':
      return `Waiting for ${ctl} to assign an address${lb.pool ? ` from ${lb.pool}` : ''}${
        svc?.spec?.loadBalancerClass === CILIUM_L2_CLASS ? " (Cilium serves this Service's class only with its L2 announcements on)" : ''
      }`;
    case 'failed':
      return `Failed: ${lb.reason ?? 'no address'}`;
    case 'assigned':
      return `${lb.address} from ${lb.pool ? `pool ${lb.pool}` : ctl}; no host announces it yet`;
    default:
      return `${lb.address} from ${lb.pool ? `pool ${lb.pool}` : ctl}, announced by ${lb.node}`;
  }
}

/** The line a user copies to reach the port: ssh, a URL, or address:port. */
export function rowCopyLine(row: PortRow, nodes: Obj[], lb: LbState | undefined, user: string | undefined, ipv6: boolean): string | null {
  const guest = row.guest;
  if (row.mode === 'cluster') return connectLine(guest, `${row.service.metadata.name}.${row.service.metadata.namespace}.svc`, row.port, user);
  if (row.mode === 'host') {
    const h = hostAddresses(nodes, ipv6)[0];
    return h && row.nodePort ? connectLine(guest, h.ip, row.nodePort, user) : null;
  }
  return lb?.address ? connectLine(guest, lb.address, row.port, user) : null;
}

export function LiveLabel({ tone, children }: { tone: LedTone; children: React.ReactNode }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}>
      <Led tone={tone} size={8} />
      {children}
    </Box>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTokens();
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <Tooltip title={done ? 'Copied' : `Copy: ${text}`}>
      <IconButton size="small" aria-label={label} onClick={async () => setDone(await writeHostClipboard(text))} sx={{ color: t.muted }}>
        <Icon icon={done ? 'mdi:check' : 'mdi:content-copy'} width={16} />
      </IconButton>
    </Tooltip>
  );
}

/** Host ports and firewalld: k4all opens only the CNI's ports, so the NodePort range must be opened where firewalld runs. */
export function FirewalldNote() {
  const inv = useInventories();
  const k4all = useK4all();
  const hosts = [...inv.hosts.entries()].filter(([, r]) => r.inv?.firewalld).map(([h]) => h);
  const known = [...inv.hosts.values()].some(r => r.inv && r.inv.firewalld !== null);
  if (known && !hosts.length) return null;
  const why = k4all ? "k4all's k4all-cni-firewalld opens only the CNI's ports there, not the host port range 30000-32767" : 'it lets in only the ports it is told to';
  return (
    <Note tone={hosts.length ? 'warn' : 'info'} icon={<Icon icon="mdi:wall-fire" width={16} style={{ flex: 'none', marginTop: 2 }} />}>
      {hosts.length ? (
        <>
          <b>firewalld runs on {hosts.join(', ')}:</b> {why}. Open them on those hosts (<code>firewall-cmd --permanent --add-port=30000-32767/tcp</code>, and /udp for UDP ports, then{' '}
          <code>firewall-cmd --reload</code>), or the ports answer only from inside the cluster.
        </>
      ) : (
        <>If firewalld runs on the hosts, {why}: open 30000-32767/tcp (and /udp) there, or the ports answer only from inside the cluster.</>
      )}
    </Note>
  );
}

export const MODE_ICON = { cluster: 'mdi:lan', host: 'mdi:server-network', address: 'mdi:ip-network-outline' } as const;
