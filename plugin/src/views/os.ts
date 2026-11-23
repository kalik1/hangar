/* The guest OS of a VM with every hint Hangar has, including the library image it came from. */
import { HangarData } from '../api/data';
import { Obj } from '../model/types';
import { GuestOs, guestOs, key, osFromSources } from '../model/vm';

const cache = new WeakMap<Obj[], Map<string, string>>();

function imageOs(d: HangarData): Map<string, string> {
  let m = cache.get(d.dvs);
  if (!m) {
    m = new Map();
    for (const o of [...d.dvs, ...d.pvcs]) {
      const os = o.metadata.annotations?.['hangar.magesgate.com/os'];
      if (os) m.set(`${o.metadata.namespace}/${o.metadata.name}`, os);
    }
    cache.set(d.dvs, m);
  }
  return m;
}

export function vmOs(vm: Obj, d: HangarData): GuestOs {
  return guestOs(vm, d.idx.vmi.get(key(vm)), osFromSources(vm, imageOs(d)));
}
