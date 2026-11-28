import { createHash } from 'crypto';
import { ConflictPolicy, READ_CHUNK, WRITE_CHUNK } from '../model/guestfiles';
import { tasks } from '../model/tasks';
import { GuestFileError } from './guestfiles';
import { FakeGuest, FakeLocalDir, pattern } from './guestfiles.fixture';
import { bytesSource } from './localfs';
import { downloadFile, planDownload, planUpload, runAsTask, runDownload, runUpload, uploadFile, vmCopyState } from './transfer';

const noSleep = async () => undefined;
const sha = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');
const never = () => new ConflictPolicy(async () => null);
const answer = (choice: 'replace' | 'skip' | 'keepBoth', all = true) => new ConflictPolicy(async () => ({ choice, all }));

function memSink() {
  const parts: Uint8Array[] = [];
  const bytes = () => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const s = { closed: false, aborted: false, bytes };
  return Object.assign(s, {
    write: async (b: Uint8Array) => void parts.push(b),
    close: async () => void (s.closed = true),
    abort: async () => void (s.aborted = true),
  });
}

describe('upload: chunked writes', () => {
  it('first chunk at 0 with truncate, then each at the size so far, at most 1 MiB; sha256 checked; owner after the last chunk', async () => {
    const g = new FakeGuest().dir('/home/k4all', 'k4all');
    const data = pattern(2 * WRITE_CHUNK + 1234);
    const seen: number[] = [];
    const r = await uploadFile(g, '/home/k4all/big.bin', bytesSource('big.bin', data), 'replace', { verify: true, owner: { owner: 'k4all', group: 'k4all' }, onBytes: n => seen.push(n) });
    expect(g.log('write')).toEqual(['write /home/k4all/big.bin@0!', `write /home/k4all/big.bin@${WRITE_CHUNK}`, `write /home/k4all/big.bin@${2 * WRITE_CHUNK}`]);
    expect(g.calls.filter(c => c.op === 'write').every(c => (c.bytes ?? 0) <= WRITE_CHUNK)).toBe(true);
    expect(g.log().slice(-2)).toEqual(['chown /home/k4all/big.bin', 'hash /home/k4all/big.bin']);
    expect(r).toEqual({ size: data.length, sha256: sha(data), verified: true });
    expect(sha(g.nodes.get('/home/k4all/big.bin')!.data)).toBe(sha(data));
    expect(seen).toEqual([WRITE_CHUNK, 2 * WRITE_CHUNK, data.length]);
  });

  it('a chunk that fails with a 503 (the VM moving to another host) is sent again at the same offset', async () => {
    const g = new FakeGuest().dir('/tmp');
    const data = pattern(WRITE_CHUNK + 10);
    const write = g.write.bind(g);
    let n = 0;
    g.write = async (...a) => {
      if (++n === 2) throw new GuestFileError({ reason: 'Unavailable', status: 503, message: 'the server is currently unable to handle the request' });
      return write(...a);
    };
    await uploadFile(g, '/tmp/x', bytesSource('x', data), 'replace', { sleep: noSleep });
    expect(g.log('write')).toEqual(['write /tmp/x@0!', `write /tmp/x@${WRITE_CHUNK}`]);
    expect(n).toBe(3);
    expect(sha(g.nodes.get('/tmp/x')!.data)).toBe(sha(data));
  });

  it('keep both: an exclusive create on the new name, then writes without truncate', async () => {
    const g = new FakeGuest().file('/tmp/a.txt', 'old');
    await uploadFile(g, '/tmp/a (1).txt', bytesSource('a.txt', new TextEncoder().encode('new')), 'new');
    expect(g.log()).toEqual(['create /tmp/a (1).txt', 'write /tmp/a (1).txt@0']);
    expect(g.text('/tmp/a.txt')).toBe('old');
    expect(g.text('/tmp/a (1).txt')).toBe('new');
  });

  it('an empty file is one write at 0 with truncate', async () => {
    const g = new FakeGuest().file('/tmp/e', 'something');
    await uploadFile(g, '/tmp/e', bytesSource('e', new Uint8Array(0)), 'replace');
    expect(g.log()).toEqual(['write /tmp/e@0!']);
    expect(g.text('/tmp/e')).toBe('');
  });

  it('a confined guest refuses a write outside /tmp: PermissionDenied, not retried', async () => {
    const g = new FakeGuest().dir('/root');
    g.confined = true;
    const e = await uploadFile(g, '/root/x', bytesSource('x', pattern(10)), 'replace', { sleep: noSleep }).catch(x => x);
    expect(e.reason).toBe('PermissionDenied');
    expect(e.message).toContain('SELinux');
    expect(g.log('write')).toHaveLength(1);
  });
});

describe('download: chunked reads', () => {
  it('reads of 3 MiB until end of file, the sha256 against the guest’s', async () => {
    const data = pattern(2 * READ_CHUNK + 5);
    const g = new FakeGuest().file('/var/tmp/big', data);
    const sink = memSink();
    const r = await downloadFile(g, '/var/tmp/big', sink, { verify: true });
    expect(g.log('read')).toEqual(['read /var/tmp/big@0', `read /var/tmp/big@${READ_CHUNK}`, `read /var/tmp/big@${2 * READ_CHUNK}`]);
    expect(sha(sink.bytes())).toBe(sha(data));
    expect(r).toMatchObject({ size: data.length, sha256: sha(data), verified: true, changed: false });
    expect(sink.closed).toBe(true);
  });

  it('a read that fails is asked again at the same offset; a cancel drops the local file', async () => {
    const g = new FakeGuest().file('/f', pattern(READ_CHUNK + 1));
    g.failNext('read', 503, 'Guest agent is not connected', 2);
    const sink = memSink();
    await downloadFile(g, '/f', sink, { sleep: noSleep });
    expect(g.log('read')).toEqual(['read /f@0', 'read /f@0', 'read /f@0', `read /f@${READ_CHUNK}`]);

    const ctl = new AbortController();
    const s2 = memSink();
    const e = await downloadFile(g, '/f', s2, { signal: ctl.signal, onBytes: () => ctl.abort() }).catch(x => x);
    expect(e.reason).toBe('Cancelled');
    expect(s2.aborted).toBe(true);
    expect(s2.closed).toBe(false);
  });
});

describe('copies of folders, with the overwrite questions first', () => {
  it('to the VM: new folders made, existing files asked; replace in place, keep both on a new name, skip', async () => {
    const g = new FakeGuest().file('/srv/a.txt', 'vm-a').file('/srv/b.txt', 'vm-b').dir('/srv/docs');
    g.file('/srv/docs/c.txt', 'vm-c');
    const local = new FakeLocalDir('pc');
    const put = (d: FakeLocalDir, n: string, s: string) => d.files.set(n, { data: new TextEncoder().encode(s), lastModified: 1 });
    put(local, 'a.txt', 'pc-a');
    put(local, 'b.txt', 'pc-b');
    const docs = await local.dir('docs', true);
    put(docs, 'c.txt', 'pc-c');
    put(docs, 'd.txt', 'pc-d');
    const choices = ['replace', 'keepBoth', 'skip'] as const;
    const asked: string[] = [];
    const policy = new ConflictPolicy(async c => {
      asked.push(c.name);
      return { choice: choices[asked.length - 1], all: false };
    });
    const items = [
      { kind: 'file' as const, name: 'a.txt', source: await local.source('a.txt') },
      { kind: 'file' as const, name: 'b.txt', source: await local.source('b.txt') },
      { kind: 'dir' as const, name: 'docs', dir: docs as any },
    ];
    const plan = await planUpload(g, items, '/srv', (await g.list('/srv')).entries, policy);
    expect(asked).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(plan.steps.map(s => `${s.op} ${s.path}${s.op === 'upload' ? ` ${s.mode}` : ''}`)).toEqual([
      'upload /srv/a.txt replace',
      'upload /srv/b (1).txt new',
      'upload /srv/docs/d.txt replace',
    ]);
    expect(plan.skipped).toBe(1);
    const r = await runUpload(g, plan, { owner: { owner: 'k4all' } });
    expect(r).toMatchObject({ done: 3, failed: [] });
    expect([g.text('/srv/a.txt'), g.text('/srv/b.txt'), g.text('/srv/b (1).txt'), g.text('/srv/docs/c.txt'), g.text('/srv/docs/d.txt')]).toEqual(['pc-a', 'vm-b', 'pc-b', 'vm-c', 'pc-d']);
    // The owner goes to what the copy created, not to a replaced file.
    expect(g.log('chown')).toEqual(['chown /srv/b (1).txt', 'chown /srv/docs/d.txt']);
  });

  it('a cancelled question cancels the copy before any byte moves', async () => {
    const g = new FakeGuest().file('/tmp/a', 'x');
    const e = await planUpload(g, [{ kind: 'file', name: 'a', source: bytesSource('a', pattern(3)) }], '/tmp', (await g.list('/tmp')).entries, never()).catch(x => x);
    expect(e.reason).toBe('Cancelled');
    expect(g.log('write')).toEqual([]);
  });

  it('to this PC: folders walked in the VM; partial listings reported; links inside folders skipped', async () => {
    const g = new FakeGuest().file('/etc/app/a.conf', 'A').file('/etc/app/sub/b.conf', 'B');
    g.nodes.set('/etc/app/link', { ...g.nodes.get('/etc/app/a.conf')!, type: 'symlink' });
    g.hidden.set('/etc/app', 3);
    const local = new FakeLocalDir('pc');
    const plan = await planDownload(g, [(await g.list('/etc')).entries.find(e => e.name === 'app')!], '/etc', local as any, never());
    expect(plan.steps.map(s => (s.op === 'download' ? `get ${s.path} → ${s.local.join('/')}` : `mkdir ${s.local.join('/')}`))).toEqual([
      'mkdir app',
      'get /etc/app/a.conf → app/a.conf',
      'mkdir app/sub',
      'get /etc/app/sub/b.conf → app/sub/b.conf',
    ]);
    expect(plan).toMatchObject({ partial: ['/etc/app'], skipped: 1, bytes: 2 });
    const versions: string[] = [];
    await runDownload(g, plan, local as any, { onVersion: p => versions.push(p) });
    expect(new TextDecoder().decode(local.dirs.get('app')!.dirs.get('sub')!.files.get('b.conf')!.data)).toBe('B');
    expect(versions).toEqual(['/etc/app/a.conf', '/etc/app/sub/b.conf']);
  });

  it('a file that fails is reported and the copy goes on; a fatal error stops it', async () => {
    const g = new FakeGuest().dir('/root').dir('/tmp');
    g.confined = true;
    const plan = await planUpload(
      g,
      [
        { kind: 'file', name: 'x', source: bytesSource('x', pattern(3)) },
        { kind: 'file', name: 'y', source: bytesSource('y', pattern(3)) },
      ],
      '/root',
      [],
      never()
    );
    const r = await runUpload(g, plan, { sleep: noSleep });
    expect(r.done).toBe(0);
    expect(r.failed.map(f => `${f.path}: ${f.error.reason}`)).toEqual(['/root/x: PermissionDenied', '/root/y: PermissionDenied']);

    const g2 = new FakeGuest().dir('/tmp');
    g2.failNext('write', 403, "the guest agent's configuration disables guest-file-write (qemu-ga --allow-rpcs …)");
    await expect(runUpload(g2, await planUpload(g2, [{ kind: 'file', name: 'x', source: bytesSource('x', pattern(3)) }], '/tmp', [], never()))).rejects.toMatchObject({
      reason: 'Blocked',
      commands: ['guest-file-write'],
    });
  });

  it('a cancelled upload deletes the file it created; a replaced one is said to be incomplete', async () => {
    const g = new FakeGuest().file('/tmp/old', 'old');
    const ctl = new AbortController();
    const src = (n: string) => bytesSource(n, pattern(3 * WRITE_CHUNK));
    const plan = await planUpload(g, [{ kind: 'file', name: 'new', source: src('new') }], '/tmp', (await g.list('/tmp')).entries, never());
    const e = await runUpload(g, plan, { signal: ctl.signal, onProgress: n => n > 0 && ctl.abort() }).catch(x => x);
    expect(e.reason).toBe('Cancelled');
    expect(g.nodes.has('/tmp/new')).toBe(false);

    const ctl2 = new AbortController();
    const plan2 = await planUpload(g, [{ kind: 'file', name: 'old', source: src('old') }], '/tmp', (await g.list('/tmp')).entries, answer('replace'));
    const e2 = await runUpload(g, plan2, { signal: ctl2.signal, onProgress: n => n > 0 && ctl2.abort() }).catch(x => x);
    expect(e2.message).toBe('Cancelled: /tmp/old is incomplete in the VM');
    expect(g.nodes.has('/tmp/old')).toBe(true);
  });
});

describe('the VM copy against the version read', () => {
  it('same stat: no hash; a touch: the hash says same; new bytes: changed; deleted: gone', async () => {
    const g = new FakeGuest().file('/tmp/f', 'hello');
    const st = await g.stat('/tmp/f');
    const base = { size: st.size, mtime: st.mtime, sha256: sha(new TextEncoder().encode('hello')) };
    g.calls = [];
    expect(await vmCopyState(g, '/tmp/f', base)).toBe('same');
    expect(g.log()).toEqual(['stat /tmp/f']);
    g.touch('/tmp/f');
    expect(await vmCopyState(g, '/tmp/f', base)).toBe('same');
    g.touch('/tmp/f', 'HELLO');
    expect(await vmCopyState(g, '/tmp/f', base)).toBe('changed');
    await g.remove('/tmp/f', false);
    expect(await vmCopyState(g, '/tmp/f', base)).toBe('gone');
  });
});

describe('copies as tasks', () => {
  it('progress in the task, Cancel offered while it runs, one copy at a time per VM', async () => {
    tasks.useCluster(`test-${Math.random()}`);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const order: string[] = [];
    const first = runAsTask({ namespace: 'vms', name: 'vm' }, 'Copy 1', async t => {
      order.push('1 start');
      t.progress(5, 10, '/tmp/a');
      await gate;
      order.push('1 end');
      return { status: 'done', message: 'ok' };
    });
    const second = runAsTask({ namespace: 'vms', name: 'vm' }, 'Copy 2', async () => {
      order.push('2 start');
      return { status: 'done', message: 'ok' };
    });
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    const [t2, t1] = tasks.getSnapshot();
    expect(t1).toMatchObject({ title: 'Copy 1', status: 'running', progress: 50 });
    expect(t1.message).toMatch(/^5 B of 10 B.*· a$/);
    expect(t2.message).toBe('Waiting for the copy before it');
    expect(tasks.canCancel(t1.id)).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['1 start', '1 end', '2 start']);
    expect(tasks.canCancel(t1.id)).toBe(false);

    const third = runAsTask({ namespace: 'vms', name: 'vm' }, 'Copy 3', t => new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('x')))));
    await new Promise(r => setTimeout(r, 0));
    tasks.cancel(tasks.getSnapshot()[0].id);
    await third;
    expect(tasks.getSnapshot()[0]).toMatchObject({ title: 'Copy 3', status: 'failed' });
  });
});
