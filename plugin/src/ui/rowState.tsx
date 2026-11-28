/*
 * The state of one row's change (a Settings switch, a published port):
 * idle → pending → done | failed. Pending shows what was asked at once,
 * while the request runs; done shows for a few seconds, then the row is
 * idle again and shows the resource; failed keeps the reason on the row
 * until the next try, and the control shows the resource again (the old
 * state). Only the latest change of a row counts.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { Led } from './Led';
import { LED } from './tokens';
import { useTokens } from './useTokens';

export type RowPhase = 'idle' | 'pending' | 'done' | 'failed';

export interface RowState<V> {
  phase: RowPhase;
  /** What the change asked for (pending, done, failed). */
  want?: V;
  /** Why it failed. */
  error?: unknown;
}

/** How long "done" shows. */
export const DONE_MS = 4000;

export interface RowChange<V> {
  state: RowState<V>;
  /** Runs one change: pending until `work` settles, then done or failed. Never rejects. */
  run: (want: V, work: () => Promise<unknown>) => Promise<void>;
  /** Back to idle (dismisses a failure). */
  clear: () => void;
}

export function useRowChange<V>(): RowChange<V> {
  const [state, setState] = React.useState<RowState<V>>({ phase: 'idle' });
  const latest = React.useRef(0);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = React.useCallback(async (want: V, work: () => Promise<unknown>) => {
    const id = ++latest.current;
    setState({ phase: 'pending', want });
    let next: RowState<V>;
    try {
      await work();
      next = { phase: 'done', want };
    } catch (error) {
      next = { phase: 'failed', want, error };
    }
    if (alive.current && latest.current === id) setState(next);
  }, []);
  const clear = React.useCallback(() => {
    latest.current++;
    setState({ phase: 'idle' });
  }, []);
  React.useEffect(() => {
    if (state.phase !== 'done') return;
    const id = window.setTimeout(() => setState(s => (s === state ? { phase: 'idle' } : s)), DONE_MS);
    return () => window.clearTimeout(id);
  }, [state]);
  return { state, run, clear };
}

/** The line under a row: nothing when idle, else what is happening, done, or why it failed. */
export function RowStatus<V>({
  state,
  pending,
  done,
  failed,
  sx,
}: {
  state: RowState<V>;
  pending: React.ReactNode;
  done: React.ReactNode;
  failed: React.ReactNode;
  sx?: object;
}) {
  const t = useTokens();
  if (state.phase === 'idle') return null;
  const line = { display: 'flex', alignItems: 'baseline', gap: 0.75, fontSize: 12.5, lineHeight: 1.5, ...sx };
  if (state.phase === 'pending')
    return (
      <Box role="status" sx={{ ...line, color: t.muted }}>
        <Box component="span" sx={{ flex: 'none', alignSelf: 'center', display: 'inline-flex' }}>
          <Led tone="busy" size={8} />
        </Box>
        <span>{pending}</span>
      </Box>
    );
  if (state.phase === 'done')
    return (
      <Box role="status" sx={{ ...line, color: t.muted }}>
        <Icon icon="mdi:check" width={14} style={{ flex: 'none', position: 'relative', top: 2, color: LED.on }} />
        <span>{done}</span>
      </Box>
    );
  return (
    <Box role="alert" sx={{ ...line, color: LED.fault }}>
      <Icon icon="mdi:alert-circle-outline" width={14} style={{ flex: 'none', position: 'relative', top: 2 }} />
      <span>{failed}</span>
    </Box>
  );
}
