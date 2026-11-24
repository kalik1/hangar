/*
 * Building VirtualMachine objects: new VMs from the wizard, copies of a VM
 * (clone), VMs from a template. Disks are copied with CDI (a DataVolume
 * per disk cloning the source PVC), which works on any storage; CDI picks
 * the fastest strategy the storage offers (CSI clone, snapshot, copy).
 */

import { applyDns, DnsSettings } from './dns';
import { withVmProtection } from './protection';
import { Obj, VM } from './types';
import { GiB, parseQuantity, toQuantity } from './units';
import { L_TEMPLATE } from './vm';

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
  cloudInit?: { user?: string; password?: string; sshKeys?: string[]; hostname?: string; custom?: string };
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
}

export function cloudInitUserData(c: NonNullable<WizardInput['cloudInit']>, hostname: string): string {
  if (c.custom && c.custom.trim()) return c.custom;
  const lines = ['#cloud-config', `hostname: ${c.hostname || hostname}`];
  if (c.user) lines.push(`user: ${c.user}`);
  if (c.password) {
    lines.push(`password: ${JSON.stringify(c.password)}`);
    lines.push('chpasswd: { expire: false }');
    lines.push('ssh_pwauth: true');
  }
  const keys = (c.sshKeys ?? []).map(k => k.trim()).filter(Boolean);
  if (keys.length) {
    lines.push('ssh_authorized_keys:');
    for (const k of keys) lines.push(`  - ${JSON.stringify(k)}`);
  }
  lines.push('runcmd:');
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
    volumes.push({ name: 'cloudinitdisk', cloudInitNoCloud: { userData: cloudInitUserData(w.cloudInit, w.name) } });
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
  const spec: any = {
    runStrategy: w.runStrategy,
    dataVolumeTemplates: dvts,
    template: {
      metadata: { labels: { ...labels }, ...(w.templateAnnotations && Object.keys(w.templateAnnotations).length ? { annotations: { ...w.templateAnnotations } } : {}) },
      spec: templateSpec,
    },
  };
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
