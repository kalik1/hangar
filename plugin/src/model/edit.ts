/*
 * Edits of a VM's settings, as pure functions on a copy of the VM. The
 * Configure tab applies them with a full update (PUT) guarded by the
 * resourceVersion, so a concurrent change is reported, not overwritten.
 * Changes a running VM cannot take live make KubeVirt flag RestartRequired,
 * which the VM page shows.
 */

import { VM } from './types';
import { toQuantity } from './units';
import { localMac } from './vmspec';

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function tpl(vm: VM): any {
  vm.spec ??= {};
  vm.spec.template ??= {};
  vm.spec.template.spec ??= {};
  vm.spec.template.spec.domain ??= {};
  vm.spec.template.spec.domain.devices ??= {};
  return vm.spec.template.spec;
}

/** Custom sizing: drops the size profile, sets CPU topology and memory. */
export function setCompute(vm: VM, c: { sockets: number; cores: number; threads: number; memoryBytes: number }): VM {
  const out = clone(vm);
  const t = tpl(out);
  delete out.spec.instancetype;
  t.domain.cpu = { ...(t.domain.cpu ?? {}), sockets: c.sockets, cores: c.cores, threads: c.threads };
  t.domain.memory = { ...(t.domain.memory ?? {}), guest: toQuantity(c.memoryBytes) };
  if (t.domain.resources?.requests?.memory) delete t.domain.resources.requests.memory;
  return out;
}

/** Sizing from a size profile (cluster instancetype): CPU and memory come from it. */
export function setInstancetype(vm: VM, name: string): VM {
  const out = clone(vm);
  const t = tpl(out);
  out.spec.instancetype = { kind: 'VirtualMachineClusterInstancetype', name };
  if (t.domain.cpu) {
    delete t.domain.cpu.sockets;
    delete t.domain.cpu.cores;
    delete t.domain.cpu.threads;
    if (!Object.keys(t.domain.cpu).length) delete t.domain.cpu;
  }
  if (t.domain.memory) delete t.domain.memory.guest;
  if (t.domain.memory && !Object.keys(t.domain.memory).length) delete t.domain.memory;
  // KubeVirt keeps the revision it expanded; let it pick the new one.
  delete out.spec.instancetype.revisionName;
  return out;
}

export function setFirmware(vm: VM, fw: 'bios' | 'uefi' | 'uefi-secure', tpm: boolean): VM {
  const out = clone(vm);
  const t = tpl(out);
  t.domain.firmware ??= {};
  if (fw === 'bios') {
    t.domain.firmware.bootloader = { bios: {} };
  } else {
    t.domain.firmware.bootloader = { efi: { secureBoot: fw === 'uefi-secure' } };
    if (fw === 'uefi-secure') t.domain.features = { ...(t.domain.features ?? {}), smm: { enabled: true } };
  }
  if (tpm) t.domain.devices.tpm = t.domain.devices.tpm ?? { persistent: true };
  else delete t.domain.devices.tpm;
  return out;
}

function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  for (let i = 1; i < 100; i++) if (!existing.includes(`${base}${i}`)) return `${base}${i}`;
  return `${base}-${Date.now()}`;
}

export function deviceNames(vm: VM): string[] {
  const t = vm.spec?.template?.spec ?? {};
  return [...(t.volumes ?? []).map((v: any) => v.name), ...(t.domain?.devices?.disks ?? []).map((d: any) => d.name)];
}

/** A new empty disk, created by the VM (dataVolumeTemplate). */
export function addBlankDisk(
  vm: VM,
  d: { name?: string; sizeBytes: number; storageClass?: string; bus: string; hotplug?: boolean }
): { vm: VM; name: string } {
  const out = d.hotplug ? forHotplug(vm) : clone(vm);
  const t = tpl(out);
  const name = uniqueName(deviceNames(vm), d.name || 'disk');
  const dvName = `${vm.metadata.name}-${name}`.slice(0, 63);
  out.spec.dataVolumeTemplates = [
    ...(out.spec.dataVolumeTemplates ?? []),
    {
      metadata: { name: dvName },
      spec: {
        source: { blank: {} },
        storage: { resources: { requests: { storage: toQuantity(d.sizeBytes) } }, ...(d.storageClass ? { storageClassName: d.storageClass } : {}) },
      },
    },
  ];
  t.domain.devices.disks = [...(t.domain.devices.disks ?? []), { name, disk: { bus: d.bus } }];
  t.volumes = [...(t.volumes ?? []), { name, dataVolume: { name: dvName, ...(d.hotplug ? { hotpluggable: true } : {}) } }];
  return { vm: out, name };
}

/* ------------------------------------------------------------ boot order */

/** On a VM: the claim of the boot disk taken out of it, so attaching it again makes it boot first. */
export const A_FORMER_BOOT_DISK = 'hangar.magesgate.com/former-boot-disk';

/** Some disk or network adapter has a boot order. */
export function hasBootOrder(vm: VM): boolean {
  const dev = vm.spec?.template?.spec?.domain?.devices ?? {};
  return [...(dev.disks ?? []), ...(dev.interfaces ?? [])].some((x: any) => x.bootOrder !== undefined);
}

export function isEfi(vm: VM): boolean {
  return !!vm.spec?.template?.spec?.domain?.firmware?.bootloader?.efi;
}

/** The boot disk taken out of the VM, if attaching `claim` would bring it back. */
export function isFormerBootDisk(vm: VM, claim: string): boolean {
  return vm.metadata.annotations?.[A_FORMER_BOOT_DISK] === claim;
}

/** The claim of the first disk in boot order, when it has one. */
function bootClaim(vm: VM): string | undefined {
  const t = vm.spec?.template?.spec ?? {};
  const first = ((t.domain?.devices?.disks ?? []) as any[])
    .filter(d => d.bootOrder !== undefined && !d.cdrom)
    .sort((a, b) => a.bootOrder - b.bootOrder)[0];
  const v = first && ((t.volumes ?? []) as any[]).find(x => x.name === first.name);
  return v?.dataVolume?.name ?? v?.persistentVolumeClaim?.claimName;
}

function setAnnotation(vm: VM, k: string, v: string | undefined) {
  const a = { ...(vm.metadata.annotations ?? {}) };
  if (v === undefined) delete a[k];
  else a[k] = v;
  if (Object.keys(a).length) vm.metadata.annotations = a;
  else delete vm.metadata.annotations;
}

/**
 * Why saving `after` may leave a UEFI VM that does not boot: no device has
 * a boot order, and the edit took the last one away or changed the disks.
 * OVMF then tries the devices in bus order, the cloud-init disk among them,
 * and can stop there.
 */
export function bootOrderWarning(before: VM, after: VM): string | undefined {
  if (!isEfi(after) || hasBootOrder(after)) return undefined;
  const names = (v: VM) => ((v.spec?.template?.spec?.domain?.devices?.disks ?? []) as any[]).map(d => d.name).join();
  if (!hasBootOrder(before) && names(before) === names(after)) return undefined;
  return 'No disk or network adapter of the VM has a boot order. With UEFI the firmware may try another disk first, such as the cloud-init disk, and not start the guest: choose a boot disk in Boot order.';
}

/** The boot order after every device's, 1 when none has one. */
function nextBootOrder(vm: VM): number {
  const dev = vm.spec?.template?.spec?.domain?.devices ?? {};
  const orders = [...(dev.disks ?? []), ...(dev.interfaces ?? [])].map((x: any) => x.bootOrder).filter((n: any) => typeof n === 'number');
  return orders.length ? Math.max(...orders) + 1 : 1;
}

/**
 * Attaches an existing disk (PVC) of the same folder. The VM's former boot
 * disk gets its boot order back: 1 when no other device has one, else after
 * them. It is then attached for the next power-on, not hot-plugged: a
 * hot-plugged disk joins after the firmware has looked for one.
 */
export function attachDisk(vm: VM, claimName: string, bus: string, hotplug = false): { vm: VM; name: string; bootOrder?: number } {
  const bootOrder = isFormerBootDisk(vm, claimName) ? nextBootOrder(vm) : undefined;
  const live = hotplug && bootOrder === undefined;
  const out = live ? forHotplug(vm) : clone(vm);
  const t = tpl(out);
  const name = uniqueName(deviceNames(vm), claimName.replace(/^.*?-/, '').slice(0, 30) || 'disk');
  t.domain.devices.disks = [...(t.domain.devices.disks ?? []), { name, disk: { bus }, ...(bootOrder !== undefined ? { bootOrder } : {}) }];
  t.volumes = [...(t.volumes ?? []), { name, persistentVolumeClaim: { claimName, ...(live ? { hotpluggable: true } : {}) } }];
  if (bootOrder !== undefined) setAnnotation(out, A_FORMER_BOOT_DISK, undefined);
  return { vm: out, name, bootOrder };
}

/**
 * A copy of the VM ready for a hot-plug edit. KubeVirt skips declarative
 * hot-plug while spec.updateVolumesStrategy is Migration, which a live disk
 * move leaves behind; the default (Replacement) is put back.
 */
export function forHotplug(vm: VM): VM {
  const out = clone(vm);
  if (out.spec?.updateVolumesStrategy === 'Migration') delete out.spec.updateVolumesStrategy;
  return out;
}

/** Buses a disk can be hot-plugged on (KubeVirt v1.7): VirtIO and SCSI. CD/DVD media go into an existing drive. */
export const HOTPLUG_BUSES = ['virtio', 'scsi'];

/** The volume is hot-pluggable: KubeVirt adds and removes it on the running VM. */
export function isHotpluggable(vm: VM, name: string): boolean {
  const v = (vm.spec?.template?.spec?.volumes ?? []).find((x: any) => x.name === name);
  return !!(v?.dataVolume?.hotpluggable || v?.persistentVolumeClaim?.hotpluggable);
}

/** Inserts an ISO of the library as a CD/DVD (a per-VM copy, so any host can mount it). */
export function insertIso(
  vm: VM,
  iso: { namespace: string; name: string; sizeBytes: number },
  boot = false,
  opts: { drive?: string; hotplug?: boolean } = {}
): VM {
  const out = opts.hotplug ? forHotplug(vm) : clone(vm);
  const t = tpl(out);
  const disks: any[] = t.domain.devices.disks ?? [];
  const drive = opts.drive ? disks.find(d => d.name === opts.drive && d.cdrom) : undefined;
  const name = drive ? drive.name : uniqueName(deviceNames(vm), 'cdrom');
  const dvName = `${vm.metadata.name}-${name}`.slice(0, 63);
  out.spec.dataVolumeTemplates = [
    ...(out.spec.dataVolumeTemplates ?? []),
    {
      metadata: { name: dvName },
      spec: {
        source: { pvc: { namespace: iso.namespace, name: iso.name } },
        storage: { resources: { requests: { storage: toQuantity(Math.max(iso.sizeBytes, 2 ** 30)) } } },
      },
    },
  ];
  if (boot) {
    for (const d of disks) if (d.bootOrder && d !== drive) d.bootOrder += 1;
  }
  if (drive) {
    // Media into an empty drive: the drive stays, so a running VM gets it at once (hot-plug).
    if (boot) drive.bootOrder = 1;
  } else {
    t.domain.devices.disks = [...disks, { name, cdrom: { bus: 'sata', readonly: true }, ...(boot ? { bootOrder: 1 } : {}) }];
  }
  t.volumes = [...(t.volumes ?? []), { name, dataVolume: { name: dvName, ...(opts.hotplug ? { hotpluggable: true } : {}) } }];
  return out;
}

/** An empty CD/DVD drive (SATA): media can then go in while the VM runs. Needs DeclarativeHotplugVolumes. */
export function addCdromDrive(vm: VM): { vm: VM; name: string } {
  const out = clone(vm);
  const t = tpl(out);
  const name = uniqueName(deviceNames(vm), 'cdrom');
  t.domain.devices.disks = [...(t.domain.devices.disks ?? []), { name, cdrom: { bus: 'sata', readonly: true } }];
  return { vm: out, name };
}

/**
 * Ejects the media of a CD/DVD drive. With `keepDrive` (declarative
 * hot-plug on) the empty drive stays, ready for the next ISO; otherwise the
 * drive goes too. The per-VM ISO copy goes with its template.
 */
export function ejectCdrom(vm: VM, name: string, keepDrive: boolean): { vm: VM; claim?: string; owned: boolean } {
  if (!keepDrive) return removeDisk(vm, name);
  const out = forHotplug(vm);
  const t = tpl(out);
  const vol = (t.volumes ?? []).find((v: any) => v.name === name);
  const claim = vol?.dataVolume?.name ?? vol?.persistentVolumeClaim?.claimName;
  t.volumes = (t.volumes ?? []).filter((v: any) => v.name !== name);
  const owned = !!claim && (out.spec.dataVolumeTemplates ?? []).some((d: any) => d.metadata?.name === claim);
  if (owned) out.spec.dataVolumeTemplates = out.spec.dataVolumeTemplates.filter((d: any) => d.metadata?.name !== claim);
  return { vm: out, claim, owned };
}

/**
 * Removes a disk from the VM. The dataVolumeTemplate goes too when the VM
 * created it, so the disk is deleted with it unless `keep` (then the PVC
 * stays, unattached). Returns the claim to delete separately, if asked.
 * The boot disk is remembered on the VM (A_FORMER_BOOT_DISK): attached
 * again, it boots first again.
 */
export function removeDisk(vm: VM, name: string): { vm: VM; claim?: string; owned: boolean } {
  const out = clone(vm);
  const t = tpl(out);
  const vol = (t.volumes ?? []).find((v: any) => v.name === name);
  const claim = vol?.dataVolume?.name ?? vol?.persistentVolumeClaim?.claimName;
  const wasBoot = !!claim && bootClaim(vm) === claim;
  t.domain.devices.disks = (t.domain.devices.disks ?? []).filter((d: any) => d.name !== name);
  t.volumes = (t.volumes ?? []).filter((v: any) => v.name !== name);
  const owned = !!claim && (out.spec.dataVolumeTemplates ?? []).some((d: any) => d.metadata?.name === claim);
  if (owned) out.spec.dataVolumeTemplates = out.spec.dataVolumeTemplates.filter((d: any) => d.metadata?.name !== claim);
  if (wasBoot) setAnnotation(out, A_FORMER_BOOT_DISK, claim);
  return { vm: out, claim, owned };
}

/**
 * Boot order from an ordered list of device names (disks and NICs). The
 * devices that had a boot order and are not in the list lose it: they are
 * returned in `dropped`, for the caller to say so.
 */
export function setBootOrder(vm: VM, order: string[]): { vm: VM; dropped: string[] } {
  const out = clone(vm);
  const t = tpl(out);
  const dropped: string[] = [];
  for (const d of [...(t.domain.devices.disks ?? []), ...(t.domain.devices.interfaces ?? [])]) {
    const i = order.indexOf(d.name);
    if (i >= 0) d.bootOrder = i + 1;
    else if (d.bootOrder !== undefined) {
      dropped.push(d.name);
      delete d.bootOrder;
    }
  }
  return { vm: out, dropped };
}

export function addNic(vm: VM, network: string, model: string): { vm: VM; name: string } {
  const out = clone(vm);
  const t = tpl(out);
  const names = [...(t.domain.devices.interfaces ?? []).map((i: any) => i.name), ...(t.networks ?? []).map((n: any) => n.name)];
  const name = uniqueName(names, network ? 'nic' : 'default');
  const iface = network ? { name, bridge: {}, model } : { name, masquerade: {}, model, macAddress: localMac() };
  t.domain.devices.interfaces = [...(t.domain.devices.interfaces ?? []), iface];
  t.networks = [...(t.networks ?? []), network ? { name, multus: { networkName: network } } : { name, pod: {} }];
  return { vm: out, name };
}

export function removeNic(vm: VM, name: string): VM {
  const out = clone(vm);
  const t = tpl(out);
  t.domain.devices.interfaces = (t.domain.devices.interfaces ?? []).filter((i: any) => i.name !== name);
  t.networks = (t.networks ?? []).filter((n: any) => n.name !== name);
  return out;
}

export function setNic(vm: VM, name: string, p: { network?: string; model?: string; mac?: string | null; linkDown?: boolean }): VM {
  const out = clone(vm);
  const t = tpl(out);
  const i = (t.domain.devices.interfaces ?? []).find((x: any) => x.name === name);
  const n = (t.networks ?? []).find((x: any) => x.name === name);
  if (!i || !n) return out;
  if (p.network !== undefined) {
    delete i.masquerade;
    delete i.bridge;
    delete n.pod;
    delete n.multus;
    if (p.network) {
      i.bridge = {};
      n.multus = { networkName: p.network };
    } else {
      i.masquerade = {};
      n.pod = {};
    }
  }
  if (p.model) i.model = p.model;
  if (p.mac === null) delete i.macAddress;
  else if (p.mac) i.macAddress = p.mac;
  if (p.linkDown !== undefined) {
    if (p.linkDown) i.state = 'down';
    else delete i.state;
  }
  return out;
}

export function setPolicies(
  vm: VM,
  p: { runStrategy?: string; eviction?: string | null; graceSeconds?: number | null; hostAffinity?: { host: string; required: boolean } | null }
): VM {
  const out = clone(vm);
  const t = tpl(out);
  if (p.runStrategy) {
    out.spec.runStrategy = p.runStrategy;
    delete out.spec.running;
  }
  if (p.eviction !== undefined) {
    if (p.eviction) t.evictionStrategy = p.eviction;
    else delete t.evictionStrategy;
  }
  if (p.graceSeconds !== undefined) {
    if (p.graceSeconds === null) delete t.terminationGracePeriodSeconds;
    else t.terminationGracePeriodSeconds = p.graceSeconds;
  }
  if (p.hostAffinity !== undefined) {
    if (!p.hostAffinity) {
      if (t.affinity?.nodeAffinity) delete t.affinity.nodeAffinity;
      if (t.affinity && !Object.keys(t.affinity).length) delete t.affinity;
    } else {
      const term = { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [p.hostAffinity.host] }] };
      t.affinity = {
        ...(t.affinity ?? {}),
        nodeAffinity: p.hostAffinity.required
          ? { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [term] } }
          : { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, preference: term }] },
      };
    }
  }
  return out;
}

/** The host a VM is pinned to or prefers, from its node affinity. */
export function hostAffinity(vm: VM): { host: string; required: boolean } | null {
  const na = vm.spec?.template?.spec?.affinity?.nodeAffinity;
  const req = na?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0]?.matchExpressions?.find(
    (e: any) => e.key === 'kubernetes.io/hostname'
  );
  if (req?.values?.[0]) return { host: req.values[0], required: true };
  const pref = na?.preferredDuringSchedulingIgnoredDuringExecution?.[0]?.preference?.matchExpressions?.find(
    (e: any) => e.key === 'kubernetes.io/hostname'
  );
  if (pref?.values?.[0]) return { host: pref.values[0], required: false };
  return null;
}

export function setCloudInit(vm: VM, userData: string): VM {
  const out = clone(vm);
  const t = tpl(out);
  const v = (t.volumes ?? []).find((x: any) => x.cloudInitNoCloud || x.cloudInitConfigDrive);
  if (v) {
    const ci = v.cloudInitNoCloud ?? v.cloudInitConfigDrive;
    delete ci.userDataBase64;
    ci.userData = userData;
  } else {
    t.volumes = [...(t.volumes ?? []), { name: 'cloudinitdisk', cloudInitNoCloud: { userData } }];
    t.domain.devices.disks = [...(t.domain.devices.disks ?? []), { name: 'cloudinitdisk', disk: { bus: 'virtio' } }];
  }
  return out;
}

export function cloudInitOf(vm: VM): string | undefined {
  const v = (vm.spec?.template?.spec?.volumes ?? []).find((x: any) => x.cloudInitNoCloud || x.cloudInitConfigDrive);
  const ci = v?.cloudInitNoCloud ?? v?.cloudInitConfigDrive;
  if (!ci) return undefined;
  if (ci.userData) return ci.userData;
  if (ci.userDataBase64) {
    try {
      return atob(ci.userDataBase64);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setTags(vm: VM, tags: Record<string, string>, keep: (k: string) => boolean): VM {
  const out = clone(vm);
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(out.metadata.labels ?? {})) if (keep(k)) labels[k] = v;
  out.metadata.labels = { ...labels, ...tags };
  return out;
}
