/* Delays between reconnection attempts: exponential, capped, with jitter. */

export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs?: number;
  /** Longest delay. */
  maxMs?: number;
  /** Random spread, as a fraction of the delay (0.2 = ±20%). */
  jitter?: number;
  /** For tests. */
  random?: () => number;
}

/** Delay before retry number `attempt` (1-based): base, 2×base, 4×base… up to max, ± jitter. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = 30000, jitter = 0.2, random = Math.random } = opts;
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
  const spread = raw * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(maxMs, raw + spread)));
}
