/*
 * Clipboard sharing between the browser and a VM's graphical console.
 *
 * QEMU's VNC server shares the clipboard when the guest has a qemu-vdagent
 * port with copy/paste on and runs the SPICE agent (spice-vdagent). KubeVirt
 * has no field for it, so Hangar adds the port with a KubeVirt hook sidecar
 * (feature gate "Sidecar"): KubeVirt's sidecar-shim image runs a small
 * script, kept in a ConfigMap in the VM's folder, when the domain is defined.
 * KubeVirt re-reads the hook's XML into its own types and drops
 * <channel><source><clipboard/>, so the script adds the port as QEMU
 * arguments, which KubeVirt keeps.
 */

import { Obj } from './types';

export const HOOK_ANNOTATION = 'hooks.kubevirt.io/hookSidecars';
export const CLIPBOARD_HOOK_CM = 'hangar-clipboard-hook';
export const CLIPBOARD_HOOK_KEY = 'onDefineDomain.sh';
export const CLIPBOARD_HOOK_PATH = '/usr/bin/onDefineDomain';
export const SIDECAR_GATE = 'Sidecar';

/**
 * The onDefineDomain hook. The port is a JSON -device because QEMU creates
 * JSON devices after the classic ones and libvirt declares the virtio-serial
 * controller in JSON. mouse=off: the agent shares the clipboard only, the
 * pointer stays the USB tablet (with the agent's mouse, clicks got lost).
 */
export const CLIPBOARD_HOOK_SCRIPT = `#!/bin/sh
# Hangar clipboard sharing: a KubeVirt onDefineDomain hook (sidecar-shim, ConfigMap script).
# Gives the guest a qemu-vdagent port with copy/paste, so QEMU's VNC server and
# spice-vdagent in the guest share the clipboard. Prints the domain XML.
dom=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) dom="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$dom" in
  *hangarvdagent*) printf '%s' "$dom"; exit 0 ;;
esac
args=$(cat <<'XML'
<qemu:arg value="-chardev"/><qemu:arg value="qemu-vdagent,id=hangarvdagent,name=vdagent,clipboard=on,mouse=off"/><qemu:arg value="-device"/><qemu:arg value='{"driver":"virtserialport","bus":"virtio-serial0.0","nr":30,"chardev":"hangarvdagent","id":"hangarvdagentport","name":"com.redhat.spice.0"}'/>
XML
)
case "$dom" in
  *xmlns:qemu=*) ;;
  *) dom=$(printf '%s' "$dom" | sed '0,/<domain /s|<domain |<domain xmlns:qemu="http://libvirt.org/schemas/domain/qemu/1.0" |') ;;
esac
case "$dom" in
  *"</qemu:commandline>"*) printf '%s' "$dom" | sed "s|</qemu:commandline>|$args</qemu:commandline>|" ;;
  *) printf '%s' "$dom" | sed "s|</domain>|<qemu:commandline>$args</qemu:commandline></domain>|" ;;
esac
`;

export interface Sidecar {
  args?: string[];
  image?: string;
  configMap?: { name?: string; key?: string; hookPath?: string };
  [key: string]: unknown;
}

/** The hook sidecars in an annotation value; null when it is not a JSON list (left alone). */
export function parseSidecars(value: string | undefined): Sidecar[] | null {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? (v as Sidecar[]) : null;
  } catch {
    return null;
  }
}

export function isClipboardSidecar(s: Sidecar): boolean {
  return s?.configMap?.name === CLIPBOARD_HOOK_CM;
}

function hasClipboardHook(annotations: Record<string, string> | undefined): boolean {
  return (parseSidecars(annotations?.[HOOK_ANNOTATION]) ?? []).some(isClipboardSidecar);
}

/** The VM asks for clipboard sharing (its template carries the hook). */
export function clipboardOnVm(vm: Obj | null | undefined): boolean {
  return hasClipboardHook(vm?.spec?.template?.metadata?.annotations);
}

/** The running instance was started with the hook. */
export function clipboardOnVmi(vmi: Obj | null | undefined): boolean {
  return hasClipboardHook(vmi?.metadata?.annotations);
}

/**
 * QEMU refuses to migrate a VM with the qemu-vdagent port (a migration
 * blocker KubeVirt does not know of: its LiveMigratable stays True). So a
 * VM started with the clipboard on moves to another host only powered off,
 * until it is powered off and on with the clipboard off.
 */
export const CLIPBOARD_NOT_LIVE_MIGRATABLE = 'ClipboardNotLiveMigratable';
export const CLIPBOARD_NOT_LIVE_WHY =
  'Clipboard sharing was on when it started, and QEMU cannot move the clipboard port: it cannot move while running. Turn the clipboard off and power the VM off and on to move it live.';
/** What turning the clipboard on costs, said before it is turned on. */
export const CLIPBOARD_MOVE_NOTE =
  'While it is on, the VM cannot move to another host while running (Migrate, maintenance mode, live disk moves): QEMU cannot move the clipboard port. It moves powered off.';

/**
 * What the console can do: 'shared' (the running VM has the port), 'pending'
 * (on, from the next power-on), 'off-pending' (turned off, the running VM
 * still has it), 'none'.
 */
export type ClipboardMode = 'shared' | 'pending' | 'off-pending' | 'none';

export function clipboardMode(vm: Obj | null | undefined, vmi: Obj | null | undefined): ClipboardMode {
  const wanted = clipboardOnVm(vm);
  const running = !!vmi && clipboardOnVmi(vmi);
  if (running) return wanted ? 'shared' : 'off-pending';
  if (wanted) return vmi ? 'pending' : 'shared';
  return 'none';
}

/** KubeVirt's sidecar-shim image for the cluster's KubeVirt version. */
export function sidecarImage(kubevirt: Obj | null | undefined): string {
  const registry = kubevirt?.status?.observedKubeVirtRegistry || kubevirt?.spec?.imageRegistry || 'quay.io/kubevirt';
  const version = kubevirt?.status?.observedKubeVirtVersion || kubevirt?.status?.targetKubeVirtVersion || kubevirt?.spec?.imageTag || 'v1.7.0';
  return `${String(registry).replace(/\/+$/, '')}/sidecar-shim:${version}`;
}

export function sidecarGateOn(kubevirt: Obj | null | undefined): boolean {
  const gates: string[] = kubevirt?.spec?.configuration?.developerConfiguration?.featureGates ?? [];
  return gates.includes(SIDECAR_GATE);
}

/** The KubeVirt resource with the Sidecar feature gate added, other gates kept. */
export function withSidecarGate(kubevirt: Obj): Obj {
  const out = JSON.parse(JSON.stringify(kubevirt));
  out.spec ??= {};
  out.spec.configuration ??= {};
  out.spec.configuration.developerConfiguration ??= {};
  const gates: string[] = out.spec.configuration.developerConfiguration.featureGates ?? [];
  if (!gates.includes(SIDECAR_GATE)) out.spec.configuration.developerConfiguration.featureGates = [...gates, SIDECAR_GATE];
  return out;
}

/**
 * The template annotation with Hangar's hook on the given sidecar-shim
 * image, when it names another one (KubeVirt was updated since the
 * clipboard was turned on); null when it is up to date, off, or not
 * readable. Other sidecars are kept as they are.
 */
export function alignedClipboardSidecars(annotations: Record<string, string> | undefined, image: string): string | null {
  const list = parseSidecars(annotations?.[HOOK_ANNOTATION]);
  if (!list || !list.some(s => isClipboardSidecar(s) && s.image !== image)) return null;
  return JSON.stringify(list.map(s => (isClipboardSidecar(s) ? { ...s, image } : s)));
}

/** The hook entry Hangar adds to a VM's template. */
export function clipboardSidecar(image: string): Sidecar {
  return {
    args: ['--version', 'v1alpha2'],
    image,
    configMap: { name: CLIPBOARD_HOOK_CM, key: CLIPBOARD_HOOK_KEY, hookPath: CLIPBOARD_HOOK_PATH },
  };
}

/**
 * Sets the template annotation (pure): adds or removes Hangar's hook, keeps
 * other sidecars. Throws when the annotation holds something Hangar cannot
 * read, rather than overwrite it.
 */
export function setClipboardAnnotation(annotations: Record<string, string> | undefined, on: boolean, image: string): Record<string, string> {
  const out = { ...(annotations ?? {}) };
  const list = parseSidecars(out[HOOK_ANNOTATION]);
  if (list === null) throw new Error(`The VM already has hook sidecars Hangar cannot read (${HOOK_ANNOTATION}).`);
  const others = list.filter(s => !isClipboardSidecar(s));
  const next = on ? [...others, clipboardSidecar(image)] : others;
  if (next.length) out[HOOK_ANNOTATION] = JSON.stringify(next);
  else delete out[HOOK_ANNOTATION];
  return out;
}

/** The VM with clipboard sharing turned on or off (applies at the next power-on). */
export function withClipboard(vm: Obj, on: boolean, image: string): Obj {
  const next = JSON.parse(JSON.stringify(vm));
  next.spec ??= {};
  next.spec.template ??= {};
  next.spec.template.metadata ??= {};
  const ann = setClipboardAnnotation(next.spec.template.metadata.annotations, on, image);
  if (Object.keys(ann).length) next.spec.template.metadata.annotations = ann;
  else delete next.spec.template.metadata.annotations;
  return next;
}

/**
 * Ctrl+V in the console: give the VM this computer's clipboard only when it
 * changed since the last paste. Otherwise the VM keeps its own clipboard,
 * which may be newer (text copied in the VM that the browser could not put
 * on this computer's clipboard).
 */
export function shouldSendToVm(text: string, lastSeenHostText: string | null): boolean {
  return text.length > 0 && text !== lastSeenHostText;
}
