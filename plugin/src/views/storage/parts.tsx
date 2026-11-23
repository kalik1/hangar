/* Small pieces the storage, library and network views share. */

import Box from '@mui/material/Box';
import React from 'react';
import { DiskState, StorageKind } from '../../model/storage';
import { Led } from '../../ui/Led';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

/** Read by screen readers, not shown. */
export const srOnly = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const t = useTokens();
  return (
    <Box
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      sx={{ height: 4, borderRadius: 1, background: t.meterTrack, overflow: 'hidden', mt: 0.5, width: '100%', maxWidth: 160 }}
    >
      <Box sx={{ height: '100%', width: `${Math.max(2, Math.min(100, value))}%`, background: t.meterUsed, transition: 'width .4s' }} />
    </Box>
  );
}

/** LED, label, and a thin bar while importing or copying. Errors show their message. */
export function StateLabel({ state, extra }: { state: DiskState; extra?: React.ReactNode }) {
  const t = useTokens();
  return (
    <Box sx={{ minWidth: 0 }} title={state.detail ? `${state.label}: ${state.detail}` : state.label}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.9, maxWidth: '100%' }}>
        <Led tone={state.tone} size={8} />
        <Box
          component="span"
          sx={{ fontSize: 13, color: state.tone === 'fault' ? '#E5484D' : t.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...tabular }}
        >
          {state.label}
        </Box>
        {extra}
      </Box>
      {state.progress !== undefined && state.progress < 100 && <ProgressBar value={state.progress} label={state.label} />}
      {state.tone === 'fault' && state.detail && (
        <Box sx={{ fontSize: 12, color: t.muted, whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 320 }}>{state.detail}</Box>
      )}
    </Box>
  );
}

export function kindIcon(k: StorageKind): string {
  switch (k.family) {
    case 'local':
      return 'mdi:harddisk';
    case 'block':
      return 'mdi:database';
    case 'file':
      return 'mdi:folder-network-outline';
    case 'cloud':
      return 'mdi:cloud-outline';
    default:
      return 'mdi:database-outline';
  }
}

/** A labelled yes/no with the reason, for datastore facts. */
export function YesNo({ yes, children }: { yes: boolean; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.75 }}>
      <Box component="span" sx={{ fontWeight: 600, color: yes ? t.text : t.muted }}>
        {yes ? 'Yes' : 'No'}
      </Box>
      <Box component="span" sx={{ color: t.muted }}>
        {children}
      </Box>
    </Box>
  );
}

/** A quiet notice line inside a panel. */
export function Note({ icon, tone, children }: { icon?: React.ReactNode; tone?: 'warn' | 'info'; children: React.ReactNode }) {
  const t = useTokens();
  const warn = tone === 'warn';
  return (
    <Box
      role={warn ? 'status' : undefined}
      sx={{
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
        fontSize: 13,
        lineHeight: 1.5,
        color: t.muted,
        background: warn ? (t.dark ? 'rgba(232,163,61,0.12)' : '#FFF6E5') : t.hover,
        border: `1px solid ${warn ? (t.dark ? 'rgba(232,163,61,0.35)' : '#F3D9A4') : t.rule}`,
        borderRadius: `${t.radius.small}px`,
        px: 1.25,
        py: 0.75,
        '& b': { color: t.text },
      }}
    >
      {icon}
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  );
}
