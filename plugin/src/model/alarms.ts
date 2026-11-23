/*
 * Alarms: what needs a person, computed from the live inventory. Each says
 * what is wrong and where to look.
 */

import { hostState } from './inventory';
import { Obj } from './types';
import { key, pendingRestart, powerState } from './vm';

export type Severity = 'critical' | 'warning' | 'info';

export interface Alarm {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  target: { kind: 'vm' | 'host' | 'disk' | 'platform'; namespace?: string; name: string };
}

export interface AlarmInput {
  vms: Obj[];
  vmiIdx: Map<string, Obj>;
  nodes: Obj[];
  dvs: Obj[];
  pvcs: Obj[];
  migrations: Obj[];
  kubevirt: Obj | null;
  now?: number;
}

const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function alarms(i: AlarmInput): Alarm[] {
  const now = i.now ?? Date.now();
  const out: Alarm[] = [];
  const kvPhase = i.kubevirt?.status?.phase;
  if (i.kubevirt && kvPhase && kvPhase !== 'Deployed') {
    out.push({
      id: 'kubevirt',
      severity: 'critical',
      title: `Virtualization is ${kvPhase.toLowerCase()}`,
      detail: 'KubeVirt is not fully deployed: new VMs may not start.',
      target: { kind: 'platform', name: 'KubeVirt' },
    });
  }
  for (const n of i.nodes) {
    const s = hostState(n);
    if (!s.ready)
      out.push({
        id: `host-${n.metadata.name}`,
        severity: 'critical',
        title: `${n.metadata.name} is not responding`,
        detail: 'VMs on it may be down. They restart elsewhere if their power policy says so.',
        target: { kind: 'host', name: n.metadata.name },
      });
    else if (s.maintenance)
      out.push({
        id: `maint-${n.metadata.name}`,
        severity: 'info',
        title: `${n.metadata.name} is in maintenance mode`,
        detail: 'No VM starts on it until it exits maintenance.',
        target: { kind: 'host', name: n.metadata.name },
      });
  }
  for (const vm of i.vms) {
    const p = powerState(vm, i.vmiIdx.get(key(vm)));
    const t = { kind: 'vm' as const, namespace: vm.metadata.namespace, name: vm.metadata.name };
    if (p.tone === 'fault')
      out.push({ id: `vm-${key(vm)}`, severity: 'critical', title: `${vm.metadata.name}: ${p.label}`, detail: p.detail, target: t });
    const r = pendingRestart(vm);
    if (r && (p.kind === 'on' || p.kind === 'paused'))
      out.push({ id: `restart-${key(vm)}`, severity: 'info', title: `${vm.metadata.name} waits for a restart`, detail: r, target: t });
  }
  for (const dv of i.dvs) {
    if (dv.status?.phase === 'Failed')
      out.push({
        id: `dv-${key(dv)}`,
        severity: 'warning',
        title: `Disk ${dv.metadata.name} could not be prepared`,
        detail: (dv.status?.conditions ?? []).find((c: any) => c.type === 'Running')?.message,
        target: { kind: 'disk', namespace: dv.metadata.namespace, name: dv.metadata.name },
      });
    const restarts = Number(dv.status?.restartCount ?? 0);
    if (dv.status?.phase !== 'Succeeded' && restarts >= 3)
      out.push({
        id: `dvr-${key(dv)}`,
        severity: 'warning',
        title: `Import of ${dv.metadata.name} keeps failing`,
        detail: `${restarts} attempts so far`,
        target: { kind: 'disk', namespace: dv.metadata.namespace, name: dv.metadata.name },
      });
  }
  for (const pvc of i.pvcs) {
    const age = now - new Date(pvc.metadata.creationTimestamp ?? now).getTime();
    if (pvc.status?.phase === 'Pending' && age > 10 * 60 * 1000 && !pvc.metadata.name.startsWith('prime-'))
      out.push({
        id: `pvc-${key(pvc)}`,
        severity: 'warning',
        title: `Disk ${pvc.metadata.name} has no storage yet`,
        detail: 'Pending for more than 10 minutes: the datastore may be full or unreachable.',
        target: { kind: 'disk', namespace: pvc.metadata.namespace, name: pvc.metadata.name },
      });
  }
  for (const m of i.migrations) {
    const at = new Date(m.status?.phaseTransitionTimestamps?.slice(-1)?.[0]?.phaseTransitionTimestamp ?? m.metadata.creationTimestamp ?? 0).getTime();
    if (m.status?.phase === 'Failed' && now - at < 60 * 60 * 1000)
      out.push({
        id: `mig-${key(m)}`,
        severity: 'warning',
        title: `Migration of ${m.spec?.vmiName} failed`,
        detail: m.status?.migrationState?.failureReason,
        target: { kind: 'vm', namespace: m.metadata.namespace, name: m.spec?.vmiName },
      });
  }
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.title.localeCompare(b.title));
}
