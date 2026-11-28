/*
 * RFB's ExtendedDesktopSize over noVNC. noVNC (1.4) speaks it but keeps it
 * private: its own `resizeSession` asks for the size of its screen element
 * after 500 ms, with no minimum, and drops the server's answer to a
 * request. Hangar keeps `resizeSession` off and asks itself (resize.ts), so
 * this is the one place that reaches into noVNC: the server's
 * ExtendedDesktopSize rectangles are observed as they arrive, and
 * SetDesktopSize goes out on noVNC's socket with the screen id and flags the
 * server gave. When a noVNC release lacks one of these, `linkDesktopSize`
 * returns null and the console says it cannot resize the desktop.
 */

import RFB from '@novnc/novnc/core/rfb.js';
import type { Size } from './resize';

/** One ExtendedDesktopSize rectangle from the server. */
export interface DesktopSizeReply {
  /** Why it changed: 0 the server (the guest), 1 this client asked, 2 another client asked. */
  reason: number;
  /**
   * For reason 1: 0 done, 1 prohibited, 2 out of resources, 3 invalid
   * layout (QEMU: the display device cannot), 4 forwarded to the guest
   * (QEMU: the guest decides, and a change follows as reason 0).
   */
  status: number;
  width: number;
  height: number;
}

export interface DesktopSizeLink {
  /** The server sent ExtendedDesktopSize, so it takes SetDesktopSize. */
  supported(): boolean;
  /** Asks for a desktop size; false when the server does not take it. */
  request(size: Size): boolean;
  dispose(): void;
}

/** The parts of noVNC's RFB this uses (core/rfb.js 1.4). */
interface RfbInternals {
  _sock?: unknown;
  /** noVNC 1.4 keeps the 4 bytes as they came (rQshiftBytes); later releases a number. */
  _screenID?: number | ArrayLike<number>;
  _screenFlags?: number | ArrayLike<number>;
  _supportsSetDesktopSize?: boolean;
  _FBU?: { x?: number; y?: number; width?: number; height?: number };
  _handleExtendedDesktopSize?: (this: RfbInternals) => boolean;
}

/** A big-endian u32 from noVNC's field, a number or its 4 bytes. */
export function u32Of(v: number | ArrayLike<number> | undefined): number {
  if (typeof v === 'number') return v >>> 0;
  if (!v || v.length !== 4) return 0;
  return ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;
}

type SetDesktopSize = (sock: unknown, width: number, height: number, id: number, flags: number) => void;

function noVncSetDesktopSize(): SetDesktopSize | null {
  const f = (RFB as unknown as { messages?: { setDesktopSize?: SetDesktopSize } }).messages?.setDesktopSize;
  return typeof f === 'function' ? f : null;
}

export function linkDesktopSize(
  rfb: object,
  onReply: (reply: DesktopSizeReply) => void,
  setDesktopSize: SetDesktopSize | null = noVncSetDesktopSize()
): DesktopSizeLink | null {
  const r = rfb as RfbInternals;
  const handle = r._handleExtendedDesktopSize;
  if (typeof handle !== 'function' || typeof r._supportsSetDesktopSize !== 'boolean' || !setDesktopSize) return null;
  const own = Object.prototype.hasOwnProperty.call(r, '_handleExtendedDesktopSize');

  r._handleExtendedDesktopSize = function (this: RfbInternals) {
    // The rectangle's header, read before noVNC consumes its body.
    const h = this._FBU ?? {};
    const reply: DesktopSizeReply = { reason: h.x ?? 0, status: h.y ?? 0, width: h.width ?? 0, height: h.height ?? 0 };
    const done = handle.call(this);
    // false: noVNC waits for more bytes and calls again.
    if (done) {
      try {
        onReply(reply);
      } catch {
        /* never break noVNC's message loop */
      }
    }
    return done;
  };

  return {
    supported: () => r._supportsSetDesktopSize === true,
    request: ({ width, height }) => {
      if (r._supportsSetDesktopSize !== true || !r._sock) return false;
      // noVNC 1.4 would send its byte arrays as 0: give it the numbers.
      setDesktopSize(r._sock, width, height, u32Of(r._screenID), u32Of(r._screenFlags));
      return true;
    },
    dispose: () => {
      if (own) r._handleExtendedDesktopSize = handle;
      else delete r._handleExtendedDesktopSize;
    },
  };
}
