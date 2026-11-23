import { describe, expect, it, vi } from 'vitest';
import { consolePopupFeatures, consolePopupKey, consolePopupName, consolePopupTitle, openOrFocusPopup } from './popup';
import { applyPresence, isOpen, STALE_MS } from './popupPresence';

function fakeWindows(existing?: string) {
  const popup = existing === null ? null : { location: { href: existing ?? 'about:blank', replace: vi.fn() }, focus: vi.fn(), open: vi.fn() };
  const opener = { location: { href: 'http://hl.example/c/main/hangar/vm/demo/web-01' }, focus: vi.fn(), open: vi.fn(() => popup) };
  return { opener, popup };
}

describe('popup names and sizes', () => {
  it('one window per cluster and VM, with a safe name', () => {
    expect(consolePopupKey('main', 'demo', 'web-01')).toBe('main/demo/web-01');
    expect(consolePopupName('main', 'demo', 'web-01')).toBe('hangar-console_main_demo_web-01');
    expect(consolePopupName('my cluster', 'a', 'b')).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
  it('titles', () => {
    expect(consolePopupTitle('web-01', 'vnc')).toBe('web-01 — Console');
    expect(consolePopupTitle('web-01', 'serial')).toBe('web-01 — Serial console');
  });
  it('sizes to the console and centers on the screen', () => {
    expect(consolePopupFeatures('vnc')).toBe('popup=yes,width=1280,height=860');
    expect(consolePopupFeatures('vnc', { availWidth: 1920, availHeight: 1040, availLeft: 0, availTop: 0 })).toBe(
      'popup=yes,width=1280,height=860,left=320,top=90'
    );
    expect(consolePopupFeatures('vnc', { availWidth: 1024, availHeight: 700 })).toContain('width=1024,height=700');
  });
});

describe('openOrFocusPopup', () => {
  const href = '/c/main/hangar-console/demo/web-01/vnc';
  const full = 'http://hl.example/c/main/hangar-console/demo/web-01/vnc';
  it('opens a new window on the console URL', () => {
    const { opener, popup } = fakeWindows();
    const r = openOrFocusPopup(opener as any, href, 'n', 'popup=yes');
    expect(r.result).toBe('opened');
    expect(opener.open).toHaveBeenCalledWith('', 'n', 'popup=yes');
    expect(popup!.location.replace).toHaveBeenCalledWith(full);
    expect(popup!.focus).toHaveBeenCalled();
  });
  it('brings back the open window without reloading it', () => {
    const { opener, popup } = fakeWindows(full);
    expect(openOrFocusPopup(opener as any, href, 'n', '').result).toBe('focused');
    expect(popup!.location.replace).not.toHaveBeenCalled();
  });
  it('switches an open window to the asked kind, unless only focusing', () => {
    const serial = 'http://hl.example/c/main/hangar-console/demo/web-01/serial';
    const a = fakeWindows(serial);
    expect(openOrFocusPopup(a.opener as any, href, 'n', '').result).toBe('switched');
    expect(a.popup!.location.replace).toHaveBeenCalledWith(full);
    const b = fakeWindows(serial);
    expect(openOrFocusPopup(b.opener as any, href, 'n', '', { focusOnly: true }).result).toBe('focused');
    expect(b.popup!.location.replace).not.toHaveBeenCalled();
  });
  it('reports a blocked pop-up', () => {
    const { opener } = fakeWindows(null as any);
    expect(openOrFocusPopup(opener as any, href, 'n', '').result).toBe('blocked');
  });
});

describe('presence', () => {
  it('tracks open and closed windows, and forgets silent ones', () => {
    let seen = applyPresence(new Map(), { type: 'open', key: 'k', kind: 'vnc' }, 1000);
    expect(isOpen(seen, 'k', 1000 + STALE_MS - 1)).toBe(true);
    expect(isOpen(seen, 'k', 1000 + STALE_MS)).toBe(false);
    seen = applyPresence(seen, { type: 'closed', key: 'k' }, 2000);
    expect(isOpen(seen, 'k', 2000)).toBe(false);
    expect(applyPresence(seen, { type: 'query' }, 3000)).toEqual(seen);
  });
});
