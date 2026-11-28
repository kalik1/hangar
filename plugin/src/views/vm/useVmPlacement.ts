/*
 * A VM's placement verdicts (model/placement.ts) with the live data: what
 * the Migrate and Move disks dialogs decide from.
 */

import { useHangar } from '../../api/data';
import { last, useMetrics } from '../../api/metrics';
import { usePodMemoryRequests } from '../../api/move';
import { placement } from '../../model/placement';
import { Obj } from '../../model/types';
import { key } from '../../model/vm';

/** The placement verdicts of a VM with the live data. */
export function useVmPlacement(vm: Obj) {
  const d = useHangar();
  const m = useMetrics();
  const vmi = d.idx.vmi.get(key(vm)) ?? null;
  const podMemRequests = usePodMemoryRequests();
  const memUsed = new Map<string, number>();
  for (const n of d.nodes) {
    const u = last(m.hosts.get(n.metadata.name));
    if (u) memUsed.set(n.metadata.name, u.mem);
  }
  return placement({
    podMemRequests,
    vm: d.idx.vm.get(key(vm)) ?? vm,
    vmi,
    nodes: d.nodes,
    launchers: d.launchers,
    pvcs: d.idx.pvc,
    pvs: d.idx.pv,
    instancetypes: d.instancetypes,
    memUsed,
    clusterCpuModel: d.kubevirt?.spec?.configuration?.cpuModel,
  });
}
