/* "Send key": keys and shortcuts the browser or the host keeps for itself. */

import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import React from 'react';
import { useTokens } from '../ui/useTokens';
import { KeyCombo, SEND_KEYS, VT_KEYS } from './keys';

export function SendKeyMenu({
  anchorEl,
  onClose,
  onSend,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onSend: (combo: KeyCombo) => void;
}) {
  const t = useTokens();
  const pick = (combo: KeyCombo) => {
    onSend(combo);
    onClose();
  };
  const header = {
    lineHeight: '28px',
    fontSize: 12,
    fontWeight: 600,
    color: t.muted,
    background: 'transparent',
    position: 'static' as const,
  };
  return (
    <Menu
      anchorEl={anchorEl}
      open={!!anchorEl}
      onClose={onClose}
      MenuListProps={{ dense: true, 'aria-label': 'Send key' }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{ paper: { sx: { minWidth: 220 } } }}
    >
      <ListSubheader sx={header}>Keys</ListSubheader>
      {SEND_KEYS.map(k => (
        <MenuItem key={k.id} onClick={() => pick(k)} sx={{ fontSize: 13.5 }}>
          {k.label}
        </MenuItem>
      ))}
      <ListSubheader sx={header}>Switch terminal</ListSubheader>
      {VT_KEYS.map(k => (
        <MenuItem
          key={k.id}
          onClick={() => pick(k)}
          sx={{ fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {k.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
