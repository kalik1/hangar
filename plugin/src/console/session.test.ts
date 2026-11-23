import { describe, expect, it } from 'vitest';
import {
  initialSession,
  SessionEvent,
  SessionOptions,
  sessionReducer,
  SessionState,
} from './session';

const VNC: SessionOptions = { canPreserve: true, maxFailures: 3, settleMs: 10000 };
const SERIAL: SessionOptions = { canPreserve: false, maxFailures: 3, settleMs: 10000 };

function run(
  events: SessionEvent[],
  opts = VNC,
  from: SessionState = initialSession()
): SessionState {
  return events.reduce((s, e) => sessionReducer(s, e, opts), from);
}

const up = (uid = 'u1', now = 0): SessionEvent => ({ type: 'vmi', available: true, uid, now });
const down = (now = 0): SessionEvent => ({ type: 'vmi', available: false, now });

describe('session: starting up', () => {
  it('stays idle while the VM is not running', () => {
    const s = run([down()]);
    expect(s.phase).toBe('idle');
    expect(s.epoch).toBe(0);
  });

  it('connects, taking over, once the VM runs', () => {
    const s = run([up()]);
    expect(s).toMatchObject({
      phase: 'connecting',
      epoch: 1,
      takeover: true,
      available: true,
      vmiUid: 'u1',
    });
  });

  it('is connected when the console answers, and later reconnects politely', () => {
    const s = run([up(), { type: 'opened', epoch: 1 }]);
    expect(s).toMatchObject({
      phase: 'connected',
      takeover: false,
      wasConnected: true,
      failures: 0,
    });
  });

  it('ignores status updates of the same instance', () => {
    const a = run([up('u1'), { type: 'opened', epoch: 1 }]);
    expect(sessionReducer(a, up('u1', 50), VNC)).toBe(a);
  });

  it('ignores events of an old socket', () => {
    const s = run([up(), { type: 'opened', epoch: 1 }, up('u2', 5)]);
    expect(s.epoch).toBe(2);
    const after = run(
      [
        { type: 'closed', epoch: 1, opened: true, now: 6 },
        { type: 'opened', epoch: 1 },
      ],
      VNC,
      s
    );
    expect(after).toBe(s);
  });
});

describe('session: VM restarts and stops', () => {
  it('connects again to a new instance of the VM', () => {
    const s = run([up('u1'), { type: 'opened', epoch: 1 }, up('u2', 100)]);
    expect(s).toMatchObject({
      phase: 'connecting',
      epoch: 2,
      vmiUid: 'u2',
      takeover: false,
      availableAt: 100,
    });
  });

  it('goes idle when the VM stops, and connects when it runs again', () => {
    let s = run([
      up('u1'),
      { type: 'opened', epoch: 1 },
      { type: 'closed', epoch: 1, opened: true, now: 1 },
    ]);
    s = run([down(2)], VNC, s);
    expect(s.phase).toBe('idle');
    s = run([up('u2', 3)], VNC, s);
    expect(s).toMatchObject({ phase: 'connecting', vmiUid: 'u2', failures: 0 });
  });

  it('goes idle when the socket closes after the VM stopped', () => {
    const s = run([
      up(),
      { type: 'opened', epoch: 1 },
      down(1),
      { type: 'closed', epoch: 1, opened: true, now: 2 },
    ]);
    expect(s.phase).toBe('idle');
  });
});

describe('session: drops and failures (VNC)', () => {
  it('settles from when the instance started, not from when the page saw it', () => {
    // Running for long before the page opened: a refused polite reconnect is checked at once.
    const s = run([
      { type: 'vmi', available: true, uid: 'u1', since: 0, now: 100000 },
      { type: 'opened', epoch: 1 },
      { type: 'closed', epoch: 1, opened: true, now: 100500 },
      { type: 'closed', epoch: 2, opened: false, now: 100600 },
    ]);
    expect(s.phase).toBe('checking');
  });

  it('never settles from a start time in the future (clock skew)', () => {
    const s = run([{ type: 'vmi', available: true, uid: 'u1', since: 999999, now: 5 }]);
    expect(s.availableAt).toBe(5);
  });

  it('reconnects at once, politely, when a connection drops', () => {
    const s = run([
      up(),
      { type: 'opened', epoch: 1 },
      { type: 'closed', epoch: 1, opened: true, now: 60000 },
    ]);
    expect(s).toMatchObject({ phase: 'connecting', epoch: 2, takeover: false });
  });

  it('checks for another session when a polite reconnect is refused', () => {
    const s = run([
      up('u1', 0),
      { type: 'opened', epoch: 1 },
      { type: 'closed', epoch: 1, opened: true, now: 60000 },
      { type: 'closed', epoch: 2, opened: false, now: 60100 },
    ]);
    expect(s.phase).toBe('checking');
    expect(run([{ type: 'checked', result: 'in-use' }], VNC, s)).toMatchObject({
      phase: 'stopped',
      reason: 'in-use',
    });
    expect(run([{ type: 'checked', result: 'unreachable' }], VNC, s)).toMatchObject({
      phase: 'retrying',
    });
    expect(run([{ type: 'checked', result: 'not-running' }], VNC, s)).toMatchObject({
      phase: 'retrying',
    });
  });

  it('retries, without checking, while the VM has just started', () => {
    const s = run([
      up('u1', 0),
      { type: 'opened', epoch: 1 },
      up('u2', 1000),
      { type: 'closed', epoch: 2, opened: false, now: 2000 },
    ]);
    expect(s).toMatchObject({ phase: 'retrying', failures: 1 });
    expect(run([{ type: 'retry' }], VNC, s)).toMatchObject({ phase: 'connecting', epoch: 3 });
  });

  it('retries a first connection that fails, and gives up after the maximum', () => {
    let s = run([up('u1', 0), { type: 'closed', epoch: 1, opened: false, now: 50000 }]);
    expect(s).toMatchObject({ phase: 'retrying', failures: 1, takeover: true });
    s = run([{ type: 'retry' }, { type: 'closed', epoch: 2, opened: false, now: 51000 }], VNC, s);
    expect(s).toMatchObject({ phase: 'retrying', failures: 2 });
    s = run([{ type: 'retry' }, { type: 'closed', epoch: 3, opened: false, now: 52000 }], VNC, s);
    expect(s).toMatchObject({ phase: 'stopped', reason: 'unreachable', failures: 3 });
  });

  it('stops on a protocol failure, with its message', () => {
    const s = run([up(), { type: 'failed', epoch: 1, message: 'Security negotiation failed' }]);
    expect(s).toMatchObject({
      phase: 'stopped',
      reason: 'failed',
      message: 'Security negotiation failed',
    });
  });

  it('takes the console over when the user reconnects', () => {
    const stopped = run([
      up('u1', 0),
      { type: 'opened', epoch: 1 },
      { type: 'closed', epoch: 1, opened: true, now: 60000 },
      { type: 'closed', epoch: 2, opened: false, now: 60100 },
      { type: 'checked', result: 'in-use' },
    ]);
    const s = run([{ type: 'reconnect' }], VNC, stopped);
    expect(s).toMatchObject({
      phase: 'connecting',
      epoch: 3,
      takeover: true,
      failures: 0,
      reason: undefined,
    });
  });

  it('does nothing on reconnect while the VM is not running', () => {
    const s = run([down()]);
    expect(sessionReducer(s, { type: 'reconnect' }, VNC)).toBe(s);
  });

  it('ignores the retry timer outside of retrying', () => {
    const s = run([up(), { type: 'opened', epoch: 1 }]);
    expect(sessionReducer(s, { type: 'retry' }, VNC)).toBe(s);
  });
});

describe('session: console held elsewhere', () => {
  const inUse = () =>
    run([
      up('u1', 0),
      { type: 'opened', epoch: 1 },
      { type: 'closed', epoch: 1, opened: true, now: 60000 },
      { type: 'closed', epoch: 2, opened: false, now: 60100 },
      { type: 'checked', result: 'in-use' },
    ]);

  it('tries again quietly and politely, staying "in use" while refused', () => {
    let s = run([{ type: 'poll' }], VNC, inUse());
    expect(s).toMatchObject({
      phase: 'connecting',
      epoch: 3,
      takeover: false,
      quiet: true,
      reason: 'in-use',
    });
    s = run([{ type: 'closed', epoch: 3, opened: false, now: 70000 }], VNC, s);
    expect(s).toMatchObject({ phase: 'stopped', reason: 'in-use', quiet: false });
  });

  it('comes back when the console is free again', () => {
    const s = run([{ type: 'poll' }, { type: 'opened', epoch: 3 }], VNC, inUse());
    expect(s).toMatchObject({ phase: 'connected', quiet: false, reason: undefined });
  });

  it('does not poll in other states, nor for the serial console', () => {
    const connected = run([up(), { type: 'opened', epoch: 1 }]);
    expect(sessionReducer(connected, { type: 'poll' }, VNC)).toBe(connected);
    const held = inUse();
    expect(sessionReducer(held, { type: 'poll' }, SERIAL)).toBe(held);
  });
});

describe('session: serial console', () => {
  it('stops when the session closes: there is no polite reconnect', () => {
    const s = run(
      [up(), { type: 'opened', epoch: 1 }, { type: 'closed', epoch: 1, opened: true, now: 60000 }],
      SERIAL
    );
    expect(s).toMatchObject({ phase: 'stopped', reason: 'closed' });
  });

  it('retries failed handshakes instead of checking', () => {
    const s = run([up('u1', 0), { type: 'closed', epoch: 1, opened: false, now: 60000 }], SERIAL);
    expect(s).toMatchObject({ phase: 'retrying', failures: 1 });
  });

  it('connects again to a new instance', () => {
    const s = run(
      [
        up('u1'),
        { type: 'opened', epoch: 1 },
        { type: 'closed', epoch: 1, opened: true, now: 5 },
        down(6),
        up('u2', 7),
      ],
      SERIAL
    );
    expect(s).toMatchObject({ phase: 'connecting', vmiUid: 'u2' });
  });
});
