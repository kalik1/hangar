/*
 * VM snapshots (VirtualMachineSnapshot) and reverts (VirtualMachineRestore)
 * as a timeline: what each snapshot holds, how consistent it is, and what
 * the cluster is missing when snapshots cannot work.
 */

import { slugName } from './library';
import { Obj } from './types';
import { parseQuantity } from './units';
import { disks } from './vm';

export const A_DISPLAY = 'hangar.magesgate.com/display-name';
export const A_DESCRIPTION = 'description';
export const SNAPSHOT_API = 'snapshot.kubevirt.io/v1beta1';

export type Consistency = 'offline' | 'quiesced' | 'crash' | 'unknown';

export interface SnapshotView {
  name: string;
  displayName: string;
  description?: string;
  created?: string;
  state: { label: string; tone: 'on' | 'busy' | 'fault' | 'standby' };
  ready: boolean;
  online: boolean;
  consistency: Consistency;
  included: string[];
  excluded: string[];
  /** Sum of the disks' sizes it restores, when the volume snapshots report it. */
  sizeBytes?: number;
  error?: string;
  contentName?: string;
  volumeSnapshots: string[];
  obj: Obj;
}

export function consistencyOf(indications: string[] | undefined): Consistency {
  const ind = indications ?? [];
  if (!ind.length) return 'unknown';
  if (!ind.includes('Online')) return 'offline';
  if (ind.includes('QuiesceFailed') || ind.includes('NoGuestAgent')) return 'crash';
  if (ind.includes('GuestAgent')) return 'quiesced';
  return 'crash';
}

export const CONSISTENCY_LABELS: Record<Consistency, { label: string; help: string }> = {
  offline: { label: 'Powered off', help: 'Taken while the VM was off: the disks were at rest.' },
  quiesced: { label: 'Quiesced', help: 'The guest agent froze the file systems while the snapshot was taken.' },
  crash: {
    label: 'Crash-consistent',
    help: 'Taken while running without freezing the guest: like pulling the power cord. File systems recover, open files may not.',
  },
  unknown: { label: 'Unknown', help: 'KubeVirt did not report how the snapshot was taken.' },
};

export function snapshotView(s: Obj, volumeSnapshots: Obj[] = []): SnapshotView {
  const st = s.status ?? {};
  const uid = s.metadata.uid;
  const mine = uid ? volumeSnapshots.filter(v => v.metadata.namespace === s.metadata.namespace && v.metadata.name.startsWith(`vmsnapshot-${uid}-volume-`)) : [];
  const sizes = mine.map(v => parseQuantity(v.status?.restoreSize)).filter(n => isFinite(n));
  const failed = st.phase === 'Failed' || (st.conditions ?? []).some((c: any) => c.type === 'Failure' && c.status === 'True');
  const deleting = !!s.metadata.deletionTimestamp;
  const ready = !!st.readyToUse;
  const state = deleting
    ? { label: 'Deleting', tone: 'busy' as const }
    : failed
    ? { label: 'Failed', tone: 'fault' as const }
    : ready
    ? { label: 'Ready', tone: 'on' as const }
    : st.phase === 'Succeeded'
    ? { label: 'Not usable', tone: 'standby' as const }
    : { label: 'Taking snapshot', tone: 'busy' as const };
  return {
    name: s.metadata.name,
    displayName: s.metadata.annotations?.[A_DISPLAY] || s.metadata.name,
    description: s.metadata.annotations?.[A_DESCRIPTION],
    created: st.creationTime ?? s.metadata.creationTimestamp,
    state,
    ready,
    online: (st.indications ?? []).includes('Online'),
    consistency: consistencyOf(st.indications),
    included: st.snapshotVolumes?.includedVolumes ?? [],
    excluded: st.snapshotVolumes?.excludedVolumes ?? [],
    sizeBytes: sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined,
    error: st.error?.message ?? (st.conditions ?? []).find((c: any) => c.type === 'Failure' && c.status === 'True')?.message,
    contentName: st.virtualMachineSnapshotContentName,
    volumeSnapshots: mine.map(v => v.metadata.name),
    obj: s,
  };
}

/** Why KubeVirt leaves a disk out of snapshots, in plain words. */
export function exclusionReason(reason: string | undefined): string {
  const r = reason ?? '';
  if (/cloudinit/i.test(r)) return 'Cloud-init settings: rebuilt from the VM settings';
  if (/containerdisk/i.test(r)) return 'Container image disk: comes back from the image at each boot';
  if (/configmap|secret|serviceaccount|downward/i.test(r)) return 'Configuration disk: rebuilt from the VM settings';
  if (/emptydisk|ephemeral/i.test(r)) return 'Temporary disk: empty at each boot';
  if (/hostdisk/i.test(r)) return 'Host disk: lives on one host, not snapshotted';
  if (/no volumesnapshotclass|not configured for this storageclass/i.test(r)) return 'Its datastore has no snapshot support';
  if (/no storageclass/i.test(r)) return 'It has no datastore';
  return r || 'Not included';
}

export interface DiskCoverage {
  disk: string;
  included: boolean;
  reason?: string;
  /** Config disks (cloud-init…): leaving them out is expected. */
  config: boolean;
}

/** Which of the VM's disks a snapshot taken now would hold (vm.status.volumeSnapshotStatuses). */
export function diskCoverage(vm: Obj): DiskCoverage[] {
  const st: { name: string; enabled: boolean; reason?: string }[] = vm.status?.volumeSnapshotStatuses ?? [];
  return disks(vm).map(d => {
    const s = st.find(x => x.name === d.name);
    const included = s ? s.enabled : false;
    return {
      disk: d.name,
      included,
      reason: included ? undefined : s ? exclusionReason(s.reason) : 'KubeVirt has not checked this disk yet',
      config: d.config || d.sourceKind === 'containerDisk' || d.sourceKind === 'emptyDisk',
    };
  });
}

export type GateState = 'on' | 'off' | 'unknown';

/** The KubeVirt feature gate as written in the KubeVirt resource (absent may still mean GA). */
export function featureGate(kubevirt: Obj | null | undefined, gate: string): GateState {
  const dc = kubevirt?.spec?.configuration?.developerConfiguration ?? {};
  if ((dc.featureGates ?? []).includes(gate)) return 'on';
  if ((dc.disabledFeatureGates ?? []).includes(gate)) return 'off';
  return 'unknown';
}

export interface Support {
  /** Snapshots can be taken. */
  ok: boolean;
  /** What is missing on the cluster, in words, with the fix. */
  missing: { title: string; fix: string }[];
  /** Disks a snapshot leaves out because their datastore has no snapshot class. */
  uncovered: string[];
}

/**
 * What the cluster lacks for snapshots of this VM. `gate` is the result of
 * the feature gate check (the KubeVirt resource, else a dry-run create).
 */
export function snapshotSupport(p: {
  vmSnapshotApi: boolean;
  volumeSnapshotApi: boolean;
  gate: GateState;
  gateMessage?: string;
  vm: Obj;
  pvcs: Map<string, Obj>;
  storageClasses: Obj[];
  snapshotClasses: Obj[];
}): Support {
  const missing: Support['missing'] = [];
  if (!p.vmSnapshotApi)
    missing.push({
      title: "KubeVirt's snapshot API is not installed",
      fix: 'The VirtualMachineSnapshot resource is missing: install or upgrade KubeVirt.',
    });
  if (!p.volumeSnapshotApi)
    missing.push({
      title: 'The cluster has no volume snapshots',
      fix: 'Install the external-snapshotter CRDs and the snapshot controller (github.com/kubernetes-csi/external-snapshotter), then a VolumeSnapshotClass for your storage driver.',
    });
  if (p.gate === 'off')
    missing.push({
      title: 'Turn on the Snapshot feature of KubeVirt',
      fix: `Add "Snapshot" to spec.configuration.developerConfiguration.featureGates of the KubeVirt resource.${p.gateMessage ? ` KubeVirt says: ${p.gateMessage}` : ''}`,
    });
  const ns = p.vm.metadata.namespace as string;
  const uncovered: string[] = [];
  const classesMissing = new Map<string, string>();
  for (const d of disks(p.vm)) {
    if (!d.claimName) continue;
    const pvc = p.pvcs.get(`${ns}/${d.claimName}`);
    const scName = pvc?.spec?.storageClassName;
    const sc = p.storageClasses.find(s => s.metadata.name === scName);
    if (!sc) continue;
    if (!p.snapshotClasses.some(c => c.driver === sc.provisioner)) {
      uncovered.push(d.name);
      classesMissing.set(sc.metadata.name, sc.provisioner);
    }
  }
  if (p.volumeSnapshotApi)
    for (const [sc, driver] of classesMissing)
      missing.push({
        title: `Datastore ${sc} has no snapshot class`,
        fix: `Create a VolumeSnapshotClass for the driver ${driver}${driver === 'topolvm.io' ? ' (TopoLVM supports snapshots on thin pools)' : ''}. Until then its disks are left out of snapshots.`,
      });
  const blocking = missing.filter(m => !m.title.startsWith('Datastore '));
  const nothingCovered = uncovered.length > 0 && disks(p.vm).filter(d => d.claimName).every(d => uncovered.includes(d.name));
  return { ok: blocking.length === 0 && !nothingCovered, missing, uncovered };
}

/** A snapshot name: "<vm>-<what the user typed>", unique in the namespace. */
export function snapshotName(vmName: string, display: string, taken: Set<string>): string {
  const base = slugName(display || 'snapshot', new Set(), 40);
  const prefix = vmName.slice(0, 20).replace(/-+$/, '');
  return slugName(`${prefix}-${base}`, taken, 63);
}

export function defaultSnapshotLabel(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Snapshot ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

export function snapshotManifest(vm: Obj, name: string, displayName: string, description?: string): Obj {
  return {
    apiVersion: SNAPSHOT_API,
    kind: 'VirtualMachineSnapshot',
    metadata: {
      name,
      namespace: vm.metadata.namespace,
      annotations: {
        [A_DISPLAY]: displayName.trim() || name,
        ...(description?.trim() ? { [A_DESCRIPTION]: description.trim() } : {}),
      },
      labels: { 'hangar.magesgate.com/initiated': 'true' },
    },
    spec: { source: { apiGroup: 'kubevirt.io', kind: 'VirtualMachine', name: vm.metadata.name } },
  };
}

export function restoreManifest(vm: Obj, snapshot: string, name: string): Obj {
  return {
    apiVersion: SNAPSHOT_API,
    kind: 'VirtualMachineRestore',
    metadata: { name, namespace: vm.metadata.namespace, labels: { 'hangar.magesgate.com/initiated': 'true' } },
    spec: {
      target: { apiGroup: 'kubevirt.io', kind: 'VirtualMachine', name: vm.metadata.name },
      virtualMachineSnapshotName: snapshot,
    },
  };
}

export type TimelineEntry =
  | { kind: 'snapshot'; time: string; snap: SnapshotView }
  | { kind: 'revert'; time: string; restore: Obj; snapshot: string; complete: boolean; failed?: string };

/** Snapshots and reverts of a VM, newest first. */
export function timeline(vm: Obj, snapshots: Obj[], restores: Obj[], volumeSnapshots: Obj[] = []): TimelineEntry[] {
  const ns = vm.metadata.namespace;
  const out: TimelineEntry[] = [];
  for (const s of snapshots) {
    if (s.metadata.namespace !== ns || s.spec?.source?.name !== vm.metadata.name) continue;
    const v = snapshotView(s, volumeSnapshots);
    out.push({ kind: 'snapshot', time: v.created ?? '', snap: v });
  }
  for (const r of restores) {
    if (r.metadata.namespace !== ns || r.spec?.target?.name !== vm.metadata.name) continue;
    const fail = (r.status?.conditions ?? []).find((c: any) => (c.type === 'Failure' && c.status === 'True') || (c.type === 'Ready' && c.status === 'False' && /fail|error/i.test(c.reason ?? '')));
    out.push({
      kind: 'revert',
      time: r.status?.restoreTime ?? r.metadata.creationTimestamp ?? '',
      restore: r,
      snapshot: r.spec?.virtualMachineSnapshotName,
      complete: !!r.status?.complete,
      failed: fail?.message,
    });
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

/** A revert in progress for the VM: KubeVirt runs one at a time. */
export function revertInProgress(vm: Obj, restores: Obj[]): Obj | undefined {
  return restores.find(
    r => r.metadata.namespace === vm.metadata.namespace && r.spec?.target?.name === vm.metadata.name && !r.status?.complete && !r.metadata.deletionTimestamp
  );
}
