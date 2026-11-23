/*
 * Shared by both consoles: watch the VM, run the session reducer, arm the
 * retry timer and answer "checking" with a look at the VM instance.
 */

import { ApiProxy, Utils } from '@kinvolk/headlamp-plugin/lib';
import { useCallback, useEffect, useReducer } from 'react';
import { backoffDelay } from './backoff';
import { vmiPath } from './paths';
import { CheckResult, initialSession, SessionEvent, sessionReducer, SessionState } from './session';
import { isConsoleAvailable, useVmStatus } from './useVmStatus';
import { ConsoleKindName, screenView } from './view';

/** How often a console held elsewhere checks, politely, whether it is free. */
const IN_USE_POLL_MS = 10000;

/** The given cluster, or the one of the current route. */
export function resolveCluster(cluster?: string): string {
  return cluster || (Utils.getCluster?.() as string | null) || '';
}

/** Is the instance still running? Then a refused polite reconnect means someone else holds the console. */
async function checkInstance(
  namespace: string,
  name: string,
  cluster: string
): Promise<CheckResult> {
  try {
    const vmi = await ApiProxy.clusterRequest(vmiPath(namespace, name), {
      cluster,
      autoLogoutOnAuthError: false,
      timeout: 10000,
    } as any);
    return isConsoleAvailable(vmi) ? 'in-use' : 'not-running';
  } catch (err) {
    return (err as { status?: number })?.status === 404 ? 'not-running' : 'unreachable';
  }
}

export function useConsoleSession(
  namespace: string,
  name: string,
  cluster: string,
  kind: ConsoleKindName
) {
  const vm = useVmStatus(namespace, name, cluster);
  const canPreserve = kind === 'vnc';
  const [session, dispatch] = useReducer(
    (s: SessionState, e: SessionEvent) => sessionReducer(s, e, { canPreserve }),
    undefined,
    initialSession
  );

  useEffect(() => {
    if (!vm.loaded) return;
    dispatch({
      type: 'vmi',
      available: vm.available,
      uid: vm.vmiUid,
      since: vm.runningSince,
      now: Date.now(),
    });
    // runningSince belongs to the instance: it changes with vmiUid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.loaded, vm.available, vm.vmiUid]);

  useEffect(() => {
    if (session.phase !== 'retrying') return;
    const id = setTimeout(() => dispatch({ type: 'retry' }), backoffDelay(session.failures));
    return () => clearTimeout(id);
  }, [session.phase, session.failures]);

  useEffect(() => {
    if (session.phase !== 'checking') return;
    let cancelled = false;
    // Give a stopping VM a moment to say so.
    const id = setTimeout(async () => {
      const result = await checkInstance(namespace, name, cluster);
      if (!cancelled) dispatch({ type: 'checked', result });
    }, 1000);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [session.phase, session.epoch, namespace, name, cluster]);

  // Held elsewhere: look politely now and then, to come back when it is free.
  useEffect(() => {
    if (!canPreserve || session.phase !== 'stopped' || session.reason !== 'in-use') return;
    const id = setTimeout(() => dispatch({ type: 'poll' }), IN_USE_POLL_MS);
    return () => clearTimeout(id);
  }, [canPreserve, session.phase, session.reason, session.epoch]);

  const reconnect = useCallback(() => dispatch({ type: 'reconnect' }), []);

  return { vm, session, dispatch, reconnect, view: screenView(vm, session, kind) };
}
