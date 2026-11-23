/*
 * Hangar design tokens.
 *
 * The idea: a machine room seen through a clean console. Pages stay quiet
 * and dense (Headlamp's theme, its font, tabular numbers); the one loud
 * element is the VM faceplate, a dark band like a server's front panel with
 * the live console screen and a status LED. LED colours carry power state
 * everywhere (lists, tree, tasks), always with a text label next to them.
 */

import { Theme } from '@mui/material/styles';

/** Status LED colours. Same in light and dark mode: they sit on their own halo. */
export const LED = {
  /** Powered on and healthy. */
  on: '#2FBF71',
  /** Suspended, or something wants attention. */
  standby: '#E8A33D',
  /** Error. */
  fault: '#E5484D',
  /** In transition: starting, stopping, migrating, provisioning, importing. */
  busy: '#3D8BFD',
  /** Powered off. */
  off: '#7D8791',
} as const;

export type LedTone = keyof typeof LED;

export interface HangarTokens {
  dark: boolean;
  /** Faceplate band (always dark, like hardware). */
  chassis: string;
  chassisEdge: string;
  chassisText: string;
  chassisMuted: string;
  /** Console screen and its bezel. */
  screen: string;
  bezel: string;
  /** Page background behind panels, inventory tree background. */
  sunken: string;
  /** Panel surface. */
  surface: string;
  /** Hairlines between rows and panels. */
  rule: string;
  text: string;
  muted: string;
  /** Selected row / tree item. */
  selected: string;
  /** Hover on rows. */
  hover: string;
  /** Accent for links and the primary action (Headlamp's primary). */
  accent: string;
  /** Usage bars: used part, allocated part, track. */
  meterUsed: string;
  meterAlloc: string;
  meterTrack: string;
  radius: { small: number; panel: number };
  font: { mono: string };
}

export function hangarTokens(theme: Theme): HangarTokens {
  const dark = theme.palette.mode === 'dark';
  return {
    dark,
    chassis: dark ? '#0E1215' : '#1D2329',
    chassisEdge: dark ? '#242B31' : '#2D353D',
    chassisText: '#ECEFF2',
    chassisMuted: '#9AA5AF',
    screen: '#050706',
    bezel: '#2A3138',
    sunken: dark ? '#14181B' : '#F2F4F6',
    surface: theme.palette.background.paper,
    rule: theme.palette.divider,
    text: theme.palette.text.primary,
    muted: theme.palette.text.secondary,
    selected: dark ? 'rgba(61,139,253,0.18)' : 'rgba(61,139,253,0.12)',
    hover: dark ? 'rgba(255,255,255,0.04)' : 'rgba(16,24,32,0.04)',
    accent: theme.palette.primary.main,
    meterUsed: dark ? '#5B9CFF' : '#2F6FD6',
    meterAlloc: dark ? 'rgba(91,156,255,0.35)' : 'rgba(47,111,214,0.28)',
    meterTrack: dark ? 'rgba(255,255,255,0.08)' : 'rgba(16,24,32,0.08)',
    radius: { small: 4, panel: 6 },
    font: {
      mono: '"Overpass Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  };
}

/** Numbers line up in tables and meters. */
export const tabular = { fontVariantNumeric: 'tabular-nums' } as const;
