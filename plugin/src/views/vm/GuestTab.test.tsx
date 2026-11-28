import { render, screen, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { BridgeState, GuestInfo, KubevirtGuest } from '../../model/guestinfo';
import { kvFedoraFilesystems, kvFedoraInfo, kvFedoraUsers, kvWindowsInfo, kvWindowsUsers, linuxVm, linuxVmi, windowsVm, windowsVmi } from '../../model/guestinfo.fixture';
import { Obj } from '../../model/types';
import { GuestSummary } from './GuestSummary';
import { GuestTab } from './GuestTab';

// The bridge's real answers (bridge/internal/guestinfo/testdata).
const golden = (name: string): GuestInfo =>
  JSON.parse(fs.readFileSync(path.resolve('..', 'bridge', 'internal', 'guestinfo', 'testdata', `${name}.golden.json`), 'utf8'));

const state = {
  vm: linuxVm() as Obj,
  vmi: linuxVmi() as Obj | undefined,
  kv: null as KubevirtGuest | null,
  bridge: { kind: 'loading' } as BridgeState,
};

vi.mock('../../api/data', () => ({
  useHangar: () => ({
    idx: { vmi: new Map(state.vmi ? [[`${state.vm.metadata.namespace}/${state.vm.metadata.name}`, state.vmi]] : []) },
    instancetypes: [],
    dvs: [],
    pvcs: [],
  }),
}));
vi.mock('../../api/guest', () => ({
  useKubevirtGuest: () => state.kv,
  useGuestBridge: () => ({ state: state.bridge, refresh: vi.fn() }),
}));
vi.mock('../../console/ClipboardTray', () => ({ writeHostClipboard: vi.fn(async () => true) }));
vi.mock('../../shell/nav', () => ({ hrefFor: () => '/c/main/hangar/vms/vms/vm/guest' }));

const kvFedora = (): KubevirtGuest => ({ info: kvFedoraInfo, users: kvFedoraUsers, filesystems: kvFedoraFilesystems, readAt: Date.UTC(2026, 10, 28, 4) });
const ok = (info: GuestInfo): BridgeState => ({ kind: 'ok', info });

const show = (el: React.ReactElement) => render(<MemoryRouter>{el}</MemoryRouter>);
const panel = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;

beforeEach(() => {
  state.vm = linuxVm();
  state.vmi = linuxVmi();
  state.kv = kvFedora();
  state.bridge = ok(golden('fedora'));
});

describe('Guest tab', () => {
  it('Fedora through the bridge: every section, disks and NICs matched', () => {
    show(<GuestTab vm={state.vm} />);
    expect(screen.getByText('Connected: qemu-ga 11.1.2')).toBeTruthy();

    const system = panel('System');
    expect(within(system).getByText('Fedora Linux 45 (Cloud Edition)')).toBeTruthy();
    expect(within(system).getByText(/43 commands, 43 enabled/)).toBeTruthy();
    expect(system.textContent).toContain('guest-get-osinfo');

    const disks = within(panel('Disks and filesystems')).getByRole('table', { name: 'Disks' });
    const root = within(disks).getByText('rootdisk').closest('tr') as HTMLElement;
    expect(root.textContent).toContain('/dev/vda');
    expect(root.textContent).toContain('/dev/vda1');
    expect(root.textContent).toContain('serial');
    expect(within(disks).getByText('scratch').closest('tr')?.textContent).toContain('Not seen in the guest');
    expect(panel('Disks and filesystems').textContent).toContain('/ (xfs)');

    const net = panel('Network');
    const eth = within(within(net).getByRole('table', { name: 'Network interfaces' })).getByText('eth0').closest('tr') as HTMLElement;
    expect(eth.textContent).toContain('default');
    expect(eth.textContent).toContain('10.0.2.2/24');
    expect(within(net).getByRole('table', { name: 'Routes' }).textContent).toContain('10.0.2.1');

    expect(within(panel('Users')).getByText('fedora')).toBeTruthy();
    const keys = panel('SSH keys');
    expect(keys.textContent).toContain('ssh-ed25519');
    expect(keys.textContent).toContain('Permission denied');
    expect(screen.queryByRole('heading', { name: 'Devices and drivers' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Commands the guest blocks' })).toBeNull();
  });

  it('Rocky with an allow-list: what is blocked, and the guest-side fix', () => {
    state.bridge = ok(golden('rocky-blocked'));
    show(<GuestTab vm={state.vm} />);
    const fix = panel('Commands the guest blocks');
    expect(fix.textContent).toContain('/etc/sysconfig/qemu-ga');
    expect(fix.textContent).toContain(
      `sudo sed -i -E 's/^(FILTER_RPC_ARGS="--allow-rpcs=[^"]*)"/\\1,guest-network-get-route,guest-get-users,guest-ssh-get-authorized-keys"/' /etc/sysconfig/qemu-ga`
    );
    expect(fix.textContent).toContain("echo 'FILTER_RPC_ARGS=' | sudo tee /etc/hangar/qemu-ga.env >/dev/null");
    expect(fix.textContent).toContain('sudo systemctl restart qemu-guest-agent');
    const users = panel('Users');
    expect(users.textContent).toContain('guest-get-users is blocked by the guest’s agent configuration.');
    expect(within(users).getByText('How to enable it')).toBeTruthy();
    // KubeVirt still lists the users: they are shown, from KubeVirt.
    expect(within(users).getByText('fedora')).toBeTruthy();
    expect(users.textContent).toContain('From KubeVirt’s API (userlist)');
    expect(panel('SSH keys').textContent).toContain('guest-ssh-get-authorized-keys is blocked');
    expect(screen.getByText(/32 enabled, 11 disabled \(by the guest’s configuration, or not for this OS\)/)).toBeTruthy();
  });

  it('without the bridge: KubeVirt’s part, and what the bridge would add', () => {
    state.bridge = { kind: 'absent' };
    show(<GuestTab vm={state.vm} />);
    expect(screen.getByText(/Guest bridge: not installed on this cluster/)).toBeTruthy();
    expect(panel('CPU').textContent).toContain('Needs Hangar’s guest bridge, which this cluster does not have. It adds the vCPUs the guest has online');
    expect(panel('System').textContent).toContain('From KubeVirt’s API');
    expect(within(panel('System')).getByText('Fedora Linux 45 (Cloud Edition)')).toBeTruthy();
    expect(within(panel('Users')).getByText('fedora')).toBeTruthy();
    expect(panel('Disks and filesystems').textContent).toContain('/data (ext4)');
    // Without the bridge the adapters come from the VMI's status.
    expect(within(panel('Network')).getByText('eth0')).toBeTruthy();
    expect(panel('Network').textContent).toContain('From the VMI’s status');
  });

  it('no permission: the missing role', () => {
    state.bridge = { kind: 'forbidden', role: 'hangar-viewer' };
    show(<GuestTab vm={state.vm} />);
    expect(screen.getByText(/Guest bridge: your role does not include hangar-viewer on this VM/)).toBeTruthy();
    expect(panel('CPU').textContent).toContain('which the role hangar-viewer grants');
  });

  it('agent not responding: from the bridge, although AgentConnected is True', () => {
    state.bridge = ok({
      kind: 'GuestInfo',
      agent: { connected: true, healthy: false, message: 'Guest agent is not responding: QEMU guest agent is not available due to an error; restart qemu-guest-agent in the guest' },
      errors: ['system', 'cpu', 'users'].map(s => ({ section: s as any, command: 'guest-info', reason: 'NotResponding', message: 'not available due to an error' })),
      readAt: '2026-11-28T04:00:00Z',
    });
    show(<GuestTab vm={state.vm} />);
    expect(screen.getByText('Not responding')).toBeTruthy();
    expect(screen.getAllByText('sudo systemctl restart qemu-guest-agent').length).toBeGreaterThan(0);
    expect(panel('CPU').textContent).toContain('No answer: the guest agent does not respond.');
    expect(panel('Users').textContent).toContain('KubeVirt may still show what the agent said before it stopped responding.');
  });

  it('agent not connected: how to install it for this OS', () => {
    state.vm.metadata.annotations = { 'hangar.magesgate.com/os': 'fedora' };
    state.vmi = linuxVmi(false);
    state.kv = null;
    state.bridge = ok({ agent: { connected: false, healthy: false, message: 'the guest agent is not connected: QEMU guest agent is not connected' }, readAt: '2026-11-28T04:00:00Z' });
    show(<GuestTab vm={state.vm} />);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/sudo dnf install -y qemu-guest-agent/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'CPU' })).toBeNull();
  });

  it('an old agent: the command it lacks and the version it needs', () => {
    state.bridge = ok(golden('ubuntu-8.2'));
    show(<GuestTab vm={state.vm} />);
    expect(panel('CPU').textContent).toContain('needs qemu-ga 10.0 or later');
    expect(panel('Network').textContent).toContain('needs qemu-ga 9.1 or later');
  });

  it('Windows: devices and drivers, virtio-win highlighted', () => {
    state.vm = windowsVm();
    state.vmi = windowsVmi();
    state.kv = { info: kvWindowsInfo, users: kvWindowsUsers, readAt: 0 };
    state.bridge = ok(golden('windows'));
    show(<GuestTab vm={state.vm} />);
    const devices = panel('Devices and drivers');
    expect(within(devices).getAllByText('virtio-win')).toHaveLength(3);
    expect(devices.textContent).toContain('1af4:1042');
    expect(devices.textContent).toContain('Microsoft Basic Display Adapter');
    expect(panel('Memory').textContent).toContain('Windows agents do not report memory blocks.');
    expect(panel('Users').textContent).toContain('WIN-GUEST\\Administrator');
    expect(within(panel('Disks and filesystems')).getByRole('table', { name: 'Disks' }).textContent).toContain('\\\\.\\PhysicalDrive0');
    expect(panel('Network').textContent).toContain('Ethernet Instance 0');
  });

  it('a powered-off VM', () => {
    state.vmi = undefined;
    show(<GuestTab vm={state.vm} />);
    expect(screen.getByText('The VM is powered off')).toBeTruthy();
  });
});

describe('Summary quick info', () => {
  it('KubeVirt’s report with the bridge’s load and clock', () => {
    // The Summary asks for sections=cpu,time only.
    const { agent, cpu, time, readAt } = golden('fedora');
    state.bridge = ok({ agent, cpu, time: { ...time!, driftSeconds: -42.5 }, readAt });
    show(<GuestSummary vm={state.vm} />);
    const p = panel('Guest');
    expect(p.textContent).toContain('Fedora Linux 45 (Cloud Edition)');
    expect(p.textContent).toContain('7.2.11-300.fc45.x86_64 (x86_64)');
    expect(p.textContent).toContain('qemu-ga 11.1.2, connected');
    expect(p.textContent).toContain('eth0: 10.0.2.2');
    expect(within(p).getByText('1 user')).toBeTruthy();
    expect(p.textContent).toContain('0.08 · 0.03 · 0.01');
    expect(p.textContent).toContain('The guest’s clock is 42.5 s behind the host’s.');
    expect(p.textContent).toContain('/data is 95 % full');
    expect(p.textContent).not.toContain('/ is');
  });

  it('without the bridge: no load, no clock, the rest from KubeVirt', () => {
    state.bridge = { kind: 'absent' };
    show(<GuestSummary vm={state.vm} />);
    const p = panel('Guest');
    expect(p.textContent).toContain('qemu-ga 11.1.2');
    expect(p.textContent).not.toContain('Load');
    expect(p.textContent).not.toContain('clock');
  });

  it('no agent: the install hint; a broken agent: the restart', () => {
    state.vm.metadata.annotations = { 'hangar.magesgate.com/os': 'ubuntu' };
    state.vmi = linuxVmi(false);
    state.kv = null;
    state.bridge = { kind: 'absent' };
    const { unmount } = show(<GuestSummary vm={state.vm} />);
    expect(panel('Guest').textContent).toContain('sudo apt install -y qemu-guest-agent');
    expect(panel('Guest').textContent).toContain('(from the network, not the agent)');
    unmount();

    state.vmi = linuxVmi();
    state.kv = kvFedora();
    state.bridge = ok({ agent: { connected: true, healthy: false, message: 'not available due to an error' }, readAt: '2026-11-28T04:00:00Z' });
    show(<GuestSummary vm={state.vm} />);
    expect(panel('Guest').textContent).toContain('The guest agent does not respond.');
    expect(panel('Guest').textContent).toContain('sudo systemctl restart qemu-guest-agent');
  });
});
