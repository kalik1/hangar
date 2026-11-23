/*
 * The one line a gated control shows when its KubeVirt feature is off: the
 * reason and a link to Datacenter settings → Features, where the gate is
 * highlighted.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { gateHref } from '../../shell/nav';
import { useTokens } from '../../ui/useTokens';

export function GateHint({ gate, children, sx }: { gate: string; children?: React.ReactNode; sx?: object }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, fontSize: 12.5, color: t.muted, lineHeight: 1.5, ...sx }}>
      <Icon icon="mdi:lock-outline" width={14} style={{ flex: 'none', position: 'relative', top: 2 }} />
      <span>
        {children ?? <>Needs KubeVirt&apos;s {gate} feature, off in this datacenter.</>}{' '}
        <Box component={RouterLink} to={gateHref(gate)} sx={{ color: t.accent, whiteSpace: 'nowrap' }}>
          Open Features
        </Box>
      </span>
    </Box>
  );
}
