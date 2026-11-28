import fs from 'fs';
import path from 'path';
import {
  agentHealth,
  allowListSed,
  blockedCommands,
  blockedFix,
  bridgeErrorState,
  cloudInitUsers,
  cpuTimes,
  disabledCommands,
  driverDateMs,
  DROPIN_ENABLE_ALL,
  filesystemDisk,
  filesystemsFromBridge,
  filesystemsFromKubevirt,
  formatIp,
  formatTimezone,
  fullFilesystems,
  GuestAgent,
  GuestAgentCommand,
  GuestCPU,
  GuestCPUStats,
  GuestDeviceInfo,
  GuestDiskAddress,
  GuestDiskInfo,
  GuestDisks,
  GuestDiskStats,
  GuestDiskStatsInfo,
  GuestFilesystemInfo,
  GuestInfo,
  GuestInfoError,
  GuestIPAddress,
  GuestLoadAverage,
  GuestLogicalProcessor,
  GuestMemory,
  GuestMemoryBlock,
  GuestNetwork,
  GuestNetworkInterface,
  GuestNetworkInterfaceStat,
  GuestNetworkRoute,
  guestOsId,
  GuestOSInfo,
  GuestPCIAddress,
  GuestSystem,
  GuestTime,
  GuestTimezone,
  GuestUser,
  GuestUserSSHKeys,
  installHint,
  ipsFromStatus,
  ipv6FromHex,
  isVirtioDriver,
  keyParts,
  matchDisks,
  matchNics,
  noSuchUser,
  parseKvTimezone,
  quickInfo,
  restartLine,
  routeRow,
  sectionErrors,
  SSH_USER_NAME,
  usersFromBridge,
  usersFromKubevirt,
} from './guestinfo';
import {
  kvFedoraFilesystems,
  kvFedoraInfo,
  kvFedoraUsers,
  kvWindowsInfo,
  kvWindowsUsers,
  linuxVm,
  linuxVmi,
  windowsVm,
  windowsVmi,
} from './guestinfo.fixture';
import { disks, nics } from './vm';

// The bridge's goldens are real answers (Fedora 45, Rocky 9.9 with an
// allow-list, Ubuntu's qemu-ga 8.2, Windows Server 2022): the plugin reads
// the same files the bridge's tests write.
const TESTDATA = path.resolve('..', 'bridge', 'internal', 'guestinfo', 'testdata');
const golden = (name: string): GuestInfo => JSON.parse(fs.readFileSync(path.join(TESTDATA, `${name}.golden.json`), 'utf8'));
const GOLDENS = ['fedora', 'rocky-blocked', 'ubuntu-8.2', 'windows'];

/*
 * The TypeScript mirror of v1alpha1.GuestInfo: each Shape lists exactly the
 * keys of its interface (the compiler checks that), and every key of the
 * goldens must be in a Shape (the test checks that). A field the bridge
 * adds fails here until the mirror has it.
 */
type Leaf = 0;
type Shape<T> = { [K in keyof Required<T>]: Leaf | object };
const pci: Shape<GuestPCIAddress> = { domain: 0, bus: 0, slot: 0, function: 0 };
const ccw: Shape<NonNullable<GuestDiskAddress['ccwAddress']>> = { cssid: 0, ssid: 0, subchno: 0, devno: 0 };
const address: Shape<GuestDiskAddress> = { pciController: pci, busType: 0, bus: 0, target: 0, unit: 0, serial: 0, dev: 0, ccwAddress: ccw };
const osShape: Shape<GuestOSInfo> = { kernelRelease: 0, kernelVersion: 0, machine: 0, id: 0, name: 0, prettyName: 0, version: 0, versionId: 0, variant: 0, variantId: 0 };
const timezone: Shape<GuestTimezone> = { zone: 0, offset: 0 };
const system: Shape<GuestSystem> = { os: osShape, hostName: 0, timezone };
const vcpu: Shape<GuestLogicalProcessor> = { logicalId: 0, online: 0, canOffline: 0 };
const cpuStats: Shape<GuestCPUStats> = { type: 0, cpu: 0, user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0, guest: 0, guestnice: 0 };
const load: Shape<GuestLoadAverage> = { load1: 0, load5: 0, load15: 0 };
const cpu: Shape<GuestCPU> = { vcpus: [vcpu], stats: [cpuStats], load };
const block: Shape<GuestMemoryBlock> = { physIndex: 0, online: 0, canOffline: 0 };
const memory: Shape<GuestMemory> = { blocks: [block] };
const diskStats: Shape<GuestDiskStats> = {
  readSectors: 0,
  readIos: 0,
  readMerges: 0,
  writeSectors: 0,
  writeIos: 0,
  writeMerges: 0,
  discardSectors: 0,
  discardIos: 0,
  discardMerges: 0,
  flushIos: 0,
  readTicks: 0,
  writeTicks: 0,
  discardTicks: 0,
  flushTicks: 0,
  iosPending: 0,
  totalTicks: 0,
  weightTicks: 0,
};
const statsInfo: Shape<GuestDiskStatsInfo> = { name: 0, major: 0, minor: 0, stats: diskStats };
const disk: Shape<GuestDiskInfo> = { name: 0, partition: 0, dependencies: 0, address, alias: 0 };
const fsShape: Shape<GuestFilesystemInfo> = { name: 0, mountpoint: 0, type: 0, usedBytes: 0, totalBytes: 0, totalBytesPrivileged: 0, disk: [address] };
const disksShape: Shape<GuestDisks> = { disks: [disk], stats: [statsInfo], filesystems: [fsShape] };
const ip: Shape<GuestIPAddress> = { ipAddress: 0, ipAddressType: 0, prefix: 0 };
const ifStats: Shape<GuestNetworkInterfaceStat> = { rxBytes: 0, rxPackets: 0, rxErrs: 0, rxDropped: 0, txBytes: 0, txPackets: 0, txErrs: 0, txDropped: 0 };
const iface: Shape<GuestNetworkInterface> = { name: 0, hardwareAddress: 0, ipAddresses: [ip], statistics: ifStats };
const route: Shape<GuestNetworkRoute> = {
  iface: 0,
  destination: 0,
  metric: 0,
  version: 0,
  gateway: 0,
  mask: 0,
  irtt: 0,
  flags: 0,
  refcnt: 0,
  use: 0,
  window: 0,
  mtu: 0,
  desprefixlen: 0,
  source: 0,
  srcprefixlen: 0,
  nexthop: 0,
};
const network: Shape<GuestNetwork> = { interfaces: [iface], routes: [route] };
const user: Shape<GuestUser> = { user: 0, domain: 0, loginTime: 0 };
const deviceId: Shape<NonNullable<GuestDeviceInfo['id']>> = { type: 0, vendorId: 0, deviceId: 0 };
const device: Shape<GuestDeviceInfo> = { driverName: 0, driverDate: 0, driverVersion: 0, id: deviceId };
const sshUser: Shape<GuestUserSSHKeys> = { username: 0, keys: 0, reason: 0, message: 0 };
const command: Shape<GuestAgentCommand> = { name: 0, enabled: 0 };
const agent: Shape<GuestAgent> = { connected: 0, healthy: 0, version: 0, commands: [command], message: 0 };
const error: Shape<GuestInfoError> = { section: 0, command: 0, reason: 0, message: 0 };
const time: Shape<GuestTime> = { guestTime: 0, hostTime: 0, driftSeconds: 0 };
const guestInfo: Shape<GuestInfo> = {
  kind: 0,
  apiVersion: 0,
  agent,
  system,
  cpu,
  memory,
  disks: disksShape,
  network,
  users: { items: [user] },
  devices: { items: [device] },
  sshkeys: { users: [sshUser] },
  time,
  errors: [error],
  readAt: 0,
};

function unknownKeys(value: any, shape: any, at: string): string[] {
  if (shape === 0 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(shape)) return (value as any[]).flatMap((v, i) => unknownKeys(v, shape[0], `${at}[${i}]`));
  return Object.keys(value).flatMap(k => (k in shape ? unknownKeys(value[k], shape[k], `${at}.${k}`) : [`${at}.${k}`]));
}

describe('the GuestInfo mirror', () => {
  it.each(GOLDENS)('%s: every field of the bridge answer is in the TypeScript types', name => {
    expect(unknownKeys(golden(name), guestInfo, 'GuestInfo')).toEqual([]);
  });

  it('the goldens are what the Guest tab needs', () => {
    const f = golden('fedora');
    expect(f.kind).toBe('GuestInfo');
    expect(f.agent).toMatchObject({ connected: true, healthy: true, version: '11.1.2' });
    expect(f.system?.os?.prettyName).toBe('Fedora Linux 45 (Cloud Edition)');
    expect(golden('windows').system?.os?.id).toBe('mswindows');
  });
});

describe('the bridge state', () => {
  it('maps a failed call by its status and the group discovery', () => {
    expect(bridgeErrorState(403, 'Forbidden', 'present')).toEqual({ kind: 'forbidden', role: 'hangar-viewer' });
    expect(bridgeErrorState(404, 'not found', 'absent')).toEqual({ kind: 'absent' });
    expect(bridgeErrorState(503, 'the server is currently unable to handle the request', 'unavailable')).toMatchObject({ kind: 'unavailable', apiService: true });
    expect(bridgeErrorState(503, 'cannot reach the libvirt of virtualmachineinstance vms/vm yet; try again', 'present')).toMatchObject({ kind: 'unavailable', apiService: false });
    expect(bridgeErrorState(409, 'not running', 'present')).toEqual({ kind: 'not-running' });
    expect(bridgeErrorState(404, 'virtualmachineinstances.kubevirt.io "vm" not found', 'present')).toMatchObject({ kind: 'error' });
    expect(bridgeErrorState(500, 'boom', 'unknown')).toMatchObject({ kind: 'error', message: 'boom' });
  });

  it('the agent is not responding from the bridge, never from AgentConnected', () => {
    const broken: GuestInfo = {
      agent: { connected: true, healthy: false, message: 'restart qemu-guest-agent in the guest' },
      errors: [{ section: 'system', command: 'guest-info', reason: 'NotResponding', message: 'x' }],
      readAt: '2026-11-28T04:00:00Z',
    };
    expect(agentHealth({ kind: 'ok', info: broken }, true)).toBe('not-responding');
    expect(agentHealth({ kind: 'ok', info: golden('fedora') }, true)).toBe('connected');
    expect(agentHealth({ kind: 'ok', info: { agent: { connected: false, healthy: false }, readAt: '' } }, true)).toBe('not-connected');
    expect(agentHealth({ kind: 'absent' }, true)).toBe('connected');
    expect(agentHealth({ kind: 'absent' }, false)).toBe('not-connected');
    expect(agentHealth({ kind: 'loading' }, false)).toBe('unknown');
    // NotResponding is said once, by the agent's state, not in every section.
    expect(sectionErrors(broken, 'system')).toEqual([]);
  });
});

describe('blocked commands', () => {
  const rocky = golden('rocky-blocked');

  it('lists what the guest blocks, per section', () => {
    expect(blockedCommands(rocky)).toEqual(['guest-network-get-route', 'guest-get-users', 'guest-ssh-get-authorized-keys']);
    expect(sectionErrors(rocky, 'users').map(e => e.reason)).toEqual(['Blocked']);
    expect(disabledCommands(rocky.agent.commands)).toContain('guest-exec');
    expect(blockedCommands(golden('fedora'))).toEqual([]);
    expect(sectionErrors(golden('ubuntu-8.2'), 'cpu')[0].message).toContain('needs qemu-ga 10.0');
  });

  it('Rocky: the two tested ways, each with the restart', () => {
    const fix = blockedFix(guestOsId(rocky, null, null), blockedCommands(rocky));
    expect(fix?.where).toContain('/etc/sysconfig/qemu-ga');
    expect(fix?.ways).toHaveLength(2);
    expect(fix?.ways[0].lines).toEqual([
      `sudo sed -i -E 's/^(FILTER_RPC_ARGS="--allow-rpcs=[^"]*)"/\\1,guest-network-get-route,guest-get-users,guest-ssh-get-authorized-keys"/' /etc/sysconfig/qemu-ga`,
      'sudo systemctl restart qemu-guest-agent',
    ]);
    // The lab's line for the file commands (prototype A5), verbatim.
    expect(allowListSed(['guest-exec', 'guest-exec-status', 'guest-file-open', 'guest-file-close', 'guest-file-read', 'guest-file-write', 'guest-file-seek', 'guest-file-flush'])[0]).toBe(
      `sudo sed -i -E 's/^(FILTER_RPC_ARGS="--allow-rpcs=[^"]*)"/\\1,guest-exec,guest-exec-status,guest-file-open,guest-file-close,guest-file-read,guest-file-write,guest-file-seek,guest-file-flush"/' /etc/sysconfig/qemu-ga`
    );
    // The drop-in lines of spec §8.11, verbatim, without the SELinux module.
    expect(fix?.ways[1].lines).toEqual(DROPIN_ENABLE_ALL);
    expect(DROPIN_ENABLE_ALL).toEqual([
      'sudo mkdir -p /etc/hangar /etc/systemd/system/qemu-guest-agent.service.d',
      "printf '[Service]\\nEnvironmentFile=-/etc/hangar/qemu-ga.env\\n' | sudo tee /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf >/dev/null",
      "echo 'FILTER_RPC_ARGS=' | sudo tee /etc/hangar/qemu-ga.env >/dev/null",
      'sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent',
    ]);
    expect(fix?.ways[1].note).toContain('hangar-guest-admin');
    expect(fix?.ways[1].revert?.join('\n')).toContain('rm -f /etc/hangar/qemu-ga.env');
  });

  it('other guests: where the list is, and the restart', () => {
    expect(blockedFix('ubuntu', ['guest-get-users'])?.where).toContain('sudo systemctl restart qemu-guest-agent');
    expect(blockedFix('mswindows', ['guest-get-devices'])?.where).toContain('Restart-Service QEMU-GA');
    expect(blockedFix('rocky', [])).toBeNull();
  });
});

describe('the agent: install and restart', () => {
  it('per OS', () => {
    expect(installHint('fedora').lines?.[0]).toBe('sudo dnf install -y qemu-guest-agent');
    expect(installHint('rocky').lines?.[0]).toBe('sudo dnf install -y qemu-guest-agent');
    expect(installHint('ubuntu').lines?.[0]).toBe('sudo apt install -y qemu-guest-agent');
    expect(installHint('debian').lines?.[1]).toBe('sudo systemctl start qemu-guest-agent');
    expect(installHint('windows').text).toContain('virtio-win guest tools');
    expect(installHint('').lines).toBeUndefined();
    expect(restartLine('mswindows')).toBe('Restart-Service QEMU-GA');
    expect(restartLine('rocky')).toBe('sudo systemctl restart qemu-guest-agent');
  });
});

describe('matching disks', () => {
  it('by serial, with partitions, stats and filesystems (Linux)', () => {
    const vm = linuxVm();
    const vmi = linuxVmi();
    const g = golden('fedora');
    const m = matchDisks(vm, vmi, disks(vm), g.disks);
    expect(m.map(x => [x.vmDisk?.name, x.guest?.name, x.by])).toEqual([
      ['rootdisk', '/dev/vda', 'serial'],
      ['datadisk', '/dev/vdb', 'serial'],
      // No such disk in the guest (an empty disk it has not formatted is still
      // listed by a real guest; the fixture leaves it out).
      ['scratch', undefined, undefined],
    ]);
    expect(m[0].partitions.map(p => p.name)).toEqual(['/dev/vda1', '/dev/vda2']);
    expect(m[0].stats?.name).toBe('vda');
    const fsList = filesystemsFromBridge(g.disks?.filesystems);
    expect(filesystemDisk(fsList[0], m)?.vmDisk?.name).toBe('rootdisk');
  });

  it('by PCI address, then by device name, without serials', () => {
    const vm = linuxVm();
    const d = vm.spec.template.spec.domain.devices.disks;
    delete d[0].serial;
    delete d[1].serial;
    d[1].disk.pciAddress = '0000:08:00.0';
    const m = matchDisks(vm, linuxVmi(), disks(vm), golden('fedora').disks);
    expect(m.map(x => [x.vmDisk?.name, x.guest?.name, x.by])).toEqual([
      ['rootdisk', '/dev/vda', 'name'],
      ['datadisk', '/dev/vdb', 'pci'],
      ['scratch', undefined, undefined],
    ]);
  });

  it('a 20-character virtio serial, and guest disks the VM does not have', () => {
    const vm = linuxVm();
    vm.spec.template.spec.domain.devices.disks[0].serial = 'rootdisk-0123456789abcdef';
    const g = golden('fedora');
    const guest = { ...g.disks, disks: (g.disks?.disks ?? []).map(x => (x.name === '/dev/vda' ? { ...x, address: { ...x.address!, serial: 'rootdisk-0123456789a' } } : x)) };
    const m = matchDisks(vm, null, disks(vm).filter(r => r.name !== 'datadisk'), guest);
    expect(m.map(x => [x.vmDisk?.name, x.guest?.name, x.by])).toEqual([
      ['rootdisk', '/dev/vda', 'serial'],
      ['scratch', undefined, undefined],
      [undefined, '/dev/vdb', undefined],
    ]);
  });

  it('Windows: by serial on SATA', () => {
    const vm = windowsVm();
    const m = matchDisks(vm, windowsVmi(), disks(vm), golden('windows').disks);
    expect(m.map(x => [x.vmDisk?.name, x.guest?.name, x.by])).toEqual([['rootdisk', '\\\\.\\PhysicalDrive0', 'serial']]);
  });
});

describe('matching NICs', () => {
  it('by MAC; the guest’s others last', () => {
    const vm = linuxVm();
    const m = matchNics(nics(vm, linuxVmi()), golden('fedora').network?.interfaces);
    expect(m.map(x => [x.nic?.name, x.guest?.name])).toEqual([
      ['default', 'eth0'],
      ['lan', undefined],
      [undefined, 'lo'],
    ]);
    expect(m[0].guest?.statistics?.rxBytes).toBeGreaterThan(0);
    expect(formatIp(m[0].guest!.ipAddresses![0])).toBe('10.0.2.2/24');
  });

  it('MACs in another case and with dashes (Windows)', () => {
    const vm = windowsVm();
    const g = golden('windows').network!.interfaces!.map(i => ({ ...i, hardwareAddress: i.hardwareAddress?.toUpperCase().replace(/:/g, '-') }));
    const m = matchNics(nics(vm, windowsVmi()), g);
    expect(m[0].guest?.name).toBe('Ethernet Instance 0');
    expect(formatIp(m[0].guest!.ipAddresses![0])).toBe('fe80::2c5e:7aff:fe00:2/64');
  });
});

describe('filesystems, users, CPU, devices, keys', () => {
  it('filesystems from either source, and the full ones', () => {
    expect(filesystemsFromBridge(golden('fedora').disks?.filesystems).map(f => f.mountpoint)).toEqual(['/', '/boot/efi']);
    const kv = filesystemsFromKubevirt(kvFedoraFilesystems);
    expect(kv.map(f => f.mountpoint)).toEqual(['/', '/boot/efi', '/data']);
    // / is at 84.9 %: not yet a warning.
    expect(fullFilesystems(kv).map(f => f.mountpoint)).toEqual(['/data']);
  });

  it('users: one entry per user, the first login', () => {
    expect(usersFromBridge(golden('ubuntu-8.2').users?.items)).toEqual([{ name: 'ubuntu', domain: undefined, since: 1795836100500 }]);
    expect(usersFromBridge(golden('windows').users?.items)[0]).toMatchObject({ name: 'Administrator', domain: 'WIN-GUEST' });
    expect(usersFromKubevirt(kvFedoraUsers)).toEqual([{ name: 'fedora', domain: undefined, since: 1795836000125 }]);
  });

  it('CPU times as shares since boot', () => {
    const t = cpuTimes(golden('fedora').cpu?.stats);
    expect(t).toHaveLength(2);
    for (const c of t) expect(c.user + c.system + c.iowait + c.steal + c.idle).toBeCloseTo(1, 9);
    expect(t[0].idle).toBeGreaterThan(0.9);
  });

  it('virtio-win drivers (Windows)', () => {
    const devs = golden('windows').devices!.items;
    expect(devs.map(isVirtioDriver)).toEqual([true, true, true, false]);
    expect(driverDateMs(devs[0])).toBe(Date.UTC(2024, 0, 1));
    expect(driverDateMs(devs[3])).toBeUndefined();
  });

  it('SSH keys: parts of a line, and a user the guest lacks', () => {
    expect(keyParts('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHangarFixtureKeyNotARealKey000000000000000 user@example')).toEqual({
      type: 'ssh-ed25519',
      short: 'AAAAC3NzaC1l…00000000',
      comment: 'user@example',
    });
    expect(noSuchUser({ username: 'ghost', keys: [], reason: 'AgentError', message: "failed to lookup user 'ghost': No such file or directory" })).toBe(true);
    expect(noSuchUser(golden('fedora').sshkeys!.users[0])).toBe(false);
  });
});

describe('routes', () => {
  it('as people read them, IPv6 from /proc/net/ipv6_route', () => {
    expect(golden('fedora').network!.routes!.map(routeRow)).toEqual([
      { destination: 'default', via: '10.0.2.1', iface: 'eth0', metric: 100, version: 4 },
      { destination: '10.0.2.0/24', via: undefined, iface: 'eth0', metric: 100, version: 4 },
      { destination: 'fe80::/64', via: undefined, iface: 'eth0', metric: 256, version: 6 },
    ]);
    expect(ipv6FromHex('20010db8000000000000000000000001')).toBe('2001:db8::1');
    expect(ipv6FromHex('00000000000000000000000000000000')).toBe('::');
    expect(ipv6FromHex('20010db8000100020003000400050006')).toBe('2001:db8:1:2:3:4:5:6');
    expect(ipv6FromHex('fd000000000000010000000000000000')).toBe('fd00:0:0:1::');
    expect(routeRow({ iface: 'eth0', destination: '00000000000000000000000000000000', desprefixlen: '00', nexthop: 'fe800000000000000000000000000001', metric: 1024, version: 6 })).toEqual({
      destination: 'default',
      via: 'fe80::1',
      iface: 'eth0',
      metric: 1024,
      version: 6,
    });
  });
});

describe('the cloud-init users (sshUsers)', () => {
  it('reads users: and user: from inline user data', () => {
    expect(cloudInitUsers(linuxVm())).toEqual(['k4all']);
    expect(cloudInitUsers(linuxVm('#cloud-config\nusers:\n  - default\n  - name: ops\n  - dev\nuser: admin\n'))).toEqual(['admin', 'ops', 'dev']);
    expect(cloudInitUsers(linuxVm('#cloud-config\nuser:\n  name: alice\n'))).toEqual(['alice']);
    expect(cloudInitUsers(linuxVm('#cloud-config\nusers: [a, b, c, d, e]\n'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('only names the bridge accepts, and only cloud-config', () => {
    expect(cloudInitUsers(linuxVm('#cloud-config\nusers:\n  - name: Bad User\n  - name: "../etc"\n  - name: ok_1\n'))).toEqual(['ok_1']);
    expect(cloudInitUsers(linuxVm('#!/bin/sh\nuseradd bob\n'))).toEqual([]);
    expect(cloudInitUsers(linuxVm('#cloud-config\nusers: [unclosed\n'))).toEqual([]);
    for (const u of cloudInitUsers(linuxVm('#cloud-config\nusers: [k4all, root]\n'))) expect(SSH_USER_NAME.test(u)).toBe(true);
  });

  it('base64 user data, and none in a Secret', () => {
    const vm = linuxVm();
    vm.spec.template.spec.volumes[3].cloudInitNoCloud = { userDataBase64: btoa('#cloud-config\nusers:\n  - name: b64user\n') };
    expect(cloudInitUsers(vm)).toEqual(['b64user']);
    vm.spec.template.spec.volumes[3].cloudInitNoCloud = { secretRef: { name: 'vm-cloud-init' } };
    expect(cloudInitUsers(vm)).toEqual([]);
  });
});

describe('quick info', () => {
  it('from KubeVirt only (no bridge)', () => {
    const q = quickInfo(linuxVmi(), { info: kvFedoraInfo, users: kvFedoraUsers, filesystems: kvFedoraFilesystems, readAt: 0 }, { kind: 'absent' });
    expect(q).toMatchObject({
      os: 'Fedora Linux 45 (Cloud Edition)',
      kernel: '7.2.11-300.fc45.x86_64',
      arch: 'x86_64',
      hostName: 'fedora',
      timezone: 'UTC',
      agentVersion: '11.1.2',
      connectedSince: '2026-11-28T03:10:00Z',
    });
    expect(q.ips).toEqual([{ name: 'eth0', ips: ['10.0.2.2'], fromAgent: true }]);
    expect(q.users?.map(u => u.name)).toEqual(['fedora']);
    expect(q.full.map(f => f.mountpoint)).toEqual(['/data']);
    expect(q.load).toBeUndefined();
    expect(q.drift).toBeUndefined();
  });

  it('with the bridge: load, and the drift past a few seconds', () => {
    const info = golden('fedora');
    expect(quickInfo(linuxVmi(), null, { kind: 'ok', info }).load).toEqual({ load1: 0.08, load5: 0.03, load15: 0.01 });
    expect(quickInfo(linuxVmi(), null, { kind: 'ok', info }).drift).toBeUndefined();
    const late = { ...info, time: { ...info.time!, driftSeconds: -42.5 } };
    expect(quickInfo(linuxVmi(), null, { kind: 'ok', info: late }).drift).toBe(-42.5);
  });

  it('Windows: the zone with its offset, the domain user', () => {
    const q = quickInfo(windowsVmi(), { info: kvWindowsInfo, users: kvWindowsUsers, readAt: 0 }, { kind: 'absent' });
    expect(q.timezone).toBe('Pacific Standard Time (UTC−08:00)');
    expect(q.users?.[0]).toMatchObject({ name: 'Administrator', domain: 'WIN-GUEST' });
    expect(formatTimezone(golden('windows').system?.timezone)).toBe('Pacific Standard Time (UTC−08:00)');
    expect(parseKvTimezone('Asia/Kolkata, 19800')).toEqual({ zone: 'Asia/Kolkata', offset: 19800 });
    expect(formatTimezone(parseKvTimezone('Asia/Kolkata, 19800'))).toBe('Asia/Kolkata (UTC+05:30)');
  });

  it('IPs without the agent: from the network, said so', () => {
    expect(ipsFromStatus(linuxVmi(false))).toEqual([{ name: 'eth0', ips: ['10.0.2.2'], fromAgent: false }]);
  });
});
