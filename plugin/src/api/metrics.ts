/*
 * Usage history from metrics-server: the virt-launcher pod of each VM (CPU
 * and memory the VM really uses on its host) and each host. Polled every
 * 15 s while Hangar is open; the last 30 minutes are kept in memory so
 * charts have a past when you open a VM.
 */

import React from 'react';
import { parseQuantity } from '../model/units';
import { kreq } from './client';

export interface Sample {
  t: number;
  cpu: number; // cores
  mem: number; // bytes
}

const KEEP_MS = 30 * 60 * 1000;
const EVERY_MS = 15000;

class MetricsStore {
  vms = new Map<string, Sample[]>();
  hosts = new Map<string, Sample[]>();
  available: boolean | null = null;
  version = 0;
  private listeners = new Set<() => void>();
  private users = 0;
  private timer: number | undefined;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;

  start() {
    this.users++;
    if (this.users === 1) {
      this.poll();
      this.timer = window.setInterval(() => this.poll(), EVERY_MS);
    }
    return () => {
      this.users--;
      if (this.users === 0) window.clearInterval(this.timer);
    };
  }

  private push(map: Map<string, Sample[]>, k: string, s: Sample) {
    const arr = (map.get(k) ?? []).filter(x => s.t - x.t < KEEP_MS);
    if (arr.length && arr[arr.length - 1].t === s.t) return;
    arr.push(s);
    map.set(k, arr);
  }

  async poll() {
    try {
      const [pods, nodes] = await Promise.all([
        kreq('/apis/metrics.k8s.io/v1beta1/pods', { query: { labelSelector: 'kubevirt.io=virt-launcher' } }),
        kreq('/apis/metrics.k8s.io/v1beta1/nodes'),
      ]);
      for (const p of pods.items ?? []) {
        const vm = p.metadata.labels?.['vm.kubevirt.io/name'] ?? p.metadata.labels?.['kubevirt.io/domain'];
        if (!vm) continue;
        // The "compute" container runs the guest; the rest is small overhead.
        let cpu = 0;
        let mem = 0;
        for (const c of p.containers ?? []) {
          cpu += parseQuantity(c.usage?.cpu) || 0;
          mem += parseQuantity(c.usage?.memory) || 0;
        }
        this.push(this.vms, `${p.metadata.namespace}/${vm}`, { t: new Date(p.timestamp).getTime() || Date.now(), cpu, mem });
      }
      for (const n of nodes.items ?? []) {
        this.push(this.hosts, n.metadata.name, {
          t: new Date(n.timestamp).getTime() || Date.now(),
          cpu: parseQuantity(n.usage?.cpu) || 0,
          mem: parseQuantity(n.usage?.memory) || 0,
        });
      }
      this.available = true;
    } catch {
      this.available = false;
    }
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const metrics = new MetricsStore();

/** Keeps the poller running while mounted; re-renders on each new sample. */
export function useMetricsPolling() {
  React.useEffect(() => metrics.start(), []);
}

export function useMetrics() {
  React.useSyncExternalStore(metrics.subscribe, metrics.getVersion);
  return metrics;
}

export function last(samples: Sample[] | undefined): Sample | undefined {
  return samples?.[samples.length - 1];
}
