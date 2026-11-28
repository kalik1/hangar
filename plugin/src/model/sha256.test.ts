import { createHash } from 'crypto';
import { Sha256, sha256Hex } from './sha256';

const enc = (s: string) => new TextEncoder().encode(s);
const node = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');

describe('sha256', () => {
  it('the FIPS 180-4 vectors', () => {
    expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('the same digest whatever the chunks, around the 55/56/64-byte edges', () => {
    const data = new Uint8Array(3 * 1024 * 1024 + 77);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 9)) & 0xff;
    const want = node(data);
    for (const step of [1 << 20, 128 * 1024, 4097, 63, 64, 65]) {
      const h = new Sha256();
      for (let o = 0; o < data.length; o += step) h.update(data.subarray(o, o + step));
      expect(h.hex()).toBe(want);
    }
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) expect(sha256Hex(data.subarray(0, n))).toBe(node(data.subarray(0, n)));
  });
});
