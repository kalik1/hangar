/*
 * KubeVirt feature gates as a virtualizer admin sees them: which features of
 * the cluster are on, how mature each one is, and what it unlocks in Hangar.
 *
 * Facts (KubeVirt v1.7.0, pkg/virt-config/featuregate): a GA gate is always
 * on and cannot be turned off; Alpha, Beta and Deprecated gates are off
 * unless listed in spec.configuration.developerConfiguration.featureGates;
 * a Discontinued gate does nothing. Maturity changes between KubeVirt
 * releases, so the table is keyed by KubeVirt version: for a version Hangar
 * has no table for, the maturity is "unknown" rather than a guess.
 */

import { GATE_TABLES } from './gateTables';
import { Obj } from './types';

export type Maturity = 'GA' | 'Beta' | 'Alpha' | 'Deprecated' | 'Discontinued';

export interface GateTable {
  /** KubeVirt minor version the table describes ("v1.9" covers v1.9.x). */
  version: string;
  /** Where the table comes from. */
  source: string;
  /** Beta gates are on unless listed in disabledFeatureGates (v1.9 on); before, off unless listed. */
  betaOnByDefault: boolean;
  /** The KubeVirt resource has developerConfiguration.disabledFeatureGates (v1.8 on). */
  disabledList: boolean;
  gates: Record<string, Maturity>;
}

export { GATE_TABLES };

/** KubeVirt's running version (v1.7.0), from the KubeVirt resource. */
export function kubevirtVersion(kv: Obj | null | undefined): string | undefined {
  return kv?.status?.observedKubeVirtVersion || kv?.status?.targetKubeVirtVersion || undefined;
}

/** The table for the cluster's KubeVirt (same minor version), or null. */
export function gateTable(kv: Obj | null | undefined): GateTable | null {
  const v = kubevirtVersion(kv);
  const m = v?.match(/^v?(\d+)\.(\d+)(\.|$|-)/);
  if (!m) return null;
  return GATE_TABLES.find(t => t.version === `v${m[1]}.${m[2]}`) ?? null;
}

export function listedGates(kv: Obj | null | undefined): string[] {
  return (kv?.spec?.configuration?.developerConfiguration?.featureGates ?? []) as string[];
}

/** Gates listed in developerConfiguration.disabledFeatureGates (KubeVirt v1.8 on). */
export function disabledGates(kv: Obj | null | undefined): string[] {
  return (kv?.spec?.configuration?.developerConfiguration?.disabledFeatureGates ?? []) as string[];
}

export interface GateState {
  name: string;
  /** null: no table for this KubeVirt version, or a gate the table does not know. */
  maturity: Maturity | null;
  /** Listed in featureGates of the KubeVirt resource. */
  listed: boolean;
  /** Listed in disabledFeatureGates. */
  disabled: boolean;
  /** On for KubeVirt; null when Hangar cannot tell (unknown version, not listed). */
  on: boolean | null;
  /** On without being listed (GA, or Beta from v1.9). */
  byDefault: boolean;
  /** Something to know (redundant entry, overridden, discontinued). */
  note?: string;
}

export const HOTPLUG_OLD = 'HotplugVolumes';
export const HOTPLUG_DECLARATIVE = 'DeclarativeHotplugVolumes';

/** The gate's state as KubeVirt computes it (featuregate.IsEnabled), without the hot-plug precedence. */
function rawState(kv: Obj | null | undefined, name: string): GateState {
  const listed = listedGates(kv).includes(name);
  const disabled = disabledGates(kv).includes(name);
  const table = gateTable(kv);
  const maturity = table?.gates[name] ?? null;
  let on: boolean | null;
  let byDefault = false;
  let note: string | undefined;
  if (!table) on = listed ? true : disabled ? false : null;
  else
    switch (maturity) {
      case 'GA':
        on = true;
        byDefault = true;
        if (listed || disabled) note = `${disabled ? 'Listed in disabledFeatureGates, but' : 'Listed in the KubeVirt resource, but'} always on: the entry can go.`;
        break;
      case 'Discontinued':
        on = false;
        if (listed) note = 'Removed from KubeVirt: the entry does nothing.';
        break;
      case 'Beta':
        byDefault = table.betaOnByDefault;
        on = listed || (table.betaOnByDefault && !disabled);
        break;
      case null:
        on = false;
        if (listed || disabled) note = `KubeVirt ${table.version} does not know this gate: the entry does nothing.`;
        break;
      default:
        on = listed;
    }
  return { name, maturity, listed, disabled, on, byDefault, note };
}

export function gateState(kv: Obj | null | undefined, name: string): GateState {
  const s = rawState(kv, name);
  // KubeVirt's VM controller skips declarative hot-plug while the old gate is on.
  if (name === HOTPLUG_DECLARATIVE && s.on && rawState(kv, HOTPLUG_OLD).on) {
    return { ...s, on: false, note: `${HOTPLUG_OLD} is also on and takes precedence: turn it off.` };
  }
  return s;
}

export interface GateLists {
  featureGates: string[];
  disabledFeatureGates: string[];
}

/**
 * The gate lists after turning `name` on or off, as KubeVirt reads them
 * (`kv` gives the version): an Alpha gate goes in or out of featureGates; a
 * Beta gate that is on by default (v1.9 on) is turned off through
 * disabledFeatureGates; a gate is never in both lists. The two hot-plug
 * gates are never on together (the old one would win): turning one on turns
 * the other off. `removed` names what else went off.
 */
export function nextGates(kv: Obj | null | undefined, name: string, on: boolean): GateLists & { removed: string[] } {
  const table = gateTable(kv);
  let featureGates = [...listedGates(kv)];
  let disabledFeatureGates = [...disabledGates(kv)];
  const removed: string[] = [];
  const set = (gate: string, want: boolean) => {
    const defaultOn = rawState(kv, gate).maturity === 'Beta' && !!table?.betaOnByDefault;
    disabledFeatureGates = disabledFeatureGates.filter(g => g !== gate);
    if (want) {
      if (!defaultOn && !featureGates.includes(gate)) featureGates.push(gate);
    } else {
      featureGates = featureGates.filter(g => g !== gate);
      if (defaultOn) disabledFeatureGates.push(gate);
    }
  };
  if (on) {
    const rival = name === HOTPLUG_DECLARATIVE ? HOTPLUG_OLD : name === HOTPLUG_OLD ? HOTPLUG_DECLARATIVE : null;
    if (rival && rawState(kv, rival).on) {
      set(rival, false);
      removed.push(rival);
    }
  }
  set(name, on);
  return { featureGates, disabledFeatureGates: table?.disabledList || disabledGates(kv).length ? disabledFeatureGates : [], removed };
}

/* ------------------------------------------------ what Hangar does with them */

export type GateArea = 'disks' | 'devices' | 'sharing' | 'compute' | 'network';

export interface HangarFeature {
  gate: string;
  area: GateArea;
  /** What it unlocks, in Hangar's words. */
  unlocks: string;
  /** Where in Hangar. */
  where: string;
  /** More to know before turning it on. */
  note?: string;
  /** VMs that use it (their spec), to say what turning it off affects. */
  uses?: (vm: Obj) => boolean;
}

const dom = (vm: Obj) => vm?.spec?.template?.spec?.domain ?? {};
const devs = (vm: Obj) => dom(vm).devices ?? {};
const vols = (vm: Obj): any[] => vm?.spec?.template?.spec?.volumes ?? [];
const fsVolumes = (vm: Obj) => {
  const names = new Set((devs(vm).filesystems ?? []).map((f: any) => f.name));
  return vols(vm).filter(v => names.has(v.name));
};

export const HANGAR_FEATURES: HangarFeature[] = [
  {
    gate: HOTPLUG_DECLARATIVE,
    area: 'disks',
    unlocks: 'Add and remove disks, insert and eject CD/DVDs while a VM runs',
    where: 'Configure → Disks and CD/DVD',
    note: `Keep ${HOTPLUG_OLD} off: with both on, KubeVirt uses the old one and Hangar cannot hot-plug.`,
    uses: vm =>
      vols(vm).some(v => v.dataVolume?.hotpluggable || v.persistentVolumeClaim?.hotpluggable) ||
      (devs(vm).disks ?? []).some((d: any) => d.cdrom && !vols(vm).some(v => v.name === d.name)),
  },
  {
    gate: 'ExpandDisks',
    area: 'disks',
    unlocks: 'A running VM sees its disk grow at once',
    where: 'Configure → Disks and CD/DVD → Expand',
  },
  {
    gate: 'Snapshot',
    area: 'disks',
    unlocks: 'Take and revert snapshots',
    where: 'VM → Snapshots',
  },
  {
    gate: HOTPLUG_OLD,
    area: 'disks',
    unlocks: "KubeVirt's older disk hot-plug (virtctl addvolume)",
    where: 'Not used by Hangar',
    note: `Hangar hot-plugs with ${HOTPLUG_DECLARATIVE}. With both on, this one wins and Hangar's hot-plug stops working.`,
  },
  {
    gate: 'HostDevices',
    area: 'devices',
    unlocks: 'Give host devices (PCI, GPU, vGPU, USB) to VMs',
    where: 'Hosts → Hardware, Configure → Host devices',
    uses: vm => !!(devs(vm).hostDevices?.length || devs(vm).gpus?.length),
  },
  {
    gate: 'VideoConfig',
    area: 'devices',
    unlocks: 'Choose the video card (VirtIO, VGA, Bochs, ramfb)',
    where: 'Configure → Devices',
    uses: vm => !!devs(vm).video,
  },
  {
    gate: 'PanicDevices',
    area: 'devices',
    unlocks: 'A crash-report device (pvpanic): guest crashes show as events',
    where: 'Configure → Devices',
    uses: vm => !!devs(vm).panicDevices?.length,
  },
  {
    gate: 'VSOCK',
    area: 'devices',
    unlocks: 'Host–guest sockets (VSOCK) for agents that talk without a network',
    where: 'Configure → Devices',
    uses: vm => devs(vm).autoattachVSOCK === true,
  },
  {
    gate: 'DownwardMetrics',
    area: 'devices',
    unlocks: "Host metrics inside the guest (vm-dump-metrics), like VMware's guest stats",
    where: 'Configure → Devices',
    note: 'The guest learns facts about its host (CPU and memory usage of the host).',
    uses: vm => !!devs(vm).downwardMetrics || vols(vm).some(v => v.downwardMetrics),
  },
  {
    gate: 'CPUManager',
    area: 'compute',
    unlocks: 'Dedicated CPUs: hosts report whether they can pin CPUs to VMs',
    where: 'Flavors (dedicated CPUs), Configure → CPU',
    uses: vm => !!dom(vm).cpu?.dedicatedCpuPlacement,
  },
  {
    gate: 'EnableVirtioFsStorageVolumes',
    area: 'sharing',
    unlocks: 'Share a disk with the guest as a folder (virtiofs)',
    where: 'Configure → Shared folders',
    uses: vm => fsVolumes(vm).some(v => v.persistentVolumeClaim || v.dataVolume),
  },
  {
    gate: 'EnableVirtioFsConfigVolumes',
    area: 'sharing',
    unlocks: 'Share ConfigMaps and Secrets with the guest as read-only folders',
    where: 'Configure → Shared folders',
    uses: vm => fsVolumes(vm).some(v => v.configMap || v.secret || v.serviceAccount || v.downwardAPI),
  },
  {
    gate: 'Sidecar',
    area: 'sharing',
    unlocks: 'Clipboard sharing with the console',
    where: 'Configure → Clipboard sharing',
    note: 'Cluster-wide: anyone who may edit VMs can then add hook sidecars to them.',
    uses: vm => !!vm?.spec?.template?.metadata?.annotations?.['hooks.kubevirt.io/hookSidecars'],
  },
  // GA in v1.7: always on, listed for what they unlock and what else they need.
  {
    gate: 'VMLiveUpdateFeatures',
    area: 'compute',
    unlocks: 'Add CPUs and memory to a running VM',
    where: 'Configure → CPU and memory',
    note: 'Needs the LiveMigrate update method and live updates (below): KubeVirt moves the VM to a bigger slot on a host.',
  },
  {
    gate: 'VMPersistentState',
    area: 'compute',
    unlocks: 'Keep UEFI variables and the TPM across power cycles',
    where: 'Configure → CPU, memory and firmware',
  },
  {
    gate: 'VolumeMigration',
    area: 'disks',
    unlocks: 'Move disks to another datastore while the VM runs',
    where: 'Configure → Disks → Move',
    note: 'Needs the LiveMigrate update method (below).',
  },
  {
    gate: 'HotplugNICs',
    area: 'network',
    unlocks: 'Add and remove bridged network adapters while a VM runs',
    where: 'Configure → Network adapters',
  },
  {
    gate: 'LiveMigration',
    area: 'compute',
    unlocks: 'Move running VMs between hosts',
    where: 'VM → Migrate, host maintenance mode',
  },
  {
    gate: 'GPU',
    area: 'devices',
    unlocks: 'GPU passthrough',
    where: 'Configure → Host devices',
  },
];

export function hangarFeature(gate: string): HangarFeature | undefined {
  return HANGAR_FEATURES.find(f => f.gate === gate);
}

/** VMs whose spec uses the feature behind the gate. */
export function vmsUsingGate(vms: Obj[], gate: string): Obj[] {
  const f = hangarFeature(gate);
  return f?.uses ? vms.filter(v => f.uses!(v)) : [];
}

export interface GateRow extends GateState {
  feature?: HangarFeature;
}

/**
 * Every gate to show: Hangar's (in catalog order), then the others listed
 * in the KubeVirt resource, then the rest of the version's table.
 */
export function gateRows(kv: Obj | null | undefined): { hangar: GateRow[]; listedOther: GateRow[]; other: GateRow[] } {
  const known = new Set(HANGAR_FEATURES.map(f => f.gate));
  const hangar = HANGAR_FEATURES.map(f => ({ ...gateState(kv, f.gate), feature: f }));
  const listed = listedGates(kv).filter(g => !known.has(g));
  const listedOther = [...new Set(listed)].map(g => gateState(kv, g));
  const table = gateTable(kv);
  const other = Object.keys(table?.gates ?? {})
    .filter(g => !known.has(g) && !listed.includes(g))
    .sort((a, b) => a.localeCompare(b))
    .map(g => gateState(kv, g));
  return { hangar, listedOther, other };
}

/** Problems with the gate list as written. */
export function gateProblems(kv: Obj | null | undefined): string[] {
  const listed = listedGates(kv);
  const out: string[] = [];
  if (rawState(kv, HOTPLUG_OLD).on && rawState(kv, HOTPLUG_DECLARATIVE).on)
    out.push(`${HOTPLUG_OLD} and ${HOTPLUG_DECLARATIVE} are both on: KubeVirt uses the old one, so disks cannot be hot-plugged from Hangar. Turn ${HOTPLUG_OLD} off.`);
  for (const g of listed) {
    const s = gateState(kv, g);
    if (s.maturity === 'Discontinued') out.push(`${g} was removed from KubeVirt: the entry does nothing.`);
    if (s.disabled) out.push(`${g} is in both featureGates and disabledFeatureGates of the KubeVirt resource: KubeVirt turns it on; remove one entry.`);
  }
  return out;
}

/* --------------------------------------------- cluster settings next to them */

export interface ClusterSettings {
  /** spec.workloadUpdateStrategy.workloadUpdateMethods has LiveMigrate. */
  liveMigrateUpdates: boolean;
  workloadUpdateMethods: string[];
  /** spec.configuration.vmRolloutStrategy, KubeVirt's default LiveUpdate. */
  rollout: 'LiveUpdate' | 'Stage';
  rolloutSet: boolean;
  /** liveUpdateConfiguration: hot-add ceilings. */
  maxHotplugRatio: number;
  maxCpuSockets?: number;
  maxGuest?: string;
  /** Where persistent UEFI/TPM state lives; undefined: KubeVirt's fallback. */
  vmStateStorageClass?: string;
  evictionStrategy?: string;
}

export function clusterSettings(kv: Obj | null | undefined): ClusterSettings {
  const c = kv?.spec?.configuration ?? {};
  const methods: string[] = kv?.spec?.workloadUpdateStrategy?.workloadUpdateMethods ?? [];
  const lu = c.liveUpdateConfiguration ?? {};
  return {
    liveMigrateUpdates: methods.includes('LiveMigrate'),
    workloadUpdateMethods: methods,
    rollout: c.vmRolloutStrategy === 'Stage' ? 'Stage' : 'LiveUpdate',
    rolloutSet: !!c.vmRolloutStrategy,
    maxHotplugRatio: Number(lu.maxHotplugRatio) || 4,
    maxCpuSockets: lu.maxCpuSockets,
    maxGuest: lu.maxGuest,
    vmStateStorageClass: c.vmStateStorageClass || undefined,
    evictionStrategy: c.evictionStrategy,
  };
}

/**
 * The datastore KubeVirt uses for persistent UEFI/TPM state, as KubeVirt
 * picks it (pkg/storage/backend-storage): vmStateStorageClass, else the
 * default VM datastore, else the cluster default. Without
 * vmStateStorageClass the state disk is single-host (RWO) unless the
 * datastore's profile offers RWX, so such VMs cannot move live.
 */
export function vmStateDatastore(kv: Obj | null | undefined, storageClasses: Obj[]): { name?: string; how: 'set' | 'virt-default' | 'default' | 'none' } {
  const set = clusterSettings(kv).vmStateStorageClass;
  if (set) return { name: set, how: 'set' };
  const ann = (s: Obj, k: string) => s.metadata.annotations?.[k] === 'true';
  const virt = storageClasses.find(s => ann(s, 'storageclass.kubevirt.io/is-default-virt-class'));
  if (virt) return { name: virt.metadata.name, how: 'virt-default' };
  const def = storageClasses.find(s => ann(s, 'storageclass.kubernetes.io/is-default-class'));
  if (def) return { name: def.metadata.name, how: 'default' };
  return { how: 'none' };
}

/**
 * The access mode KubeVirt gives the VM state disk (backend-storage
 * getAccessMode, filesystem mode): from the datastore's profile, RWX first;
 * without a profile RWX when vmStateStorageClass is set, RWO otherwise.
 */
export function vmStateAccess(kv: Obj | null | undefined, storageProfiles: Obj[], storageClass: string | undefined): 'RWX' | 'RWO' {
  const fallback = clusterSettings(kv).vmStateStorageClass ? 'RWX' : 'RWO';
  const sp = storageProfiles.find(p => p.metadata.name === storageClass);
  const sets: any[] = sp?.status?.claimPropertySets ?? [];
  let rwo = false;
  for (const s of sets) {
    if ((s.volumeMode ?? '') !== 'Filesystem' || !s.accessModes) continue;
    if (s.accessModes.includes('ReadWriteMany')) return 'RWX';
    if (s.accessModes.includes('ReadWriteOnce')) rwo = true;
  }
  return rwo ? 'RWO' : fallback;
}
