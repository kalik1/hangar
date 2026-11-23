import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleChannel, KUBEVIRT_PROTOCOL, StreamFn } from './channel';

/** A WebSocket stand-in: an EventTarget with readyState, send and close. */
class FakeSocket extends EventTarget {
  readyState = 0;
  protocol = '';
  sent: unknown[] = [];
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const ev = Object.assign(new Event('close'), { code: 1005, reason: '', wasClean: true });
    this.dispatchEvent(ev);
  }
  serverOpen() {
    this.readyState = 1;
    this.protocol = KUBEVIRT_PROTOCOL;
    this.dispatchEvent(new Event('open'));
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '', wasClean: false }));
  }
}

/** A stream() stand-in: the socket shows up after `delayMs`, data goes through `cb`. */
function fakeStream(delayMs = 10) {
  const socket = new FakeSocket();
  let cb: (d: any) => void = () => {};
  let failCb: (() => void) | undefined;
  let ready = false;
  let cancelled = false;
  const calls: { url: string; args: any }[] = [];
  const stream: StreamFn = (url, onData, args) => {
    calls.push({ url, args });
    cb = onData;
    failCb = args.failCb;
    setTimeout(() => (ready = true), delayMs);
    return {
      cancel: () => {
        cancelled = true;
        if (ready) socket.close();
      },
      getSocket: () => (ready ? (socket as unknown as WebSocket) : null),
    };
  };
  return {
    stream,
    socket,
    calls,
    data: (bytes: number[]) => cb(new Uint8Array(bytes).buffer),
    fail: () => failCb?.(),
    get cancelled() {
      return cancelled;
    },
  };
}

const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

describe('ConsoleChannel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the stream like Headlamp does, offering the KubeVirt protocol', () => {
    const f = fakeStream();
    new ConsoleChannel({ path: '/apis/x/vnc', cluster: 'demo', stream: f.stream });
    expect(f.calls[0].url).toBe('/apis/x/vnc');
    expect(f.calls[0].args).toMatchObject({
      isJson: false,
      additionalProtocols: [KUBEVIRT_PROTOCOL],
      reconnectOnFailure: false,
      cluster: 'demo',
    });
  });

  it('looks like a WebSocket to noVNC', () => {
    const ch = new ConsoleChannel({ path: '/x', stream: fakeStream().stream });
    const props = [...Object.keys(ch), ...Object.getOwnPropertyNames(Object.getPrototypeOf(ch))];
    for (const p of [
      'send',
      'close',
      'binaryType',
      'onerror',
      'onmessage',
      'onopen',
      'protocol',
      'readyState',
    ]) {
      expect(props, p).toContain(p);
    }
    expect(ch.readyState).toBe(0);
  });

  it('opens when the socket opens, then delivers data held until then', () => {
    const f = fakeStream();
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const seen: string[] = [];
    ch.onopen = () => seen.push('open');
    ch.onmessage = e => seen.push(`data ${bytes(e.data).join(',')}`);
    vi.advanceTimersByTime(20);
    f.socket.serverOpen();
    expect(ch.readyState).toBe(1);
    expect(ch.protocol).toBe(KUBEVIRT_PROTOCOL);
    f.data([1, 2]);
    expect(seen).toEqual(['open', 'data 1,2']);
  });

  it('holds data that arrives before it saw the open event', () => {
    const f = fakeStream();
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const seen: string[] = [];
    ch.onopen = () => seen.push('open');
    ch.onmessage = e => seen.push(`data ${bytes(e.data).join(',')}`);
    // The socket opened and spoke before the channel found it.
    f.socket.readyState = 1;
    f.data([82, 70, 66]);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(seen).toEqual(['open', 'data 82,70,66']);
  });

  it('sends only while open', () => {
    const f = fakeStream();
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    ch.send(new Uint8Array([1]));
    vi.advanceTimersByTime(20);
    f.socket.serverOpen();
    ch.send(new Uint8Array([2]));
    ch.send('é');
    expect(f.socket.sent).toHaveLength(2);
    expect(Array.from(f.socket.sent[1] as Uint8Array)).toEqual([0xc3, 0xa9]);
  });

  it('reports a server close with its code, once, and says it had opened', () => {
    const f = fakeStream();
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const closes: number[] = [];
    ch.onclose = e => closes.push(e.code);
    vi.advanceTimersByTime(20);
    f.socket.serverOpen();
    f.socket.serverClose(1006);
    f.fail();
    vi.advanceTimersByTime(10);
    expect(closes).toEqual([1006]);
    expect(ch.opened).toBe(true);
    expect(ch.readyState).toBe(3);
  });

  it('reports a refused handshake as a close that never opened', () => {
    const f = fakeStream();
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const closes: number[] = [];
    ch.onclose = e => closes.push(e.code);
    vi.advanceTimersByTime(20);
    f.socket.serverClose(1006);
    expect(closes).toEqual([1006]);
    expect(ch.opened).toBe(false);
  });

  it('closes the socket when asked, and reports the close', () => {
    const f = fakeStream();
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const closes: boolean[] = [];
    ch.onclose = e => closes.push(e.wasClean);
    vi.advanceTimersByTime(20);
    f.socket.serverOpen();
    ch.close();
    expect(f.cancelled).toBe(true);
    expect(f.socket.readyState).toBe(3);
    expect(closes).toEqual([true]);
  });

  it('closes a socket that appears after it was closed', () => {
    const f = fakeStream(50);
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const closes: number[] = [];
    ch.onclose = e => closes.push(e.code);
    ch.close();
    vi.advanceTimersByTime(1);
    expect(closes).toEqual([1000]);
    f.socket.readyState = 1;
    vi.advanceTimersByTime(100);
    expect(f.socket.readyState).toBe(3);
    expect(closes).toEqual([1000]);
  });

  it('gives up when no socket appears', () => {
    const f = fakeStream(60000);
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream, socketTimeoutMs: 1000 });
    const closes: number[] = [];
    ch.onclose = e => closes.push(e.code);
    vi.advanceTimersByTime(1200);
    expect(closes).toEqual([1006]);
  });

  it('reports a stream that failed before creating a socket', () => {
    const f = fakeStream(60000);
    const ch = new ConsoleChannel({ path: '/x', stream: f.stream });
    const closes: number[] = [];
    ch.onclose = e => closes.push(e.code);
    f.fail();
    vi.advanceTimersByTime(1);
    expect(closes).toEqual([1006]);
  });
});
