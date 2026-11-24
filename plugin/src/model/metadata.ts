/*
 * k4all's metadata service (k4all spec §11): an OpenStack/EC2-style server
 * on 169.254.169.254 inside each VM's pod, which k4all injects with an
 * admission policy into the virt-launcher pods of the VMs that ask for it.
 * What Hangar does with it:
 *   - the wizard asks for it: the VM template label
 *     k4all.magesgate.com/metadata: enabled, the chassis asset tag cloud-init
 *     looks for ("OpenStack Nova": without it cloud-init in the guest never
 *     asks), and optionally the ServiceAccount whose tokens the guest gets
 *     (label k4all.magesgate.com/service-account; default: the folder's
 *     "default");
 *   - the VM page says whether the VM gets it, what it serves, and why not.
 *
 * Whether the service is on comes from k4all's ClusterConfig
 * (spec.features.virt.metadata: enabled, scope Labelled or All): the API k4all
 * publishes, not the admission policy's name, which is k4all's own detail.
 * The policy is not injected where it cannot work: VMs without a pod network
 * (NAT) adapter, and namespaces whose PodSecurity enforces baseline or
 * restricted (its redirect needs NET_ADMIN; those VMs keep their cloud-init
 * disk, D8). When k4all skips a labelled VM it says so in an Event on the
 * VM (reason starting with "Metadata", from a k4all component).
 */

import { Obj } from './types';

export const L_METADATA = 'k4all.magesgate.com/metadata';
export const METADATA_ENABLED = 'enabled';
/** With scope All, the label value that keeps a VM out of the service. */
export const METADATA_DISABLED = 'disabled';
export const L_SERVICE_ACCOUNT = 'k4all.magesgate.com/service-account';
/** The chassis asset tag that makes cloud-init's ds-identify look for an OpenStack metadata service. */
export const CHASSIS_ASSET = 'OpenStack Nova';
export const PSA_ENFORCE = 'pod-security.kubernetes.io/enforce';
/** The audience k4all serves tokens for when the ClusterConfig names none. */
export const DEFAULT_AUDIENCE = 'k4all-metadata';
/** The ClusterConfig condition type the operator reports the service in. */
export const METADATA_CONDITION = 'MetadataService';

export interface MetadataService {
  enabled: boolean;
  scope: 'Labelled' | 'All';
  /** Token audiences; empty: the operator's default. */
  audiences: string[];
  /** The MetadataService condition, when the operator reports one. */
  condition?: { status: string; reason?: string; message?: string };
}

/** k4all's metadata service settings from its ClusterConfig; null without one. */
export function metadataService(cc: Obj | null | undefined): MetadataService | null {
  if (!cc) return null;
  const m = cc.spec?.features?.virt?.metadata ?? {};
  const cond = (cc.status?.conditions ?? []).find((c: any) => c?.type === METADATA_CONDITION);
  const out: MetadataService = {
    enabled: m.enabled === true,
    scope: m.scope === 'All' ? 'All' : 'Labelled',
    audiences: Array.isArray(m.tokens?.audiences) ? m.tokens.audiences.filter((a: unknown) => typeof a === 'string' && a) : [],
  };
  if (cond) out.condition = { status: String(cond.status), ...(cond.reason ? { reason: cond.reason } : {}), ...(cond.message ? { message: cond.message } : {}) };
  return out;
}

/**
 * Whether a new VM asks for the service: the user's pick, else on when
 * k4all's service is on (D10); never without k4all.
 */
export function metadataChoice(k4all: boolean, service: MetadataService | null | 'unknown' | undefined, picked: boolean | null): boolean {
  if (!k4all) return false;
  if (picked !== null) return picked;
  return !!service && service !== 'unknown' && service.enabled;
}

/**
 * A ServiceAccount name usable in the label: a DNS subdomain that is also a
 * label value (at most 63 characters). '' is the folder's default.
 */
export function serviceAccountProblem(name: string): string | null {
  if (!name) return null;
  if (name.length > 63) return 'A label holds at most 63 characters: pick a ServiceAccount with a shorter name.';
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) return 'Use lowercase letters, digits, dots and hyphens; start and end with a letter or digit.';
  return null;
}

/**
 * A VM spec that asks for the metadata service: the template label, the
 * ServiceAccount label (none for '' or "default", which k4all uses
 * anyway) and the chassis asset tag, unless the VM sets its own chassis.
 */
export function withMetadata(spec: any, o: { serviceAccount?: string }): any {
  const out = JSON.parse(JSON.stringify(spec ?? {}));
  const tpl = out.template ?? (out.template = {});
  const meta = tpl.metadata ?? (tpl.metadata = {});
  meta.labels = { ...(meta.labels ?? {}), [L_METADATA]: METADATA_ENABLED };
  const sa = o.serviceAccount?.trim();
  if (sa && sa !== 'default') meta.labels[L_SERVICE_ACCOUNT] = sa;
  const tspec = tpl.spec ?? (tpl.spec = {});
  const domain = tspec.domain ?? (tspec.domain = {});
  if (!domain.chassis?.asset) domain.chassis = { ...(domain.chassis ?? {}), asset: CHASSIS_ASSET };
  return out;
}

const tplLabels = (vm: Obj): Record<string, string> => vm.spec?.template?.metadata?.labels ?? {};

/** The VM template asks for the service. */
export const asksForMetadata = (vm: Obj) => tplLabels(vm)[L_METADATA] === METADATA_ENABLED;

/** The VM template opts out of a scope All service. */
const optsOut = (vm: Obj) => tplLabels(vm)[L_METADATA] === METADATA_DISABLED;

/**
 * Whether k4all's service is meant for the VM: on, and the VM asks for it
 * (scope Labelled) or does not opt out (scope All). When Hangar cannot read
 * k4all's settings, only a VM that asks counts. Where the service cannot
 * reach the VM (no NAT adapter, PodSecurity) is metadataVerdict's business.
 */
export function usesMetadata(vm: Obj, service: MetadataService | null | 'unknown' | undefined): boolean {
  if (service === 'unknown') return asksForMetadata(vm);
  if (!service?.enabled) return false;
  return service.scope === 'All' ? !optsOut(vm) : asksForMetadata(vm);
}

/**
 * A chassis asset tag of the user's on a VM that uses the service: cloud-init
 * looks for an OpenStack metadata service only when the tag is "OpenStack
 * Nova" (k4all sets it when the VM has none), so with any other tag the guest
 * never asks. null when the tag is fine.
 */
export function chassisAssetWarning(asset: string | undefined, vm: Obj, service: MetadataService | null | 'unknown' | undefined): string | null {
  const tag = (asset ?? '').trim();
  if (!tag || tag === CHASSIS_ASSET || !usesMetadata(vm, service)) return null;
  return `This VM gets k4all's metadata service, but with the asset tag "${tag}" cloud-init in the guest does not find the OpenStack datasource: it looks for one only when the tag is "${CHASSIS_ASSET}". Leave the tag empty (k4all sets it) or use "${CHASSIS_ASSET}".`;
}

const evTime = (e: Obj) => e.lastTimestamp ?? e.eventTime ?? e.series?.lastObservedTime ?? e.metadata?.creationTimestamp ?? '';

/** The newest Event k4all wrote on the VM about its metadata service. */
export function metadataEvent(events: Obj[], vm: Obj): Obj | undefined {
  const from = (e: Obj) => String(e.reportingController ?? e.reportingComponent ?? e.source?.component ?? '');
  return events
    .filter(
      e =>
        e.involvedObject?.kind === 'VirtualMachine' &&
        e.involvedObject?.name === vm.metadata.name &&
        (e.involvedObject?.namespace ?? e.metadata?.namespace) === vm.metadata.namespace &&
        /^Metadata/.test(String(e.reason ?? '')) &&
        from(e).includes('k4all')
    )
    .sort((a, b) => evTime(b).localeCompare(evTime(a)))[0];
}

export type MetadataState = 'on' | 'off' | 'not-asked' | 'skipped' | 'unknown';

export interface MetadataVerdict {
  state: MetadataState;
  /** One sentence: why it is on, off or skipped. */
  why: string;
  /** What the guest gets when on. */
  serves: string[];
  /** Things to know. */
  notes: string[];
  /** The ServiceAccount whose tokens the guest gets. */
  serviceAccount: string;
  asked: boolean;
}

export interface MetadataInput {
  vm: Obj;
  /** The VM's namespace (its PodSecurity labels), when readable. */
  namespace?: Obj;
  /** k4all's settings; 'unknown' when Hangar cannot read them. */
  service: MetadataService | null | 'unknown';
  /** Events of the VM's namespace (or of the VM). */
  events: Obj[];
  /** ServiceAccounts of the namespace; null when Hangar cannot list them. */
  serviceAccounts?: string[] | null;
}

const hasCloudInitDisk = (vm: Obj) => (vm.spec?.template?.spec?.volumes ?? []).some((v: any) => v?.cloudInitNoCloud || v?.cloudInitConfigDrive);

/** Whether the VM gets k4all's metadata service, what it serves, and why not. */
export function metadataVerdict(i: MetadataInput): MetadataVerdict {
  const { vm, service } = i;
  const asked = asksForMetadata(vm);
  const sa = tplLabels(vm)[L_SERVICE_ACCOUNT] || 'default';
  const base = { serves: [] as string[], notes: [] as string[], serviceAccount: sa, asked };
  if (service === 'unknown')
    return {
      ...base,
      state: 'unknown',
      why: `${asked ? 'The VM asks for it' : 'The VM does not ask for it'}, but Hangar cannot read k4all's settings (ClusterConfig) to tell whether the service is on.`,
    };
  if (!service?.enabled)
    return { ...base, state: 'off', why: `k4all's metadata service is off in this datacenter${asked ? ': the VM asks for it and gets it once it is turned on' : ''}.` };
  if (service.scope === 'Labelled' && !asked) return { ...base, state: 'not-asked', why: `The VM does not ask for it (no ${L_METADATA}: ${METADATA_ENABLED} label on its template).` };
  if (service.scope === 'All' && optsOut(vm)) return { ...base, state: 'not-asked', why: `The VM opts out of it (label ${L_METADATA}: ${METADATA_DISABLED} on its template).` };
  const ifaces: any[] = vm.spec?.template?.spec?.domain?.devices?.interfaces ?? [];
  if (ifaces.length && !ifaces.some(x => x?.masquerade))
    return { ...base, state: 'skipped', why: 'It has no pod network (NAT) adapter: the service is reached through the pod network only.' };
  const level = i.namespace?.metadata?.labels?.[PSA_ENFORCE];
  if (level === 'baseline' || level === 'restricted') {
    const notes = hasCloudInitDisk(vm) ? [] : ['This VM has no cloud-init disk either: its guest gets no hostname, user or keys from Kubernetes.'];
    return {
      ...base,
      notes,
      state: 'skipped',
      why: `Folder ${vm.metadata.namespace} enforces PodSecurity ${level}, which forbids what the service needs (NET_ADMIN): k4all does not inject it there, and the VM keeps its cloud-init disk.`,
    };
  }
  const ev = metadataEvent(i.events, vm);
  if (ev?.type === 'Warning') return { ...base, state: 'skipped', why: `k4all: ${ev.message ?? ev.reason}` };
  const audiences = service.audiences.length ? service.audiences : [DEFAULT_AUDIENCE];
  const serves = [
    `instance-id ${vm.metadata.uid ?? '(the VM’s UID)'} (the VM’s UID)`,
    'hostname, SSH keys and user-data from the VM’s cloud-init settings',
    `tokens for ${audiences.join(', ')} as ServiceAccount ${sa}`,
  ];
  const notes: string[] = [];
  const tagWarning = chassisAssetWarning(vm.spec?.template?.spec?.domain?.chassis?.asset, vm, service);
  if (tagWarning) notes.push(tagWarning);
  if (i.serviceAccounts && !i.serviceAccounts.includes(sa)) notes.push(`ServiceAccount ${sa} does not exist in ${vm.metadata.namespace}: the VM cannot start until it does.`);
  if (service.condition && service.condition.status !== 'True')
    notes.push(`k4all reports the service as not ready${service.condition.message ? `: ${service.condition.message}` : service.condition.reason ? ` (${service.condition.reason})` : ''}.`);
  return { ...base, serves, notes, state: 'on', why: service.scope === 'All' ? 'k4all serves every VM of the datacenter (scope All).' : 'The VM asks for it.' };
}
