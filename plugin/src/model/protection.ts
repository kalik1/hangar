/*
 * Delete protection, like Proxmox's "Protection" option: a VM and its disks
 * labelled hangar.magesgate.com/protected=true cannot be deleted while the
 * ValidatingAdmissionPolicy in distribution/protection-policy.yaml is
 * installed (it refuses DELETE of labelled VirtualMachines, DataVolumes and
 * PVCs, for everyone). The label alone protects nothing: Hangar offers the
 * switch only when the policy and its binding exist.
 *
 * Disks are the VM's disk devices (not CD/DVD media, which are per-VM copies
 * of library ISOs, nor config volumes). New disks of a protected VM get the
 * label through their DataVolume template (CDI copies DataVolume labels to
 * the PVC it creates, and to its temporary claims, which the policy leaves
 * deletable: they carry cdi.kubevirt.io/OwnedByUID).
 */

import { clone } from './edit';
import { Obj, VM } from './types';

export const PROTECTED_LABEL = 'hangar.magesgate.com/protected';
export const PROTECTION_POLICY = 'hangar-protect-from-deletion';
export const PROTECTION_POLICY_URL = 'https://raw.githubusercontent.com/kalik1/hangar/main/distribution/protection-policy.yaml';

export function isProtected(o: Obj | null | undefined): boolean {
  return o?.metadata?.labels?.[PROTECTED_LABEL] === 'true';
}

/** Names of the DataVolumes/PVCs behind the VM's disk devices (not CD/DVD media). */
export function protectedClaims(vm: VM): string[] {
  const t = vm.spec?.template?.spec ?? {};
  const disks: any[] = t.domain?.devices?.disks ?? [];
  const out: string[] = [];
  for (const v of (t.volumes ?? []) as any[]) {
    const d = disks.find(x => x.name === v.name);
    if (d?.cdrom) continue;
    const c = v.dataVolume?.name ?? v.persistentVolumeClaim?.claimName;
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function setLabel(meta: any, on: boolean) {
  meta.labels = { ...(meta.labels ?? {}) };
  if (on) meta.labels[PROTECTED_LABEL] = 'true';
  else delete meta.labels[PROTECTED_LABEL];
  if (!Object.keys(meta.labels).length) delete meta.labels;
}

/** The VM with the label on itself and on the templates of its disks (so disks created later carry it). */
export function withVmProtection(vm: VM, on: boolean): VM {
  const out = clone(vm);
  setLabel(out.metadata, on);
  const claims = protectedClaims(out);
  for (const d of (out.spec?.dataVolumeTemplates ?? []) as any[]) {
    d.metadata ??= {};
    if (claims.includes(d.metadata.name)) setLabel(d.metadata, on);
    else if (!on) setLabel(d.metadata, false);
  }
  return out;
}

/** Why a delete is refused, or undefined. */
export function protectionReason(o: Obj | null | undefined, what = 'It'): string | undefined {
  return isProtected(o) ? `${what} is protected from deletion: turn protection off in Configure → Options first` : undefined;
}

/** The label patch for a DataVolume or PVC. */
export function labelPatch(on: boolean): unknown {
  return { metadata: { labels: { [PROTECTED_LABEL]: on ? 'true' : null } } };
}

export type PolicyState = 'installed' | 'unbound' | 'missing' | 'unknown';

/** The policy state from what the cluster answered for the policy and its binding (null: 404). */
export function policyState(policy: Obj | null | 'forbidden', binding: Obj | null | 'forbidden'): PolicyState {
  if (policy === 'forbidden' || binding === 'forbidden') return 'unknown';
  if (!policy) return 'missing';
  if (!binding) return 'unbound';
  const deny = (binding.spec?.validationActions ?? []).includes('Deny');
  return deny ? 'installed' : 'unbound';
}
