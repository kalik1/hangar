/*
 * KubeVirt feature gates: turning one on or off (only the featureGates and
 * disabledFeatureGates lists of the KubeVirt resource, read fresh and
 * written with its resourceVersion), and whether the user may. On k4all the
 * gates its ClusterConfig lists are its own (read-only, model/gates.ts
 * k4allKubevirt); k4all keeps the others Hangar sets (union, D2).
 */

import React from 'react';
import { disabledGates, gateState, gateTable, k4allKubevirt, nextGates } from '../model/gates';
import { Obj } from '../model/types';
import { runTask } from './actions';
import { kmerge, kreq } from './client';
import { useHangar } from './data';
import { isK4all } from './k4all';
import { useCan } from './permissions';

/** The API path of the KubeVirt resource, for a GET or a write. */
export const kubevirtPath = (kv: Obj) => `/apis/kubevirt.io/v1/namespaces/${kv.metadata.namespace}/kubevirts/${kv.metadata.name}`;

/** Turns a gate on or off; other gates stay. Retries when the resource changed meanwhile. */
export function setFeatureGate(kv: Obj, name: string, on: boolean) {
  return runTask({ title: `${on ? 'Turn on' : 'Turn off'} ${name}`, target: { kind: 'datacenter', name: 'Features' } }, async () => {
    for (let attempt = 0; ; attempt++) {
      const fresh = await kreq<Obj>(kubevirtPath(kv));
      const next = nextGates(fresh, name, on);
      // A gate k4all's ClusterConfig lists is k4all's: it would put it back.
      const owned = k4allKubevirt(fresh, await isK4all());
      const theirs = [name, ...next.removed].find(g => owned.gatesOn.includes(g) || owned.gatesOff.includes(g));
      if (theirs) throw new Error(`${theirs} is set by k4all: change it in the k4all addon (Settings → Virtualization).`);
      // disabledFeatureGates exists from KubeVirt v1.8: written only where KubeVirt has it.
      const writeDisabled = !!gateTable(fresh)?.disabledList || disabledGates(fresh).length > 0;
      try {
        // A merge patch replaces just these lists; the resourceVersion makes it fail if the resource changed since the read.
        await kmerge(kubevirtPath(fresh), {
          metadata: { resourceVersion: fresh.metadata.resourceVersion },
          spec: {
            configuration: {
              developerConfiguration: { featureGates: next.featureGates, ...(writeDisabled ? { disabledFeatureGates: next.disabledFeatureGates } : {}) },
            },
          },
        });
        return;
      } catch (e: any) {
        if (e?.status !== 409 || attempt >= 2) throw e;
      }
    }
  });
}

/** The user may change the KubeVirt resource. */
export function useCanPatchKubevirt(kv: Obj | null): boolean {
  return useCan(kv ? { verb: 'patch', group: 'kubevirt.io', resource: 'kubevirts', namespace: kv.metadata.namespace as string } : null);
}

export interface GateCheck {
  /** On, off, or null when Hangar cannot tell (then controls stay usable). */
  on: boolean | null;
  /** One line for a disabled control, when off. */
  why?: string;
}

/** A gated control asks this; when the gate is off it is disabled with `why` and a link to the Features page. */
export function useGate(name: string): GateCheck {
  const d = useHangar();
  return React.useMemo(() => {
    if (!d.kubevirt) return { on: null };
    const s = gateState(d.kubevirt, name);
    return s.on === false ? { on: false, why: `KubeVirt's ${name} feature is off` } : { on: s.on };
  }, [d.kubevirt, name]);
}
