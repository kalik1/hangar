/*
 * In-page console windows: Headlamp Activities (floating windows with a
 * taskbar). The console normally opens in its own browser window (popup.ts);
 * this is the fallback when the browser blocks pop-ups.
 */

import { Icon } from '@iconify/react';
import { Activity } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import React from 'react';
import { ConsoleKind, consoleWindowId } from './paths';
import { SerialConsole } from './SerialConsole';
import { resolveCluster } from './useConsoleSession';
import { VncConsole } from './VncConsole';

export interface OpenConsoleWindowOptions {
  namespace: string;
  name: string;
  /** Defaults to the cluster of the current route; the window keeps it when the route changes. */
  cluster?: string;
  /** Graphical (default) or serial console. */
  kind?: ConsoleKind;
  /** Shown as "Power on" when the VM is off. */
  onRequestPowerOn?: () => void;
  /** Shown as "Resume" when the VM is paused. */
  onRequestResume?: () => void;
  /** A line above the console, e.g. why it opened here and not in its own window. */
  notice?: string;
}

function ConsoleWindowBody(
  props: Required<Pick<OpenConsoleWindowOptions, 'namespace' | 'name' | 'cluster' | 'kind'>> &
    Pick<OpenConsoleWindowOptions, 'onRequestPowerOn' | 'onRequestResume' | 'notice'>
) {
  const { kind, notice, ...rest } = props;
  // A window is opened to be used: the keyboard goes to the console.
  const focus = { autoFocus: true };
  return (
    // The window body scrolls; the console fills it instead.
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        p: 1,
        overflow: 'hidden',
      }}
    >
      {notice && (
        <Box role="status" sx={{ fontSize: 13, px: 1, pb: 1, display: 'flex', gap: 0.75, alignItems: 'center' }}>
          <Icon icon="mdi:information-outline" width={16} />
          {notice}
        </Box>
      )}
      {kind === 'serial' ? (
        <SerialConsole {...rest} {...focus} />
      ) : (
        <VncConsole {...rest} {...focus} />
      )}
    </Box>
  );
}

/** Opens (or brings back) the console window of a VM. Returns the window id. */
export function openConsoleWindow(opts: OpenConsoleWindowOptions): string {
  const kind = opts.kind ?? 'vnc';
  const cluster = resolveCluster(opts.cluster);
  const id = consoleWindowId(cluster, opts.namespace, opts.name, kind);
  Activity.launch({
    id,
    title: kind === 'serial' ? `${opts.name} (serial)` : opts.name,
    icon: (
      <Icon
        icon={kind === 'serial' ? 'mdi:console-line' : 'mdi:monitor'}
        width="100%"
        height="100%"
      />
    ),
    location: 'window',
    cluster,
    content: (
      <ConsoleWindowBody
        namespace={opts.namespace}
        name={opts.name}
        cluster={cluster}
        kind={kind}
        onRequestPowerOn={opts.onRequestPowerOn}
        onRequestResume={opts.onRequestResume}
        notice={opts.notice}
      />
    ),
  });
  return id;
}

/** Closes a console window if it is open. */
export function closeConsoleWindow(
  opts: Pick<OpenConsoleWindowOptions, 'namespace' | 'name' | 'cluster' | 'kind'>
) {
  Activity.close(
    consoleWindowId(resolveCluster(opts.cluster), opts.namespace, opts.name, opts.kind ?? 'vnc')
  );
}
