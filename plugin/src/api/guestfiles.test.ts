import { kraw } from './client';
import { bridgeChannel, GuestFileError, guestFilesPath, withRetry } from './guestfiles';

vi.mock('./client', () => ({ kraw: vi.fn(), currentCluster: () => 'c' }));
vi.mock('./permissions', () => ({ can: vi.fn(async () => true) }));

const PATH = '/apis/subresources.hangar.magesgate.com/v1alpha1/namespaces/vms/virtualmachineinstances/vm/guestfiles';
const noSleep = async () => undefined;

/** Headlamp's rejection: "Status text - message", with the status. */
const reject = (status: number, message: string) => Object.assign(new Error(`${status === 503 ? 'Service Unavailable' : 'Error'} - ${message}`), { status });

type Answer = Response | Error | ((init: any) => Response | Error);
function serve(...answers: Answer[]) {
  vi.mocked(kraw).mockImplementation(async (_path: string, init: any = {}, read: any = (r: Response) => r) => {
    const a = answers.length > 1 ? answers.shift() : answers[0];
    const v = typeof a === 'function' ? a(init) : a;
    if (v instanceof Error) throw v;
    return read(v as Response);
  });
}

/** A fresh answer per call (a Response's body is read once). */
const jsonRes = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const calls = () => vi.mocked(kraw).mock.calls.map(c => ({ path: c[0], method: c[1]?.method, query: c[1]?.query, body: c[1]?.body as Uint8Array | undefined }));

beforeEach(() => {
  vi.mocked(kraw).mockReset();
});

describe('the guestfiles calls', () => {
  const ch = bridgeChannel('vms', 'vm', false, { sleep: noSleep });

  it('the path, each op’s method and only its own parameters', async () => {
    serve(jsonRes({ entries: [], partial: false }));
    expect(guestFilesPath('vms', 'vm')).toBe(PATH);
    await ch.list('/etc');
    await ch.stat('/etc/hosts');
    await ch.hash('/etc/hosts');
    await ch.write('/tmp/a', 0, true, new Uint8Array([1, 2]));
    await ch.write('/tmp/a', 2, false, new Uint8Array([3]));
    await ch.create('/tmp/a (1)', true);
    await ch.mkdir('/tmp/d', false);
    await ch.rename('/tmp/a', '/tmp/b', true);
    await ch.chown('/tmp/b', 'k4all', 'k4all');
    await ch.remove('/tmp/d', true);
    expect(calls().map(c => [c.method, c.query])).toEqual([
      ['GET', { op: 'list', path: '/etc', limit: '5000' }],
      ['GET', { op: 'stat', path: '/etc/hosts' }],
      ['GET', { op: 'hash', path: '/etc/hosts' }],
      ['PUT', { op: 'write', path: '/tmp/a', offset: '0', truncate: 'true' }],
      ['PUT', { op: 'write', path: '/tmp/a', offset: '2' }],
      ['POST', { op: 'create', path: '/tmp/a (1)', exclusive: 'true' }],
      ['POST', { op: 'mkdir', path: '/tmp/d', exclusive: 'false' }],
      ['POST', { op: 'rename', from: '/tmp/a', to: '/tmp/b', exclusive: 'true' }],
      ['POST', { op: 'chown', path: '/tmp/b', owner: 'k4all', group: 'k4all' }],
      ['DELETE', { op: 'delete', path: '/tmp/d', recursive: 'true' }],
    ]);
    expect(calls().every(c => c.path === PATH)).toBe(true);
    expect(Array.from(calls()[3].body as Uint8Array)).toEqual([1, 2]);
  });

  it('a listing in pages, its partial state kept; an expired cursor lists again', async () => {
    const pages = [
      jsonRes({ entries: [{ name: 'a', type: 'file', size: 1 }], cursor: 'c1', partial: true, partialReason: 'SELinux confines the guest agent in this guest: 17 entries' }),
      reject(410, 'the listing behind this cursor is gone from the guest'),
      jsonRes({ entries: [{ name: 'a', type: 'file', size: 1 }], cursor: 'c2', partial: true, partialReason: 'SELinux confines the guest agent in this guest: 17 entries' }),
      jsonRes({ entries: [{ name: 'b', type: 'file', size: 2 }], partial: true }),
    ];
    serve(...pages);
    const l = await ch.list('/etc');
    expect(l.entries.map(e => e.name)).toEqual(['a', 'b']);
    expect(l).toMatchObject({ partial: true, partialReason: expect.stringContaining('SELinux') });
    expect(calls().map(c => c.query?.cursor)).toEqual([undefined, 'c1', undefined, 'c2']);
  });

  it('a read: the bytes and the X-Hangar-File-* headers', async () => {
    serve(() =>
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { 'X-Hangar-File-Size': '10', 'X-Hangar-File-Offset': '4', 'X-Hangar-File-Eof': 'false', 'X-Hangar-File-Mtime': '2026-11-28T12:00:00.5Z' },
      })
    );
    const c = await ch.read('/var/log/x', 4, 3);
    expect(Array.from(c.bytes)).toEqual([7, 8, 9]);
    expect(c).toMatchObject({ offset: 4, size: 10, eof: false, mtime: '2026-11-28T12:00:00.5Z' });
    expect(calls()[0].query).toEqual({ op: 'read', path: '/var/log/x', offset: '4', length: '3' });
  });

  it('a read shorter than its Content-Length means the file changed: an error a transfer reads again', async () => {
    serve(() => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Length': '3', 'X-Hangar-File-Eof': 'true' } }));
    const e = await ch.read('/x', 0, 3).catch(x => x);
    expect(e).toBeInstanceOf(GuestFileError);
    expect(e.reason).toBe('Network');
  });

  it('errors carry the cause read from the status and message; Blocked names its commands', async () => {
    serve(
      reject(
        403,
        "the guest agent's configuration disables guest-exec, guest-exec-status, guest-file-open (qemu-ga --allow-rpcs or --block-rpcs; on RHEL-family guests, FILTER_RPC_ARGS in /etc/sysconfig/qemu-ga)"
      )
    );
    const e = await ch.list('/').catch(x => x);
    expect(e).toMatchObject({ reason: 'Blocked', status: 403, commands: ['guest-exec', 'guest-exec-status', 'guest-file-open'] });
    serve(reject(404, '/nope: No such file or directory'));
    expect(await ch.stat('/nope').catch(x => x.reason)).toBe('NotFound');
  });

  it('list and stat ask again after a 503, twice (the Guest tab’s rule)', async () => {
    serve(reject(503, 'Guest agent is not connected'), reject(503, 'Guest agent is not connected'), jsonRes({ name: 'x', type: 'file', size: 1 }));
    expect(await ch.stat('/x')).toMatchObject({ name: 'x' });
    serve(reject(503, 'Guest agent is not connected'));
    expect(await ch.stat('/x').catch(e => e.reason)).toBe('NotConnected');
    expect(vi.mocked(kraw).mock.calls.length).toBe(6);
  });

  it('Windows paths go as they are', async () => {
    serve(jsonRes({ entries: [], partial: false }));
    await bridgeChannel('vms', 'vm', true).list('C:\\Users');
    expect(calls()[0].query).toMatchObject({ path: 'C:\\Users' });
  });
});

describe('withRetry', () => {
  it('no second try for a write that got no answer unless it is idempotent; a cancel stops the pauses', async () => {
    let n = 0;
    const fn = async () => {
      n++;
      throw reject(502, '');
    };
    await expect(withRetry(fn, { pauses: [1, 1], idempotent: false, sleep: noSleep })).rejects.toMatchObject({ reason: 'Network' });
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(fn, { pauses: [1, 1], idempotent: true, sleep: noSleep })).rejects.toMatchObject({ reason: 'Network' });
    expect(n).toBe(3);
    const ctl = new AbortController();
    ctl.abort();
    await expect(withRetry(fn, { pauses: [1], idempotent: true, signal: ctl.signal })).rejects.toMatchObject({ reason: 'Cancelled' });
  });
});
