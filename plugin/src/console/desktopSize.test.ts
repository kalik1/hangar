import { DesktopSizeReply, linkDesktopSize, u32Of } from './desktopSize';

/** The noVNC 1.4 internals desktopSize.ts relies on, on a prototype as in noVNC. */
class FakeRfb {
  _sock: object | null = { name: 'sock' };
  _screenID = 0;
  _screenFlags = 0;
  _supportsSetDesktopSize = false;
  _FBU = { x: 0, y: 0, width: 0, height: 0 };
  /** What the fake noVNC handler returns: false waits for more bytes. */
  complete = true;
  handled = 0;
  _handleExtendedDesktopSize() {
    this.handled++;
    if (!this.complete) return false;
    this._supportsSetDesktopSize = true;
    this._screenID = 7;
    this._screenFlags = 2;
    return true;
  }
}

const rect = (rfb: FakeRfb, x: number, y: number, width: number, height: number) => {
  rfb._FBU = { x, y, width, height };
  return rfb._handleExtendedDesktopSize();
};

describe('linkDesktopSize', () => {
  it('passes on each ExtendedDesktopSize the server sends, with why and the status', () => {
    const rfb = new FakeRfb();
    const replies: DesktopSizeReply[] = [];
    const link = linkDesktopSize(rfb, r => replies.push(r), vi.fn());
    expect(link).not.toBeNull();
    expect(link!.supported()).toBe(false);
    expect(rect(rfb, 0, 0, 1280, 800)).toBe(true);
    expect(link!.supported()).toBe(true);
    // QEMU: the request went to the guest.
    rect(rfb, 1, 4, 1280, 800);
    // Another client resized it.
    rect(rfb, 2, 0, 1024, 768);
    expect(replies).toEqual([
      { reason: 0, status: 0, width: 1280, height: 800 },
      { reason: 1, status: 4, width: 1280, height: 800 },
      { reason: 2, status: 0, width: 1024, height: 768 },
    ]);
    expect(rfb.handled).toBe(3);
  });

  it('waits while noVNC waits for the rest of the rectangle', () => {
    const rfb = new FakeRfb();
    const replies: DesktopSizeReply[] = [];
    linkDesktopSize(rfb, r => replies.push(r), vi.fn());
    rfb.complete = false;
    expect(rect(rfb, 0, 0, 800, 600)).toBe(false);
    expect(replies).toEqual([]);
    rfb.complete = true;
    expect(rfb._handleExtendedDesktopSize()).toBe(true);
    expect(replies).toEqual([{ reason: 0, status: 0, width: 800, height: 600 }]);
  });

  it('never breaks noVNC when the listener throws', () => {
    const rfb = new FakeRfb();
    linkDesktopSize(
      rfb,
      () => {
        throw new Error('boom');
      },
      vi.fn()
    );
    expect(rect(rfb, 0, 0, 800, 600)).toBe(true);
  });

  it('asks only once the server offered it, with the screen id and flags it gave', () => {
    const rfb = new FakeRfb();
    const send = vi.fn();
    const link = linkDesktopSize(rfb, () => undefined, send)!;
    expect(link.request({ width: 1600, height: 900 })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    rect(rfb, 0, 0, 1280, 800);
    expect(link.request({ width: 1600, height: 900 })).toBe(true);
    expect(send).toHaveBeenCalledWith(rfb._sock, 1600, 900, 7, 2);
    rfb._sock = null;
    expect(link.request({ width: 1600, height: 900 })).toBe(false);
  });

  it('reads the screen id and flags as noVNC 1.4 keeps them (4 bytes) or as a number', () => {
    expect(u32Of(new Uint8Array([0, 0, 0, 0x11]))).toBe(0x11);
    expect(u32Of(new Uint8Array([0xff, 0, 0, 1]))).toBe(0xff000001);
    expect(u32Of(7)).toBe(7);
    expect(u32Of(undefined)).toBe(0);
    expect(u32Of(new Uint8Array([1, 2]))).toBe(0);
    const rfb = new FakeRfb() as any;
    const send = vi.fn();
    const link = linkDesktopSize(rfb, () => undefined, send)!;
    rect(rfb, 0, 0, 800, 600);
    rfb._screenID = new Uint8Array([0, 0, 1, 0]);
    rfb._screenFlags = new Uint8Array([0, 0, 0, 3]);
    link.request({ width: 640, height: 480 });
    expect(send).toHaveBeenCalledWith(rfb._sock, 640, 480, 256, 3);
  });

  it('gives noVNC its own handler back', () => {
    const rfb = new FakeRfb();
    const replies: DesktopSizeReply[] = [];
    const link = linkDesktopSize(rfb, r => replies.push(r), vi.fn())!;
    link.dispose();
    expect(Object.prototype.hasOwnProperty.call(rfb, '_handleExtendedDesktopSize')).toBe(false);
    rect(rfb, 0, 0, 800, 600);
    expect(replies).toEqual([]);
  });

  it('is null on a noVNC without these internals', () => {
    expect(linkDesktopSize({}, () => undefined, vi.fn())).toBeNull();
    expect(linkDesktopSize(new FakeRfb(), () => undefined, null)).toBeNull();
    const old = new FakeRfb() as any;
    delete old._supportsSetDesktopSize;
    expect(linkDesktopSize(old, () => undefined, vi.fn())).toBeNull();
  });

  it('finds SetDesktopSize in the noVNC this plugin ships', () => {
    // The default argument: noVNC's RFB.messages.setDesktopSize.
    expect(linkDesktopSize(new FakeRfb(), () => undefined)).not.toBeNull();
  });
});
