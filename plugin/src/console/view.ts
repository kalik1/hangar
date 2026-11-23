/*
 * What a console shows: the status in its toolbar and the message on its
 * screen, from the VM's power state and the connection. Pure, so the
 * copy and the precedence of states are tested in one place.
 */

import type { PowerState } from '../model/vm';
import type { LedTone } from '../ui/tokens';
import type { SessionState } from './session';

/** What the console knows about its VM. */
export interface VmStatus {
  /** The first answer from the API arrived. */
  loaded: boolean;
  /** The VM does not exist (or is not visible). */
  missing: boolean;
  /** Reading the VM failed. */
  error?: string;
  power: PowerState | null;
  /** Its instance runs: the console can answer. */
  available: boolean;
  /** Its instance is going away (deleted, or the guest powered off). */
  stopping?: boolean;
}

export type ScreenAction = 'power-on' | 'resume' | 'reconnect' | 'take-over';

export const ACTION_LABEL: Record<ScreenAction, string> = {
  'power-on': 'Power on',
  resume: 'Resume',
  reconnect: 'Reconnect',
  'take-over': 'Take over',
};

export interface ScreenMessage {
  tone: LedTone;
  title: string;
  detail?: string;
  action?: ScreenAction;
  /** Shown over the live picture (a paused VM's frozen screen stays visible). */
  translucent?: boolean;
}

export interface ScreenView {
  status: { tone: LedTone; label: string };
  /** null: the live console, nothing over it. */
  message: ScreenMessage | null;
  /** Keys and text can be sent. */
  interactive: boolean;
}

export type ConsoleKindName = 'vnc' | 'serial';

function view(
  tone: LedTone,
  label: string,
  message: ScreenMessage | null,
  interactive = false
): ScreenView {
  return { status: { tone, label }, message, interactive };
}

export function screenView(vm: VmStatus, s: SessionState, kind: ConsoleKindName): ScreenView {
  if (vm.error) {
    return view('fault', 'Unavailable', {
      tone: 'fault',
      title: 'Cannot read this VM',
      detail: vm.error,
    });
  }
  if (!vm.loaded) return view('busy', 'Connecting', { tone: 'busy', title: 'Connecting' });
  if (vm.missing || !vm.power) {
    return view('fault', 'Not found', {
      tone: 'fault',
      title: 'VM not found',
      detail: 'It was deleted, or you cannot see it in this namespace.',
    });
  }
  const power = vm.power;

  if (s.phase === 'connected') {
    if (power.kind === 'paused') {
      return view('standby', power.label, {
        tone: 'standby',
        title: power.label,
        detail: 'The VM is paused: its screen is frozen until it resumes.',
        action: 'resume',
        translucent: true,
      });
    }
    return view('on', 'Connected', null, true);
  }

  if (!vm.available) {
    switch (power.kind) {
      case 'off':
        return view('off', power.label, {
          tone: 'off',
          title: power.label,
          detail: 'Power on the VM to use its console.',
          action: 'power-on',
        });
      case 'error':
        return view('fault', power.label, {
          tone: 'fault',
          title: power.label,
          detail: power.detail,
        });
      case 'on':
      case 'paused':
        // printableStatus lags behind the instance: it is going away, or about to run.
        if (vm.stopping)
          return view('busy', 'Shutting down', { tone: 'busy', title: 'Shutting down' });
        return view('busy', 'Starting', {
          tone: 'busy',
          title: 'Starting',
          detail: 'The console opens when the VM is running.',
        });
      case 'starting':
      case 'provisioning':
        return view(power.tone, power.label, {
          tone: power.tone,
          title: power.label,
          detail: power.detail ?? 'The console opens when the VM is running.',
        });
      case 'migrating':
        return view(power.tone, power.label, {
          tone: power.tone,
          title: power.label,
          detail: 'The console reconnects when the migration ends.',
        });
      default:
        return view(power.tone, power.label, {
          tone: power.tone,
          title: power.label,
          detail: power.detail,
        });
    }
  }

  // A quiet attempt while the console is held elsewhere still reads "in use".
  const phase = s.quiet && s.phase === 'connecting' ? 'stopped' : s.phase;
  switch (phase) {
    case 'stopped':
      switch (s.reason) {
        case 'in-use':
          return view('standby', 'In use elsewhere', {
            tone: 'standby',
            title: 'Console in use elsewhere',
            detail:
              'Another tab, window or user opened this console, and KubeVirt allows one at a time. It reconnects here when the console is free.',
            action: 'take-over',
          });
        case 'unreachable':
          return view('fault', 'Disconnected', {
            tone: 'fault',
            title: 'Cannot reach the console',
            detail:
              'The connection kept failing. Check that the cluster is reachable, then reconnect.',
            action: 'reconnect',
          });
        case 'closed':
          return view('off', 'Disconnected', {
            tone: 'off',
            title: 'Disconnected',
            detail:
              kind === 'serial'
                ? 'The session ended. The serial console may be open in another tab, window or terminal.'
                : 'The session ended.',
            action: 'reconnect',
          });
        default:
          return view('fault', 'Error', {
            tone: 'fault',
            title: 'Console error',
            detail: s.message || 'The console protocol failed.',
            action: 'reconnect',
          });
      }
    case 'retrying':
    case 'checking':
      return view('busy', 'Reconnecting', {
        tone: 'busy',
        title: 'Reconnecting',
        detail: s.phase === 'retrying' ? 'The console did not answer. Trying again.' : undefined,
        action: 'reconnect',
      });
    default:
      if (s.wasConnected)
        return view('busy', 'Reconnecting', { tone: 'busy', title: 'Reconnecting' });
      return view('busy', 'Connecting', { tone: 'busy', title: 'Connecting' });
  }
}
