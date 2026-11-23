/*
 * KubeVirt feature gates: turning one on or off (only the featureGates and
 * disabledFeatureGates lists of the KubeVirt resource, read fresh and
 * written with its resourceVersion), whether the user may, and whether k4all runs the
 * cluster (it will manage KubeVirt's features from its own addon).
 */

import React from 'react';
import { disabledGates, gateState, gateTable, nextGates } from '../model/gates';
import { Obj } from '../model/types';
import { runTask } from './actions';
import { currentCluster, kmerge, kreq } from './client';
import { useHangar } from './data';
import { useCan } from './permissions';

const kvPath = (kv: Obj) => `/apis/kubevirt.io/v1/namespaces/${kv.metadata.namespace}/kubevirts/${kv.metadata.name}`;

/** Turns a gate on or off; other gates stay. Retries when the resource changed meanwhile. */
export function setFeatureGate(kv: Obj, name: string, on: boolean) {
  return runTask({ title: `${on ? 'Turn on' : 'Turn off'} ${name}`, target: { kind: 'datacenter', name: 'Features' } }, async () => {
    for (let attempt = 0; ; attempt++) {
      const fresh = await kreq<Obj>(kvPath(kv));
      const next = nextGates(fresh, name, on);
      // disabledFeatureGates exists from KubeVirt v1.8: written only where KubeVirt has it.
      const writeDisabled = !!gateTable(fresh)?.disabledList || disabledGates(fresh).length > 0;
      try {
        // A merge patch replaces just these lists; the resourceVersion makes it fail if the resource changed since the read.
        await kmerge(kvPath(fresh), {
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

const k4allCache = new Map<string, Promise<boolean>>();

/** k4all runs this cluster: its API group (clusterconfigs.k4all.magesgate.com) is served. */
export function useK4all(): boolean {
  const [on, setOn] = React.useState(false);
  const cluster = currentCluster();
  React.useEffect(() => {
    let alive = true;
    let p = k4allCache.get(cluster);
    if (!p) {
      // Discovery is open to every authenticated user: 200 when the group exists.
      p = kreq('/apis/k4all.magesgate.com').then(
        () => true,
        (e: any) => e?.status === 403
      );
      k4allCache.set(cluster, p);
    }
    p.then(v => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, [cluster]);
  return on;
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
