/*
 * Menu items for a datastore picker: name, tags, free space, and how far
 * its disks reach ("Shared — VMs can move between hosts while running" or
 * "Local to each host"), so the choice says what it means for migration.
 */

import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import React from 'react';
import { Datastore } from '../../model/capacity';
import { datastoreReach, reachLabel } from '../../model/placement';
import { formatBytes } from '../../model/units';
import { Tag } from '../../ui/kit';
import { HangarTokens } from '../../ui/tokens';

/** MUI selects want MenuItems as direct children: call this inside the TextField. */
export function datastoreItems(ds: Datastore[], hosts: number, t: Pick<HangarTokens, 'muted'>, opts: { snapshots?: boolean } = {}) {
  return ds.map(x => {
    const reach = datastoreReach(x);
    const label = reachLabel(reach, hosts);
    return (
      <MenuItem key={x.name} value={x.name}>
        <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <span>{x.name}</span>
            {x.isDefault && <Tag>default</Tag>}
            {reach === 'shared' && <Tag tone="accent">shared</Tag>}
            {opts.snapshots && x.snapshots && <Tag>snapshots</Tag>}
            <Box sx={{ flex: 1 }} />
            {x.freeBytes !== undefined && <Box sx={{ color: t.muted, fontSize: 13 }}>{formatBytes(x.freeBytes)} free</Box>}
          </Box>
          {hosts > 1 && <Box sx={{ fontSize: 12, color: t.muted, whiteSpace: 'normal' }}>{label.long}</Box>}
        </Box>
      </MenuItem>
    );
  });
}

/** The selected datastore shown in the closed select: just its name and reach. */
export function renderDatastore(ds: Datastore[], hosts: number) {
  return (value: unknown) => {
    const x = ds.find(d => d.name === value);
    if (!x) return String(value ?? '');
    return hosts > 1 ? `${x.name} — ${reachLabel(datastoreReach(x), hosts).short.toLowerCase()}` : x.name;
  };
}
