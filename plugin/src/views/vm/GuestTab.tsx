/*
 * A VM's Guest tab: everything its QEMU guest agent reports, refreshed every
 * 30 s while the tab is open. Each section says where its data comes from
 * (Hangar's guest bridge, KubeVirt's API, the VMI's status) and when it was
 * read, and why a part is missing: the bridge is not installed or the
 * user's role does not reach it, the agent is not connected or does not
 * respond, the guest blocks a command, or the agent is too old for it.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { useHangar } from '../../api/data';
import { useGuestBridge, useKubevirtGuest } from '../../api/guest';
import {
  agentHealth,
  blockedCommands,
  blockedFix,
  BridgeState,
  cloudInitUsers,
  cpuTimes,
  disabledCommands,
  driverDateMs,
  Filesystem,
  filesystemDisk,
  filesystemsFromBridge,
  filesystemsFromKubevirt,
  formatIp,
  formatTimezone,
  GuestInfo,
  guestOsId,
  GuestSection,
  hex4,
  installHint,
  isVirtioDriver,
  isWindowsId,
  keyParts,
  KubevirtGuest,
  matchDisks,
  matchNics,
  noSuchUser,
  parseKvTimezone,
  restartLine,
  routeRow,
  SECTION_COMMANDS,
  sectionErrors,
  usersFromBridge,
  usersFromKubevirt,
} from '../../model/guestinfo';
import { Obj } from '../../model/types';
import { formatAge, formatBytes } from '../../model/units';
import { disks, guestAgent, hardware, key, nics } from '../../model/vm';
import { Empty, KV, Meter, Panel, Tag } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { AgentNotResponding, BlockedFixBody, BridgeNotice, InstallAgent, Note, SectionErrors, Source, SourceLine, timeOf } from './guestParts';

const FIX_ID = 'guest-blocked-commands';

/* ------------------------------------------------------------ helpers */

function Table({ head, rows, label }: { head: React.ReactNode[]; rows: React.ReactNode[][]; label: string }) {
  const t = useTokens();
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box
        component="table"
        aria-label={label}
        sx={{
          width: '100%',
          fontSize: 13.5,
          borderCollapse: 'collapse',
          ...tabular,
          '& td, & th': { py: 0.5, pr: 1.5, textAlign: 'left', verticalAlign: 'top', borderTop: `1px solid ${t.rule}` },
          '& th': { color: t.muted, fontWeight: 600, fontSize: 12.5, borderTop: 'none', whiteSpace: 'nowrap' },
        }}
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </Box>
    </Box>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => {
  const t = useTokens();
  return <Box sx={{ color: t.muted, fontSize: 12.5 }}>{children}</Box>;
};

const Mono = ({ children }: { children: React.ReactNode }) => {
  const t = useTokens();
  return (
    <Box component="span" sx={{ fontFamily: t.font.mono, fontSize: 12.5 }}>
      {children}
    </Box>
  );
};

const n = (v: number | undefined) => (v === undefined ? '—' : v.toLocaleString());
const percent = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.01 ? 1 : 0)} %`;
const since = (ms: number | string | undefined) => (ms === undefined ? '—' : `${new Date(ms).toLocaleString()} (${formatAge(ms)} ago)`);

/** What a section shows from the bridge, or why it has nothing from it. */
interface Ctx {
  vm: Obj;
  vmi?: Obj;
  bridge: BridgeState;
  info?: GuestInfo;
  kv: KubevirtGuest | null;
  osId: string;
  windows: boolean;
  /** The bridge says the agent does not respond: KubeVirt's data may be stale. */
  stale: boolean;
}

function bridgeFooter(c: Ctx, section: GuestSection, extra: GuestSection[] = []) {
  return c.info ? <SourceLine source="bridge" commands={[section, ...extra].flatMap(s => SECTION_COMMANDS[s])} readAt={c.info.readAt} /> : undefined;
}

/**
 * The bridge's part of a section: the body when the bridge answered for it,
 * else why not; then the section's command errors.
 */
function FromBridge({ c, section, adds, has, children }: { c: Ctx; section: GuestSection; adds?: string; has: boolean; children?: React.ReactNode }) {
  if (c.bridge.kind !== 'ok') return <BridgeNotice state={c.bridge} adds={adds} />;
  const a = c.bridge.info.agent;
  return (
    <>
      {has && children}
      {!has && !a.connected && <Note icon="mdi:link-variant-off">The guest agent is not connected.</Note>}
      {!has && a.connected && !a.healthy && (
        <Note icon="mdi:heart-broken-outline" tone="error">
          No answer: the guest agent does not respond.
        </Note>
      )}
      <SectionErrors errors={sectionErrors(c.info, section)} fixId={FIX_ID} />
    </>
  );
}

function StaleNote({ c }: { c: Ctx }) {
  return c.stale ? (
    <Note icon="mdi:history" tone="warn">
      KubeVirt may still show what the agent said before it stopped responding.
    </Note>
  ) : null;
}

/* ------------------------------------------------------------ sections */

function SystemSection({ c }: { c: Ctx }) {
  const [all, setAll] = React.useState(false);
  const b = c.info;
  const kvi = c.kv?.info;
  const os = b?.system?.os ?? kvi?.os ?? c.vmi?.status?.guestOSInfo;
  const tz = b?.system?.timezone ?? parseKvTimezone(kvi?.timezone);
  const cond = ((c.vmi?.status?.conditions ?? []) as any[]).find(x => x.type === 'AgentConnected' && x.status === 'True');
  const commands = b?.agent.commands ?? kvi?.supportedCommands;
  const disabled = disabledCommands(commands);
  const drift = b?.time?.driftSeconds;
  const source: Source = b?.system ? 'bridge' : kvi ? 'kubevirt' : 'status';
  return (
    <Panel
      title="System"
      icon="mdi:monitor"
      footer={
        <Box sx={{ display: 'grid', gap: 0.25 }}>
          {source === 'bridge' ? bridgeFooter(c, 'system', ['time']) : <SourceLine source={source} readAt={c.kv?.readAt} />}
        </Box>
      }
    >
      <KV
        rows={[
          ['Operating system', os?.prettyName || os?.name || '—'],
          ['Version', [os?.version, os?.versionId && os.versionId !== os.version ? `(${os.versionId})` : ''].filter(Boolean).join(' ') || '—'],
          [
            'Kernel',
            os?.kernelRelease ? (
              <>
                {os.kernelRelease}
                {os.kernelVersion && <Muted>{os.kernelVersion}</Muted>}
              </>
            ) : (
              '—'
            ),
          ],
          ['Architecture', os?.machine ?? '—'],
          ['Host name', b?.system?.hostName ?? kvi?.hostname ?? '—'],
          ['Time zone', formatTimezone(tz) ?? '—'],
          [
            'Guest time',
            b?.time ? (
              <>
                {new Date(b.time.guestTime).toLocaleString()}{' '}
                <Muted>
                  {Math.abs(drift ?? 0) < 0.5 ? 'In step with the host.' : `${Math.abs(drift ?? 0).toFixed(1)} s ${(drift ?? 0) > 0 ? 'ahead of' : 'behind'} the host.`}
                </Muted>
              </>
            ) : (
              '—'
            ),
          ],
          ['Agent', b?.agent.version ?? kvi?.guestAgentVersion ? `qemu-ga ${b?.agent.version ?? kvi?.guestAgentVersion}` : '—'],
          ['Connected since', cond?.lastTransitionTime ? since(cond.lastTransitionTime) : '—'],
          [
            'Agent commands',
            commands?.length ? (
              <>
                {commands.length} commands, {commands.length - disabled.length} enabled
                {disabled.length ? `, ${disabled.length} disabled (by the guest’s configuration, or not for this OS)` : ''}.{' '}
                <Button size="small" onClick={() => setAll(v => !v)} sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }}>
                  {all ? 'Hide them' : 'Show them'}
                </Button>
                {all && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }} aria-label="Agent commands">
                    {commands.map(x => (
                      <Tag key={x.name} tone={x.enabled ? 'muted' : 'warn'}>
                        <Icon icon={x.enabled ? 'mdi:check' : 'mdi:cancel'} width={13} /> {x.name}
                      </Tag>
                    ))}
                  </Box>
                )}
              </>
            ) : (
              '—'
            ),
          ],
        ]}
      />
      {source !== 'bridge' && c.bridge.kind !== 'ok' && (
        <Box sx={{ mt: 1.25 }}>
          <BridgeNotice state={c.bridge} adds="the guest’s time against the host’s, and every command’s state from the agent itself" />
        </Box>
      )}
      {source === 'kubevirt' && <StaleNote c={c} />}
      {c.info && <SectionErrors errors={[...sectionErrors(c.info, 'system'), ...sectionErrors(c.info, 'time')]} fixId={FIX_ID} />}
    </Panel>
  );
}

function CpuSection({ c, vcpus }: { c: Ctx; vcpus: number }) {
  const cpu = c.info?.cpu;
  const online = (cpu?.vcpus ?? []).filter(v => v.online).length;
  const offline = (cpu?.vcpus ?? []).filter(v => !v.online).map(v => v.logicalId);
  const times = cpuTimes(cpu?.stats);
  return (
    <Panel title="CPU" icon="mdi:cpu-64-bit" footer={bridgeFooter(c, 'cpu')}>
      <KV
        rows={[
          ['Configured', `${vcpus} vCPU`],
          ...(cpu?.vcpus?.length
            ? ([['In the guest', `${online} of ${cpu.vcpus.length} online${offline.length ? `; offline: ${offline.join(', ')}` : ''}`]] as [string, string][])
            : []),
          ...(cpu?.load ? ([['Load', `${cpu.load.load1.toFixed(2)} · ${cpu.load.load5.toFixed(2)} · ${cpu.load.load15.toFixed(2)} (1, 5, 15 min)`]] as [string, string][]) : []),
        ]}
      />
      <FromBridge c={c} section="cpu" adds="the vCPUs the guest has online, each CPU’s times and the load averages" has={!!cpu}>
        {times.length > 0 && (
          <Box sx={{ mt: 1.5 }}>
            <Table
              label="CPU times"
              head={['CPU', 'User', 'System', 'I/O wait', 'Steal', 'Idle']}
              rows={times.map(x => [x.cpu, percent(x.user), percent(x.system), percent(x.iowait), percent(x.steal), percent(x.idle)])}
            />
            <Muted>Shares of each CPU’s time since the guest booted.</Muted>
          </Box>
        )}
      </FromBridge>
    </Panel>
  );
}

function MemorySection({ c, memoryBytes }: { c: Ctx; memoryBytes: number }) {
  const blocks = c.info?.memory?.blocks;
  const on = (blocks ?? []).filter(b => b.online).length;
  const removable = (blocks ?? []).filter(b => b.online && b.canOffline).length;
  return (
    <Panel title="Memory" icon="mdi:memory" footer={bridgeFooter(c, 'memory')}>
      <KV
        rows={[
          ['Configured', formatBytes(memoryBytes)],
          ...(blocks?.length
            ? ([
                ['Memory blocks', `${on} of ${blocks.length} online${blocks.length - on ? `, ${blocks.length - on} offline` : ''}`],
                ['Can go offline', `${removable}`],
              ] as [string, string][])
            : []),
        ]}
      />
      {!c.windows && (
        <FromBridge c={c} section="memory" adds="the guest’s memory blocks (Linux), online and offline" has={!!blocks} />
      )}
      {c.windows && <Muted>Windows agents do not report memory blocks.</Muted>}
    </Panel>
  );
}

function DisksSection({ c }: { c: Ctx }) {
  const vmDisks = disks(c.vm);
  const guest = c.info?.disks;
  const matches = matchDisks(c.vm, c.vmi, vmDisks, guest);
  const fsBridge = guest?.filesystems ? filesystemsFromBridge(guest.filesystems) : undefined;
  const fsKv = filesystemsFromKubevirt(c.kv?.filesystems ?? c.kv?.info?.fsInfo?.disks);
  const fsList: Filesystem[] = fsBridge ?? fsKv;
  const fsSource: Source = fsBridge ? 'bridge' : 'kubevirt';
  const freeze = c.vmi?.status?.fsFreezeStatus ?? c.kv?.info?.fsFreezeStatus;
  const by = { serial: 'serial', pci: 'PCI address', name: 'device name' } as const;
  return (
    <Panel
      title="Disks and filesystems"
      icon="mdi:harddisk"
      sx={{ gridColumn: { lg: '1 / -1' } }}
      footer={
        <Box sx={{ display: 'grid', gap: 0.25 }}>
          {bridgeFooter(c, 'disks')}
          {fsSource === 'kubevirt' && c.kv && <SourceLine source="kubevirt" commands={['filesystemlist']} readAt={c.kv.readAt} />}
        </Box>
      }
    >
      <FromBridge c={c} section="disks" adds="the guest’s disks and partitions matched to the VM’s, with their I/O counters" has={!!guest?.disks || !!guest?.stats}>
        <Table
          label="Disks"
          head={['VM disk', 'In the guest', 'Partitions', 'Matched by', 'Reads', 'Writes']}
          rows={matches.map(m => [
            m.vmDisk ? (
              <>
                {m.vmDisk.name}
                <Muted>
                  {m.vmDisk.device === 'cdrom' ? 'CD/DVD' : 'Disk'}, {m.vmDisk.bus}
                  {m.vmDisk.serial ? `, serial ${m.vmDisk.serial}` : ''}
                </Muted>
              </>
            ) : (
              <Muted>Not a disk of the VM’s settings</Muted>
            ),
            m.guest ? (
              <>
                <Mono>{m.guest.name}</Mono>
                {m.guest.address && (
                  <Muted>
                    {m.guest.address.busType}
                    {m.guest.address.serial ? `, serial ${m.guest.address.serial}` : ''}
                  </Muted>
                )}
              </>
            ) : (
              <Muted>Not seen in the guest</Muted>
            ),
            m.partitions.length ? m.partitions.map(p => <Mono key={p.name}>{p.name} </Mono>) : '—',
            m.by ? (m.by === 'name' ? <Box title="libvirt’s name for the disk; the guest usually names it the same">device name*</Box> : by[m.by]) : '—',
            m.stats ? `${n(m.stats.stats.readIos)} (${formatBytes((m.stats.stats.readSectors ?? 0) * 512)})` : '—',
            m.stats ? `${n(m.stats.stats.writeIos)} (${formatBytes((m.stats.stats.writeSectors ?? 0) * 512)})` : '—',
          ])}
        />
        {matches.some(m => m.by === 'name') && <Muted>* Matched by libvirt’s device name (vda, sda…), which the guest usually uses too. A disk serial makes it certain.</Muted>}
      </FromBridge>
      <Box sx={{ mt: 2, display: 'grid', gap: 1.25, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        {fsList.map(f => {
          const on = filesystemDisk(f, matches);
          return (
            <Meter
              key={`${f.device}-${f.mountpoint}`}
              label={`${f.mountpoint} (${f.type})`}
              used={f.used}
              total={f.total}
              format={x => formatBytes(x)}
              caption={`${f.device}${on?.vmDisk ? ` on ${on.vmDisk.name}` : ''}`}
            />
          );
        })}
      </Box>
      {!fsList.length && <Muted>No filesystem reported.</Muted>}
      {fsSource === 'kubevirt' && <StaleNote c={c} />}
      <Box sx={{ mt: 1.25, fontSize: 13.5 }}>
        Filesystem freeze: {freeze === 'frozen' ? <b>frozen (a snapshot is being taken, or a freeze was not thawed)</b> : 'not frozen'}
      </Box>
    </Panel>
  );
}

function NetworkSection({ c }: { c: Ctx }) {
  const rows = nics(c.vm, c.vmi);
  const net = c.info?.network;
  const matches = matchNics(rows, net?.interfaces);
  const routes = (net?.routes ?? []).map(routeRow);
  return (
    <Panel title="Network" icon="mdi:ethernet" sx={{ gridColumn: { lg: '1 / -1' } }} footer={net ? bridgeFooter(c, 'network') : <SourceLine source="status" />}>
      {net?.interfaces ? (
        <Table
          label="Network interfaces"
          head={['VM adapter', 'MAC', 'In the guest', 'Addresses', 'Received', 'Sent']}
          rows={matches.map(m => {
            const s = m.guest?.statistics;
            return [
              m.nic ? (
                <>
                  {m.nic.name}
                  <Muted>
                    {m.nic.model}, {m.nic.network}
                  </Muted>
                </>
              ) : (
                <Muted>Not an adapter of the VM</Muted>
              ),
              <Mono key="mac">{m.guest?.hardwareAddress ?? m.nic?.mac ?? '—'}</Mono>,
              m.guest ? m.guest.name : <Muted>Not seen in the guest</Muted>,
              m.guest?.ipAddresses?.length ? (
                <>
                  {m.guest.ipAddresses.map(a => (
                    <Box key={a.ipAddress}>{formatIp(a)}</Box>
                  ))}
                </>
              ) : (
                '—'
              ),
              s ? (
                <>
                  {formatBytes(s.rxBytes)}
                  <Muted>
                    {n(s.rxPackets)} packets{s.rxErrs || s.rxDropped ? `, ${n(s.rxErrs)} errors, ${n(s.rxDropped)} dropped` : ''}
                  </Muted>
                </>
              ) : (
                '—'
              ),
              s ? (
                <>
                  {formatBytes(s.txBytes)}
                  <Muted>
                    {n(s.txPackets)} packets{s.txErrs || s.txDropped ? `, ${n(s.txErrs)} errors, ${n(s.txDropped)} dropped` : ''}
                  </Muted>
                </>
              ) : (
                '—'
              ),
            ];
          })}
        />
      ) : (
        <Table
          label="Network interfaces"
          head={['VM adapter', 'MAC', 'In the guest', 'Addresses']}
          rows={rows.map(r => [r.name, <Mono key="mac">{r.mac ?? '—'}</Mono>, r.guestIface ?? '—', r.ips.join(', ') || '—'])}
        />
      )}
      {routes.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Table
            label="Routes"
            head={['Destination', 'Via', 'Interface', 'Metric']}
            rows={routes.map(r => [r.destination, r.via ?? 'on-link', r.iface, r.metric])}
          />
        </Box>
      )}
      <Box sx={{ mt: 1.25 }}>
        <FromBridge c={c} section="network" adds="every interface the guest has, with its counters, and its routes (qemu-ga 9.1 and later)" has={!!net} />
      </Box>
    </Panel>
  );
}

function UsersSection({ c }: { c: Ctx }) {
  const fromBridge = !!c.info?.users;
  const users = fromBridge ? usersFromBridge(c.info?.users?.items) : c.kv?.users ? usersFromKubevirt(c.kv.users) : undefined;
  const blockedOnBridge = c.info && sectionErrors(c.info, 'users').length > 0;
  return (
    <Panel
      title="Users"
      icon="mdi:account-multiple-outline"
      footer={fromBridge ? bridgeFooter(c, 'users') : c.kv ? <SourceLine source="kubevirt" commands={['userlist']} readAt={c.kv.readAt} /> : undefined}
    >
      {users ? (
        users.length ? (
          <Table label="Users logged in" head={['User', 'Logged in since']} rows={users.map(u => [u.domain ? `${u.domain}\\${u.name}` : u.name, since(u.since)])} />
        ) : (
          <Box sx={{ fontSize: 13.5 }}>Nobody is logged in.</Box>
        )
      ) : (
        <Muted>{c.kv ? 'KubeVirt has no list of users.' : 'The guest agent has not reported its users.'}</Muted>
      )}
      {!fromBridge && <StaleNote c={c} />}
      {blockedOnBridge && <SectionErrors errors={sectionErrors(c.info, 'users')} fixId={FIX_ID} />}
    </Panel>
  );
}

function DevicesSection({ c }: { c: Ctx }) {
  const items = c.info?.devices?.items;
  return (
    <Panel title="Devices and drivers" icon="mdi:microsoft-windows" sx={{ gridColumn: { lg: '1 / -1' } }} footer={bridgeFooter(c, 'devices')}>
      <FromBridge c={c} section="devices" adds="the guest’s devices and their drivers, with the virtio-win versions" has={!!items}>
        {items && (
          <Table
            label="Devices and drivers"
            head={['Driver', 'Version', 'Date', 'PCI ID']}
            rows={items.map(d => {
              const date = driverDateMs(d);
              return [
                <Box key="name" sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
                  {d.driverName}
                  {isVirtioDriver(d) && <Tag tone="accent">virtio-win</Tag>}
                </Box>,
                d.driverVersion ?? '—',
                date !== undefined ? new Date(date).toLocaleDateString() : '—',
                d.id ? <Mono key="id">{`${hex4(d.id.vendorId)}:${hex4(d.id.deviceId)}`}</Mono> : '—',
              ];
            })}
          />
        )}
      </FromBridge>
    </Panel>
  );
}

function SshKeysSection({ c, requested }: { c: Ctx; requested: string[] }) {
  const t = useTokens();
  const users = c.info?.sshkeys?.users;
  return (
    <Panel title="SSH keys" icon="mdi:key-outline" footer={bridgeFooter(c, 'sshkeys')}>
      <FromBridge c={c} section="sshkeys" adds="the authorized SSH keys of root, the VM’s cloud-init user and the users logged in" has={!!users}>
        <Box sx={{ display: 'grid', gap: 1.25 }}>
          {(users ?? [])
            .filter(u => !(noSuchUser(u) && requested.includes(u.username)))
            .map(u => (
              <Box key={u.username}>
                <Box sx={{ fontWeight: 600, fontSize: 13.5 }}>
                  {u.username}
                  {requested.includes(u.username) && <Muted>The VM’s cloud-init user.</Muted>}
                </Box>
                {u.reason ? (
                  <Note icon="mdi:alert-circle-outline" tone={u.reason === 'Blocked' ? 'warn' : 'error'}>
                    {u.message}
                  </Note>
                ) : u.keys.length ? (
                  u.keys.map((k, i) => {
                    const p = keyParts(k);
                    return (
                      <Box key={i} sx={{ fontSize: 13, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'baseline' }}>
                        <Mono>{p.type}</Mono>
                        <Box component="span" title={k} sx={{ fontFamily: t.font.mono, fontSize: 12, color: t.muted }}>
                          {p.short}
                        </Box>
                        {p.comment}
                      </Box>
                    );
                  })
                ) : (
                  <Muted>No authorized keys.</Muted>
                )}
              </Box>
            ))}
          {(users ?? [])
            .filter(u => noSuchUser(u) && requested.includes(u.username))
            .map(u => (
              <Muted key={u.username}>The VM’s cloud-init user {u.username} does not exist in the guest (yet).</Muted>
            ))}
        </Box>
        <Box sx={{ mt: 1.25 }}>
          <Muted>Read only. KubeVirt’s access credentials (spec.accessCredentials) or the guest itself manage them.</Muted>
        </Box>
      </FromBridge>
    </Panel>
  );
}

/* -------------------------------------------------------------- the tab */

export function GuestTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const vmi = d.idx.vmi.get(key(vm));
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name;
  const running = vmi?.status?.phase === 'Running' && !!vmi?.status?.nodeName;
  const connected = guestAgent(vmi);
  const kv = useKubevirtGuest(ns, name, connected);
  const sshUsers = React.useMemo(() => cloudInitUsers(vm), [vm]);
  const { state: bridge, refresh } = useGuestBridge({ namespace: ns, name, running, sshUsers });
  const info = bridge.kind === 'ok' ? bridge.info : undefined;
  const os = vmOs(vm, d);
  const osId = guestOsId(info, kv, vmi, os.id);
  const windows = isWindowsId(osId);
  const health = agentHealth(bridge, connected);
  const hw = hardware(vm, vmi, d.instancetypes);
  const blocked = blockedCommands(info);
  const fix = blockedFix(osId, blocked);

  if (!vmi || !running) {
    return (
      <Empty icon="mdi:power-plug-off-outline" title={vmi ? 'The VM is not running' : 'The VM is powered off'}>
        The guest agent reports while the VM runs.
      </Empty>
    );
  }

  const c: Ctx = { vm, vmi, bridge, info, kv, osId, windows, stale: health === 'not-responding' };
  const bridgeLine =
    bridge.kind === 'ok' ? (
      <>Guest bridge: read at {timeOf(bridge.info.readAt)}.</>
    ) : bridge.kind === 'absent' ? (
      <>Guest bridge: not installed on this cluster. Without it the tab has what KubeVirt reports.</>
    ) : bridge.kind === 'forbidden' ? (
      <>Guest bridge: your role does not include {bridge.role} on this VM.</>
    ) : bridge.kind === 'loading' ? (
      <>Guest bridge: asking…</>
    ) : bridge.kind === 'not-running' ? (
      <>Guest bridge: the VM is not running on a host.</>
    ) : (
      <>Guest bridge: {bridge.message}</>
    );

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Panel
        title="Guest agent"
        icon="mdi:robot-outline"
        actions={
          <Button size="small" onClick={refresh} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:refresh" width={16} />}>
            Refresh
          </Button>
        }
        footer={
          <Box sx={{ display: 'grid', gap: 0.25, fontSize: 12.5, color: t.muted, ...tabular }}>
            <Box>{bridgeLine}</Box>
            <Box>
              KubeVirt’s API: {kv ? `read at ${timeOf(kv.readAt)}${kv.error ? `; ${kv.error}` : ''}.` : connected ? 'asking…' : 'nothing while the agent is not connected.'}
            </Box>
            <Box>Both are read again every 30 s while this tab is open.</Box>
          </Box>
        }
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 15, fontWeight: 600, mb: 1 }}>
          <Led tone={health === 'connected' ? 'on' : health === 'not-responding' ? 'fault' : health === 'unknown' ? 'busy' : 'off'} />
          {health === 'connected'
            ? `Connected${info?.agent.version ?? kv?.info?.guestAgentVersion ? `: qemu-ga ${info?.agent.version ?? kv?.info?.guestAgentVersion}` : ''}`
            : health === 'not-responding'
            ? 'Not responding'
            : health === 'unknown'
            ? 'Checking'
            : 'Not connected'}
        </Box>
        {health === 'not-connected' && (
          <>
            {info?.agent.message && <Note icon="mdi:information-outline">{info.agent.message}</Note>}
            <InstallAgent hint={installHint(osId)} />
          </>
        )}
        {health === 'not-responding' && <AgentNotResponding message={info?.agent.message} restart={restartLine(osId)} />}
        {health === 'connected' && info?.agent.message && <Note icon="mdi:information-outline">{info.agent.message}</Note>}
        {bridge.kind !== 'ok' && bridge.kind !== 'loading' && (
          <Box sx={{ mt: 1 }}>
            <BridgeNotice
              state={bridge}
              adds="what KubeVirt does not: CPU and memory, the disks matched to the VM’s, every interface with its counters and routes, Windows drivers, SSH keys, the guest’s clock, and whether the agent still responds"
            />
          </Box>
        )}
      </Panel>
      {fix && (
        <Box id={FIX_ID}>
          <Panel title="Commands the guest blocks" icon="mdi:cancel">
            <BlockedFixBody fix={fix} commands={blocked} />
          </Panel>
        </Box>
      )}
      {health !== 'not-connected' && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1fr) minmax(0,1fr)' }, alignItems: 'start' }}>
          <SystemSection c={c} />
          <Box sx={{ display: 'grid', gap: 2 }}>
            <CpuSection c={c} vcpus={hw.vcpus} />
            <MemorySection c={c} memoryBytes={hw.memoryBytes} />
          </Box>
          <DisksSection c={c} />
          <NetworkSection c={c} />
          <UsersSection c={c} />
          <SshKeysSection c={c} requested={sshUsers} />
          {(windows || !!info?.devices) && <DevicesSection c={c} />}
        </Box>
      )}
    </Box>
  );
}
