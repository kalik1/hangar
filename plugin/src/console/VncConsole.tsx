/*
 * The graphical console: noVNC on KubeVirt's `vnc` subresource, through
 * Headlamp's proxy and auth (see channel.ts). It follows the VM: it
 * connects when the VM runs, says why when it cannot, and reconnects on
 * its own after a restart or a dropped connection. With a VirtIO video
 * card the VM's desktop can take the size of the window (resize.ts).
 */

import Box from '@mui/material/Box';
import RFB from '@novnc/novnc/core/rfb.js';
import React from 'react';
import * as A from '../api/actions';
import { useCan } from '../api/permissions';
import { ClipboardMode, clipboardMode, shouldSendToVm } from '../model/clipboard';
import { videoCards } from '../model/display';
import { VM } from '../model/types';
import { guestOs } from '../model/vm';
import { useTokens } from '../ui/useTokens';
import { ConsoleChannel } from './channel';
import { ClipboardTray, writeHostClipboard } from './ClipboardTray';
import { DesktopSizeReply, linkDesktopSize } from './desktopSize';
import { comboEvents, CTRL_ALT_DEL, KeyCombo, KEYS, planTyping, strokeEvents } from './keys';
import {
  Bezel,
  ConsoleShell,
  ConsoleToolbar,
  KeyboardIndicator,
  ScreenBanner,
  ScreenNotice,
  StatusReadout,
  ToolbarDivider,
  ToolbarSpacer,
  ToolButton,
  ToolTextButton,
} from './parts';
import { screenshotFileName, vncPath } from './paths';
import {
  BOOT_GRACE_MS,
  DesktopResizer,
  guestIgnoredMessage,
  readResizeChoice,
  refusalText,
  resizeAvailability,
  resizeChoiceKey,
  resizeOn,
  sameSize,
  scaleViewport,
  SERVER_WAIT_MS,
  ServerSupport,
  Size,
  SWITCH_LABEL,
  switchTooltip,
  unavailableReason,
  writeResizeChoice,
} from './resize';
import { SendKeyMenu } from './SendKeyMenu';
import { TypeTextDialog } from './TypeTextDialog';
import { resolveCluster, useConsoleSession } from './useConsoleSession';

export interface VncConsoleProps {
  namespace: string;
  /** The VM (and its instance) name. */
  name: string;
  /** Defaults to the cluster of the current route. */
  cluster?: string;
  /** Give the keyboard to the VM as soon as the console connects. */
  autoFocus?: boolean;
  /** Shown as "Power on" when the VM is off. */
  onRequestPowerOn?: () => void;
  /** Shown as "Resume" when the VM is paused. */
  onRequestResume?: () => void;
  /** The smallest height of the whole unit (toolbar + screen); 260 px by default. */
  minHeight?: number;
}

/** Give up on a handshake after this long. */
const CONNECT_TIMEOUT_MS = 20000;
/** Pause between typed characters: slow enough for a guest's keyboard buffer. */
const TYPE_DELAY_MS = 12;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** After Ctrl+C/X in the console, text the VM copies goes to this computer's clipboard for this long (a user gesture lasts ~5 s). */
const COPY_GESTURE_MS = 4000;
/** If the browser fires no paste event, the shortcut still reaches the VM after this long. */
const PASTE_FALLBACK_MS = 400;
/** Time for the VM's agent to take the new clipboard before the paste shortcut. */
const PASTE_SETTLE_MS = 150;

type PasteKey = { shift: boolean; insert: boolean };

/** The guest's paste shortcut, pressed and released (noVNC let go of the held keys when the screen lost focus). */
function pasteCombo(k: PasteKey): KeyCombo {
  const V = { keysym: 0x76, code: 'KeyV' };
  const Insert = { keysym: 0xff63, code: 'Insert' };
  return k.insert
    ? { id: 'paste', label: 'Shift+Insert', keys: [KEYS.ShiftLeft, Insert] }
    : { id: 'paste', label: 'Ctrl+V', keys: k.shift ? [KEYS.ControlLeft, KEYS.ShiftLeft, V] : [KEYS.ControlLeft, V] };
}

type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
const keyboardApi = () => (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;

/** The size of the console's screen in CSS pixels; null while hidden. */
function screenOf(el: HTMLElement | null): Size | null {
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
}

/** A notice over the screen about resizing: why the switch is off, the guest's silence, a refusal. */
type ResizeNotice = { kind: 'why' } | { kind: 'guest'; text: string } | { kind: 'error'; text: string };

export function VncConsole(props: VncConsoleProps) {
  const { namespace, name, autoFocus = false, onRequestPowerOn, onRequestResume } = props;
  const cluster = resolveCluster(props.cluster);
  const t = useTokens();
  const { vm: status, session, dispatch, reconnect, view } = useConsoleSession(namespace, name, cluster, 'vnc');
  const clipMode: ClipboardMode = clipboardMode(status.vm, status.vmi);

  const shellRef = React.useRef<HTMLDivElement>(null);
  const screenRef = React.useRef<HTMLDivElement>(null);
  const rfbRef = React.useRef<RFB | null>(null);
  const [fit, setFit] = React.useState(true);
  // Resize the desktop to the window: the choice per VM, what the server and noVNC can do.
  const choiceKey = resizeChoiceKey(cluster, namespace, name);
  const [choice, setChoice] = React.useState<boolean | null>(() => readResizeChoice(choiceKey));
  const [server, setServer] = React.useState<ServerSupport>('unknown');
  const [client, setClient] = React.useState(true);
  const [refused, setRefused] = React.useState(false);
  const [resizeNotice, setResizeNotice] = React.useState<ResizeNotice | null>(null);
  const [cardBusy, setCardBusy] = React.useState(false);
  /** The one-click change went through: no second button while the VM watch catches up. */
  const [virtioAsked, setVirtioAsked] = React.useState(false);
  const [screenSize, setScreenSize] = React.useState<Size | null>(null);
  const resizerRef = React.useRef<DesktopResizer | null>(null);
  /** The instance for which "the guest did not change its resolution" was said. */
  const guestToldFor = React.useRef<string | null>(null);
  const [viewOnly, setViewOnly] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [resolution, setResolution] = React.useState<[number, number] | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [keyMenu, setKeyMenu] = React.useState<HTMLElement | null>(null);
  const [typeOpen, setTypeOpen] = React.useState(false);
  const [typing, setTyping] = React.useState<{ done: number; total: number } | null>(null);
  const typingRun = React.useRef<{ stop: boolean } | null>(null);
  const pasteSinkRef = React.useRef<HTMLTextAreaElement>(null);
  const [clipAnchor, setClipAnchor] = React.useState<HTMLElement | null>(null);
  const [vmClip, setVmClip] = React.useState<{ text: string; at: number; unseen: boolean } | null>(null);
  const [clipNote, setClipNote] = React.useState<string | null>(null);
  const clipNoteTimer = React.useRef(0);
  /** This computer's clipboard as last seen by a paste in the console. */
  const lastHostText = React.useRef<string | null>(null);
  const copyGestureUntil = React.useRef(0);
  const pendingPaste = React.useRef<{ key: PasteKey; timer: number } | null>(null);

  const connected = session.phase === 'connected';
  const canType = view.interactive && !viewOnly;
  const cards = videoCards(status.vm, status.vmi);
  const resizeAvail = resizeAvailability({ connected, cards, server, client, refused });
  const resizing = resizeOn(resizeAvail, choice);
  const desktop = resolution ? { width: resolution[0], height: resolution[1] } : null;
  const scale = scaleViewport({ resizing, fit, desktop, screen: screenSize });
  const canEditVm = useCan({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace });

  // Read by the connection effect without restarting it.
  const live = React.useRef({ scale, viewOnly, autoFocus, screen: t.screen, clipMode });
  live.current = { scale, viewOnly, autoFocus, screen: t.screen, clipMode };

  const flashClip = (note: string) => {
    window.clearTimeout(clipNoteTimer.current);
    setClipNote(note);
    clipNoteTimer.current = window.setTimeout(() => setClipNote(null), 5000);
  };

  // What the VNC server says about the desktop's size (desktopSize.ts).
  const onDesktopReply = React.useRef<(r: DesktopSizeReply) => void>(() => undefined);
  onDesktopReply.current = r => {
    setServer('yes');
    if (r.reason === 1 && r.status === 3) {
      // The display device cannot change size: the switch goes off, and says why.
      setRefused(true);
      setResizeNotice({ kind: 'why' });
    } else if (r.reason === 1 && (r.status === 1 || r.status === 2)) {
      setResizeNotice({ kind: 'error', text: `The VNC server refused the new desktop size: ${refusalText(r.status)}.` });
    } else if (r.reason === 2) {
      flashClip('Another console changed the desktop size');
    }
  };
  // A request the guest left unanswered: said once per instance of the VM.
  const onUnanswered = React.useRef<() => void>(() => undefined);
  onUnanswered.current = () => {
    const uid = status.vmiUid ?? '';
    if (guestToldFor.current === uid) return;
    guestToldFor.current = uid;
    const os = status.vm ? guestOs(status.vm as VM, status.vmi as any).id : '';
    setResizeNotice({ kind: 'guest', text: guestIgnoredMessage(os) });
  };
  const onFollowed = React.useRef<() => void>(() => undefined);
  onFollowed.current = () => setResizeNotice(n => (n?.kind === 'guest' ? null : n));

  // Text the VM copied: kept for the Clipboard panel, and put on this
  // computer's clipboard when the browser allows it (https, or right after
  // Ctrl+C/X in the console).
  const fromVm = React.useRef<(text: string) => void>(() => undefined);
  fromVm.current = (text: string) => {
    setVmClip({ text, at: Date.now(), unseen: true });
    const gesture = Date.now() < copyGestureUntil.current;
    if (!gesture && !window.isSecureContext) {
      flashClip('The VM copied text: open Clipboard to take it');
      return;
    }
    writeHostClipboard(text).then(ok => {
      if (ok) {
        lastHostText.current = text;
        setVmClip(v => (v && v.text === text ? { ...v, unseen: false } : v));
        flashClip('Copied from the VM');
      } else flashClip('The VM copied text: open Clipboard to take it');
    });
  };

  const active = session.phase === 'connecting' || session.phase === 'connected';

  React.useEffect(() => {
    const target = screenRef.current;
    if (!active || !target) return;
    const epoch = session.epoch;
    const channel = new ConsoleChannel({
      path: vncPath(namespace, name, !session.takeover),
      cluster,
    });
    let rfb: RFB;
    try {
      rfb = new RFB(target, channel, { shared: true });
    } catch (err) {
      channel.close();
      dispatch({ type: 'failed', epoch, message: String((err as Error)?.message ?? err) });
      return;
    }
    let disposed = false;
    let ended = false;
    let canvasWatch: MutationObserver | null = null;
    let serverWait = 0;

    rfb.scaleViewport = live.current.scale;
    rfb.clipViewport = false;
    // Hangar asks for the desktop's size itself (resize.ts): debounced, never below 640×480.
    rfb.resizeSession = false;
    rfb.viewOnly = live.current.viewOnly;
    rfb.focusOnClick = true;
    rfb.background = live.current.screen;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;

    setServer('unknown');
    setRefused(false);
    const link = linkDesktopSize(rfb, reply => {
      if (!disposed) onDesktopReply.current(reply);
    });
    setClient(!!link);
    const canvasSize = (): Size | null => {
      const c = target.querySelector('canvas');
      return c && c.width && c.height ? { width: c.width, height: c.height } : null;
    };
    const resizer = new DesktopResizer({
      send: size => !!link?.request(size),
      desktop: canvasSize,
      screen: () => screenOf(target),
      unanswered: () => onUnanswered.current(),
      followed: () => onFollowed.current(),
    });
    resizerRef.current = resizer;

    const watchdog = setTimeout(() => {
      if (!ended) rfb.disconnect();
    }, CONNECT_TIMEOUT_MS);

    const onConnect = () => {
      clearTimeout(watchdog);
      dispatch({ type: 'opened', epoch });
      const canvas = target.querySelector('canvas');
      if (canvas) {
        const read = () => {
          setResolution(canvas.width && canvas.height ? [canvas.width, canvas.height] : null);
          const size = canvasSize();
          if (size) resizer.desktopChanged(size);
        };
        read();
        canvasWatch = new MutationObserver(read);
        canvasWatch.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
      }
      // QEMU announces ExtendedDesktopSize right after the handshake.
      serverWait = window.setTimeout(() => {
        if (!disposed) setServer(s => (s === 'unknown' ? (link?.supported() ? 'yes' : 'no') : s));
      }, SERVER_WAIT_MS);
      if (live.current.autoFocus) rfb.focus({ preventScroll: true });
    };
    const onDisconnect = () => {
      ended = true;
      clearTimeout(watchdog);
      clearTimeout(serverWait);
      resizer.dispose();
      canvasWatch?.disconnect();
      setResolution(null);
      setFocused(false);
      if (!disposed) dispatch({ type: 'closed', epoch, opened: channel.opened, now: Date.now() });
    };
    const onSecurityFailure = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
      dispatch({
        type: 'failed',
        epoch,
        message: reason || 'The VNC server refused the connection.',
      });
    };
    const onClipboard = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === 'string' && !disposed) fromVm.current(text);
    };
    rfb.addEventListener('connect', onConnect);
    rfb.addEventListener('disconnect', onDisconnect);
    rfb.addEventListener('securityfailure', onSecurityFailure);
    rfb.addEventListener('clipboard', onClipboard);
    rfbRef.current = rfb;

    return () => {
      disposed = true;
      clearTimeout(watchdog);
      clearTimeout(serverWait);
      resizer.dispose();
      link?.dispose();
      if (resizerRef.current === resizer) resizerRef.current = null;
      canvasWatch?.disconnect();
      if (typingRun.current) typingRun.current.stop = true;
      if (!ended) rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
      setResolution(null);
      setFocused(false);
    };
    // A new connection per epoch; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, session.epoch]);

  React.useEffect(() => {
    if (rfbRef.current) rfbRef.current.scaleViewport = scale;
  }, [scale]);

  // noVNC scales to 0×0 while hidden (a minimized window is display:none)
  // and does not always scale back: apply the scaling again on a real size.
  // A new size is also one the desktop may take (debounced by the resizer);
  // the pop-up's own window resizes count too.
  React.useEffect(() => {
    const el = screenRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const size = screenOf(el);
        setScreenSize(prev => (sameSize(prev, size) ? prev : size));
        const rfb = rfbRef.current;
        if (rfb && el.clientWidth > 0 && el.clientHeight > 0) rfb.scaleViewport = live.current.scale;
        if (size) resizerRef.current?.windowChanged();
      });
    });
    ro.observe(el);
    const onWindowResize = () => resizerRef.current?.windowChanged();
    window.addEventListener('resize', onWindowResize);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, []);

  // Turned on for this VM before, now with a card that cannot follow: say so once.
  const cardTold = React.useRef(false);
  React.useEffect(() => {
    if (choice === true && resizeAvail.kind === 'card' && !cardTold.current) {
      cardTold.current = true;
      setResizeNotice(n => n ?? { kind: 'why' });
    }
  }, [choice, resizeAvail.kind]);

  // The requester follows the switch; view only and a paused VM ask for nothing.
  React.useEffect(() => {
    const r = resizerRef.current;
    if (!r) return;
    r.setGraceUntil((status.runningSince ?? 0) + BOOT_GRACE_MS);
    r.setEnabled(resizing && canType && connected);
  }, [resizing, canType, connected, session.epoch, status.runningSince]);

  React.useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
    if (viewOnly) rfbRef.current?.blur();
  }, [viewOnly]);

  // Where the keyboard goes: the screen's canvas has focus or not.
  React.useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const update = () =>
      setFocused(!!document.activeElement && el.contains(document.activeElement));
    el.addEventListener('focusin', update);
    el.addEventListener('focusout', update);
    return () => {
      el.removeEventListener('focusin', update);
      el.removeEventListener('focusout', update);
    };
  }, []);

  // Clipboard sharing. Ctrl+V (Ctrl+Shift+V, Shift+Insert) is kept from
  // noVNC and the browser's paste goes to a hidden field in the screen; the
  // text goes to the VM's clipboard when it changed, then the VM gets the
  // shortcut and pastes it. Ctrl+C/X still go to the VM and open a short
  // window in which what the VM copies lands on this computer's clipboard.
  React.useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const finish = (text: string | null) => {
      const p = pendingPaste.current;
      if (!p) return;
      window.clearTimeout(p.timer);
      pendingPaste.current = null;
      const rfb = rfbRef.current;
      if (!rfb) return;
      rfb.focus({ preventScroll: true });
      const send = text !== null && shouldSendToVm(text, lastHostText.current);
      if (text !== null) lastHostText.current = text;
      if (send) rfb.clipboardPasteFrom(text as string);
      const press = () => {
        if (rfbRef.current !== rfb) return;
        for (const ev of comboEvents(pasteCombo(p.key))) rfb.sendKey(ev.keysym, ev.code, ev.down);
      };
      if (send) window.setTimeout(press, PASTE_SETTLE_MS);
      else press();
    };
    const isPaste = (e: KeyboardEvent) =>
      (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyV') ||
      (e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'Insert');
    const isCopy = (e: KeyboardEvent) =>
      (e.ctrlKey && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyX')) || (e.ctrlKey && e.code === 'Insert');
    let swallowUp: string | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target === pasteSinkRef.current) return;
      if (isCopy(e)) {
        copyGestureUntil.current = Date.now() + COPY_GESTURE_MS;
        return;
      }
      const { clipMode: mode, viewOnly: vo } = live.current;
      if ((mode !== 'shared' && mode !== 'off-pending') || vo || !rfbRef.current || !isPaste(e)) return;
      // noVNC must not see it: it would cancel the browser's paste.
      e.stopPropagation();
      swallowUp = e.code;
      if (pendingPaste.current) window.clearTimeout(pendingPaste.current.timer);
      pendingPaste.current = {
        key: { shift: e.shiftKey, insert: e.code === 'Insert' },
        timer: window.setTimeout(() => finish(null), PASTE_FALLBACK_MS),
      };
      pasteSinkRef.current?.focus({ preventScroll: true });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (swallowUp && e.code === swallowUp) {
        e.stopPropagation();
        swallowUp = null;
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!pendingPaste.current) return;
      e.preventDefault();
      e.stopPropagation();
      finish(e.clipboardData?.getData('text/plain') ?? '');
    };
    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('keyup', onKeyUp, true);
    el.addEventListener('paste', onPaste, true);
    return () => {
      el.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('keyup', onKeyUp, true);
      el.removeEventListener('paste', onPaste, true);
      if (pendingPaste.current) window.clearTimeout(pendingPaste.current.timer);
      pendingPaste.current = null;
    };
  }, []);

  React.useEffect(() => () => window.clearTimeout(clipNoteTimer.current), []);

  // Fullscreen: with the Keyboard Lock API (Chromium), Esc, Alt+Tab and
  // browser shortcuts go to the VM too; holding Esc leaves fullscreen.
  React.useEffect(() => {
    const onChange = () => {
      const on = !!shellRef.current && document.fullscreenElement === shellRef.current;
      setFullscreen(on);
      const kb = keyboardApi();
      if (on) kb?.lock?.().catch(() => undefined);
      else kb?.unlock?.();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  React.useEffect(
    () => () => {
      if (typingRun.current) typingRun.current.stop = true;
    },
    []
  );

  const sendCombo = (combo: KeyCombo) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const ev of comboEvents(combo)) rfb.sendKey(ev.keysym, ev.code, ev.down);
  };

  const sendCtrlAltDel = () => sendCombo(CTRL_ALT_DEL);

  const typeText = async (text: string) => {
    setTypeOpen(false);
    const rfb = rfbRef.current;
    if (!rfb) return;
    if (typingRun.current) typingRun.current.stop = true;
    const run = { stop: false };
    typingRun.current = run;
    const { strokes } = planTyping(text);
    setTyping({ done: 0, total: strokes.length });
    for (let i = 0; i < strokes.length; i++) {
      if (run.stop || rfbRef.current !== rfb) break;
      for (const ev of strokeEvents(strokes[i])) rfb.sendKey(ev.keysym, ev.code, ev.down);
      if (i % 5 === 4 || i === strokes.length - 1)
        setTyping({ done: i + 1, total: strokes.length });
      await sleep(TYPE_DELAY_MS);
    }
    if (typingRun.current === run) {
      typingRun.current = null;
      setTyping(null);
      if (!run.stop && rfbRef.current === rfb) rfb.focus({ preventScroll: true });
    }
  };

  const stopTyping = () => {
    if (typingRun.current) typingRun.current.stop = true;
    typingRun.current = null;
    setTyping(null);
  };

  const screenshot = () => {
    rfbRef.current?.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = screenshotFileName(name, new Date());
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };

  const toggleFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen?.().catch(() => undefined);
  };

  /** The switch: on/off where it can be; elsewhere a click says why, with the fix. */
  const toggleResize = () => {
    if (resizeAvail.kind !== 'ready') {
      setResizeNotice({ kind: 'why' });
      return;
    }
    const next = !resizing;
    setChoice(next);
    writeResizeChoice(choiceKey, next);
    setResizeNotice(null);
  };

  /** The one-click fix: VirtIO from the next power-on (KubeVirt asks for a restart of a running VM). */
  const switchToVirtio = async () => {
    const vm = status.vm as VM | null;
    if (!vm) return;
    setCardBusy(true);
    try {
      await A.patchVm(vm, 'Change video card', { spec: { template: { spec: { domain: { devices: { video: { type: 'virtio' } } } } } } });
      setVirtioAsked(true);
      setChoice(true);
      writeResizeChoice(choiceKey, true);
    } catch (e) {
      setResizeNotice({ kind: 'error', text: `The video card was not changed: ${String((e as Error)?.message ?? e)}` });
    } finally {
      setCardBusy(false);
    }
  };

  const whyText = resizeNotice?.kind === 'why' ? unavailableReason(resizeAvail) : null;
  const bannerText = resizeNotice?.kind === 'why' ? whyText : resizeNotice?.text ?? null;
  const bannerAction =
    resizeNotice?.kind === 'why' && resizeAvail.kind === 'card' && !resizeAvail.pending && !virtioAsked && canEditVm && status.vm
      ? { label: 'Use VirtIO', onClick: switchToVirtio, busy: cardBusy }
      : undefined;

  const notConnectedHint = connected ? undefined : 'Available when the console is connected';
  const clipShared = clipMode === 'shared' || clipMode === 'off-pending';
  const statusExtra = typing
    ? `Typing ${typing.done} of ${typing.total}`
    : clipNote && connected
    ? clipNote
    : connected && resolution
    ? `${resolution[0]}×${resolution[1]}${viewOnly ? ' · view only' : ''}`
    : undefined;

  return (
    <ConsoleShell ref={shellRef} label={`Console of ${name}`} minHeight={props.minHeight}>
      <ConsoleToolbar label="Console controls">
        <StatusReadout tone={view.status.tone} label={view.status.label} extra={statusExtra} />
        {typing && <ToolTextButton icon="mdi:stop" label="Stop typing" onClick={stopTyping} />}
        <ToolbarSpacer />
        <ToolTextButton
          icon="mdi:keyboard-variant"
          label="Send Ctrl+Alt+Del"
          onClick={sendCtrlAltDel}
          disabled={!canType}
          tooltip={canType ? 'Send Ctrl+Alt+Del' : notConnectedHint ?? 'View only'}
        />
        <ToolTextButton
          icon="mdi:keyboard-outline"
          label="Send key"
          endIcon="mdi:menu-down"
          onClick={e => setKeyMenu(e.currentTarget)}
          disabled={!canType}
          aria-haspopup="menu"
          aria-expanded={!!keyMenu}
          tooltip={
            canType
              ? 'Send a key or shortcut the browser keeps for itself'
              : notConnectedHint ?? 'View only'
          }
        />
        <ToolTextButton
          icon="mdi:clipboard-text-outline"
          label="Clipboard"
          dot={vmClip?.unseen ? '#2FBF71' : undefined}
          onClick={e => {
            setClipAnchor(e.currentTarget);
            setVmClip(v => (v ? { ...v, unseen: false } : v));
          }}
          aria-haspopup="dialog"
          aria-expanded={!!clipAnchor}
          tooltip={
            clipShared
              ? 'Clipboard shared with the VM: Ctrl+V pastes, what the VM copies shows here'
              : 'Clipboard not shared: type text into the VM'
          }
        />
        <ToolTextButton
          icon="mdi:clipboard-arrow-right-outline"
          label="Type text"
          onClick={() => setTypeOpen(true)}
          disabled={!canType || !!typing}
          aria-haspopup="dialog"
          tooltip={canType ? 'Type pasted text into the VM' : notConnectedHint ?? 'View only'}
        />
        <ToolbarDivider />
        <ToolButton
          icon={fit ? 'mdi:fit-to-screen-outline' : 'mdi:image-size-select-actual'}
          label={fit ? 'Show at 1:1' : 'Scale to fit'}
          tooltip={
            resizing
              ? 'The desktop follows the window: scaled only while its size differs'
              : fit
              ? 'Scaled to fit. Show at 1:1'
              : 'Shown at 1:1. Scale to fit'
          }
          onClick={() => setFit(f => !f)}
          disabled={resizing}
        />
        <ToolButton
          icon="mdi:resize"
          label={SWITCH_LABEL}
          pressed={resizing}
          disabled={resizeAvail.kind === 'offline' || resizeAvail.kind === 'checking'}
          unavailable={resizeAvail.kind !== 'ready'}
          tooltip={resizing && viewOnly ? 'View only: the desktop keeps its size until view only is off' : switchTooltip(resizeAvail, resizing)}
          onClick={toggleResize}
        />
        <ToolButton
          icon="mdi:eye-outline"
          label="View only"
          pressed={viewOnly}
          tooltip={
            viewOnly
              ? 'View only: keyboard and mouse are off. Turn off'
              : 'View only: turn keyboard and mouse off'
          }
          onClick={() => setViewOnly(v => !v)}
        />
        <ToolButton
          icon="mdi:camera-outline"
          label="Save screenshot"
          tooltip={connected ? 'Save a screenshot (PNG)' : notConnectedHint}
          onClick={screenshot}
          disabled={!connected}
        />
        <ToolButton
          icon={fullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'}
          label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          tooltip={fullscreen ? 'Exit fullscreen (hold Esc)' : 'Fullscreen'}
          onClick={toggleFullscreen}
        />
        <ToolButton
          icon="mdi:refresh"
          label="Reconnect"
          tooltip={
            session.available
              ? 'Reconnect, taking over the console'
              : 'Available when the VM is running'
          }
          onClick={reconnect}
          disabled={!session.available}
        />
        <ToolbarDivider />
        <KeyboardIndicator
          captured={focused}
          disabled={!canType}
          onCapture={() => rfbRef.current?.focus({ preventScroll: true })}
          onRelease={() => rfbRef.current?.blur()}
        />
      </ConsoleToolbar>
      <Bezel focused={focused}>
        <Box
          ref={screenRef}
          sx={{
            position: 'absolute',
            inset: 0,
            '& > div': { scrollbarColor: `${t.bezel} ${t.screen}`, scrollbarWidth: 'thin' },
            '& canvas': { cursor: viewOnly ? 'default' : undefined },
          }}
        >
          <textarea
            ref={pasteSinkRef}
            aria-hidden
            tabIndex={-1}
            readOnly={false}
            style={{ position: 'absolute', left: -9999, top: 0, width: 1, height: 1, opacity: 0 }}
          />
        </Box>
        {bannerText && (
          <ScreenBanner tone={resizeNotice?.kind === 'why' ? 'info' : 'warn'} action={bannerAction} onClose={() => setResizeNotice(null)}>
            {bannerText}
          </ScreenBanner>
        )}
        {view.message && (
          <ScreenNotice
            message={view.message}
            actions={{
              'power-on': onRequestPowerOn,
              resume: onRequestResume,
              reconnect,
              'take-over': reconnect,
            }}
          />
        )}
      </Bezel>
      <SendKeyMenu anchorEl={keyMenu} onClose={() => setKeyMenu(null)} onSend={sendCombo} />
      <ClipboardTray
        anchorEl={clipAnchor}
        onClose={() => setClipAnchor(null)}
        mode={clipMode}
        vmText={vmClip?.text ?? null}
        vmTextAt={vmClip?.at ?? null}
        canType={canType && connected}
        onSend={text => {
          rfbRef.current?.clipboardPasteFrom(text);
          flashClip('Sent to the VM clipboard: paste it there');
          rfbRef.current?.focus({ preventScroll: true });
        }}
        onType={text => typeText(text)}
      />
      <TypeTextDialog
        open={typeOpen}
        vmName={name}
        onClose={() => setTypeOpen(false)}
        onType={typeText}
      />
    </ConsoleShell>
  );
}
