import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

const mid = () => 0.5; // no jitter

describe('backoffDelay', () => {
  it('doubles from the base delay', () => {
    expect([1, 2, 3, 4].map(n => backoffDelay(n, { random: mid }))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('stops at the maximum', () => {
    expect(backoffDelay(6, { random: mid })).toBe(30000);
    expect(backoffDelay(60, { random: mid })).toBe(30000);
    expect(backoffDelay(3, { random: mid, maxMs: 2500 })).toBe(2500);
  });

  it('spreads delays by the jitter, never above the maximum', () => {
    expect(backoffDelay(2, { random: () => 0 })).toBe(1600);
    expect(backoffDelay(2, { random: () => 1 })).toBe(2400);
    expect(backoffDelay(10, { random: () => 1 })).toBe(30000);
  });

  it('treats attempts below 1 as the first', () => {
    expect(backoffDelay(0, { random: mid })).toBe(1000);
    expect(backoffDelay(-3, { random: mid })).toBe(1000);
  });
});
