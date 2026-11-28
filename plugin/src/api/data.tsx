/*
 * HangarData: the live inventory every Hangar view reads. One provider
 * watches the lists (Headlamp's list hooks: a list, then a watch) and
 * builds the indexes views need. Kinds whose CRD is missing (snapshots,
 * Multus, nmstate…) come back as 404: `has` says which features exist.
 */

import { K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { checkUntil, tasks, UntilWorld } from '../model/tasks';
import { Obj } from '../model/types';
import { key, launcherVmName, powerState } from '../model/vm';
import { CephBlockPool, CephCluster } from './cephResources';
import { currentCluster } from './client';
import { advanceDiskMove } from './move';
import {
  CDIConfig,
  ClusterInstancetype,
  ClusterPreference,
  DataImportCron,
  DataSource,
  DataVolume,
  KubeVirt,
  NetworkAttachmentDefinition,
  NodeNetworkState,
  StorageProfile,
  VirtualMachine,
  VirtualMachineInstance,
  VirtualMachineInstanceMigration,
  VirtualMachineRestore,
  VirtualMachineSnapshot,
  VolumeSnapshotClass,
} from './resources';
import { VolumeSnapshot } from './storageResources';

export interface HangarData {
  cluster: string;
  vms: Obj[];
  vmis: Obj[];
  migrations: Obj[];
  nodes: Obj[];
  pvcs: Obj[];
  dvs: Obj[];
  storageClasses: Obj[];
  namespaces: Obj[];
  launchers: Obj[];
  snapshots: Obj[];
  restores: Obj[];
  dataSources: Obj[];
  nads: Obj[];
  instancetypes: Obj[];
  preferences: Obj[];
  storageProfiles: Obj[];
  snapshotClasses: Obj[];
  kubevirt: Obj | null;
  cdiConfig: Obj | null;
  /** nmstate's view of each host's network (empty without nmstate). */
  nodeNetworkStates: Obj[];
  dataImportCrons: Obj[];
  /** CSI VolumeSnapshots (the disks of VM snapshots). */
  volumeSnapshots: Obj[];
  /** PersistentVolumes: where each disk lives (a host, or shared storage). */
  pvs: Obj[];
  /** Rook-Ceph clusters and block pools (empty without Rook). */
  cephClusters: Obj[];
  cephPools: Obj[];
  /** By "namespace/name". */
  idx: {
    vm: Map<string, Obj>;
    vmi: Map<string, Obj>;
    pvc: Map<string, Obj>;
    dv: Map<string, Obj>;
    /** VM key → its virt-launcher pod (the running one). */
    launcher: Map<string, Obj>;
    /** VM key → migrations, newest first. */
    migrations: Map<string, Obj[]>;
    /** VM key → snapshots, newest first. */
    snapshots: Map<string, Obj[]>;
    node: Map<string, Obj>;
    /** VM key → reverts (VirtualMachineRestores), newest first. */
    restores: Map<string, Obj[]>;
    /** PV name → PV. */
    pv: Map<string, Obj>;
  };
  /** Optional features, from which lists answered. */
  has: {
    snapshots: boolean;
    nads: boolean;
    instancetypes: boolean;
    dataSources: boolean;
    metrics: boolean;
    /** nmstate's NodeNetworkState exists. */
    nmstate?: boolean;
    /** The CSI VolumeSnapshot API exists (external-snapshotter CRDs). */
    volumeSnapshots?: boolean;
    /** KubeVirt's VirtualMachineSnapshot API exists. */
    vmSnapshots?: boolean;
    dataImportCrons?: boolean;
    /** Rook-Ceph is installed (CephCluster API exists). */
    ceph?: boolean;
  };
  loading: boolean;
  /** The VM list itself failed (no KubeVirt, no permission). */
  fatal: { status?: number; message: string } | null;
  refresh: () => void;
}

const Ctx = React.createContext<HangarData | null>(null);

export function useHangar(): HangarData {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useHangar outside HangarDataProvider');
  return v;
}

function json(list: any[] | null | undefined): Obj[] {
  return (list ?? []).map((i: any) => (i?.jsonData ?? i) as Obj);
}

function useJsonList(cls: any, opts?: Record<string, any>): { items: Obj[]; error: any; loaded: boolean } {
  const res = cls.useList(opts ?? {});
  const items: any[] | null = (res as any).items ?? (res as any)[0] ?? null;
  const error = (res as any).error ?? (res as any)[1] ?? null;
  // Headlamp may hand back a new array on every render: key on what changed.
  const sig = items
    ? items.map(i => `${i?.metadata?.uid}:${i?.metadata?.resourceVersion}`).join(',')
    : 'null';
  const errSig = error ? `${error.status}:${error.message}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const out = React.useMemo(() => json(items), [sig]);
  const loaded = items !== null || !!error;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => ({ items: out, error, loaded }), [out, errSig, loaded]);
}

const newestFirst = (a: Obj, b: Obj) =>
  (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '');

const Lists = React.memo(function Lists({
  onData,
}: {
  onData: (d: Omit<HangarData, 'refresh' | 'cluster'>) => void;
}) {
  const R = K8s.ResourceClasses as any;
  const vms = useJsonList(VirtualMachine);
  const vmis = useJsonList(VirtualMachineInstance);
  const migrations = useJsonList(VirtualMachineInstanceMigration);
  const nodes = useJsonList(R.Node);
  const pvcs = useJsonList(R.PersistentVolumeClaim);
  const dvs = useJsonList(DataVolume);
  // Lists that rarely change are polled instead of watched: fewer WebSockets
  // (browsers cap them per host).
  const slow = { refetchInterval: 60000 };
  const scs = useJsonList(R.StorageClass, slow);
  const namespaces = useJsonList(R.Namespace);
  const launchers = useJsonList(R.Pod, { labelSelector: 'kubevirt.io=virt-launcher' });
  const snapshots = useJsonList(VirtualMachineSnapshot);
  const restores = useJsonList(VirtualMachineRestore);
  const dataSources = useJsonList(DataSource, slow);
  const nads = useJsonList(NetworkAttachmentDefinition, { refetchInterval: 20000 });
  const instancetypes = useJsonList(ClusterInstancetype, slow);
  const preferences = useJsonList(ClusterPreference, slow);
  const profiles = useJsonList(StorageProfile, slow);
  const vsc = useJsonList(VolumeSnapshotClass, slow);
  const kv = useJsonList(KubeVirt, slow);
  const cdi = useJsonList(CDIConfig, slow);
  const nns = useJsonList(NodeNetworkState, slow);
  const crons = useJsonList(DataImportCron, slow);
  const volumeSnapshots = useJsonList(VolumeSnapshot, { refetchInterval: 20000 });
  const pvs = useJsonList(R.PersistentVolume, { refetchInterval: 20000 });
  const cephClusters = useJsonList(CephCluster, { refetchInterval: 30000 });
  const cephPools = useJsonList(CephBlockPool, { refetchInterval: 30000 });

  const data = React.useMemo(() => {
    const idx = {
      vm: new Map(vms.items.map(o => [key(o), o])),
      vmi: new Map(vmis.items.map(o => [key(o), o])),
      pvc: new Map(pvcs.items.map(o => [key(o), o])),
      dv: new Map(dvs.items.map(o => [key(o), o])),
      launcher: new Map<string, Obj>(),
      migrations: new Map<string, Obj[]>(),
      snapshots: new Map<string, Obj[]>(),
      node: new Map(nodes.items.map(o => [o.metadata.name, o])),
      restores: new Map<string, Obj[]>(),
      pv: new Map(pvs.items.map(o => [o.metadata.name, o])),
    };
    for (const r of [...restores.items].sort(newestFirst)) {
      const k = `${r.metadata.namespace}/${r.spec?.target?.name}`;
      idx.restores.set(k, [...(idx.restores.get(k) ?? []), r]);
    }
    for (const p of launchers.items) {
      const vmName = launcherVmName(p);
      if (!vmName) continue;
      const k = `${p.metadata.namespace}/${vmName}`;
      const prev = idx.launcher.get(k);
      // Prefer the running pod; during a migration two exist.
      if (!prev || (p.status?.phase === 'Running' && prev.status?.phase !== 'Running')) idx.launcher.set(k, p);
    }
    for (const m of [...migrations.items].sort(newestFirst)) {
      const k = `${m.metadata.namespace}/${m.spec?.vmiName}`;
      idx.migrations.set(k, [...(idx.migrations.get(k) ?? []), m]);
    }
    for (const s of [...snapshots.items].sort(newestFirst)) {
      const k = `${s.metadata.namespace}/${s.spec?.source?.name}`;
      idx.snapshots.set(k, [...(idx.snapshots.get(k) ?? []), s]);
    }
    const missing = (e: any) => !!e && (e.status === 404 || /not found/i.test(String(e.message ?? '')));
    return {
      vms: vms.items,
      vmis: vmis.items,
      migrations: migrations.items,
      nodes: nodes.items,
      pvcs: pvcs.items,
      dvs: dvs.items,
      storageClasses: scs.items,
      namespaces: namespaces.items,
      launchers: launchers.items,
      snapshots: snapshots.items,
      restores: restores.items,
      dataSources: dataSources.items,
      nads: nads.items,
      instancetypes: instancetypes.items,
      preferences: preferences.items,
      storageProfiles: profiles.items,
      snapshotClasses: vsc.items,
      kubevirt: kv.items[0] ?? null,
      cdiConfig: cdi.items[0] ?? null,
      nodeNetworkStates: nns.items,
      dataImportCrons: crons.items,
      volumeSnapshots: volumeSnapshots.items,
      pvs: pvs.items,
      cephClusters: cephClusters.items,
      cephPools: cephPools.items,
      idx,
      has: {
        snapshots: !missing(snapshots.error) && !missing(vsc.error),
        nads: !missing(nads.error),
        instancetypes: !missing(instancetypes.error),
        dataSources: !missing(dataSources.error),
        metrics: true,
        nmstate: nns.loaded && !missing(nns.error),
        volumeSnapshots: !missing(vsc.error) && !missing(volumeSnapshots.error),
        vmSnapshots: !missing(snapshots.error),
        dataImportCrons: !missing(crons.error),
        ceph: cephClusters.loaded && !missing(cephClusters.error),
      },
      loading: !vms.loaded || !nodes.loaded,
      fatal: vms.error
        ? { status: vms.error.status, message: String(vms.error.message ?? vms.error) }
        : null,
    };
  }, [
    vms,
    vmis,
    migrations,
    nodes,
    pvcs,
    dvs,
    scs,
    namespaces,
    launchers,
    snapshots,
    restores,
    dataSources,
    nads,
    instancetypes,
    preferences,
    profiles,
    vsc,
    kv,
    cdi,
    nns,
    crons,
    volumeSnapshots,
    pvs,
    cephClusters,
    cephPools,
  ]);

  React.useEffect(() => onData(data), [data, onData]);
  return null;
});

/** Resolves running tasks against the live objects, and times them out. */
function useTaskResolver(d: HangarData | null) {
  React.useEffect(() => {
    if (!d || d.loading) return;
    const world: UntilWorld = {
      vmPower: (ns, name) => {
        const vm = d.idx.vm.get(`${ns}/${name}`);
        return vm ? powerState(vm, d.idx.vmi.get(`${ns}/${name}`)) : null;
      },
      migration: (ns, name) => d.migrations.find(m => m.metadata.namespace === ns && m.metadata.name === name) ?? null,
      dataVolume: (ns, name) => d.idx.dv.get(`${ns}/${name}`) ?? null,
      snapshot: (ns, name) => d.snapshots.find(s => s.metadata.namespace === ns && s.metadata.name === name) ?? null,
      restore: (ns, name) => d.restores.find(s => s.metadata.namespace === ns && s.metadata.name === name) ?? null,
      hostVmCount: name => d.vmis.filter(v => v.status?.nodeName === name).length,
      vmi: (ns, name) => d.idx.vmi.get(`${ns}/${name}`) ?? null,
      vm: (ns, name) => d.idx.vm.get(`${ns}/${name}`) ?? null,
      vmMigration: (ns, name) => d.idx.migrations.get(`${ns}/${name}`)?.[0] ?? null,
    };
    const tick = () => {
      const now = Date.now();
      for (const t of tasks.running()) {
        if (!t.until) continue;
        const elapsed = now - t.started;
        if (t.until.type === 'diskMove') {
          if (t.timeoutMs && elapsed > t.timeoutMs) tasks.update(t.id, { status: 'warning', message: 'Not confirmed yet: check the disks' });
          else advanceDiskMove(t, world);
          continue;
        }
        const r = checkUntil(t.until, world, elapsed);
        if (r && r.status !== 'running') tasks.update(t.id, { status: r.status, message: r.message, progress: r.progress });
        else if (t.timeoutMs && elapsed > t.timeoutMs)
          tasks.update(t.id, { status: 'warning', message: r?.message ? `Not confirmed yet (${r.message})` : 'Not confirmed yet: check the target' });
        else if (r && (r.progress !== undefined || r.message)) tasks.update(t.id, { progress: r.progress, ...(r.message ? { message: r.message } : {}) });
      }
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [d]);
}

export function HangarDataProvider({ children }: { children: React.ReactNode }) {
  const cluster = currentCluster();
  const [gen, setGen] = React.useState(0);
  const [data, setData] = React.useState<Omit<HangarData, 'refresh' | 'cluster'> | null>(null);
  const refresh = React.useCallback(() => setGen(g => g + 1), []);
  React.useEffect(() => {
    tasks.useCluster(cluster);
  }, [cluster]);
  const value = React.useMemo<HangarData | null>(
    () => (data ? { ...data, cluster, refresh } : null),
    [data, cluster, refresh]
  );
  useTaskResolver(value);
  return (
    <>
      <Lists key={`${cluster}-${gen}`} onData={setData} />
      {value ? <Ctx.Provider value={value}>{children}</Ctx.Provider> : <Ctx.Provider value={EMPTY(cluster, refresh)}>{children}</Ctx.Provider>}
    </>
  );
}

function EMPTY(cluster: string, refresh: () => void): HangarData {
  return {
    cluster,
    vms: [],
    vmis: [],
    migrations: [],
    nodes: [],
    pvcs: [],
    dvs: [],
    storageClasses: [],
    namespaces: [],
    launchers: [],
    snapshots: [],
    restores: [],
    dataSources: [],
    nads: [],
    instancetypes: [],
    preferences: [],
    storageProfiles: [],
    snapshotClasses: [],
    kubevirt: null,
    cdiConfig: null,
    nodeNetworkStates: [],
    dataImportCrons: [],
    volumeSnapshots: [],
    pvs: [],
    cephClusters: [],
    cephPools: [],
    idx: {
      vm: new Map(),
      vmi: new Map(),
      pvc: new Map(),
      dv: new Map(),
      launcher: new Map(),
      migrations: new Map(),
      snapshots: new Map(),
      node: new Map(),
      restores: new Map(),
      pv: new Map(),
    },
    has: { snapshots: false, nads: false, instancetypes: false, dataSources: false, metrics: false },
    loading: true,
    fatal: null,
    refresh,
  };
}

/** Subscribes to the task store. */
export function useTasks() {
  return React.useSyncExternalStore(tasks.subscribe, tasks.getSnapshot);
}
