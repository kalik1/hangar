/*
 * Building VirtualMachine objects: new VMs from the wizard, copies of a VM
 * (clone), VMs from a template. Disks are copied with CDI (a DataVolume
 * per disk cloning the source PVC), which works on any storage; CDI picks
 * the fastest strategy the storage offers (CSI clone, snapshot, copy).
 */

import { applyDns, DnsSettings } from './dns';
import { withMetadata } from './metadata';
import { withVmProtection } from './protection';
import { Obj, VM } from './types';
import { GiB, parseQuantity, toQuantity } from './units';
import { L_TEMPLATE, lacksGuestAgent, loginShell } from './vm';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** DNS-1123 label rules for a VM name. Returns the problem, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return 'Enter a name.';
  if (name.length > 63) return 'Use at most 63 characters.';
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name))
    return 'Use lowercase letters, digits and hyphens; start and end with a letter or digit.';
  return null;
}

/** Turns a display name into a valid name: "Web Server 01" → "web-server-01". */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/** Replaces or sets `hostname:` in a #cloud-config user-data. */
export function withHostname(userData: string | undefined, hostname: string): string | undefined {
  if (!userData) return userData;
  if (/^hostname:.*$/m.test(userData)) return userData.replace(/^hostname:.*$/m, `hostname: ${hostname}`);
  if (userData.startsWith('#cloud-config')) return userData.replace('#cloud-config', `#cloud-config\nhostname: ${hostname}`);
  return userData;
}

export interface CopyOptions {
  name: string;
  namespace: string;
  runStrategy: string;
  /** PVC lookup "ns/name" → PVC, for sizes and storage classes. */
  pvcs: Map<string, Obj>;
  /** Keep as a template (template → template copy). */
  asTemplate?: boolean;
  description?: string;
  /** Datastore for the copies; default: the source disk's. */
  storageClass?: string;
}

const randomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
};

/**
 * A MAC address for a NAT (masquerade) adapter: 02 (locally administered,
 * unicast) and five random bytes. Without one KubeVirt draws a new MAC at
 * every start, and a Linux guest on a persistent disk then sees a new NIC and
 * may lose its network settings. Only NAT adapters get one: their MAC exists
 * only on the private link between the guest and its pod, so it can never
 * meet another VM's; bridged and SR-IOV adapters sit on a real network,
 * where the MAC is the user's (or the network's) call. DESIGN.md §6.
 */
export function localMac(bytes: (n: number) => Uint8Array = randomBytes): string {
  return ['02', ...Array.from(bytes(5).slice(0, 5), b => b.toString(16).padStart(2, '0'))].join(':');
}

/**
 * A new VM that copies `src`: same hardware and settings, each persistent
 * disk cloned. Firmware UUID and serial are dropped so the copy gets its
 * own; NAT adapters get a new fixed MAC (localMac), the others none.
 */
export function copyVm(src: VM, o: CopyOptions): VM {
  const spec = clone(src.spec ?? {});
  const tpl = spec.template ?? (spec.template = { spec: {} });
  const srcNs = src.metadata.namespace as string;
  const dvts: Obj[] = [];
  const srcDvts: Obj[] = spec.dataVolumeTemplates ?? [];
  const volumes: any[] = tpl.spec?.volumes ?? [];
  for (const v of volumes) {
    const claim = v.dataVolume?.name ?? v.persistentVolumeClaim?.claimName;
    if (!claim) continue;
    const pvc = o.pvcs.get(`${srcNs}/${claim}`);
    const srcDvt = srcDvts.find(d => d.metadata?.name === claim);
    const size =
      pvc?.status?.capacity?.storage ??
      pvc?.spec?.resources?.requests?.storage ??
      srcDvt?.spec?.storage?.resources?.requests?.storage ??
      srcDvt?.spec?.pvc?.resources?.requests?.storage ??
      '10Gi';
    const sc = o.storageClass ?? pvc?.spec?.storageClassName ?? srcDvt?.spec?.storage?.storageClassName;
    const dvName = `${o.name}-${v.name}`.slice(0, 63).replace(/-$/, '');
    dvts.push({
      metadata: { name: dvName },
      spec: {
        source: { pvc: { namespace: srcNs, name: claim } },
        storage: {
          resources: { requests: { storage: size } },
          ...(sc ? { storageClassName: sc } : {}),
          ...(pvc?.spec?.volumeMode ? { volumeMode: pvc.spec.volumeMode } : {}),
          ...(pvc?.spec?.accessModes ? { accessModes: pvc.spec.accessModes } : {}),
        },
      },
    });
    delete v.persistentVolumeClaim;
    v.dataVolume = { name: dvName };
  }
  spec.dataVolumeTemplates = dvts;
  for (const v of volumes) {
    const ci = v.cloudInitNoCloud ?? v.cloudInitConfigDrive;
    if (ci?.userData) ci.userData = withHostname(ci.userData, o.name);
  }
  const ifaces: any[] = tpl.spec?.domain?.devices?.interfaces ?? [];
  for (const i of ifaces) {
    if (i.masquerade) i.macAddress = localMac();
    else delete i.macAddress;
  }
  if (tpl.spec?.domain?.firmware) {
    delete tpl.spec.domain.firmware.uuid;
    delete tpl.spec.domain.firmware.serial;
  }
  if (tpl.metadata?.labels) {
    delete tpl.metadata.labels['kubevirt.io/domain'];
    delete tpl.metadata.labels['vm.kubevirt.io/name'];
  }
  spec.runStrategy = o.runStrategy;
  delete spec.running;
  const labels = { ...(src.metadata.labels ?? {}) };
  if (o.asTemplate) labels[L_TEMPLATE] = 'true';
  else delete labels[L_TEMPLATE];
  const annotations: Record<string, string> = {};
  const desc = o.description ?? src.metadata.annotations?.description;
  if (desc) annotations.description = desc;
  for (const [k, v] of Object.entries(src.metadata.annotations ?? {})) {
    if (k.startsWith('hangar.magesgate.com/') || k.startsWith('vm.kubevirt.io/os')) annotations[k] = v;
  }
  annotations['hangar.magesgate.com/copied-from'] = `${srcNs}/${src.metadata.name}`;
  return {
    apiVersion: 'kubevirt.io/v1',
    kind: 'VirtualMachine',
    metadata: { name: o.name, namespace: o.namespace, labels, annotations },
    spec,
  };
}

/* ---------------------------------------------------------------- wizard */

export type BootSource =
  | { kind: 'image'; namespace: string; name: string; sizeBytes?: number } // clone a library disk image (PVC)
  | { kind: 'iso'; namespace: string; name: string } // install from an ISO in the library
  | { kind: 'url'; url: string } // import a disk image from a URL
  | { kind: 'registry'; image: string } // import a containerDisk image into a disk
  | { kind: 'blank' }; // empty disk, network/PXE boot

export interface WizardDisk {
  name: string;
  sizeBytes: number;
  storageClass?: string;
  bus: 'virtio' | 'scsi' | 'sata';
}

export interface WizardNic {
  name: string;
  /** "" for the pod network (NAT), else "namespace/name" of a network attachment (bridge). */
  network: string;
  model: 'virtio' | 'e1000e';
  /**
   * The NAT adapter's MAC, kept in the wizard's state so the YAML review
   * shows what Create makes; default a new localMac(). Ignored for
   * attachments.
   */
  mac?: string;
}

export interface WizardInput {
  name: string;
  namespace: string;
  description?: string;
  osId?: string;
  preference?: string;
  /** Size profile (cluster instancetype), or custom sizing. */
  instancetype?: string;
  /** VirtualMachineClusterInstancetype (default) or VirtualMachineInstancetype (folder flavor). */
  instancetypeKind?: string;
  /** CPU model set on the VM ('' / undefined: the flavor's or the cluster default). */
  cpuModel?: string;
  sockets: number;
  cores: number;
  threads: number;
  memoryBytes: number;
  firmware: 'bios' | 'uefi' | 'uefi-secure';
  tpm: boolean;
  source: BootSource;
  rootDisk: WizardDisk;
  extraDisks: WizardDisk[];
  nics: WizardNic[];
  /** DNS of the pod network adapter; undefined = cluster defaults. */
  dns?: DnsSettings;
  /**
   * cloud-init: the user Hangar adds (the wizard's default is DEFAULT_USER;
   * none: the image's default user gets the password and keys), or custom
   * user data that replaces everything. guestAgentFullAccess: let the QEMU
   * guest agent reach the whole guest (GUEST_AGENT_FULL_ACCESS); not with
   * custom user data.
   */
  cloudInit?: { user?: string; password?: string; sshKeys?: string[]; hostname?: string; custom?: string; guestAgentFullAccess?: boolean };
  runStrategy: string;
  evictionStrategy?: string;
  /** Pin to a host (preferred, not required). */
  hostAffinity?: string;
  labels?: Record<string, string>;
  /** Annotations of the VM's instances (e.g. the clipboard hook sidecar). */
  templateAnnotations?: Record<string, string>;
  /** Power-on leaves the VM suspended (startStrategy Paused). */
  startPaused?: boolean;
  /** Delete protection (label on the VM and its disks; enforced by the admission policy). */
  protected?: boolean;
  /** No graphics card: serial console only. */
  headless?: boolean;
  /** Sound card model. */
  sound?: 'ich9' | 'ac97';
  /** NAT network inside the pod for pod-network adapters (vmNetworkCIDR); undefined: KubeVirt's 10.0.2.0/24. */
  vmNetworkCidr?: string;
  /** Ask for k4all's metadata service (model/metadata.ts); serviceAccount: whose tokens the guest gets. */
  metadata?: { serviceAccount?: string };
}

/** The user the New VM wizard fills in. */
export const DEFAULT_USER = 'k4all';

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/** A Linux user name cloud-init can create. Returns the problem, or null. */
export function userNameProblem(name: string): string | null {
  return !name || USER_NAME.test(name) ? null : 'Use lowercase letters, digits, - and _ (at most 32), starting with a letter or _.';
}

/**
 * "Let the guest agent reach the whole guest" (hangar#15): at first boot,
 * install the agent if missing; a systemd drop-in that reads an empty
 * FILTER_RPC_ARGS, so every agent command is on (RHEL and Rocky disable
 * many; Fedora's unit ignores it); where SELinux is on, a CIL module that
 * puts the agent's domain (virt_qemu_ga_t) in files_unconfined_type with
 * chown, fowner and fsetid, so it reads and writes every file while the
 * domain stays enforcing; then restart the agent. Each line is verbatim
 * from the lab test of 2026-11-28 (KubeVirt v1.9.1; Fedora 45, Rocky 9.9,
 * CentOS Stream 10, Ubuntu 24.04, Debian 13). The block adds 669 bytes.
 */
export const GUEST_AGENT_FULL_ACCESS = {
  packages: 'packages: [qemu-guest-agent]',
  writeFiles: [
    'write_files:',
    '  - path: /etc/systemd/system/qemu-guest-agent.service.d/50-hangar.conf',
    '    content: "[Service]\\nEnvironmentFile=-/etc/hangar/qemu-ga.env\\n"',
    '  - path: /etc/hangar/qemu-ga.env',
    '    content: "FILTER_RPC_ARGS=\\n"',
    '  - path: /etc/hangar/hangar_qemu_ga.cil',
    '    content: "(typeattributeset files_unconfined_type (virt_qemu_ga_t))\\n(allow virt_qemu_ga_t self (capability (chown fowner fsetid)))\\n"',
  ],
  /** Before the runcmd item every VM gets, which stays last. */
  runcmd: [
    '  - [sh, -c, "if command -v selinuxenabled >/dev/null && selinuxenabled; then semodule -i /etc/hangar/hangar_qemu_ga.cil; fi"]',
    '  - [sh, -c, "systemctl daemon-reload; systemctl enable qemu-guest-agent; systemctl restart qemu-guest-agent"]',
  ],
};

/**
 * The #cloud-config of a wizard VM. A user is a `users:` entry (cloud-init
 * deprecates `user:`) with what an image's default user has: sudo without
 * a password, bash where the OS has it; its password and SSH keys. Without
 * a user the image's default user gets them. Ubuntu and Debian install the
 * QEMU guest agent (`packages`); every OS enables it (`runcmd`). The
 * full-access option merges its block into the same keys (one `packages`,
 * one `write_files`, one `runcmd`). Custom user data is returned unchanged.
 */
export function cloudInitUserData(c: NonNullable<WizardInput['cloudInit']>, hostname: string, osId?: string): string {
  if (c.custom && c.custom.trim()) return c.custom;
  const lines = ['#cloud-config', `hostname: ${c.hostname || hostname}`];
  const keys = (c.sshKeys ?? []).map(k => k.trim()).filter(Boolean);
  if (c.user) {
    const shell = loginShell(osId);
    lines.push('users:');
    lines.push(`  - name: ${USER_NAME.test(c.user) ? c.user : JSON.stringify(c.user)}`);
    lines.push('    sudo: "ALL=(ALL) NOPASSWD:ALL"');
    if (shell) lines.push(`    shell: ${shell}`);
    if (c.password) {
      lines.push('    lock_passwd: false');
      lines.push(`    plain_text_passwd: ${JSON.stringify(c.password)}`);
    }
    if (keys.length) {
      lines.push('    ssh_authorized_keys:');
      for (const k of keys) lines.push(`      - ${JSON.stringify(k)}`);
    }
    if (c.password) lines.push('ssh_pwauth: true');
  } else {
    if (c.password) {
      lines.push(`password: ${JSON.stringify(c.password)}`);
      lines.push('chpasswd: { expire: false }');
      lines.push('ssh_pwauth: true');
    }
    if (keys.length) {
      lines.push('ssh_authorized_keys:');
      for (const k of keys) lines.push(`  - ${JSON.stringify(k)}`);
    }
  }
  const full = !!c.guestAgentFullAccess;
  if (full || lacksGuestAgent(osId)) lines.push(GUEST_AGENT_FULL_ACCESS.packages);
  if (full) lines.push(...GUEST_AGENT_FULL_ACCESS.writeFiles);
  lines.push('runcmd:');
  if (full) lines.push(...GUEST_AGENT_FULL_ACCESS.runcmd);
  lines.push('  - [sh, -c, "systemctl enable --now qemu-guest-agent || rc-update add qemu-guest-agent default || true"]');
  return lines.join('\n') + '\n';
}

/** The VirtualMachine the wizard creates. */
export function buildVm(w: WizardInput): VM {
  const dvts: Obj[] = [];
  const disks: any[] = [];
  const volumes: any[] = [];
  const storage = (d: WizardDisk) => ({
    resources: { requests: { storage: toQuantity(d.sizeBytes) } },
    ...(d.storageClass ? { storageClassName: d.storageClass } : {}),
  });
  const rootName = `${w.name}-rootdisk`;
  const src = w.source;
  let rootSource: any;
  switch (src.kind) {
    case 'image':
      rootSource = { pvc: { namespace: src.namespace, name: src.name } };
      break;
    case 'url':
      rootSource = { http: { url: src.url } };
      break;
    case 'registry':
      rootSource = { registry: { url: src.image.startsWith('docker://') ? src.image : `docker://${src.image}` } };
      break;
    default:
      rootSource = { blank: {} };
  }
  dvts.push({ metadata: { name: rootName }, spec: { source: rootSource, storage: storage(w.rootDisk) } });
  const iso = src.kind === 'iso';
  disks.push({ name: 'rootdisk', disk: { bus: w.rootDisk.bus }, bootOrder: iso ? 2 : 1 });
  volumes.push({ name: 'rootdisk', dataVolume: { name: rootName } });
  if (iso) {
    const cdName = `${w.name}-install-media`;
    dvts.push({
      metadata: { name: cdName },
      spec: { source: { pvc: { namespace: src.namespace, name: src.name } }, storage: { resources: { requests: { storage: '2Gi' } } } },
    });
    disks.push({ name: 'install-media', cdrom: { bus: 'sata', readonly: true }, bootOrder: 1 });
    volumes.push({ name: 'install-media', dataVolume: { name: cdName } });
  }
  w.extraDisks.forEach((d, i) => {
    const dv = `${w.name}-${d.name || `disk${i + 1}`}`;
    dvts.push({ metadata: { name: dv }, spec: { source: { blank: {} }, storage: storage(d) } });
    disks.push({ name: d.name || `disk${i + 1}`, disk: { bus: d.bus } });
    volumes.push({ name: d.name || `disk${i + 1}`, dataVolume: { name: dv } });
  });
  if (w.cloudInit && !iso) {
    disks.push({ name: 'cloudinitdisk', disk: { bus: 'virtio' } });
    volumes.push({ name: 'cloudinitdisk', cloudInitNoCloud: { userData: cloudInitUserData(w.cloudInit, w.name, w.osId) } });
  }
  const interfaces: any[] = [];
  const networks: any[] = [];
  w.nics.forEach((n, i) => {
    const name = n.name || (i === 0 ? 'default' : `nic${i}`);
    if (!n.network) {
      interfaces.push({ name, masquerade: {}, model: n.model, macAddress: n.mac || localMac() });
      networks.push({ name, pod: w.vmNetworkCidr ? { vmNetworkCIDR: w.vmNetworkCidr } : {} });
    } else {
      interfaces.push({ name, bridge: {}, model: n.model });
      networks.push({ name, multus: { networkName: n.network } });
    }
  });
  const domain: any = {
    devices: {
      disks,
      interfaces,
      ...(w.headless ? { autoattachGraphicsDevice: false } : { inputs: [{ name: 'tablet', type: 'tablet', bus: 'usb' }] }),
      rng: {},
      ...(w.tpm ? { tpm: { persistent: true } } : {}),
      ...(w.sound ? { sound: { name: 'sound', model: w.sound } } : {}),
    },
  };
  if (!w.instancetype) {
    domain.cpu = { sockets: w.sockets, cores: w.cores, threads: w.threads };
    domain.memory = { guest: toQuantity(w.memoryBytes) };
  }
  if (w.cpuModel) domain.cpu = { ...(domain.cpu ?? {}), model: w.cpuModel };
  if (w.firmware !== 'bios') {
    domain.firmware = { bootloader: { efi: { secureBoot: w.firmware === 'uefi-secure' } } };
    if (w.firmware === 'uefi-secure') domain.features = { smm: { enabled: true } };
  }
  const labels = { ...(w.labels ?? {}) };
  const annotations: Record<string, string> = {};
  if (w.description) annotations.description = w.description;
  if (w.osId) annotations['hangar.magesgate.com/os'] = w.osId;
  const templateSpec: any = {
    domain,
    networks,
    volumes,
    terminationGracePeriodSeconds: 180,
  };
  if (w.evictionStrategy) templateSpec.evictionStrategy = w.evictionStrategy;
  if (w.startPaused) templateSpec.startStrategy = 'Paused';
  if (w.dns) applyDns(templateSpec, w.dns);
  if (w.hostAffinity) {
    templateSpec.affinity = {
      nodeAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 100,
            preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [w.hostAffinity] }] },
          },
        ],
      },
    };
  }
  let spec: any = {
    runStrategy: w.runStrategy,
    dataVolumeTemplates: dvts,
    template: {
      metadata: { labels: { ...labels }, ...(w.templateAnnotations && Object.keys(w.templateAnnotations).length ? { annotations: { ...w.templateAnnotations } } : {}) },
      spec: templateSpec,
    },
  };
  if (w.metadata) spec = withMetadata(spec, w.metadata);
  if (w.instancetype) spec.instancetype = { kind: w.instancetypeKind || 'VirtualMachineClusterInstancetype', name: w.instancetype };
  if (w.preference) spec.preference = { kind: 'VirtualMachineClusterPreference', name: w.preference };
  const vm: VM = {
    apiVersion: 'kubevirt.io/v1',
    kind: 'VirtualMachine',
    metadata: { name: w.name, namespace: w.namespace, labels, annotations },
    spec,
  };
  return w.protected ? withVmProtection(vm, true) : vm;
}

/** Smallest root disk that holds a source image. */
export function minRootBytes(source: BootSource, imagePvc?: Obj): number {
  if (source.kind === 'image' && imagePvc) {
    const cap = parseQuantity(imagePvc.status?.capacity?.storage ?? imagePvc.spec?.resources?.requests?.storage);
    if (isFinite(cap)) return Math.ceil(cap / GiB) * GiB;
  }
  return GiB;
}

/* ------------------------------------------- cloud-init over KubeVirt's limit */

/** KubeVirt refuses inline cloud-init user data longer than this (the VMI admitter's cloudInitUserMaxLen, v1.9.1). */
export const CLOUD_INIT_INLINE_MAX = 2048;

/** The Secret label that names the VM whose user data it holds. */
export const L_CLOUD_INIT_OF = 'hangar.magesgate.com/cloud-init-of';

/** Bytes of a string in UTF-8, as KubeVirt counts them. */
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export interface CloudInitOverflow {
  /** The cloud-init volume. */
  volume: string;
  /** Its user data, as a Secret holds it: `stringData` (userData) or `data` (userDataBase64). */
  data: { stringData: { userdata: string } } | { data: { userdata: string } };
  bytes: number;
  /** Copied from the source VM's Secret (copiedCloudInit), whatever its size. */
  copied?: boolean;
}

/** The VM's cloud-init volumes whose inline user data KubeVirt would refuse (over CLOUD_INIT_INLINE_MAX bytes). */
export function cloudInitOverflow(vm: VM): CloudInitOverflow[] {
  const out: CloudInitOverflow[] = [];
  for (const v of vm.spec?.template?.spec?.volumes ?? []) {
    const ci = v.cloudInitNoCloud ?? v.cloudInitConfigDrive;
    if (!ci) continue;
    if (typeof ci.userData === 'string') {
      const bytes = utf8Bytes(ci.userData);
      if (bytes > CLOUD_INIT_INLINE_MAX) out.push({ volume: v.name, data: { stringData: { userdata: ci.userData } }, bytes });
    } else if (typeof ci.userDataBase64 === 'string') {
      let bytes = 0;
      try {
        bytes = atob(ci.userDataBase64).length;
      } catch {
        continue; // KubeVirt refuses it anyway, with its own reason
      }
      if (bytes > CLOUD_INIT_INLINE_MAX) out.push({ volume: v.name, data: { data: { userdata: ci.userDataBase64 } }, bytes });
    }
  }
  return out;
}

/**
 * The user data a copy of a VM takes from the source's Secrets (volume →
 * text, read by the caller), with the copy's hostname. It goes into a
 * Secret of the copy's own, whatever its size: never inline, where anyone
 * who may read the VM would see it, and not the source's, which is deleted
 * with the source and may be in another folder.
 */
export function copiedCloudInit(vm: VM, texts: Map<string, string>): CloudInitOverflow[] {
  const out: CloudInitOverflow[] = [];
  for (const v of vm.spec?.template?.spec?.volumes ?? []) {
    const text = texts.get(v.name);
    if (text === undefined || !(v.cloudInitNoCloud ?? v.cloudInitConfigDrive)?.secretRef) continue;
    const userdata = withHostname(text, vm.metadata.name) ?? text;
    out.push({ volume: v.name, data: { stringData: { userdata } }, bytes: utf8Bytes(userdata), copied: true });
  }
  return out;
}

const SUFFIX = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A name for the Secret of a VM's user data: <vm>-cloudinit-<5 random characters>, chosen before the VM exists (it refers to it). */
export function cloudInitSecretName(vmName: string, bytes: (n: number) => Uint8Array = randomBytes): string {
  return `${vmName}-cloudinit-${Array.from(bytes(5), b => SUFFIX[b % SUFFIX.length]).join('')}`;
}

/**
 * The Secret that holds a VM's user data instead (KubeVirt reads its key
 * `userdata`). With the VM's UID it is owned by the VM, from its creation:
 * the garbage collector deletes it with the VM, and no patch is needed.
 */
export function cloudInitSecret(vm: VM, o: CloudInitOverflow, name: string, uid?: string): Obj {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace: vm.metadata.namespace,
      labels: { [L_CLOUD_INIT_OF]: vm.metadata.name, 'app.kubernetes.io/managed-by': 'hangar' },
      ...(uid ? { ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: vm.metadata.name, uid }] } : {}),
    },
    type: 'Opaque',
    ...o.data,
  };
}

/** The VM with the user data of `volume` read from the Secret `secret` (secretRef) instead of inline. */
export function withCloudInitSecret(vm: VM, volume: string, secret: string): VM {
  const out = clone(vm);
  const v = (out.spec?.template?.spec?.volumes ?? []).find((x: any) => x.name === volume);
  const ci = v?.cloudInitNoCloud ?? v?.cloudInitConfigDrive;
  if (ci) {
    delete ci.userData;
    delete ci.userDataBase64;
    ci.secretRef = { name: secret };
  }
  return out;
}

/** The VM's cloud-init volumes that read their user data from a Secret. */
export function cloudInitSecretRefs(vm: VM): { volume: string; secret: string }[] {
  const out: { volume: string; secret: string }[] = [];
  for (const v of vm.spec?.template?.spec?.volumes ?? []) {
    const secret = (v.cloudInitNoCloud ?? v.cloudInitConfigDrive)?.secretRef?.name;
    if (secret) out.push({ volume: v.name, secret });
  }
  return out;
}

/** The VM without these volumes and their disks. */
export function withoutVolumes(vm: VM, names: string[]): VM {
  const out = clone(vm);
  const t = out.spec?.template?.spec;
  if (!t) return out;
  t.volumes = (t.volumes ?? []).filter((v: any) => !names.includes(v.name));
  if (t.domain?.devices?.disks) t.domain.devices.disks = t.domain.devices.disks.filter((d: any) => !names.includes(d.name));
  return out;
}

/** Why a VM is not created: its user data needs a Secret and the Secret could not be made. */
export function cloudInitRefusal(o: CloudInitOverflow, reason: string): string {
  if (o.copied) return `The source keeps its cloud-init user data in a Secret, and Hangar could not make one for the copy: ${reason}`;
  return `The cloud-init user data is ${o.bytes.toLocaleString('en-US')} bytes, more than the ${CLOUD_INIT_INLINE_MAX.toLocaleString('en-US')} KubeVirt takes inline, and Hangar could not keep it in a Secret: ${reason}`;
}
