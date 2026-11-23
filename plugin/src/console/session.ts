/*
 * The life of a console connection, as a pure reducer. The component turns
 * phases into effects: "connecting" opens a socket (one per epoch),
 * "retrying" arms a timer, "checking" asks the API whether the VM still
 * runs. Socket events carry the epoch they belong to, so a late event from
 * an old socket changes nothing.
 *
 * KubeVirt gives a VM's console to one client at a time: a new connection
 * takes it over and the old one is closed. For VNC there is a polite way
 * (`preserveSession`: refused while someone holds it). The first
 * connection and the user's Reconnect take over; automatic reconnects are
 * polite, so two open consoles never fight over the VM.
 */

export type SessionPhase =
  /** Nothing to connect to: the VM is not running (its power state says why). */
  | 'idle'
  /** A socket is opening for `epoch`. */
  | 'connecting'
  | 'connected'
  /** Waiting before the next attempt. */
  | 'retrying'
  /** A polite reconnect was refused: is someone else on the console? */
  | 'checking'
  /** Needs the user; `reason` says why. */
  | 'stopped';

export type StopReason =
  /** Another client holds the console. */
  | 'in-use'
  /** Attempts kept failing. */
  | 'unreachable'
  /** The server closed the session (serial console: no polite reconnect exists). */
  | 'closed'
  /** The console protocol failed; `message` says how. */
  | 'failed';

export interface SessionOptions {
  /** The server can refuse a connection instead of taking over (VNC). */
  canPreserve: boolean;
  /** Failed attempts in a row before giving up. */
  maxFailures?: number;
  /** For this long after the VM starts running its console may not answer yet. */
  settleMs?: number;
}

export interface SessionState {
  phase: SessionPhase;
  /** Identifies the current connection attempt. */
  epoch: number;
  /** Failed attempts in a row. */
  failures: number;
  /** The current or next connection takes the console over from another client. */
  takeover: boolean;
  reason?: StopReason;
  message?: string;
  /** The VM instance runs, so its console can answer. */
  available: boolean;
  /** UID of that instance: a new one means the VM restarted. */
  vmiUid?: string;
  /** When it became available (ms). */
  availableAt: number;
  /** A connection was up before: say "Reconnecting", not "Connecting". */
  wasConnected: boolean;
  /**
   * A background attempt while the console is held elsewhere: the view
   * keeps saying "in use", and a refusal goes straight back to it.
   */
  quiet?: boolean;
}

export type CheckResult = 'in-use' | 'not-running' | 'unreachable';

export type SessionEvent =
  /** What the VM watch says. `since`: when the instance started running (ms), if known. */
  | { type: 'vmi'; available: boolean; uid?: string; since?: number; now: number }
  /** The console is up (VNC handshake done, serial socket open). */
  | { type: 'opened'; epoch: number }
  /** The socket ended without us closing it. `opened`: it had connected. */
  | { type: 'closed'; epoch: number; opened: boolean; now: number }
  /** The console protocol failed. */
  | { type: 'failed'; epoch: number; message: string }
  /** The retry timer fired. */
  | { type: 'retry' }
  /** Answer to "checking". */
  | { type: 'checked'; result: CheckResult }
  /** The user asked to reconnect: take the console over. */
  | { type: 'reconnect' }
  /** Time to see, politely, whether the console held elsewhere is free again. */
  | { type: 'poll' };

export const DEFAULT_MAX_FAILURES = 7;
export const DEFAULT_SETTLE_MS = 20000;

export function initialSession(): SessionState {
  return {
    phase: 'idle',
    epoch: 0,
    failures: 0,
    takeover: true,
    available: false,
    availableAt: 0,
    wasConnected: false,
  };
}

function connect(s: SessionState, changes: Partial<SessionState> = {}): SessionState {
  return {
    ...s,
    reason: undefined,
    message: undefined,
    quiet: false,
    ...changes,
    phase: 'connecting',
    epoch: s.epoch + 1,
  };
}

function failure(s: SessionState, failures: number, max: number): SessionState {
  if (failures >= max) return { ...s, phase: 'stopped', reason: 'unreachable', failures };
  return { ...s, phase: 'retrying', failures };
}

export function sessionReducer(
  s: SessionState,
  e: SessionEvent,
  opts: SessionOptions
): SessionState {
  const max = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const settle = opts.settleMs ?? DEFAULT_SETTLE_MS;
  switch (e.type) {
    case 'vmi': {
      if (!e.available) {
        if (!s.available && s.phase === 'idle') return s;
        return {
          ...s,
          phase: 'idle',
          available: false,
          failures: 0,
          reason: undefined,
          message: undefined,
          quiet: false,
        };
      }
      const restarted = s.available && !!e.uid && !!s.vmiUid && e.uid !== s.vmiUid;
      if (s.available && !restarted) {
        return e.uid && e.uid !== s.vmiUid ? { ...s, vmiUid: e.uid } : s;
      }
      // A console seen for the first time may have been running for long: settle from its start.
      const availableAt = e.since !== undefined ? Math.min(e.since, e.now) : e.now;
      return connect(s, { available: true, vmiUid: e.uid, availableAt, failures: 0 });
    }

    case 'opened':
      if (e.epoch !== s.epoch || s.phase !== 'connecting') return s;
      return {
        ...s,
        phase: 'connected',
        failures: 0,
        takeover: false,
        wasConnected: true,
        reason: undefined,
        message: undefined,
        quiet: false,
      };

    case 'closed': {
      if (e.epoch !== s.epoch || (s.phase !== 'connecting' && s.phase !== 'connected')) return s;
      if (!s.available) return { ...s, phase: 'idle', quiet: false };
      // Still held elsewhere.
      if (s.quiet && s.phase === 'connecting') {
        return { ...s, phase: 'stopped', reason: 'in-use', quiet: false };
      }
      if (s.phase === 'connected') {
        if (!opts.canPreserve) return { ...s, phase: 'stopped', reason: 'closed' };
        // Dropped: try again at once, politely.
        return connect(s, { takeover: false, failures: 0 });
      }
      const failures = s.failures + 1;
      const settling = e.now - s.availableAt < settle;
      if (opts.canPreserve && !s.takeover && !settling)
        return { ...s, phase: 'checking', failures };
      return failure(s, failures, max);
    }

    case 'failed':
      if (e.epoch !== s.epoch) return s;
      return { ...s, phase: 'stopped', reason: 'failed', message: e.message };

    case 'retry':
      return s.phase === 'retrying' ? connect(s) : s;

    case 'checked':
      if (s.phase !== 'checking') return s;
      if (e.result === 'in-use') return { ...s, phase: 'stopped', reason: 'in-use' };
      return failure(s, s.failures, max);

    case 'reconnect':
      if (!s.available) return s;
      return connect(s, { takeover: true, failures: 0 });

    case 'poll':
      if (!opts.canPreserve || !s.available || s.phase !== 'stopped' || s.reason !== 'in-use')
        return s;
      return connect(s, { takeover: false, quiet: true, reason: 'in-use' });
  }
  return s;
}
