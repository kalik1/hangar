/*
 * Keys for the graphical console: what "Type text" sends for each character
 * and the combinations of the "Send key" menu.
 *
 * KubeVirt's VNC server is QEMU's. noVNC sends it both the X11 keysym and
 * the physical key (QEMU extended key events, `code` below), and QEMU then
 * uses the physical key. So typing is pressing keys on a US keyboard: an
 * upper-case letter or a symbol needs Shift held explicitly, and the guest
 * turns the keys into characters with its own layout (US assumed).
 */

/** One physical key: the X11 keysym and the KeyboardEvent.code noVNC maps to a scancode. */
export interface Key {
  keysym: number;
  code: string;
}

/** A key press for one character: the key, with or without Shift held. */
export interface KeyStroke extends Key {
  shift: boolean;
}

/** One RFB key event. */
export interface KeyEvent extends Key {
  down: boolean;
}

export const KEYS = {
  ShiftLeft: { keysym: 0xffe1, code: 'ShiftLeft' },
  ControlLeft: { keysym: 0xffe3, code: 'ControlLeft' },
  AltLeft: { keysym: 0xffe9, code: 'AltLeft' },
  MetaLeft: { keysym: 0xffeb, code: 'MetaLeft' },
  Tab: { keysym: 0xff09, code: 'Tab' },
  Enter: { keysym: 0xff0d, code: 'Enter' },
  Escape: { keysym: 0xff1b, code: 'Escape' },
  Backspace: { keysym: 0xff08, code: 'Backspace' },
  Delete: { keysym: 0xffff, code: 'Delete' },
  PrintScreen: { keysym: 0xff61, code: 'PrintScreen' },
  Space: { keysym: 0x20, code: 'Space' },
} as const satisfies Record<string, Key>;

/** F1…F12: keysyms are consecutive from 0xffbe. */
export function functionKey(n: number): Key {
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new RangeError(`no F${n} key`);
  return { keysym: 0xffbe + n - 1, code: `F${n}` };
}

/* US layout: the symbol keys, unshifted and shifted character. */
const SYMBOL_KEYS: [code: string, plain: string, shifted: string][] = [
  ['Backquote', '`', '~'],
  ['Digit1', '1', '!'],
  ['Digit2', '2', '@'],
  ['Digit3', '3', '#'],
  ['Digit4', '4', '$'],
  ['Digit5', '5', '%'],
  ['Digit6', '6', '^'],
  ['Digit7', '7', '&'],
  ['Digit8', '8', '*'],
  ['Digit9', '9', '('],
  ['Digit0', '0', ')'],
  ['Minus', '-', '_'],
  ['Equal', '=', '+'],
  ['BracketLeft', '[', '{'],
  ['BracketRight', ']', '}'],
  ['Backslash', '\\', '|'],
  ['Semicolon', ';', ':'],
  ['Quote', "'", '"'],
  ['Comma', ',', '<'],
  ['Period', '.', '>'],
  ['Slash', '/', '?'],
];

const US_LAYOUT: Map<string, KeyStroke> = (() => {
  const m = new Map<string, KeyStroke>();
  for (let c = 0x61; c <= 0x7a; c++) {
    const lower = String.fromCharCode(c);
    const code = `Key${lower.toUpperCase()}`;
    m.set(lower, { keysym: c, code, shift: false });
    m.set(lower.toUpperCase(), { keysym: c - 0x20, code, shift: true });
  }
  for (const [code, plain, shifted] of SYMBOL_KEYS) {
    m.set(plain, { keysym: plain.charCodeAt(0), code, shift: false });
    m.set(shifted, { keysym: shifted.charCodeAt(0), code, shift: true });
  }
  m.set(' ', { ...KEYS.Space, shift: false });
  m.set('\n', { ...KEYS.Enter, shift: false });
  m.set('\t', { ...KEYS.Tab, shift: false });
  return m;
})();

/** The key press that types `ch` on a US keyboard, or null when there is none. */
export function strokeFor(ch: string): KeyStroke | null {
  return US_LAYOUT.get(ch) ?? null;
}

export interface TypingPlan {
  strokes: KeyStroke[];
  /** Characters a US keyboard cannot type, once each, in order of appearance. */
  skipped: string[];
}

/** The key presses that type `text`. Line endings become Enter (CRLF and CR count once). */
export function planTyping(text: string): TypingPlan {
  const normalized = text.replace(/\r\n?/g, '\n');
  const strokes: KeyStroke[] = [];
  const skipped: string[] = [];
  for (const ch of normalized) {
    const s = strokeFor(ch);
    if (s) strokes.push(s);
    else if (!skipped.includes(ch)) skipped.push(ch);
  }
  return { strokes, skipped };
}

/** Key events for one stroke: Shift around the key when needed. */
export function strokeEvents(s: KeyStroke): KeyEvent[] {
  const key = { keysym: s.keysym, code: s.code };
  const press = [
    { ...key, down: true },
    { ...key, down: false },
  ];
  if (!s.shift) return press;
  return [{ ...KEYS.ShiftLeft, down: true }, ...press, { ...KEYS.ShiftLeft, down: false }];
}

/** A combination from the "Send key" menu. */
export interface KeyCombo {
  id: string;
  /** As shown in the menu, e.g. "Ctrl+Alt+F2". */
  label: string;
  /** Pressed in order, released in reverse order. */
  keys: Key[];
}

/** Key events for a combination: press all, release in reverse. */
export function comboEvents(combo: KeyCombo): KeyEvent[] {
  return [
    ...combo.keys.map(k => ({ ...k, down: true })),
    ...[...combo.keys].reverse().map(k => ({ ...k, down: false })),
  ];
}

/** Single keys and shortcuts the browser would keep for itself. */
export const SEND_KEYS: KeyCombo[] = [
  { id: 'alt-tab', label: 'Alt+Tab', keys: [KEYS.AltLeft, KEYS.Tab] },
  { id: 'esc', label: 'Esc', keys: [KEYS.Escape] },
  { id: 'tab', label: 'Tab', keys: [KEYS.Tab] },
  { id: 'enter', label: 'Enter', keys: [KEYS.Enter] },
  { id: 'super', label: 'Super (Windows key)', keys: [KEYS.MetaLeft] },
  { id: 'print', label: 'Print Screen', keys: [KEYS.PrintScreen] },
];

/** Ctrl+Alt+F1…F12: switch the guest's virtual terminal. */
export const VT_KEYS: KeyCombo[] = Array.from({ length: 12 }, (_, i) => ({
  id: `ctrl-alt-f${i + 1}`,
  label: `Ctrl+Alt+F${i + 1}`,
  keys: [KEYS.ControlLeft, KEYS.AltLeft, functionKey(i + 1)],
}));

export const CTRL_ALT_DEL: KeyCombo = {
  id: 'ctrl-alt-del',
  label: 'Ctrl+Alt+Del',
  keys: [KEYS.ControlLeft, KEYS.AltLeft, KEYS.Delete],
};

/** How a character is shown in the "cannot type" list. */
export function describeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return ch;
}
