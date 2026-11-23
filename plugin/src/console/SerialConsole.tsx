/*
 * The serial console: xterm.js on KubeVirt's `console` subresource (raw
 * bytes both ways), through Headlamp's proxy and auth. The terminal and
 * its scrollback outlive reconnections; markers in the output say when
 * the session dropped and came back.
 */

import '@xterm/xterm/css/xterm.css';
import Box from '@mui/material/Box';
import { FitAddon } from '@xterm/addon-fit';
import { ITheme, Terminal } from '@xterm/xterm';
import React from 'react';
import { Led } from '../ui/Led';
import { HangarTokens, LED } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import { ConsoleChannel } from './channel';
import { writeHostClipboard } from './ClipboardTray';
import {
  Bezel,
  CHASSIS_FOCUS,
  ConsoleShell,
  ConsoleToolbar,
  KeyboardIndicator,
  ScreenNotice,
  StatusReadout,
  ToolbarDivider,
  ToolbarSpacer,
  ToolButton,
  ToolTextButton,
} from './parts';
import { serialPath } from './paths';
import { resolveCluster, useConsoleSession } from './useConsoleSession';
import { ACTION_LABEL, ScreenMessage } from './view';

export interface SerialConsoleProps {
  namespace: string;
  name: string;
  /** Defaults to the cluster of the current route. */
  cluster?: string;
  /** Give the keyboard to the terminal as soon as it connects. */
  autoFocus?: boolean;
  /** Shown as "Power on" when the VM is off. */
  onRequestPowerOn?: () => void;
  /** Shown as "Resume" when the VM is paused. */
  onRequestResume?: () => void;
  /** The smallest height of the whole unit (toolbar + screen); 260 px by default. */
  minHeight?: number;
}

const CONNECT_TIMEOUT_MS = 20000;

export function terminalTheme(t: HangarTokens): ITheme {
  return {
    background: t.screen,
    foreground: '#D6DCE1',
    cursor: '#D6DCE1',
    cursorAccent: t.screen,
    selectionBackground: 'rgba(61,139,253,0.40)',
    black: '#1B2126',
    red: LED.fault,
    green: LED.on,
    yellow: LED.standby,
    blue: LED.busy,
    magenta: '#B98AE8',
    cyan: '#3FB8C4',
    white: '#C8D0D7',
    brightBlack: '#5C6770',
    brightRed: '#FF7B7F',
    brightGreen: '#5FE09A',
    brightYellow: '#F5C46E',
    brightBlue: '#76AEFF',
    brightMagenta: '#D3B0F5',
    brightCyan: '#77D9E2',
    brightWhite: '#F2F5F7',
  };
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const clock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The Clipboard API on https; on plain http a copy command, which keeps the terminal's focus. */
const copyText = (text: string) => writeHostClipboard(text);

/** A message in a bar under the output, so what was printed stays readable. */
function SerialBanner({ message, onAction }: { message: ScreenMessage; onAction?: () => void }) {
  const t = useTokens();
  return (
    <Box
      sx={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.5,
        py: 0.75,
        background: 'rgba(20,24,27,0.94)',
        borderTop: `1px solid ${t.chassisEdge}`,
        color: t.chassisText,
        fontSize: 13,
      }}
    >
      <Led tone={message.tone} />
      <Box component="span" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
        {message.title}
      </Box>
      {message.detail && (
        <Box
          component="span"
          sx={{
            color: t.chassisMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {message.detail}
        </Box>
      )}
      <Box sx={{ flex: 1 }} />
      {onAction && message.action && (
        <Box
          component="button"
          type="button"
          onClick={onAction}
          sx={{
            font: 'inherit',
            fontWeight: 600,
            color: '#fff',
            background: CHASSIS_FOCUS,
            border: 'none',
            borderRadius: '4px',
            px: 1.25,
            py: 0.5,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            '&:focus-visible': { outline: `2px solid #fff`, outlineOffset: '1px' },
          }}
        >
          {ACTION_LABEL[message.action]}
        </Box>
      )}
    </Box>
  );
}

export function SerialConsole(props: SerialConsoleProps) {
  const { namespace, name, autoFocus = false, onRequestPowerOn, onRequestResume } = props;
  const cluster = resolveCluster(props.cluster);
  const t = useTokens();
  const { session, dispatch, reconnect, view } = useConsoleSession(
    namespace,
    name,
    cluster,
    'serial'
  );

  const hostRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const channelRef = React.useRef<ConsoleChannel | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [hasSelection, setHasSelection] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [hasOutput, setHasOutput] = React.useState(false);
  const live = React.useRef({ autoFocus });
  live.current = { autoFocus };

  // The terminal: created once.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: terminalTheme(t),
      fontFamily: t.font.mono,
      fontSize: 13.5,
      lineHeight: 1.15,
      scrollback: 5000,
      cursorBlink: false,
      convertEol: false,
      disableStdin: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const send = (data: string | Uint8Array) => channelRef.current?.send(data);
    const subs = [
      term.onData(data => send(data)),
      term.onBinary(data => send(Uint8Array.from(data, c => c.charCodeAt(0) & 0xff))),
      term.onSelectionChange(() => setHasSelection(term.hasSelection())),
    ];
    term.attachCustomKeyEventHandler(ev => {
      // Ctrl+Shift+C copies, Ctrl+Shift+V pastes (the browser does): Ctrl+C stays an interrupt.
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        if (term.hasSelection()) copyText(term.getSelection());
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') return false;
      return true;
    });

    const refit = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          // Not laid out yet.
        }
      }
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host);

    const update = () =>
      setFocused(!!document.activeElement && host.contains(document.activeElement));
    host.addEventListener('focusin', update);
    host.addEventListener('focusout', update);

    return () => {
      ro.disconnect();
      host.removeEventListener('focusin', update);
      host.removeEventListener('focusout', update);
      subs.forEach(s => s.dispose());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Created once; the theme is updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(t);
  }, [t]);

  const active = session.phase === 'connecting' || session.phase === 'connected';

  // One connection per epoch.
  React.useEffect(() => {
    const term = termRef.current;
    if (!active || !term) return;
    const epoch = session.epoch;
    const again = session.wasConnected;
    const channel = new ConsoleChannel({ path: serialPath(namespace, name), cluster });
    channelRef.current = channel;
    let disposed = false;
    const watchdog = setTimeout(() => channel.close(), CONNECT_TIMEOUT_MS);
    // Split UTF-8 sequences are fine: xterm decodes a byte stream.
    channel.onmessage = e => {
      term.write(new Uint8Array(e.data));
      setHasOutput(true);
    };
    channel.onopen = () => {
      clearTimeout(watchdog);
      term.options.disableStdin = false;
      term.write(
        (again ? '\r\n' : '') +
          dim(
            again
              ? `[Reconnected ${clock()}]`
              : `[Serial console of ${name}. Press Enter for a prompt.]`
          ) +
          '\r\n'
      );
      dispatch({ type: 'opened', epoch });
      if (live.current.autoFocus) term.focus();
    };
    channel.onclose = () => {
      clearTimeout(watchdog);
      term.options.disableStdin = true;
      if (disposed) return;
      if (channel.opened) term.write('\r\n' + dim(`[Disconnected ${clock()}]`) + '\r\n');
      dispatch({ type: 'closed', epoch, opened: channel.opened, now: Date.now() });
    };
    return () => {
      disposed = true;
      clearTimeout(watchdog);
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
      term.options.disableStdin = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, session.epoch]);

  const connected = session.phase === 'connected';

  const copy = async () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    if (await copyText(term.getSelection())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
    term.focus();
  };

  const clear = () => {
    termRef.current?.clear();
    termRef.current?.focus();
  };

  const actions = {
    'power-on': onRequestPowerOn,
    reconnect,
    'take-over': reconnect,
    resume: onRequestResume,
  };
  // Over the output while there is something to read in it; over an empty screen otherwise.
  const banner = view.message && hasOutput && !view.message.translucent;

  return (
    <ConsoleShell label={`Serial console of ${name}`} minHeight={props.minHeight}>
      <ConsoleToolbar label="Serial console controls">
        <StatusReadout tone={view.status.tone} label={view.status.label} />
        <ToolbarSpacer />
        <ToolTextButton
          icon="mdi:content-copy"
          label={copied ? 'Copied' : 'Copy'}
          onClick={copy}
          disabled={!hasSelection}
          tooltip={
            hasSelection
              ? 'Copy the selection (Ctrl+Shift+C)'
              : 'Select text in the terminal to copy it'
          }
        />
        <ToolTextButton
          icon="mdi:eraser"
          label="Clear"
          onClick={clear}
          tooltip="Clear the screen and the scrollback"
        />
        <ToolButton
          icon="mdi:refresh"
          label="Reconnect"
          tooltip={
            session.available
              ? 'Reconnect, taking over the serial console'
              : 'Available when the VM is running'
          }
          onClick={reconnect}
          disabled={!session.available}
        />
        <ToolbarDivider />
        <KeyboardIndicator
          captured={focused}
          disabled={!connected}
          onCapture={() => termRef.current?.focus()}
          onRelease={() => termRef.current?.blur()}
        />
      </ConsoleToolbar>
      <Bezel focused={focused}>
        <Box
          ref={hostRef}
          sx={{
            position: 'absolute',
            inset: '4px 0 4px 8px',
            '& .xterm-viewport': {
              scrollbarColor: `${t.bezel} ${t.screen}`,
              scrollbarWidth: 'thin',
            },
            '& .xterm:focus, & .xterm textarea:focus': { outline: 'none' },
          }}
        />
        {view.message && banner && (
          <SerialBanner
            message={view.message}
            onAction={view.message.action ? actions[view.message.action] : undefined}
          />
        )}
        {view.message && !banner && <ScreenNotice message={view.message} actions={actions} />}
      </Bezel>
    </ConsoleShell>
  );
}
