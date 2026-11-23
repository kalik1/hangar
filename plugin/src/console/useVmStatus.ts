/*
 * The VM and its running instance, watched by name (Headlamp's list hooks
 * with a field selector: a list, then a watch, so the instance appearing
 * and disappearing is seen), reduced to what a console needs.
 */

import { useMemo } from 'react';
import { VirtualMachine, VirtualMachineInstance } from '../api/resources';
import type { Obj } from '../model/types';
import { powerState } from '../model/vm';
import type { VmStatus } from './view';

export interface ConsoleVmStatus extends VmStatus {
  vm: Obj | null;
  vmi: Obj | null;
  /** UID of the running instance: changes when the VM restarts. */
  vmiUid?: string;
  /** When the instance entered the Running phase (ms), if it says. */
  runningSince?: number;
}

function runningSince(vmi: Obj | null): number | undefined {
  const ts = (
    vmi?.status?.phaseTransitionTimestamps as
      | { phase?: string; phaseTransitionTimestamp?: string }[]
      | undefined
  )
    ?.filter(p => p.phase === 'Running')
    .map(p => Date.parse(p.phaseTransitionTimestamp ?? ''))
    .filter(n => !Number.isNaN(n));
  return ts?.length ? Math.max(...ts) : undefined;
}

function first(res: any): { item: Obj | null; loaded: boolean; error: any } {
  const items: any[] | null = res?.items ?? null;
  const error = res?.error ?? null;
  const raw = items?.[0];
  return {
    item: raw ? ((raw.jsonData ?? raw) as Obj) : null,
    loaded: items !== null || !!error,
    error,
  };
}

function errorMessage(err: any): string {
  const status = err?.status;
  const msg = String(err?.message ?? err ?? 'Request failed');
  if (status === 403) return 'You are not allowed to read this VM.';
  return msg;
}

/** The instance runs, so its console can answer. */
export function isConsoleAvailable(vmi: Obj | null | undefined): boolean {
  return !!vmi && vmi.status?.phase === 'Running' && !vmi.metadata.deletionTimestamp;
}

export function useVmStatus(namespace: string, name: string, cluster?: string): ConsoleVmStatus {
  const query = {
    namespace,
    cluster: cluster || undefined,
    fieldSelector: `metadata.name=${name}`,
  };
  const vmRes = first((VirtualMachine as any).useList(query));
  const vmiRes = first((VirtualMachineInstance as any).useList(query));

  const vm = vmRes.item;
  const vmi = vmiRes.item;
  const vmSig = `${vm?.metadata.uid}:${vm?.metadata.resourceVersion}`;
  const vmiSig = `${vmi?.metadata.uid}:${vmi?.metadata.resourceVersion}`;
  const loaded = vmRes.loaded && vmiRes.loaded;
  const error = vmRes.error && vmRes.error.status !== 404 ? errorMessage(vmRes.error) : undefined;

  return useMemo(() => {
    const available = isConsoleAvailable(vmi);
    return {
      loaded,
      missing: loaded && !error && !vm,
      error,
      vm,
      vmi,
      vmiUid: available ? vmi?.metadata.uid : undefined,
      runningSince: available ? runningSince(vmi) : undefined,
      power: vm ? powerState(vm as any, vmi as any) : null,
      available,
      stopping:
        !!vmi &&
        (!!vmi.metadata.deletionTimestamp || ['Succeeded', 'Failed'].includes(vmi.status?.phase)),
    };
    // Headlamp may hand back new objects on every render: key on what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmSig, vmiSig, loaded, error]);
}
