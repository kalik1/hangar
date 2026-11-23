/*
 * Small pieces the Configure panels share: a label/value row, the "needs a
 * restart" hint of a running VM, a VM edit that keeps delete protection on
 * new disks, and the "not in KubeVirt" footnote.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import * as A from '../../api/actions';
import { labelDisks } from '../../api/protection';
import { isProtected, protectedClaims, withVmProtection } from '../../model/protection';
import { VM } from '../../model/types';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

export const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

/**
 * A label/value row. It follows the width of its panel, not of the window
 * (a container query): in a narrow panel the label goes above the value.
 */
export function Row({ label, children, action, align = 'center' }: { label: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; align?: 'center' | 'flex-start' }) {
  const t = useTokens();
  return (
    <Box sx={{ containerType: 'inline-size', borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' } }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: align,
          gap: 2,
          py: 1,
          '& > .hangar-row-label': { width: 170, flex: 'none', color: t.muted, fontSize: 13.5 },
          '& > .hangar-row-value': { flex: 1, minWidth: 0, fontSize: 14, ...tabular },
          // Narrow panel: label and action on the first line, the value below at full width.
          '@container (max-width: 520px)': {
            flexWrap: 'wrap',
            rowGap: 0.5,
            '& > .hangar-row-label': { flex: 1, width: 'auto' },
            '& > .hangar-row-action': { order: 2 },
            '& > .hangar-row-value': { order: 3, flexBasis: '100%' },
          },
        }}
      >
        <Box className="hangar-row-label">{label}</Box>
        <Box className="hangar-row-value">{children}</Box>
        {action && <Box className="hangar-row-action">{action}</Box>}
      </Box>
    </Box>
  );
}

export function Later({ running }: { running: boolean }) {
  const t = useTokens();
  return running ? (
    <Tooltip title="The VM is running: KubeVirt applies what it can at once and asks for a restart for the rest.">
      <Box component="span" sx={{ fontSize: 12.5, color: t.muted, display: { xs: 'none', md: 'inline-flex' }, alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' }}>
        <Icon icon="mdi:restart" width={14} /> Some changes need a restart
      </Box>
    </Tooltip>
  ) : null;
}

/** A small muted line under a control. */
export function Help({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  const t = useTokens();
  return <Box sx={{ fontSize: 12.5, color: tone === 'warn' ? '#B7791F' : t.muted, mt: 0.5, lineHeight: 1.5 }}>{children}</Box>;
}

/** Saves an edited VM; disks added to a protected VM get the protection label too. */
export async function saveVm(vm: VM, title: string, next: VM): Promise<void> {
  if (!isProtected(vm)) {
    await A.updateVm(vm, title, next);
    return;
  }
  const before = new Set(protectedClaims(vm));
  const out = withVmProtection(next, true);
  await A.updateVm(vm, title, out);
  const added = protectedClaims(out).filter(c => !before.has(c));
  // Existing disks attached now: label them (new ones get it from their template).
  if (added.length) await labelDisks(vm.metadata.namespace as string, added, true).catch(() => undefined);
}

export function NotInKubevirt({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline', fontSize: 12.5, color: t.muted, lineHeight: 1.5 }}>
      <Icon icon="mdi:information-outline" width={14} style={{ flex: 'none', position: 'relative', top: 2 }} />
      <span>{children}</span>
    </Box>
  );
}
