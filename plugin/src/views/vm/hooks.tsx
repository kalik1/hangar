/*
 * Hooks that connect VM actions to other modules: the console windows and
 * the snapshot dialog.
 */

import { Router } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import {
  consolePopupFeatures,
  consolePopupKey,
  consolePopupName,
  notePopupOpening,
  openConsoleWindow,
  openOrFocusPopup,
  POPUP_ROUTE_NAME,
  resolveCluster,
} from '../../console';
import { Obj } from '../../model/types';
import { openTakeSnapshot } from './SnapshotDialog';

const BLOCKED =
  'Your browser blocked the pop-up window, so the console opened inside the page. Allow pop-ups for this site to get it in its own window.';

/**
 * Opens a VM's console in its own browser window (one per VM: opening it
 * again brings that window back). Call it from a click handler, or browsers
 * block the pop-up; when they do, the console opens inside the page.
 */
export function useOpenConsole() {
  const history = useHistory();
  return React.useCallback(
    (vm: Obj, kind: 'vnc' | 'serial', opts: { focusOnly?: boolean } = {}) => {
      const namespace = vm.metadata.namespace as string;
      const name = vm.metadata.name;
      const cluster = resolveCluster();
      const href = history.createHref({ pathname: Router.createRouteURL(POPUP_ROUTE_NAME, { namespace, name, kind }) });
      const { result } = openOrFocusPopup(
        window as any,
        href,
        consolePopupName(cluster, namespace, name),
        consolePopupFeatures(kind, window.screen as any),
        opts
      );
      if (result !== 'blocked') {
        notePopupOpening(consolePopupKey(cluster, namespace, name));
        return;
      }
      openConsoleWindow({
        namespace,
        name,
        kind,
        notice: BLOCKED,
        onRequestPowerOn: () => A.powerOn(vm).catch(() => undefined),
        onRequestResume: () => A.resume(vm).catch(() => undefined),
      });
    },
    [history]
  );
}

/** Opens the snapshot dialog of a VM where you are (it says what is missing when snapshots cannot work). */
export function useTakeSnapshot() {
  return React.useCallback((vm: Obj) => openTakeSnapshot(vm), []);
}
