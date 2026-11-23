import fs from 'fs';
import path from 'path';
import { ICONS } from './icons.generated';

/** The mdi: names in the plugin's sources (same rule as scripts/gen-icons.mjs). */
function used(dir: string, out = new Set<string>()): Set<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) used(full, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.') && e.name !== 'icons.generated.ts') {
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/mdi:([a-z0-9]+(?:-[a-z0-9]+)*)/g)) out.add(m[1]);
    }
  }
  return out;
}

// The generated list must be current: `npm run icons` (also run by build and start).
describe('offline icons', () => {
  it('bundles every mdi icon the sources use', () => {
    const names = [...used(path.resolve('src'))];
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter(n => !ICONS[n])).toEqual([]);
  });
});
