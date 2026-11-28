/*
 * "Resize the desktop to the window" (hangar#4): the console asks the
 * guest for the size of its screen over VNC (RFB SetDesktopSize, from the
 * ExtendedDesktopSize extension). QEMU passes the request to the display
 * device; virtio-gpu tells the guest, and a guest whose desktop follows the
 * display's preferred mode (GNOME, KDE on Wayland, Windows with viogpudo)
 * changes its resolution. No guest agent is involved.
 *
 * Pure parts: whether the switch can be on and why not, the per-VM choice
 * in browser storage, the size to ask for, and the requester, which
 * debounces requests and notices a guest that does not answer.
 */

import { followsWindow, VideoCards, VideoFacts } from '../model/display';

/** Wait this long after the last resize event (a window being dragged). */
export const RESIZE_DEBOUNCE_MS = 300;
/** Never ask for less. */
export const MIN_DESKTOP = { width: 640, height: 480 };
/**
 * Widths go in steps of this: Linux builds the guest's mode with CVT, which
 * rounds the width down to a multiple of 8, so asking for that is what a
 * guest can take exactly.
 */
export const WIDTH_STEP = 8;
/** A guest that follows takes a new size within this; after it, the request counts as unanswered. */
export const ANSWER_MS = 5000;
/** The server announces ExtendedDesktopSize right after the handshake; without it by then, it does not. */
export const SERVER_WAIT_MS = 3000;
/** After a power-on the firmware and the boot loader ignore requests: no "did not change" before this. */
export const BOOT_GRACE_MS = 90000;
/** Requests made because the guest changed its mode on its own, per window change. */
export const MAX_FOLLOW_UPS = 3;

export interface Size {
  width: number;
  height: number;
}

export const sameSize = (a: Size | null | undefined, b: Size | null | undefined) =>
  !!a && !!b && a.width === b.width && a.height === b.height;

/** The desktop size for a screen of this size: whole pixels, the width in WIDTH_STEP, at least MIN_DESKTOP. */
export function desktopSizeFor(screen: Size | null | undefined): Size | null {
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return null;
  const width = Math.max(MIN_DESKTOP.width, Math.min(0xfff8, Math.floor(screen.width)));
  return {
    width: width - (width % WIDTH_STEP),
    height: Math.max(MIN_DESKTOP.height, Math.min(0xffff, Math.floor(screen.height))),
  };
}

/* ----------------------------------------------------------- availability */

/** What the VNC server said about ExtendedDesktopSize: not yet, yes, or nothing by SERVER_WAIT_MS. */
export type ServerSupport = 'unknown' | 'yes' | 'no';

export type ResizeAvailability =
  /** The switch works. */
  | { kind: 'ready' }
  /** Not connected: nothing to resize. */
  | { kind: 'offline' }
  /** Connected; the server has not said yet whether it can. */
  | { kind: 'checking' }
  /** The guest's video card cannot follow. `pending`: VirtIO is chosen and waits for a restart. */
  | { kind: 'card'; card: VideoFacts; pending: boolean }
  /** The VNC server offers no ExtendedDesktopSize. */
  | { kind: 'server' }
  /** QEMU refused the request: the display device cannot change size. */
  | { kind: 'refused' }
  /** This console's VNC client cannot send the request. */
  | { kind: 'client' };

export function resizeAvailability(a: {
  connected: boolean;
  /** null while the VM is not known yet. */
  cards: VideoCards | null;
  server: ServerSupport;
  /** The VNC client can send SetDesktopSize (desktopSize.ts found what it needs in noVNC). */
  client: boolean;
  /** QEMU answered a request with "invalid screen layout" on this connection. */
  refused?: boolean;
}): ResizeAvailability {
  if (!a.cards) return { kind: a.connected ? 'checking' : 'offline' };
  const { now, next } = a.cards;
  // Known before connecting, from the VM: say it even while offline.
  if (!followsWindow(now.type)) return { kind: 'card', card: now, pending: followsWindow(next.type) };
  if (!a.connected) return { kind: 'offline' };
  if (!a.client) return { kind: 'client' };
  if (a.refused) return { kind: 'refused' };
  if (a.server === 'unknown') return { kind: 'checking' };
  if (a.server === 'no') return { kind: 'server' };
  return { kind: 'ready' };
}

/**
 * The switch: on by default when it can be (a VirtIO card and a server that
 * offers ExtendedDesktopSize), else what the user chose for this VM.
 */
export function resizeOn(avail: ResizeAvailability, choice: boolean | null): boolean {
  return avail.kind === 'ready' && (choice ?? true);
}

/**
 * Scale the picture? With the switch off, the user's Fit/1:1. With it on,
 * only while the desktop is not the size asked for the window (a guest that
 * does not follow, a window below MIN_DESKTOP, the moment before the guest
 * answers): a desktop of the window's size is shown pixel for pixel.
 */
export function scaleViewport(a: { resizing: boolean; fit: boolean; desktop: Size | null; screen: Size | null }): boolean {
  if (!a.resizing) return a.fit;
  const d = a.desktop;
  const fits = !!d && !!a.screen && d.width <= a.screen.width && d.height <= a.screen.height;
  return !(fits && sameSize(d, desktopSizeFor(a.screen)));
}

/* ------------------------------------------------------------------ texts */

export const SWITCH_LABEL = 'Resize the desktop to the window';

/** Where the video card is chosen. */
export const CARD_FIX = 'Configure → Devices → Video card';

export function cardNotice(card: VideoFacts, pending: boolean): string {
  return pending
    ? `This VM runs with the ${card.label} video card, which cannot follow the window. VirtIO is chosen: it applies at the next restart.`
    : `This VM's video card (${card.label}) cannot follow the window: choose VirtIO in ${CARD_FIX}; it applies at the next restart.`;
}

/** Why the switch is off and cannot be turned on (null: it can). */
export function unavailableReason(avail: ResizeAvailability): string | null {
  switch (avail.kind) {
    case 'ready':
      return null;
    case 'offline':
      return 'Available when the console is connected';
    case 'checking':
      return 'Checking whether the VNC server can resize the desktop';
    case 'card':
      return cardNotice(avail.card, avail.pending);
    case 'server':
      return 'The VNC server does not offer to resize the desktop (no ExtendedDesktopSize): the console scales the screen instead.';
    case 'refused':
      return "QEMU refused to resize the desktop: this VM's display device cannot change size. The console scales the screen instead.";
    case 'client':
      return 'This console cannot ask for a desktop size: it scales the screen instead.';
  }
}

/** Every console of a VM shows the same desktop (KubeVirt serves the VNC session shared). */
export const SHARED_NOTE = 'The desktop is the VM’s: every console of this VM sees the new size.';

export function switchTooltip(avail: ResizeAvailability, on: boolean): string {
  const why = unavailableReason(avail);
  if (why) return why;
  return on
    ? `The desktop follows the window. ${SHARED_NOTE} Turn off`
    : `${SWITCH_LABEL}. ${SHARED_NOTE}`;
}

/** Said once when a request stays unanswered: what the guest needs. */
export function guestIgnoredMessage(osId: string): string {
  const fix =
    osId === 'windows'
      ? 'install the VirtIO GPU driver (viogpudo, from virtio-win)'
      : 'install the virtio-gpu driver, or use a desktop that follows the display size (GNOME, KDE on Wayland)';
  return `The guest did not change its resolution: ${fix}. The console scales the screen instead.`;
}

/** RFB ExtendedDesktopSize status codes, for a request this client made. */
export function refusalText(status: number): string {
  switch (status) {
    case 1:
      return 'resizing is administratively prohibited';
    case 2:
      return 'out of resources';
    case 3:
      return 'invalid screen layout';
    default:
      return `status ${status}`;
  }
}

/* ---------------------------------------------------------------- storage */

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): KeyValue | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const resizeChoiceKey = (cluster: string, namespace: string, name: string) =>
  `hangar.console.resize/${cluster}/${namespace}/${name}`;

/** The user's choice for this VM in this browser; null: none (the default applies). */
export function readResizeChoice(key: string, s: KeyValue | null = storage()): boolean | null {
  try {
    const v = s?.getItem(key);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

export function writeResizeChoice(key: string, on: boolean, s: KeyValue | null = storage()) {
  try {
    s?.setItem(key, on ? 'on' : 'off');
  } catch {
    /* storage unavailable: the choice lasts until the page closes */
  }
}

/* -------------------------------------------------------------- requester */

export interface Timers {
  setTimeout: (f: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  now: () => number;
}

const browserTimers: Timers = {
  setTimeout: (f, ms) => window.setTimeout(f, ms),
  clearTimeout: id => window.clearTimeout(id),
  now: () => Date.now(),
};

export interface ResizerDeps {
  /** Sends SetDesktopSize; false when it could not. */
  send: (size: Size) => boolean;
  /** The desktop's size now (the framebuffer), if known. */
  desktop: () => Size | null;
  /** The size of the console's screen, in CSS pixels. */
  screen: () => Size | null;
  /** A request stayed unanswered (said once per requester). */
  unanswered: () => void;
  /** The desktop took the window's size after all. */
  followed?: () => void;
  timers?: Timers;
}

/**
 * Asks for the window's size while enabled: on a window change (debounced),
 * when turned on, and when the guest changes its mode on its own (a boot
 * stage), up to MAX_FOLLOW_UPS times per window change so a guest that
 * insists on its own size is left alone. A size the guest answered, even
 * with another size (a guest may round it), is not asked again until the
 * window changes. A request the desktop does not answer within ANSWER_MS is
 * reported once; during BOOT_GRACE_MS after a power-on it is asked again
 * when the grace ends instead.
 */
export class DesktopResizer {
  private enabled = false;
  private debounce = 0;
  private answer = 0;
  private pending: Size | null = null;
  /** The last request the guest answered (with any size). */
  private answered: Size | null = null;
  private followUps = 0;
  private reported = false;
  private graceUntil = 0;
  private readonly t: Timers;

  constructor(private readonly deps: ResizerDeps) {
    this.t = deps.timers ?? browserTimers;
  }

  /** No "did not change" report before this time (ms): the instance's start plus BOOT_GRACE_MS. */
  setGraceUntil(at: number) {
    this.graceUntil = at;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.stop();
    this.answered = null;
    if (on) this.windowChanged();
  }

  get isEnabled() {
    return this.enabled;
  }

  /** The console's screen changed size (the window, the popup, fullscreen). */
  windowChanged() {
    this.followUps = 0;
    this.schedule();
  }

  /** The server says the desktop has this size now. */
  desktopChanged(size: Size) {
    if (this.pending) {
      // The guest's answer, maybe not exactly the size asked.
      this.answered = this.pending;
      this.pending = null;
      this.t.clearTimeout(this.answer);
      this.deps.followed?.();
      return;
    }
    if (sameSize(size, desktopSizeFor(this.deps.screen()))) {
      this.deps.followed?.();
      return;
    }
    // A change of its own: a boot stage, or the guest's settings. Ask again, a few times.
    this.answered = null;
    if (this.enabled && this.followUps < MAX_FOLLOW_UPS) {
      this.followUps++;
      this.schedule();
    }
  }

  /** Sends now what a debounced request would send. */
  flush() {
    this.t.clearTimeout(this.debounce);
    this.debounce = 0;
    if (!this.enabled) return;
    const want = desktopSizeFor(this.deps.screen());
    if (!want) return;
    if (sameSize(this.deps.desktop(), want)) {
      this.pending = null;
      this.t.clearTimeout(this.answer);
      return;
    }
    if (sameSize(this.pending, want) || sameSize(this.answered, want)) return;
    if (!this.deps.send(want)) return;
    this.pending = want;
    this.arm(ANSWER_MS);
  }

  dispose() {
    this.enabled = false;
    this.stop();
  }

  private schedule() {
    if (!this.enabled) return;
    this.t.clearTimeout(this.debounce);
    this.debounce = this.t.setTimeout(() => this.flush(), RESIZE_DEBOUNCE_MS);
  }

  private arm(ms: number) {
    this.t.clearTimeout(this.answer);
    this.answer = this.t.setTimeout(() => this.unansweredCheck(), ms);
  }

  private unansweredCheck() {
    if (!this.pending || !this.enabled) return;
    const wait = this.graceUntil - this.t.now();
    if (wait > 0) {
      // Still booting: ask again when the guest should be up.
      this.t.clearTimeout(this.answer);
      this.answer = this.t.setTimeout(() => {
        this.pending = null;
        this.flush();
      }, wait);
      return;
    }
    if (!this.reported) {
      this.reported = true;
      this.deps.unanswered();
    }
  }

  private stop() {
    this.t.clearTimeout(this.debounce);
    this.t.clearTimeout(this.answer);
    this.debounce = 0;
    this.answer = 0;
    this.pending = null;
  }
}
