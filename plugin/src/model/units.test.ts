import { formatAge, formatBytes, parseQuantity, toQuantity } from './units';

describe('units', () => {
  it('parses Kubernetes quantities', () => {
    expect(parseQuantity('2Gi')).toBe(2 * 2 ** 30);
    expect(parseQuantity('512Mi')).toBe(512 * 2 ** 20);
    expect(parseQuantity('500m')).toBe(0.5);
    expect(parseQuantity('1.5G')).toBe(1.5e9);
    expect(parseQuantity(3)).toBe(3);
    expect(parseQuantity('nope')).toBeNaN();
    expect(parseQuantity(undefined)).toBeNaN();
  });
  it('prints binary sizes', () => {
    expect(formatBytes(2 * 2 ** 30)).toBe('2 GiB');
    expect(formatBytes(1.5 * 2 ** 30)).toBe('1.5 GiB');
    expect(formatBytes(748 * 2 ** 20)).toBe('748 MiB');
    expect(formatBytes(NaN)).toBe('—');
  });
  it('writes whole Gi or Mi quantities', () => {
    expect(toQuantity(10 * 2 ** 30)).toBe('10Gi');
    expect(toQuantity(0.5 * 2 ** 30)).toBe('512Mi');
  });
  it('prints ages', () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    expect(formatAge(now - 40 * 1000, now)).toBe('40s');
    expect(formatAge(now - (2 * 3600 + 14 * 60) * 1000, now)).toBe('2h 14m');
    expect(formatAge(now - (3 * 86400 + 4 * 3600) * 1000, now)).toBe('3d 4h');
  });
});
