import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { FilePerms } from '../../api/guestfiles';
import { FakeGuest, FakeLocalDir } from '../../api/guestfiles.fixture';
import { FULL_ACCESS_ENABLE, FULL_ACCESS_REVERT } from '../../model/guestfiles';
import { BridgeState, DROPIN_ENABLE_ALL, GuestInfo } from '../../model/guestinfo';
import { linuxVm, linuxVmi } from '../../model/guestinfo.fixture';
import { Obj } from '../../model/types';
import { DialogHost } from '../../ui/dialogs';
import { FilesTab } from './FilesTab';

const ALL: FilePerms = { loading: false, get: true, create: true, update: true, delete: true };

const state = {
  vm: linuxVm() as Obj,
  vmi: linuxVmi() as Obj | undefined,
  bridge: { kind: 'loading' } as BridgeState,
  perms: ALL,
  guest: new FakeGuest(),
  fsa: false,
  pick: null as FakeLocalDir | null,
};

vi.mock('../../api/data', () => ({
  useHangar: () => ({ idx: { vmi: new Map(state.vmi ? [[`${state.vm.metadata.namespace}/${state.vm.metadata.name}`, state.vmi]] : []) } }),
}));
vi.mock('../os', () => ({ vmOs: () => ({ id: '' }) }));
vi.mock('../../api/guest', () => ({ useGuestBridge: () => ({ state: state.bridge, refresh: vi.fn() }) }));
vi.mock('../../api/guestfiles', async orig => ({ ...((await orig()) as object), useFilePerms: () => state.perms, bridgeChannel: () => state.guest }));
vi.mock('../../api/localfs', async orig => ({
  ...((await orig()) as object),
  fsaSupported: () => state.fsa,
  loadRootHandle: async () => null,
  saveRootHandle: async () => undefined,
  pickDirectory: async () => state.pick,
  fsaDir: (h: unknown) => h,
}));
vi.mock('../../console/ClipboardTray', () => ({ writeHostClipboard: vi.fn(async () => true) }));

const FILE_CMDS = ['guest-exec', 'guest-exec-status', 'guest-file-open', 'guest-file-close', 'guest-file-read', 'guest-file-write', 'guest-file-seek', 'guest-file-flush'];

function info(osId: string, o: { blocked?: boolean; mounts?: string[] } = {}): BridgeState {
  const i: GuestInfo = {
    agent: { connected: true, healthy: true, version: '9.0', commands: [{ name: 'guest-info', enabled: true }, ...FILE_CMDS.map(name => ({ name, enabled: !o.blocked }))] },
    system: { os: { id: osId, name: osId } },
    disks: { filesystems: (o.mounts ?? ['/']).map(m => ({ name: 'vda1', mountpoint: m, type: 'xfs', totalBytes: 1, usedBytes: 0 })) },
    readAt: '2026-11-28T12:00:00Z',
  };
  return { kind: 'ok', info: i };
}

const show = () =>
  render(
    <MemoryRouter>
      <FilesTab vm={state.vm} />
      <DialogHost />
    </MemoryRouter>
  );
const vmPane = () => screen.getByRole('region', { name: 'The VM’s files' });
const rows = (pane: HTMLElement) => within(pane).queryAllByRole('row').slice(1).map(r => r.textContent);

beforeEach(() => {
  state.vm = linuxVm();
  state.vmi = linuxVmi();
  state.perms = ALL;
  state.guest = new FakeGuest().file('/a.txt', 'hello').dir('/etc');
  state.bridge = info('fedora');
  state.fsa = false;
  state.pick = null;
});

describe('Files tab: who may, and when', () => {
  it('a role without hangar-guest-admin on this VM (hangar-viewer): refused with the role that grants it; nothing is listed', () => {
    state.perms = { ...ALL, get: false, create: false, update: false, delete: false };
    show();
    expect(screen.getByText('Your role does not reach this VM’s files')).toBeTruthy();
    expect(screen.getByText(/the role hangar-guest-admin grants/)).toBeTruthy();
    expect(screen.getByText(/resourceNames/)).toBeTruthy();
    expect(state.guest.calls).toEqual([]);
  });

  it('read only (get without update): upload and edits are off, with the reason', async () => {
    state.perms = { ...ALL, update: false };
    show();
    await screen.findByText('a.txt');
    expect((within(vmPane()).getByRole('button', { name: 'Upload' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('no guest bridge on the cluster', () => {
    state.bridge = { kind: 'absent' };
    show();
    expect(screen.getByText('Needs Hangar’s guest bridge')).toBeTruthy();
  });

  it('a VM that is off', () => {
    state.vmi = undefined;
    show();
    expect(screen.getByText('The VM is powered off')).toBeTruthy();
  });
});

describe('Files tab: SELinux-confined guests (Fedora, RHEL family)', () => {
  it('a partial listing says so, with how many entries could be read', async () => {
    state.guest.hidden.set('/', 17);
    show();
    await screen.findByText('a.txt');
    const pane = vmPane();
    expect(within(pane).getByText(/some entries are hidden from the guest agent by SELinux/)).toBeTruthy();
    expect(within(pane).getByText(/2 entries could be read/)).toBeTruthy();
    expect(within(pane).getByText(/could not read 17 entries/)).toBeTruthy();
  });

  it('the guest-side change that lets the agent write everywhere, its revert, the trade-off and the wizard option', async () => {
    show();
    await screen.findByText('a.txt');
    expect(screen.getByText(/SELinux confines the guest agent in this guest/)).toBeTruthy();
    const panel = screen.getByRole('heading', { name: 'Let the guest agent reach every file' }).closest('section') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    expect(within(panel).getByLabelText('Let the guest agent reach every file').textContent).toBe(FULL_ACCESS_ENABLE.join('\n'));
    expect(within(panel).getByLabelText('Undo: let the guest agent reach every file').textContent).toBe(FULL_ACCESS_REVERT.join('\n'));
    expect(panel.textContent).toContain('at least as strict as root SSH into this guest');
    expect(panel.textContent).toContain('Hangar cannot make it through the agent');
    expect(panel.textContent).toContain('Let the guest agent reach the whole guest');
  });

  it('a write outside /tmp and /var/tmp refused with EACCES says why, and opens the change', async () => {
    state.guest.confined = true;
    show();
    await screen.findByText('a.txt');
    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [new File(['x'], 'x.conf')] } });
    expect(await screen.findByText(/SELinux confines it in this guest, and it writes only in \/tmp and \/var\/tmp/)).toBeTruthy();
    const panel = screen.getByRole('heading', { name: 'Let the guest agent reach every file' }).closest('section') as HTMLElement;
    expect(within(panel).getByRole('button', { name: 'Hide' })).toBeTruthy();
    expect(state.guest.nodes.has('/x.conf')).toBe(false);
  });
});

describe('Files tab: per OS', () => {
  it('Rocky with its allow-list: the two tested ways to enable the file commands, each with the restart', async () => {
    state.bridge = info('rocky', { blocked: true });
    state.guest.failNext('list', 403, "the guest agent's configuration disables guest-exec, guest-exec-status (qemu-ga --allow-rpcs or --block-rpcs; on RHEL-family guests, FILTER_RPC_ARGS in /etc/sysconfig/qemu-ga)");
    show();
    const panel = (await screen.findByRole('heading', { name: 'Commands the guest blocks' })).closest('section') as HTMLElement;
    const sed = within(panel).getByLabelText('Add these commands to the allow-list').textContent ?? '';
    expect(sed).toContain(`\\1,${FILE_CMDS.join(',')}"/' /etc/sysconfig/qemu-ga`);
    expect(sed.split('\n')[1]).toBe('sudo systemctl restart qemu-guest-agent');
    expect(within(panel).getByLabelText('Or turn the allow-list off with a systemd drop-in').textContent).toBe(DROPIN_ENABLE_ALL.join('\n'));
    expect(panel.textContent).toContain('replaces both ways above');
    expect(await within(vmPane()).findByText(/disables guest-exec and guest-exec-status/)).toBeTruthy();
  });

  it('Ubuntu: not confined, root: no change shown; an owner for new files offered', async () => {
    state.bridge = info('ubuntu');
    show();
    await screen.findByText('a.txt');
    expect(screen.getByText(/runs as root here/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Let the guest agent reach every file' })).toBeNull();
    expect(screen.getByText('Owner of what Hangar creates in the VM:')).toBeTruthy();
  });

  it('Windows: SYSTEM, the drives, no permission or owner columns, no owner choice', async () => {
    state.bridge = info('mswindows', { mounts: ['C:\\', 'D:\\'] });
    const g = new FakeGuest(true);
    g.list = async (p: string) => {
      g.calls.push({ op: 'list', path: p });
      return { entries: [{ name: 'Users', type: 'directory', size: 0, mtime: '2026-11-28T12:00:00.1234567Z' }, { name: 'pagefile.sys', type: 'file', size: 1 << 30, mtime: '2026-11-28T12:00:00Z' }], partial: false };
    };
    state.guest = g;
    show();
    await screen.findByText('pagefile.sys');
    expect(g.log('list')).toEqual(['list C:\\']);
    expect(screen.getByText(/runs as SYSTEM here/)).toBeTruthy();
    const table = within(vmPane()).getByRole('table', { name: 'Files in C:\\' });
    expect(within(table).queryByText('Permissions')).toBeNull();
    expect(within(table).queryByText('Owner')).toBeNull();
    expect(screen.queryByText('Owner of what Hangar creates in the VM:')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Let the guest agent reach every file' })).toBeNull();
    fireEvent.click(within(vmPane()).getByRole('button', { name: 'Users' }));
    await waitFor(() => expect(g.log('list')).toEqual(['list C:\\', 'list C:\\Users']));
  });
});

describe('Files tab: browsers', () => {
  it('Firefox and Safari: the VM pane alone, with upload, download and replace; no "Edit on this PC"', async () => {
    show();
    await screen.findByText('a.txt');
    expect(screen.queryByRole('region', { name: 'This PC’s files' })).toBeNull();
    for (const b of ['Upload', 'Download', 'Replace with a local file']) expect(within(vmPane()).getByRole('button', { name: b })).toBeTruthy();
    expect(within(vmPane()).queryByRole('button', { name: 'Edit on this PC' })).toBeNull();
    expect(screen.getByText(/This browser cannot open a folder of this PC/)).toBeTruthy();
  });

  it('Chromium: the dual view; a copy to the VM asks before replacing, and keeps both', async () => {
    state.fsa = true;
    const pc = new FakeLocalDir('Documents');
    pc.files.set('a.txt', { data: new TextEncoder().encode('from the pc'), lastModified: Date.UTC(2026, 10, 28) });
    state.pick = pc;
    show();
    await screen.findByText('a.txt');
    expect(within(vmPane()).getByRole('button', { name: 'Edit on this PC' })).toBeTruthy();
    const pcPane = screen.getByRole('region', { name: 'This PC’s files' });
    fireEvent.click(within(pcPane).getByRole('button', { name: 'Open a folder…' }));
    await within(pcPane).findByText('a.txt');
    fireEvent.click(within(pcPane).getByLabelText('Select a.txt'));
    fireEvent.click(within(pcPane).getByRole('button', { name: 'Copy to the VM' }));
    const dialog = await screen.findByRole('dialog', { name: 'a.txt is already there' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep both' }));
    await waitFor(() => expect(state.guest.text('/a (1).txt')).toBe('from the pc'));
    expect(state.guest.text('/a.txt')).toBe('hello');
    await waitFor(() => expect(rows(vmPane()).some(r => r?.includes('a (1).txt'))).toBe(true));
  });

  it('delete asks first, naming the items', async () => {
    show();
    await screen.findByText('a.txt');
    fireEvent.click(within(vmPane()).getByLabelText('Select a.txt'));
    fireEvent.click(within(vmPane()).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete a.txt?' });
    expect(dialog.textContent).toContain('In the VM, /: a.txt.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.guest.nodes.has('/a.txt')).toBe(false));
  });
});
