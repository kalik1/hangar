/*
 * desktopSize.ts against the noVNC this plugin ships, with a scripted RFB
 * server in place of QEMU: what reaches noVNC's internals, the bytes of
 * SetDesktopSize, and QEMU's answers (forwarded, then the guest's resize).
 */

import RFB from '@novnc/novnc/core/rfb.js';
import { DesktopSizeReply, linkDesktopSize } from './desktopSize';

const tick = () => new Promise(r => setTimeout(r, 0));

/** A WebSocket-like channel; the test plays the server. */
class ServerChannel {
  binaryType = 'arraybuffer';
  protocol = '';
  readyState = 'connecting';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: number[] = [];
  send(data: Uint8Array | ArrayBuffer) {
    this.sent.push(...new Uint8Array(data instanceof ArrayBuffer ? data : data.slice().buffer));
  }
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }
  push(bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const s32 = (n: number) => u32(n >>> 0);
const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));

/** A FramebufferUpdate with one ExtendedDesktopSize rectangle (pseudo-encoding -308). */
function extDesktopSize(x: number, y: number, w: number, h: number, id = 0x11, flags = 0x22) {
  return [0, 0, ...u16(1), ...u16(x), ...u16(y), ...u16(w), ...u16(h), ...s32(-308), 1, 0, 0, 0, ...u32(id), ...u16(0), ...u16(0), ...u16(w), ...u16(h), ...u32(flags)];
}

/** A 2D context that does nothing: jsdom has no canvas. */
function fakeContext(): any {
  const image = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
  return new Proxy(
    {},
    {
      get: (_, prop) =>
        prop === 'createImageData' || prop === 'getImageData'
          ? (...a: number[]) => image(a[a.length - 2] ?? 1, a[a.length - 1] ?? 1)
          : () => undefined,
    }
  );
}

describe('linkDesktopSize with noVNC 1.4', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('learns that QEMU takes SetDesktopSize, asks, and sees the answers', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const ch = new ServerChannel();
    const rfb = new RFB(target, ch, { shared: true });
    rfb.resizeSession = false;
    const replies: DesktopSizeReply[] = [];
    const link = linkDesktopSize(rfb, r => replies.push(r));
    expect(link).not.toBeNull();
    const connected = vi.fn();
    rfb.addEventListener('connect', connected);

    await tick(); // noVNC attaches the channel on a timer
    ch.open();
    ch.push(ascii('RFB 003.008\n'));
    ch.push([1, 1]); // one security type: None
    ch.push(u32(0)); // security result: OK
    const pixelFormat = [32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 16, 8, 0, 0, 0, 0];
    ch.push([...u16(1024), ...u16(768), ...pixelFormat, ...u32(4), ...ascii('demo')]);
    expect(connected).toHaveBeenCalled();
    expect(link!.supported()).toBe(false);

    // QEMU announces ExtendedDesktopSize after SetEncodings.
    ch.push(extDesktopSize(0, 0, 1024, 768));
    expect(link!.supported()).toBe(true);
    expect(replies).toEqual([{ reason: 0, status: 0, width: 1024, height: 768 }]);

    // The screen id and flags the server gave go back with the request.
    const before = ch.sent.length;
    expect(link!.request({ width: 1280, height: 720 })).toBe(true);
    expect(ch.sent.slice(before)).toEqual([251, 0, ...u16(1280), ...u16(720), 1, 0, ...u32(0x11), 0, 0, 0, 0, ...u16(1280), ...u16(720), ...u32(0x22)]);

    // QEMU: forwarded to the guest (noVNC keeps the size)…
    ch.push(extDesktopSize(1, 4, 1024, 768));
    const canvas = target.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([1024, 768]);
    // …then the guest takes it.
    ch.push(extDesktopSize(0, 0, 1280, 720));
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(replies.slice(1)).toEqual([
      { reason: 1, status: 4, width: 1024, height: 768 },
      { reason: 0, status: 0, width: 1280, height: 720 },
    ]);

    link!.dispose();
    rfb.disconnect();
    target.remove();
  });
});
