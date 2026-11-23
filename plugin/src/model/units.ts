/*
 * Kubernetes quantities and how Hangar prints them: bytes in binary units
 * (GiB like every virtualizer), CPU in cores.
 */

const BIN: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};
const DEC: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** Parses a Kubernetes quantity ("2Gi", "500m", "1.5G", 3) into a number. NaN when invalid. */
export function parseQuantity(q: string | number | undefined | null): number {
  if (q === undefined || q === null || q === '') return NaN;
  if (typeof q === 'number') return q;
  const m = String(q)
    .trim()
    .match(/^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([a-zA-Z]*)$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const suffix = m[2];
  if (suffix in BIN) return n * BIN[suffix];
  if (suffix in DEC) return n * DEC[suffix];
  return NaN;
}

/** Bytes as a virtualizer shows them: "512 MiB", "2 GiB", "1.5 TiB". */
export function formatBytes(bytes: number | undefined | null, digits = 1): string {
  if (bytes === undefined || bytes === null || !isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const sign = bytes < 0 ? '-' : '';
  const fixed = v >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(digits);
  return `${sign}${fixed.replace(/\.0+$/, '')} ${units[i]}`;
}

/** CPU cores: "2", "0.5", "250m" → "2 cores"/"0.25 cores"; vCPU counts are integers. */
export function formatCores(cores: number | undefined | null): string {
  if (cores === undefined || cores === null || !isFinite(cores)) return '—';
  if (cores >= 10 || Number.isInteger(cores)) return `${Math.round(cores * 10) / 10}`;
  return cores < 0.1 ? cores.toFixed(2) : cores.toFixed(1);
}

/** A byte size as a Kubernetes quantity the API accepts: whole Gi or Mi. */
export function toQuantity(bytes: number): string {
  if (bytes % BIN.Gi === 0) return `${bytes / BIN.Gi}Gi`;
  return `${Math.ceil(bytes / BIN.Mi)}Mi`;
}

export const GiB = BIN.Gi;
export const MiB = BIN.Mi;

/** "3d 4h", "2h 14m", "5m", "40s" since a date. */
export function formatAge(from: string | number | Date | undefined | null, now = Date.now()): string {
  if (!from) return '—';
  const t = typeof from === 'number' ? from : new Date(from).getTime();
  if (!isFinite(t)) return '—';
  let s = Math.max(0, Math.floor((now - t) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Percent, clamped, for meters. */
export function pct(part: number, whole: number): number {
  if (!whole || !isFinite(part) || !isFinite(whole)) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}
