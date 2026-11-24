/*
 * What Hangar shows where k4all owns a setting (k4all spec §4 R9): the
 * control is read-only, with "Managed by k4all — change it in the k4all
 * addon" and a link to the addon page that owns it; and, for host settings
 * a flavor or a device needs (CPU manager, huge pages, IOMMU), a link to the
 * addon's node settings. Without the k4all plugin the words stay, the link
 * goes.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { K4ALL_MANAGED } from '../../model/ownership';
import { K4allAnchor, k4allHref, K4allPage } from '../../shell/nav';
import { useTokens } from '../../ui/useTokens';

/** A link to a page of the k4all addon; nothing when the k4all plugin is not loaded. */
export function K4allLink({ page, anchor, children }: { page: K4allPage; anchor?: K4allAnchor; children: React.ReactNode }) {
  const t = useTokens();
  const href = k4allHref(page, anchor);
  if (!href) return null;
  return (
    <Box component={RouterLink} to={href} sx={{ color: t.accent, whiteSpace: 'nowrap' }}>
      {children}
    </Box>
  );
}

/** The line a read-only control shows when k4all owns its setting. */
export function K4allManaged({ page, anchor, children, sx }: { page: K4allPage; anchor?: K4allAnchor; children?: React.ReactNode; sx?: object }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, fontSize: 12.5, color: t.muted, lineHeight: 1.5, ...sx }}>
      <Icon icon="mdi:lock-outline" width={14} style={{ flex: 'none', position: 'relative', top: 2 }} />
      <span>
        {K4ALL_MANAGED}
        {children ? <> ({children})</> : null}.{' '}
        <K4allLink page={page} anchor={anchor}>
          Open the k4all addon
        </K4allLink>
      </span>
    </Box>
  );
}

/** On k4all, where a missing host setting is turned on: the addon's node settings. */
export function K4allNodesHint({ what, sx }: { what: string; sx?: object }) {
  const t = useTokens();
  return (
    <Box component="span" sx={{ fontSize: 12.5, color: t.muted, ...sx }}>
      k4all sets {what} on the hosts from its addon.{' '}
      <K4allLink page="nodes">Open node settings</K4allLink>
    </Box>
  );
}
