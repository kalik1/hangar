import { describe, expect, it } from 'vitest';
import type { PowerState } from '../model/vm';
import { initialSession, SessionState } from './session';
import { screenView, VmStatus } from './view';

const power = (
  kind: PowerState['kind'],
  label: string,
  tone: PowerState['tone'],
  detail?: string
): PowerState => ({
  kind,
  label,
  tone,
  detail,
  printable: '',
});

const ON = power('on', 'Powered on', 'on');
const OFF = power('off', 'Powered off', 'off');
const PAUSED = power('paused', 'Suspended', 'standby');

const vm = (p: PowerState | null, available: boolean, more: Partial<VmStatus> = {}): VmStatus => ({
  loaded: true,
  missing: false,
  power: p,
  available,
  ...more,
});

const session = (more: Partial<SessionState>): SessionState => ({ ...initialSession(), ...more });

describe('screenView', () => {
  it('shows the live console when connected', () => {
    const v = screenView(vm(ON, true), session({ phase: 'connected', available: true }), 'vnc');
    expect(v).toEqual({
      status: { tone: 'on', label: 'Connected' },
      message: null,
      interactive: true,
    });
  });

  it('offers to power on a VM that is off', () => {
    const v = screenView(vm(OFF, false), session({ phase: 'idle' }), 'vnc');
    expect(v.status.label).toBe('Powered off');
    expect(v.message).toMatchObject({ title: 'Powered off', action: 'power-on' });
    expect(v.interactive).toBe(false);
  });

  it('shows a paused VM over its frozen screen, with Resume', () => {
    const v = screenView(vm(PAUSED, true), session({ phase: 'connected' }), 'vnc');
    expect(v.message).toMatchObject({ title: 'Suspended', action: 'resume', translucent: true });
    expect(v.interactive).toBe(false);
  });

  it('says shutting down while the instance goes away, even if the VM still says running', () => {
    const v = screenView(vm(ON, false, { stopping: true }), session({}), 'vnc');
    expect(v.status.label).toBe('Shutting down');
    expect(screenView(vm(ON, false), session({}), 'vnc').status.label).toBe('Starting');
  });

  it('waits for a starting VM', () => {
    const v = screenView(vm(power('starting', 'Starting', 'busy'), false), session({}), 'vnc');
    expect(v.message).toMatchObject({ tone: 'busy', title: 'Starting' });
    expect(v.message?.action).toBeUndefined();
  });

  it('shows why a VM cannot start', () => {
    const v = screenView(
      vm(power('error', 'A disk is missing', 'fault', 'pvc x not found'), false),
      session({}),
      'vnc'
    );
    expect(v.message).toMatchObject({
      tone: 'fault',
      title: 'A disk is missing',
      detail: 'pvc x not found',
    });
  });

  it('says connecting, then reconnecting after a drop', () => {
    expect(screenView(vm(ON, true), session({ phase: 'connecting' }), 'vnc').status.label).toBe(
      'Connecting'
    );
    expect(
      screenView(vm(ON, true), session({ phase: 'connecting', wasConnected: true }), 'vnc').status
        .label
    ).toBe('Reconnecting');
    const retrying = screenView(vm(ON, true), session({ phase: 'retrying' }), 'vnc');
    expect(retrying.message).toMatchObject({ title: 'Reconnecting', action: 'reconnect' });
  });

  it('offers to take over a console held elsewhere', () => {
    const v = screenView(vm(ON, true), session({ phase: 'stopped', reason: 'in-use' }), 'vnc');
    expect(v.message).toMatchObject({ title: 'Console in use elsewhere', action: 'take-over' });
  });

  it('keeps saying "in use" during a quiet attempt', () => {
    const v = screenView(
      vm(ON, true),
      session({ phase: 'connecting', quiet: true, reason: 'in-use' }),
      'vnc'
    );
    expect(v.message).toMatchObject({ title: 'Console in use elsewhere', action: 'take-over' });
  });

  it('says the connection kept failing', () => {
    const v = screenView(vm(ON, true), session({ phase: 'stopped', reason: 'unreachable' }), 'vnc');
    expect(v.message).toMatchObject({
      tone: 'fault',
      title: 'Cannot reach the console',
      action: 'reconnect',
    });
  });

  it('explains an ended serial session', () => {
    const v = screenView(vm(ON, true), session({ phase: 'stopped', reason: 'closed' }), 'serial');
    expect(v.message?.detail).toMatch(/another tab/);
  });

  it('shows protocol errors with their message', () => {
    const v = screenView(
      vm(ON, true),
      session({ phase: 'stopped', reason: 'failed', message: 'boom' }),
      'vnc'
    );
    expect(v.message).toMatchObject({
      title: 'Console error',
      detail: 'boom',
      action: 'reconnect',
    });
  });

  it('says when the VM does not exist or cannot be read', () => {
    expect(screenView(vm(null, false, { missing: true }), session({}), 'vnc').message?.title).toBe(
      'VM not found'
    );
    expect(
      screenView(vm(null, false, { error: 'Forbidden' }), session({}), 'vnc').message
    ).toMatchObject({
      title: 'Cannot read this VM',
      detail: 'Forbidden',
    });
  });

  it('says connecting before the first answer', () => {
    expect(screenView(vm(null, false, { loaded: false }), session({}), 'vnc').status.label).toBe(
      'Connecting'
    );
  });

  it('prefers the power state over a stale connection state when the VM is not running', () => {
    const v = screenView(
      vm(OFF, false),
      session({ phase: 'stopped', reason: 'unreachable' }),
      'vnc'
    );
    expect(v.message?.title).toBe('Powered off');
  });
});
