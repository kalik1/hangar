/*
 * A console socket opened the way Headlamp opens its own streams.
 *
 * Headlamp's ApiProxy.stream() builds the URL (app URL, base path,
 * /clusters/<cluster>/…) and the subprotocols, and authenticates like the
 * rest of Headlamp: in-cluster and token logins ride on the HttpOnly
 * cookie the backend set at login (the browser sends it with the
 * handshake); clusters whose kubeconfig lives in the browser add the
 * `base64url.headlamp.authorization.k8s.io.<user id>` protocol; backend
 * kubeconfig clusters need nothing. KubeVirt answers with the
 * `plain.kubevirt.io` protocol (raw bytes), which we offer next to
 * Headlamp's own.
 *
 * stream() creates its WebSocket asynchronously and only exposes it via
 * getSocket(), so this class wraps it in a WebSocket-like object that
 * exists at once: noVNC attaches to it like to a real WebSocket. Data
 * arrives through stream()'s callback from the first byte, and is held
 * until the open event has been delivered.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';

export const KUBEVIRT_PROTOCOL = 'plain.kubevirt.io';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** The part of ApiProxy.stream() the channel uses. Swappable for tests. */
export type StreamFn = (
  url: string,
  cb: (data: any) => void,
  args: {
    isJson?: boolean;
    additionalProtocols?: string[];
    reconnectOnFailure?: boolean;
    failCb?: () => void;
    cluster?: string;
  }
) => { cancel: () => void; getSocket: () => WebSocket | null };

export interface ChannelOptions {
  /** Path under the cluster, e.g. /apis/subresources.kubevirt.io/…/vnc. */
  path: string;
  /** Cluster name; empty means the cluster of the current route. */
  cluster?: string;
  /** Give up if no socket appears in this time. */
  socketTimeoutMs?: number;
  stream?: StreamFn;
}

export interface ChannelCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

const encoder = new TextEncoder();

function toBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return encoder.encode(String(data)).buffer as ArrayBuffer;
}

/** WebSocket-like: send, close, binaryType, protocol, readyState and the on* handlers. */
export class ConsoleChannel {
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: ChannelCloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private handle: ReturnType<StreamFn>;
  private socket: WebSocket | null = null;
  private state = CONNECTING;
  private wasOpened = false;
  private pending: ArrayBuffer[] = [];
  private startedAt = Date.now();
  private readonly socketTimeoutMs: number;

  constructor(opts: ChannelOptions) {
    const stream = opts.stream ?? (ApiProxy.stream as unknown as StreamFn);
    this.socketTimeoutMs = opts.socketTimeoutMs ?? 15000;
    this.handle = stream(opts.path, data => this.receive(data), {
      isJson: false,
      additionalProtocols: [KUBEVIRT_PROTOCOL],
      reconnectOnFailure: false,
      // Headlamp calls this when the socket closes on its own, before our own
      // close listener (which knows the close code) runs: let that one win.
      failCb: () => setTimeout(() => this.finish(1006, '', false), 0),
      cluster: opts.cluster || undefined,
    });
    this.poll();
  }

  get readyState(): number {
    return this.state;
  }

  get protocol(): string {
    return this.socket?.protocol ?? '';
  }

  /** The socket opened at some point (the handshake was accepted). */
  get opened(): boolean {
    return this.wasOpened;
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.state !== OPEN || !this.socket || this.socket.readyState !== OPEN) return;
    this.socket.send(typeof data === 'string' ? encoder.encode(data) : data);
  }

  close(): void {
    if (this.state === CLOSED || this.state === CLOSING) return;
    this.state = CLOSING;
    this.handle.cancel();
    if (this.socket) {
      if (this.socket.readyState === CONNECTING || this.socket.readyState === OPEN)
        this.socket.close();
      // The socket's close event finishes the job.
      if (this.socket.readyState === CLOSED) this.finish(1000, '', true);
    } else {
      // No socket yet: keep polling so a late one gets closed, report closed now.
      setTimeout(() => this.finish(1000, '', true), 0);
    }
  }

  private poll = () => {
    if (this.socket) return;
    const s = this.handle.getSocket();
    if (s) {
      this.adopt(s);
      return;
    }
    if (Date.now() - this.startedAt > this.socketTimeoutMs) {
      this.finish(1006, 'no socket', false);
      return;
    }
    // The socket usually appears within milliseconds (an IndexedDB lookup).
    setTimeout(this.poll, Date.now() - this.startedAt < 1000 ? 5 : 50);
  };

  private adopt(s: WebSocket) {
    this.socket = s;
    if (this.state === CLOSING || this.state === CLOSED) {
      // Closed before the socket existed.
      if (s.readyState === CONNECTING || s.readyState === OPEN) s.close();
      return;
    }
    s.addEventListener('close', ev => this.finish(ev.code, ev.reason, ev.wasClean));
    s.addEventListener('error', ev => this.onerror?.(ev));
    if (s.readyState === OPEN) this.open();
    else if (s.readyState === CONNECTING)
      s.addEventListener('open', () => this.open(), { once: true });
    else this.finish(1006, '', false);
  }

  private open() {
    if (this.state !== CONNECTING) return;
    this.state = OPEN;
    this.wasOpened = true;
    this.onopen?.(new Event('open'));
    const queued = this.pending;
    this.pending = [];
    for (const data of queued) this.deliver(data);
  }

  private receive(data: unknown) {
    if (this.state === CLOSED || this.state === CLOSING) return;
    const buf = toBuffer(data);
    if (this.state !== OPEN) this.pending.push(buf);
    else this.deliver(buf);
  }

  private deliver(data: ArrayBuffer) {
    this.onmessage?.({ data });
  }

  private finish(code: number, reason: string, wasClean: boolean) {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    this.pending = [];
    this.onclose?.({ code, reason, wasClean });
  }
}
