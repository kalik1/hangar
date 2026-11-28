import {
  agentReach,
  blockedCommandsOf,
  blockedFileCommands,
  classifyError,
  confinedWritable,
  ConflictPolicy,
  crumbs,
  errorText,
  fileRoots,
  filterEntries,
  formatMode,
  FULL_ACCESS_ENABLE,
  FULL_ACCESS_REVERT,
  fullAccessFor,
  GuestFile,
  hashSame,
  joinPath,
  keepBothName,
  mtimeMs,
  namesText,
  normalizePath,
  ownerProblem,
  parentPath,
  parseOwner,
  progressText,
  RateMeter,
  retryable,
  rootOf,
  sortEntries,
  splitExt,
  statSame,
  underPath,
} from './guestfiles';
import { allowListSed, blockedFix } from './guestinfo';
import { GUEST_AGENT_FULL_ACCESS } from './vmspec';

describe('errors: what a failed guestfiles call means', () => {
  it('403: RBAC, Blocked with its commands, the guest’s denials', () => {
    expect(
      classifyError(403, 'virtualmachineinstances.subresources.hangar.magesgate.com "vm" is forbidden: User "u" cannot get resource "virtualmachineinstances/guestfiles"')
        .reason
    ).toBe('Forbidden');
    const blocked = classifyError(
      403,
      "the guest agent's configuration disables guest-exec, guest-exec-status (qemu-ga --allow-rpcs or --block-rpcs; on RHEL-family guests, FILTER_RPC_ARGS in /etc/sysconfig/qemu-ga)"
    );
    expect(blocked).toMatchObject({ reason: 'Blocked', commands: ['guest-exec', 'guest-exec-status'] });
    expect(classifyError(403, "/root/x: failed to open file '/root/x' (mode: 'w'): Permission denied (the guest's permissions, or SELinux…)").reason).toBe('PermissionDenied');
    expect(classifyError(403, '/mnt/x: Read-only file system').reason).toBe('ReadOnlyFileSystem');
  });

  it('404, 409, 410, 503, 507 and no answer', () => {
    expect(classifyError(404, '/x: No such file or directory').reason).toBe('NotFound');
    expect(classifyError(404, 'the server could not find the requested resource').reason).toBe('Absent');
    expect(classifyError(409, '/x: File exists').reason).toBe('AlreadyExists');
    expect(classifyError(409, '/x/y: Not a directory').reason).toBe('NotADirectory');
    expect(classifyError(409, '/x: Is a directory').reason).toBe('IsADirectory');
    expect(classifyError(409, '/x: Directory not empty').reason).toBe('DirectoryNotEmpty');
    expect(classifyError(409, '/dev/sda: a blockDevice, not a regular file').reason).toBe('NotARegularFile');
    expect(classifyError(409, 'offset: 9 is past the end of /x (5 B)').reason).toBe('Invalid');
    expect(classifyError(410, 'the listing behind this cursor is gone').reason).toBe('Expired');
    expect(classifyError(503, 'Guest agent is not connected').reason).toBe('NotConnected');
    expect(classifyError(503, 'Guest agent not available due to an error').reason).toBe('NotResponding');
    expect(classifyError(503, 'the server is currently unable to handle the request').reason).toBe('Unavailable');
    expect(classifyError(507, '/x: No space left on device').reason).toBe('NoSpace');
    expect(classifyError(502, '').reason).toBe('Network');
    expect(classifyError(408, '').reason).toBe('Network');
  });

  it('retries: the agent’s and the bridge’s states always; no answer or a timeout only for reads and writes', () => {
    const e = (status: number, m = '') => classifyError(status, m);
    expect(retryable(e(503, 'not connected'), false)).toBe(true);
    expect(retryable(e(503), false)).toBe(true);
    expect(retryable(e(502), false)).toBe(false);
    expect(retryable(e(502), true)).toBe(true);
    expect(retryable(e(504), true)).toBe(true);
    expect(retryable(e(403, 'Permission denied'), true)).toBe(false);
    expect(retryable(e(409, 'File exists'), true)).toBe(false);
  });

  it('a denied write outside /tmp on a confined guest says why; elsewhere the guest’s words', () => {
    const denied = classifyError(403, '/root/a: Permission denied');
    expect(errorText(denied, { path: '/root/a', osId: 'fedora' })).toMatch(/SELinux confines it in this guest, and it writes only in \/tmp and \/var\/tmp/);
    expect(errorText(denied, { path: '/var/tmp/a', osId: 'fedora' })).toBe('/root/a: Permission denied');
    expect(errorText(denied, { path: '/root/a', osId: 'ubuntu' })).toBe('/root/a: Permission denied');
    expect(errorText(classifyError(403, 'forbidden: User "u" cannot update'))).toMatch(/hangar-guest-admin/);
    expect(errorText({ reason: 'Blocked', message: '', commands: ['guest-exec', 'guest-file-open'] })).toMatch(/disables guest-exec and guest-file-open/);
  });
});

describe('paths: Linux and Windows', () => {
  it('normalizes, joins, finds the parent and the base name', () => {
    expect(normalizePath('//home//k4all/./docs/../x/', false)).toBe('/home/k4all/x');
    expect(normalizePath('/', false)).toBe('/');
    expect(normalizePath('c:/Users/Admin/', true)).toBe('C:\\Users\\Admin');
    expect(normalizePath('C:', true)).toBe('C:\\');
    expect(joinPath('/', 'etc', false)).toBe('/etc');
    expect(joinPath('/etc', 'hosts', false)).toBe('/etc/hosts');
    expect(joinPath('C:\\', 'Users', true)).toBe('C:\\Users');
    expect(joinPath('C:\\Users', 'Admin', true)).toBe('C:\\Users\\Admin');
    expect(parentPath('/etc/hosts', false)).toBe('/etc');
    expect(parentPath('/etc', false)).toBe('/');
    expect(parentPath('/', false)).toBeNull();
    expect(parentPath('C:\\Users\\Admin', true)).toBe('C:\\Users');
    expect(parentPath('C:\\Users', true)).toBe('C:\\');
    expect(parentPath('C:\\', true)).toBeNull();
  });

  it('the path bar’s segments', () => {
    expect(crumbs('/home/k4all', false)).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'k4all', path: '/home/k4all' },
    ]);
    expect(crumbs('C:\\Users\\Admin', true).map(c => c.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\Admin']);
  });

  it('inside a folder: /tmp, not /tmpfoo; Windows ignores case', () => {
    expect(underPath('/tmp/a', '/tmp', false)).toBe(true);
    expect(underPath('/tmpfoo', '/tmp', false)).toBe(false);
    expect(underPath('c:\\USERS\\x', 'C:\\Users', true)).toBe(true);
    expect(confinedWritable('/var/tmp/x/y')).toBe(true);
    expect(confinedWritable('/var/tmpx')).toBe(false);
    expect(confinedWritable('/root')).toBe(false);
  });
});

describe('roots: the guest’s mount points', () => {
  it('the root a path is on: the longest mount point', () => {
    expect(rootOf('/boot/efi/EFI', ['/', '/boot', '/boot/efi'], false)).toBe('/boot/efi');
    expect(rootOf('/bootx', ['/', '/boot'], false)).toBe('/');
    expect(rootOf('d:\\data', ['C:\\', 'D:\\'], true)).toBe('D:\\');
  });

  it('Linux: / first, then the others, without repeats', () => {
    const fs = [
      { name: 'vda4', mountpoint: '/boot', type: 'xfs' },
      { name: 'vda1', mountpoint: '/', type: 'xfs' },
      { name: 'vda1', mountpoint: '/', type: 'xfs' },
      { name: 'vda2', mountpoint: '/boot/efi', type: 'vfat' },
    ];
    expect(fileRoots(fs, false)).toEqual(['/', '/boot', '/boot/efi']);
    expect(fileRoots(undefined, false)).toEqual(['/']);
  });

  it('Windows: the drives, C:\\ first; volumes without a letter left out', () => {
    const fs = [
      { name: 'D', mountpoint: 'D:\\', type: 'NTFS' },
      { name: 'System Reserved', mountpoint: '', type: 'NTFS' },
      { name: 'C', mountpoint: 'C:\\', type: 'NTFS' },
    ];
    expect(fileRoots(fs, true)).toEqual(['C:\\', 'D:\\']);
    expect(fileRoots([], true)).toEqual(['C:\\']);
  });
});

describe('entries: sort, filter, permissions', () => {
  const list: GuestFile[] = [
    { name: 'b.txt', type: 'file', size: 10, mtime: '2026-11-28T12:00:02.000000001Z', mode: 0o644, user: 'root', group: 'root' },
    { name: 'a10', type: 'file', size: 5, mtime: '2026-11-28T12:00:01Z', mode: 0o600, user: 'k4all', group: 'k4all' },
    { name: 'a9', type: 'file', size: 50, mtime: '2026-11-28T12:00:03Z' },
    { name: 'zdir', type: 'directory', size: 4096 },
    { name: 'Adir', type: 'directory', size: 4096 },
  ];

  it('folders first; names in natural order; by size, by time, descending', () => {
    expect(sortEntries(list, 'name').map(e => e.name)).toEqual(['Adir', 'zdir', 'a9', 'a10', 'b.txt']);
    expect(sortEntries(list, 'size').map(e => e.name)).toEqual(['Adir', 'zdir', 'a10', 'b.txt', 'a9']);
    expect(sortEntries(list, 'mtime', true).map(e => e.name)).toEqual(['zdir', 'Adir', 'a9', 'b.txt', 'a10']);
    expect(filterEntries(list, 'A1').map(e => e.name)).toEqual(['a10']);
  });

  it('nanosecond mtimes parse; modes print as ls does; Windows has none', () => {
    expect(mtimeMs('2026-11-28T12:00:00.123456789Z')).toBe(Date.UTC(2026, 10, 28, 12, 0, 0, 123));
    expect(mtimeMs('2026-11-28T12:00:00Z')).toBe(Date.UTC(2026, 10, 28, 12));
    expect(formatMode('directory', 0o755)).toBe('drwxr-xr-x');
    expect(formatMode('file', 416)).toBe('-rw-r-----');
    expect(formatMode('file', 0o4755)).toBe('-rwsr-xr-x');
    expect(formatMode('directory', 0o1777)).toBe('drwxrwxrwt');
    expect(formatMode('file', 0o2644)).toBe('-rw-r-Sr--');
    expect(formatMode('file', undefined)).toBe('—');
  });
});

describe('what the agent reaches, and the change shown per OS', () => {
  it('Fedora and the RHEL family are confined; Debian and Ubuntu run it as root; Windows as SYSTEM', () => {
    expect(agentReach('fedora')).toBe('confined');
    expect(agentReach('rocky')).toBe('confined');
    expect(agentReach('rhel')).toBe('confined');
    expect(agentReach('ubuntu')).toBe('root');
    expect(agentReach('debian')).toBe('root');
    expect(agentReach('mswindows')).toBe('system');
    expect(agentReach('')).toBe('unknown');
  });

  it('the change: Fedora and Rocky get it (Rocky’s overrides its allow-list); Ubuntu only when a listing proved confined; never Windows', () => {
    expect(fullAccessFor('fedora')).toMatchObject({ enable: FULL_ACCESS_ENABLE, revert: FULL_ACCESS_REVERT, overridesAllowList: false });
    expect(fullAccessFor('rocky')).toMatchObject({ overridesAllowList: true });
    expect(fullAccessFor('ubuntu')).toBeNull();
    expect(fullAccessFor('ubuntu', true)).not.toBeNull();
    expect(fullAccessFor('', true)).not.toBeNull();
    expect(fullAccessFor('mswindows', true)).toBeNull();
  });

  // The lines of the lab test of 2026-11-28 (spec §8.11), verbatim.
  it('the lines are the lab’s, verbatim', () => {
    expect(FULL_ACCESS_ENABLE.join('\n')).toBe(`# Hangar: let the QEMU guest agent read and write every file (run in the guest, as a sudoer)
sudo mkdir -p /etc/hangar /etc/systemd/system/qemu-guest-agent.service.d
printf '[Service]\\nEnvironmentFile=-/etc/hangar/qemu-ga.env\\n' | sudo tee /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf >/dev/null
echo 'FILTER_RPC_ARGS=' | sudo tee /etc/hangar/qemu-ga.env >/dev/null
printf '(typeattributeset files_unconfined_type (virt_qemu_ga_t))\\n(allow virt_qemu_ga_t self (capability (chown fowner fsetid)))\\n' | sudo tee /etc/hangar/hangar_qemu_ga.cil >/dev/null
if command -v selinuxenabled >/dev/null && selinuxenabled; then sudo semodule -i /etc/hangar/hangar_qemu_ga.cil; fi
sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent`);
    expect(FULL_ACCESS_REVERT.join('\n')).toBe(`# Hangar: undo it (run in the guest, as a sudoer)
if command -v selinuxenabled >/dev/null && selinuxenabled; then sudo semodule -r hangar_qemu_ga; fi
sudo rm -rf /etc/hangar /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf
sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent`);
  });

  it('the same files as the New VM wizard’s option, which writes them at first boot', () => {
    const printed = (line: string) => /^printf '(.*)' \| sudo tee (\S+) /.exec(line);
    const files = FULL_ACCESS_ENABLE.map(printed).filter(Boolean).map(m => [m![2], m![1]]);
    const wizard = GUEST_AGENT_FULL_ACCESS.writeFiles.join('\n');
    expect(files).toHaveLength(2);
    for (const [path, content] of files) expect(wizard).toContain(`  - path: ${path}\n    content: "${content}"`);
    expect(FULL_ACCESS_ENABLE).toContain("echo 'FILTER_RPC_ARGS=' | sudo tee /etc/hangar/qemu-ga.env >/dev/null");
    expect(wizard).toContain('  - path: /etc/hangar/qemu-ga.env\n    content: "FILTER_RPC_ARGS=\\n"');
  });

  it('blocked file commands: Rocky’s eight, in the tested sed’s order; flush alone is no block', () => {
    const rocky = [
      'guest-info',
      'guest-exec',
      'guest-exec-status',
      'guest-file-close',
      'guest-file-flush',
      'guest-file-open',
      'guest-file-read',
      'guest-file-seek',
      'guest-file-write',
    ].map(name => ({ name, enabled: name === 'guest-info' }));
    const off = blockedFileCommands(rocky);
    expect(off).toEqual(['guest-exec', 'guest-exec-status', 'guest-file-open', 'guest-file-close', 'guest-file-read', 'guest-file-write', 'guest-file-seek', 'guest-file-flush']);
    expect(allowListSed(off)[0]).toBe(
      `sudo sed -i -E 's/^(FILTER_RPC_ARGS="--allow-rpcs=[^"]*)"/\\1,guest-exec,guest-exec-status,guest-file-open,guest-file-close,guest-file-read,guest-file-write,guest-file-seek,guest-file-flush"/' /etc/sysconfig/qemu-ga`
    );
    expect(blockedFix('rocky', off)?.ways.map(w => w.lines[w.lines.length - 1])).toEqual([
      'sudo systemctl restart qemu-guest-agent',
      'sudo systemctl daemon-reload && sudo systemctl restart qemu-guest-agent',
    ]);
    expect(blockedFileCommands([{ name: 'guest-file-flush', enabled: false }, { name: 'guest-exec', enabled: true }])).toEqual([]);
    expect(blockedFileCommands(undefined)).toEqual([]);
    expect(blockedCommandsOf('nothing here')).toEqual([]);
  });
});

describe('overwrite and conflicts', () => {
  it('keep both: the first free "name (n).ext"', () => {
    expect(splitExt('report.docx')).toEqual(['report', '.docx']);
    expect(splitExt('.bashrc')).toEqual(['.bashrc', '']);
    expect(splitExt('a.tar.gz')).toEqual(['a', '.tar.gz']);
    expect(splitExt('Makefile')).toEqual(['Makefile', '']);
    const taken = new Set(['report.docx', 'report (1).docx']);
    expect(keepBothName('report.docx', n => taken.has(n))).toBe('report (2).docx');
    expect(keepBothName('report (1).docx', n => taken.has(n))).toBe('report (2).docx');
    expect(keepBothName('.bashrc', () => false)).toBe('.bashrc (1)');
    expect(keepBothName('backup.tar.gz', () => false)).toBe('backup (1).tar.gz');
  });

  it('asks once per conflict until "apply to all"; folders onto folders merge; no replacing a folder by a file', async () => {
    const asked: string[] = [];
    const answers = [
      { choice: 'keepBoth' as const, all: false },
      { choice: 'replace' as const, all: true },
    ];
    const policy = new ConflictPolicy(async c => {
      asked.push(`${c.name}:${c.choices.join('/')}`);
      return answers.shift() ?? null;
    });
    const file = { type: 'file' as const, size: 1 };
    const folder = { type: 'directory' as const, size: 0 };
    expect(await policy.decide({ name: 'a', where: 'the VM', existing: file, incoming: file })).toBe('keepBoth');
    expect(await policy.decide({ name: 'b', where: 'the VM', existing: file, incoming: file })).toBe('replace');
    expect(await policy.decide({ name: 'c', where: 'the VM', existing: file, incoming: file })).toBe('replace');
    expect(await policy.decide({ name: 'd', where: 'the VM', existing: folder, incoming: folder })).toBe('merge');
    // "replace" for all does not apply where a folder would be replaced by a file: asked, and cancelled.
    expect(await policy.decide({ name: 'e', where: 'the VM', existing: folder, incoming: file })).toBeNull();
    expect(asked).toEqual(['a:replace/skip/keepBoth', 'b:replace/skip/keepBoth', 'e:skip/keepBoth']);
  });

  it('edit write-back: same size and mtime need no hash; then the hash decides', () => {
    const base = { size: 5, mtime: '2026-11-28T12:00:00.1Z', sha256: 'ab' };
    expect(statSame(base, { size: 5, mtime: '2026-11-28T12:00:00.1Z' })).toBe(true);
    expect(statSame(base, { size: 5, mtime: '2026-11-28T12:00:09Z' })).toBe(false);
    expect(statSame({ size: 5 }, { size: 5 })).toBe(false);
    expect(hashSame(base, { algorithm: 'sha256', hash: 'AB', size: 5 })).toBe(true);
    expect(hashSame(base, { algorithm: 'sha256', hash: 'cd', size: 5 })).toBe(false);
  });
});

describe('owners', () => {
  it('user, user:group, :group, ids; nothing else', () => {
    for (const ok of ['k4all', 'k4all:k4all', ':wheel', '1000:1000', 'svc$']) expect(ownerProblem(ok)).toBeNull();
    for (const bad of ['', 'a b', 'a:b:c', '-x', 'k4all:']) expect(ownerProblem(bad)).not.toBeNull();
    expect(parseOwner('k4all:users')).toEqual({ owner: 'k4all', group: 'users' });
    expect(parseOwner(':users')).toEqual({ owner: undefined, group: 'users' });
  });
});

describe('progress', () => {
  it('speed and time left, smoothed per second', () => {
    const m = new RateMeter();
    m.sample(0, 0);
    expect(m.sample(13e6, 1000)).toBe(13e6);
    expect(m.sample(13e6 + 500, 1500)).toBe(13e6);
    expect(progressText(50 * 2 ** 20, 100 * 2 ** 20, 10 * 2 ** 20)).toBe('50 MiB of 100 MiB · 10 MiB/s · 5 s left');
    expect(progressText(0, 2 ** 20)).toBe('0 B of 1 MiB');
    expect(namesText(['a', 'b', 'c', 'd'])).toBe('a, b and 2 more');
    expect(namesText(['a', 'b'])).toBe('a and b');
  });
});
