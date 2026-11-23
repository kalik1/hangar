/*
 * The screen on the faceplate: the live console miniature while the VM
 * runs, a dark screen with the state otherwise. Click opens the console.
 */

import Box from '@mui/material/Box';
import React from 'react';
import { ConsoleThumbnail } from '../../console';
import { Obj } from '../../model/types';
import { PowerState } from '../../model/vm';
import { useTokens } from '../../ui/useTokens';

export const SCREEN_W = 256;

export function Screen({ vm, p, onOpen }: { vm: Obj; p: PowerState; onOpen: () => void }) {
  const t = useTokens();
  const running = p.kind === 'on' || p.kind === 'paused' || p.kind === 'migrating';
  const label =
    p.kind === 'off'
      ? 'No signal: powered off'
      : p.kind === 'starting' || p.kind === 'provisioning'
      ? `${p.label}…`
      : p.tone === 'fault'
      ? 'No signal'
      : p.label;
  return (
    <Box
      sx={{
        flex: 'none',
        p: '4px',
        borderRadius: '7px',
        background: t.bezel,
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.05)',
        alignSelf: 'flex-start',
      }}
    >
      <ConsoleThumbnail
        namespace={vm.metadata.namespace as string}
        name={vm.metadata.name}
        running={running}
        width={SCREEN_W}
        refreshMs={4000}
        label={label}
        onClick={running ? onOpen : undefined}
      />
    </Box>
  );
}
