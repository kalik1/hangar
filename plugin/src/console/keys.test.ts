import { describe, expect, it } from 'vitest';
import {
  comboEvents,
  CTRL_ALT_DEL,
  describeChar,
  functionKey,
  KEYS,
  planTyping,
  SEND_KEYS,
  strokeEvents,
  strokeFor,
  VT_KEYS,
} from './keys';

describe('strokeFor (US layout)', () => {
  it('types lower-case letters without Shift', () => {
    expect(strokeFor('a')).toEqual({ keysym: 0x61, code: 'KeyA', shift: false });
    expect(strokeFor('z')).toEqual({ keysym: 0x7a, code: 'KeyZ', shift: false });
  });

  it('types upper-case letters with Shift on the same key', () => {
    expect(strokeFor('A')).toEqual({ keysym: 0x41, code: 'KeyA', shift: true });
    expect(strokeFor('Q')).toEqual({ keysym: 0x51, code: 'KeyQ', shift: true });
  });

  it('types digits and their shifted symbols', () => {
    expect(strokeFor('1')).toEqual({ keysym: 0x31, code: 'Digit1', shift: false });
    expect(strokeFor('!')).toEqual({ keysym: 0x21, code: 'Digit1', shift: true });
    expect(strokeFor('0')).toEqual({ keysym: 0x30, code: 'Digit0', shift: false });
    expect(strokeFor(')')).toEqual({ keysym: 0x29, code: 'Digit0', shift: true });
    expect(strokeFor('@')?.code).toBe('Digit2');
    expect(strokeFor('^')?.code).toBe('Digit6');
  });

  it('types punctuation keys, shifted and not', () => {
    const cases: [string, string, boolean][] = [
      ['-', 'Minus', false],
      ['_', 'Minus', true],
      ['=', 'Equal', false],
      ['+', 'Equal', true],
      ['[', 'BracketLeft', false],
      ['{', 'BracketLeft', true],
      [']', 'BracketRight', false],
      ['}', 'BracketRight', true],
      ['\\', 'Backslash', false],
      ['|', 'Backslash', true],
      [';', 'Semicolon', false],
      [':', 'Semicolon', true],
      ["'", 'Quote', false],
      ['"', 'Quote', true],
      [',', 'Comma', false],
      ['<', 'Comma', true],
      ['.', 'Period', false],
      ['>', 'Period', true],
      ['/', 'Slash', false],
      ['?', 'Slash', true],
      ['`', 'Backquote', false],
      ['~', 'Backquote', true],
    ];
    for (const [ch, code, shift] of cases) {
      expect(strokeFor(ch), ch).toEqual({ keysym: ch.charCodeAt(0), code, shift });
    }
  });

  it('types space, newline and tab as their keys', () => {
    expect(strokeFor(' ')).toEqual({ keysym: 0x20, code: 'Space', shift: false });
    expect(strokeFor('\n')).toEqual({ keysym: 0xff0d, code: 'Enter', shift: false });
    expect(strokeFor('\t')).toEqual({ keysym: 0xff09, code: 'Tab', shift: false });
  });

  it('has no key for characters outside the US layout', () => {
    expect(strokeFor('é')).toBeNull();
    expect(strokeFor('€')).toBeNull();
    expect(strokeFor('\u0007')).toBeNull();
  });

  it('covers every printable ASCII character', () => {
    for (let c = 0x20; c < 0x7f; c++) {
      expect(strokeFor(String.fromCharCode(c)), `char ${c}`).not.toBeNull();
    }
  });
});

describe('planTyping', () => {
  it('turns text into strokes', () => {
    const plan = planTyping('Hi!');
    expect(plan.skipped).toEqual([]);
    expect(plan.strokes.map(s => [s.code, s.shift])).toEqual([
      ['KeyH', true],
      ['KeyI', false],
      ['Digit1', true],
    ]);
  });

  it('turns CRLF, CR and LF into one Enter each', () => {
    const codes = planTyping('a\r\nb\rc\nd').strokes.map(s => s.code);
    expect(codes).toEqual(['KeyA', 'Enter', 'KeyB', 'Enter', 'KeyC', 'Enter', 'KeyD']);
  });

  it('lists characters it cannot type once, and types the rest', () => {
    const plan = planTyping('café é ü');
    expect(plan.skipped).toEqual(['é', 'ü']);
    expect(plan.strokes.map(s => s.code)).toEqual(['KeyC', 'KeyA', 'KeyF', 'Space', 'Space']);
  });

  it('treats astral characters as one character', () => {
    const plan = planTyping('a😀b');
    expect(plan.skipped).toEqual(['😀']);
    expect(plan.strokes).toHaveLength(2);
  });
});

describe('key events', () => {
  it('presses and releases a plain key', () => {
    expect(strokeEvents({ keysym: 0x61, code: 'KeyA', shift: false })).toEqual([
      { keysym: 0x61, code: 'KeyA', down: true },
      { keysym: 0x61, code: 'KeyA', down: false },
    ]);
  });

  it('holds Shift around a shifted key', () => {
    const ev = strokeEvents({ keysym: 0x41, code: 'KeyA', shift: true });
    expect(ev.map(e => `${e.code}${e.down ? '↓' : '↑'}`)).toEqual([
      'ShiftLeft↓',
      'KeyA↓',
      'KeyA↑',
      'ShiftLeft↑',
    ]);
  });

  it('presses a combination in order and releases it in reverse', () => {
    expect(comboEvents(CTRL_ALT_DEL).map(e => `${e.code}${e.down ? '↓' : '↑'}`)).toEqual([
      'ControlLeft↓',
      'AltLeft↓',
      'Delete↓',
      'Delete↑',
      'AltLeft↑',
      'ControlLeft↑',
    ]);
  });

  it('offers Ctrl+Alt+F1…F12 with the right function keys', () => {
    expect(VT_KEYS).toHaveLength(12);
    expect(VT_KEYS[0].label).toBe('Ctrl+Alt+F1');
    expect(VT_KEYS[0].keys[2]).toEqual({ keysym: 0xffbe, code: 'F1' });
    expect(VT_KEYS[11].keys[2]).toEqual({ keysym: 0xffc9, code: 'F12' });
  });

  it('offers the single keys the browser keeps for itself', () => {
    expect(SEND_KEYS.map(k => k.label)).toEqual([
      'Alt+Tab',
      'Esc',
      'Tab',
      'Enter',
      'Super (Windows key)',
      'Print Screen',
    ]);
    expect(SEND_KEYS.find(k => k.id === 'super')?.keys).toEqual([KEYS.MetaLeft]);
  });

  it('rejects function keys that do not exist', () => {
    expect(() => functionKey(0)).toThrow();
    expect(() => functionKey(13)).toThrow();
  });
});

describe('describeChar', () => {
  it('shows control characters as code points', () => {
    expect(describeChar('\u0007')).toBe('U+0007');
    expect(describeChar('é')).toBe('é');
  });
});
