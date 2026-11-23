/*
 * Status LED: a small lit dot with a halo. "busy" pulses (unless the user
 * prefers reduced motion); "off" is hollow. Always pair it with a text
 * label: colour alone never carries the state.
 */

import Box from '@mui/material/Box';
import { keyframes } from '@mui/material/styles';
import React from 'react';
import { LED, LedTone } from './tokens';

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

export function Led({ tone, size = 9, title }: { tone: LedTone; size?: number; title?: string }) {
  const color = LED[tone];
  const hollow = tone === 'off';
  return (
    <Box
      component="span"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      sx={{
        display: 'inline-block',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        boxSizing: 'border-box',
        background: hollow ? 'transparent' : color,
        border: hollow ? `1.5px solid ${color}` : 'none',
        boxShadow: hollow ? 'none' : `0 0 0 2px ${color}2e, 0 0 6px ${color}66`,
        animation: tone === 'busy' ? `${pulse} 1.4s ease-in-out infinite` : 'none',
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    />
  );
}
