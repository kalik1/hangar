import { VideoCards, videoCards } from '../model/display';
import {
  ANSWER_MS,
  BOOT_GRACE_MS,
  cardNotice,
  DesktopResizer,
  desktopSizeFor,
  guestIgnoredMessage,
  MAX_FOLLOW_UPS,
  readResizeChoice,
  RESIZE_DEBOUNCE_MS,
  resizeAvailability,
  resizeChoiceKey,
  resizeOn,
  scaleViewport,
  Size,
  switchTooltip,
  Timers,
  unavailableReason,
  writeResizeChoice,
} from './resize';

const vmWith = (video?: string, efi = false) => ({
  metadata: { name: 'desk', namespace: 'demo' },
  spec: {
    template: {
      spec: {
        domain: { devices: video ? { video: { type: video } } : {}, ...(efi ? { firmware: { bootloader: { efi: {} } } } : {}) },
      },
    },
  },
});
const vmiWith = (video?: string, efi = false) => ({
  metadata: { name: 'desk', namespace: 'demo', uid: 'u1' },
  spec: { architecture: 'amd64', domain: { devices: video ? { video: { type: video } } : {}, ...(efi ? { firmware: { bootloader: { efi: {} } } } : {}) } },
});
const cards = (vm: any, vmi: any) => videoCards(vm, vmi) as VideoCards;
const virtio = cards(vmWith('virtio'), vmiWith('virtio'));

describe('desktopSizeFor', () => {
  it('asks for whole pixels, the width in steps of 8, at least 640×480', () => {
    expect(desktopSizeFor({ width: 1280.6, height: 719.4 })).toEqual({ width: 1280, height: 719 });
    expect(desktopSizeFor({ width: 1366, height: 768 })).toEqual({ width: 1360, height: 768 });
    expect(desktopSizeFor({ width: 500, height: 300 })).toEqual({ width: 640, height: 480 });
    expect(desktopSizeFor({ width: 1920, height: 300 })).toEqual({ width: 1920, height: 480 });
  });

  it('asks for nothing while the screen is hidden', () => {
    expect(desktopSizeFor(null)).toBeNull();
    expect(desktopSizeFor({ width: 0, height: 0 })).toBeNull();
  });
});

describe('the switch', () => {
  const ready = { connected: true, cards: virtio, server: 'yes' as const, client: true };

  it('works with a VirtIO card and a server that offers ExtendedDesktopSize', () => {
    expect(resizeAvailability(ready)).toEqual({ kind: 'ready' });
  });

  it('is on by default where it works, and follows the choice for the VM', () => {
    expect(resizeOn({ kind: 'ready' }, null)).toBe(true);
    expect(resizeOn({ kind: 'ready' }, false)).toBe(false);
    expect(resizeOn({ kind: 'ready' }, true)).toBe(true);
  });

  it('stays off where it cannot work, whatever the choice', () => {
    for (const a of [
      resizeAvailability({ ...ready, cards: cards(vmWith(), vmiWith()) }),
      resizeAvailability({ ...ready, server: 'no' }),
      resizeAvailability({ ...ready, server: 'unknown' }),
      resizeAvailability({ ...ready, connected: false }),
      resizeAvailability({ ...ready, client: false }),
      resizeAvailability({ ...ready, refused: true }),
    ]) {
      expect(a.kind).not.toBe('ready');
      expect(resizeOn(a, true)).toBe(false);
      expect(unavailableReason(a)).toBeTruthy();
    }
  });

  it('names the card that cannot follow: VGA with BIOS, Bochs with UEFI, or the chosen one', () => {
    for (const [vm, vmi, label] of [
      [vmWith(), vmiWith(), 'VGA'],
      [vmWith(undefined, true), vmiWith(undefined, true), 'Bochs'],
      [vmWith('cirrus'), vmiWith('cirrus'), 'Cirrus'],
      [vmWith('ramfb'), vmiWith('ramfb'), 'ramfb'],
      [vmWith('vga'), vmiWith('vga'), 'VGA'],
    ] as const) {
      const a = resizeAvailability({ ...ready, cards: cards(vm, vmi) });
      expect(a).toMatchObject({ kind: 'card', pending: false, card: { label } });
    }
  });

  it('says so before connecting, from the VM', () => {
    expect(resizeAvailability({ ...ready, connected: false, cards: cards(vmWith(), null) }).kind).toBe('card');
    expect(resizeAvailability({ ...ready, connected: false, cards: null }).kind).toBe('offline');
    expect(resizeAvailability({ ...ready, cards: null }).kind).toBe('checking');
  });

  it('knows a VirtIO card that waits for a restart', () => {
    const a = resizeAvailability({ ...ready, cards: cards(vmWith('virtio'), vmiWith()) });
    expect(a).toMatchObject({ kind: 'card', pending: true });
    expect(unavailableReason(a)).toBe(
      'This VM runs with the VGA video card, which cannot follow the window. VirtIO is chosen: it applies at the next restart.'
    );
  });

  it('says how to fix a card that cannot follow', () => {
    const a = resizeAvailability({ ...ready, cards: cards(vmWith(), vmiWith()) });
    expect(unavailableReason(a)).toBe(
      "This VM's video card (VGA) cannot follow the window: choose VirtIO in Configure → Devices → Video card; it applies at the next restart."
    );
    expect(switchTooltip(a, false)).toBe(unavailableReason(a));
  });

  it('says that every console of the VM sees the new size', () => {
    expect(switchTooltip({ kind: 'ready' }, true)).toMatch(/every console of this VM sees the new size/);
    expect(switchTooltip({ kind: 'ready' }, false)).toMatch(/^Resize the desktop to the window\. .*every console/);
  });
});

describe('scaleViewport', () => {
  it('follows Fit / 1:1 while the switch is off', () => {
    expect(scaleViewport({ resizing: false, fit: true, desktop: null, screen: null })).toBe(true);
    expect(scaleViewport({ resizing: false, fit: false, desktop: { width: 800, height: 600 }, screen: { width: 800, height: 600 } })).toBe(false);
  });

  it('shows a desktop of the window’s size pixel for pixel, and scales any other', () => {
    const screen = { width: 1285.5, height: 720.25 };
    expect(scaleViewport({ resizing: true, fit: false, desktop: { width: 1280, height: 720 }, screen })).toBe(false);
    // The guest kept its size: fall back to scaling.
    expect(scaleViewport({ resizing: true, fit: false, desktop: { width: 1024, height: 768 }, screen })).toBe(true);
    // A window below the minimum.
    expect(scaleViewport({ resizing: true, fit: false, desktop: { width: 640, height: 480 }, screen: { width: 500, height: 400 } })).toBe(true);
  });
});

describe('the fallback message', () => {
  it('names the driver of a Linux guest', () => {
    expect(guestIgnoredMessage('fedora')).toBe(
      'The guest did not change its resolution: install the virtio-gpu driver, or use a desktop that follows the display size (GNOME, KDE on Wayland). The console scales the screen instead.'
    );
    expect(guestIgnoredMessage('')).toMatch(/virtio-gpu/);
  });

  it('names viogpudo for Windows', () => {
    expect(guestIgnoredMessage('windows')).toBe(
      'The guest did not change its resolution: install the VirtIO GPU driver (viogpudo, from virtio-win). The console scales the screen instead.'
    );
  });

  it('cardNotice matches the switch reason', () => {
    expect(cardNotice({ type: 'bochs', label: 'Bochs', chosen: false }, false)).toMatch(/^This VM's video card \(Bochs\) cannot follow/);
  });
});

describe('the choice per VM', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it('is kept per cluster, folder and VM', () => {
    const s = store();
    const k = resizeChoiceKey('main', 'demo', 'desk');
    expect(readResizeChoice(k, s)).toBeNull();
    writeResizeChoice(k, false, s);
    expect(readResizeChoice(k, s)).toBe(false);
    writeResizeChoice(k, true, s);
    expect(readResizeChoice(k, s)).toBe(true);
    expect(readResizeChoice(resizeChoiceKey('main', 'demo', 'other'), s)).toBeNull();
  });

  it('survives a browser without storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(readResizeChoice('k', broken)).toBeNull();
    expect(() => writeResizeChoice('k', true, broken)).not.toThrow();
    expect(readResizeChoice('k', null)).toBeNull();
  });
});

/* -------------------------------------------------------------- requester */

/** Manual clock and timers. */
function clock(start = 1_000_000): Timers & { advance: (ms: number) => void; at: number } {
  let id = 0;
  const due = new Map<number, { at: number; f: () => void }>();
  const c = {
    at: start,
    now: () => c.at,
    setTimeout: (f: () => void, ms: number) => {
      due.set(++id, { at: c.at + ms, f });
      return id;
    },
    clearTimeout: (i: number) => void due.delete(i),
    advance: (ms: number) => {
      const end = c.at + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        c.at = next[1].at;
        next[1].f();
      }
      c.at = end;
    },
  };
  return c;
}

function rig(opts: { screen?: Size; desktop?: Size } = {}) {
  const t = clock();
  const sent: Size[] = [];
  const state = { screen: opts.screen ?? { width: 1280, height: 720 }, desktop: opts.desktop ?? { width: 1024, height: 768 } };
  const unanswered = vi.fn();
  const followed = vi.fn();
  const r = new DesktopResizer({
    send: s => {
      sent.push(s);
      return true;
    },
    desktop: () => state.desktop,
    screen: () => state.screen,
    unanswered,
    followed,
    timers: t,
  });
  /** The guest takes a size: the server reports it. */
  const guest = (s: Size) => {
    state.desktop = s;
    r.desktopChanged(s);
  };
  return { t, r, sent, state, unanswered, followed, guest };
}

describe('DesktopResizer', () => {
  it('asks once a window being dragged stops, for its last size', () => {
    const { t, r, sent, state } = rig();
    r.setEnabled(true);
    for (const w of [1000, 1100, 1200, 1300]) {
      state.screen = { width: w, height: 700 };
      r.windowChanged();
      t.advance(RESIZE_DEBOUNCE_MS - 50);
    }
    expect(sent).toEqual([]);
    t.advance(50);
    expect(sent).toEqual([{ width: 1296, height: 700 }]);
  });

  it('asks when turned on, after the debounce', () => {
    const { t, r, sent } = rig();
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    t.advance(1);
    expect(sent).toEqual([{ width: 1280, height: 720 }]);
  });

  it('never asks for less than 640×480', () => {
    const { t, r, sent } = rig({ screen: { width: 320, height: 200 } });
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([{ width: 640, height: 480 }]);
  });

  it('asks for nothing while off, when the desktop has the size already, or twice for the same size', () => {
    const off = rig();
    off.r.windowChanged();
    off.t.advance(RESIZE_DEBOUNCE_MS);
    expect(off.sent).toEqual([]);

    const same = rig({ screen: { width: 1024, height: 768 }, desktop: { width: 1024, height: 768 } });
    same.r.setEnabled(true);
    same.t.advance(RESIZE_DEBOUNCE_MS);
    expect(same.sent).toEqual([]);

    const twice = rig();
    twice.r.setEnabled(true);
    twice.t.advance(RESIZE_DEBOUNCE_MS);
    twice.r.windowChanged();
    twice.t.advance(RESIZE_DEBOUNCE_MS);
    expect(twice.sent).toHaveLength(1);
  });

  it('stops asking when turned off', () => {
    const { t, r, sent } = rig();
    r.setEnabled(true);
    r.setEnabled(false);
    t.advance(RESIZE_DEBOUNCE_MS);
    r.windowChanged();
    t.advance(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([]);
  });

  it('a guest that follows: no message', () => {
    const { t, r, guest, unanswered, followed } = rig();
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS + 800);
    guest({ width: 1280, height: 720 });
    t.advance(ANSWER_MS * 2);
    expect(unanswered).not.toHaveBeenCalled();
    expect(followed).toHaveBeenCalledTimes(1);
  });

  it('says once that the guest did not change its resolution', () => {
    const { t, r, state, unanswered } = rig();
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS + ANSWER_MS - 1);
    expect(unanswered).not.toHaveBeenCalled();
    t.advance(1);
    expect(unanswered).toHaveBeenCalledTimes(1);
    // Another unanswered request: not said again.
    state.screen = { width: 1600, height: 900 };
    r.windowChanged();
    t.advance(RESIZE_DEBOUNCE_MS + ANSWER_MS * 2);
    expect(unanswered).toHaveBeenCalledTimes(1);
  });

  it('during a boot, asks again when the grace ends, and only then reports', () => {
    const { t, r, sent, unanswered } = rig();
    r.setGraceUntil(t.at + BOOT_GRACE_MS);
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS + ANSWER_MS);
    expect(sent).toHaveLength(1);
    expect(unanswered).not.toHaveBeenCalled();
    t.advance(BOOT_GRACE_MS - RESIZE_DEBOUNCE_MS - ANSWER_MS);
    expect(sent).toHaveLength(2);
    expect(unanswered).not.toHaveBeenCalled();
    t.advance(ANSWER_MS);
    expect(unanswered).toHaveBeenCalledTimes(1);
  });

  it('asks again when the guest changes its mode on its own, a few times per window change', () => {
    const { t, r, sent, guest } = rig();
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    // It answers with a size of its own…
    guest({ width: 800, height: 600 });
    // …then keeps changing it on its own (boot stages, or settings it insists on).
    for (let i = 0; i < MAX_FOLLOW_UPS + 2; i++) {
      guest({ width: 1024, height: 768 + i });
      t.advance(RESIZE_DEBOUNCE_MS);
      guest({ width: 800, height: 600 + i });
    }
    expect(sent).toHaveLength(1 + MAX_FOLLOW_UPS);
    // The user resizes the window: it asks again.
    r.windowChanged();
    t.advance(RESIZE_DEBOUNCE_MS);
    expect(sent).toHaveLength(2 + MAX_FOLLOW_UPS);
  });

  it('does not ask again for a size the guest answered with another (a rounded mode)', () => {
    const { t, r, sent, guest, unanswered, state } = rig();
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS);
    guest({ width: 1272, height: 720 });
    r.windowChanged();
    t.advance(RESIZE_DEBOUNCE_MS + ANSWER_MS * 2);
    expect(sent).toEqual([{ width: 1280, height: 720 }]);
    expect(unanswered).not.toHaveBeenCalled();
    // A new window size is asked for.
    state.screen = { width: 1440, height: 900 };
    r.windowChanged();
    t.advance(RESIZE_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
  });

  it('a desktop that changes to the window size withdraws nothing it did not say', () => {
    const { r, guest, followed, unanswered } = rig();
    guest({ width: 1280, height: 720 });
    expect(followed).toHaveBeenCalledTimes(1);
    expect(unanswered).not.toHaveBeenCalled();
    expect(r.isEnabled).toBe(false);
  });

  it('a failed send leaves nothing pending', () => {
    const t = clock();
    const unanswered = vi.fn();
    const r = new DesktopResizer({
      send: () => false,
      desktop: () => ({ width: 800, height: 600 }),
      screen: () => ({ width: 1280, height: 720 }),
      unanswered,
      timers: t,
    });
    r.setEnabled(true);
    t.advance(RESIZE_DEBOUNCE_MS + ANSWER_MS * 2);
    expect(unanswered).not.toHaveBeenCalled();
  });
});
