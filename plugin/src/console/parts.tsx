/*
 * The console unit: a dark chassis with a compact toolbar on top and the
 * screen in its bezel below, like a KVM tray in a rack. Shared by the
 * graphical and the serial console.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { Led } from '../ui/Led';
import { LED, LedTone } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import { ACTION_LABEL, ScreenAction, ScreenMessage } from './view';

/** Focus ring and "keyboard captured" colour on the dark chassis. */
export const CHASSIS_FOCUS = LED.busy;

const chassisButton = (muted: string, text: string) => ({
  color: text,
  borderRadius: '4px',
  '&:hover': { background: 'rgba(255,255,255,0.08)' },
  '&.Mui-disabled': { color: muted, opacity: 0.45 },
  '&.Mui-focusVisible, &:focus-visible': {
    outline: `2px solid ${CHASSIS_FOCUS}`,
    outlineOffset: '1px',
  },
});

/** The whole unit; it fills the height of its parent. */
export const ConsoleShell = React.forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; label: string; minHeight?: number }
>(function ConsoleShell({ children, label, minHeight = 260 }, ref) {
  const t = useTokens();
  return (
    <Box
      ref={ref}
      role="region"
      aria-label={label}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight,
        minWidth: 0,
        background: t.chassis,
        color: t.chassisText,
        border: `1px solid ${t.chassisEdge}`,
        borderRadius: `${t.radius.panel}px`,
        overflow: 'hidden',
        // Fullscreen: the unit fills the display, square corners.
        '&:fullscreen': { borderRadius: 0, border: 'none' },
      }}
    >
      {children}
    </Box>
  );
});

export function ConsoleToolbar({ children, label }: { children: React.ReactNode; label: string }) {
  const t = useTokens();
  return (
    <Box
      role="toolbar"
      aria-label={label}
      sx={{
        containerType: 'inline-size',
        flex: 'none',
        borderBottom: `1px solid ${t.chassisEdge}`,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          minHeight: 38,
          px: 1,
          fontSize: 13,
          '@container (max-width: 720px)': { '& .hangar-console-label': { display: 'none' } },
          '@container (max-width: 520px)': {
            '& .hangar-console-status-extra': { display: 'none' },
          },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export function ToolbarSpacer() {
  return <Box sx={{ flex: 1, minWidth: 8 }} />;
}

export function ToolbarDivider() {
  const t = useTokens();
  return (
    <Box
      aria-hidden
      sx={{ width: '1px', height: 18, mx: 0.75, background: t.chassisEdge, flex: 'none' }}
    />
  );
}

/** An icon button with a tooltip; `pressed` makes it a toggle. */
export function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  tooltip,
  buttonRef,
  ...aria
}: {
  icon: string;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  pressed?: boolean;
  /** Longer than the label, e.g. why it is disabled. */
  tooltip?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  'aria-haspopup'?: 'menu' | 'dialog' | 'true';
  'aria-expanded'?: boolean;
}) {
  const t = useTokens();
  const button = (
    <IconButton
      ref={buttonRef}
      size="small"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      {...aria}
      sx={{
        ...chassisButton(t.chassisMuted, t.chassisText),
        width: 30,
        height: 30,
        ...(pressed ? { background: 'rgba(255,255,255,0.12)', color: '#fff' } : {}),
      }}
    >
      <Icon icon={icon} width={18} height={18} />
    </IconButton>
  );
  return (
    <Tooltip title={tooltip ?? label}>
      {/* A span so the tooltip still works on a disabled button. */}
      <span style={{ display: 'inline-flex' }}>{button}</span>
    </Tooltip>
  );
}

/** A text button with an icon; in a narrow toolbar only the icon stays. */
export function ToolTextButton({
  icon,
  label,
  onClick,
  disabled,
  tooltip,
  endIcon,
  buttonRef,
  dot,
  ...aria
}: {
  icon: string;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  tooltip?: string;
  endIcon?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** A small dot on the icon (something new to look at), in this colour. */
  dot?: string;
  'aria-haspopup'?: 'menu' | 'dialog' | 'true';
  'aria-expanded'?: boolean;
}) {
  const t = useTokens();
  return (
    <Tooltip title={tooltip ?? label}>
      <span style={{ display: 'inline-flex' }}>
        <Button
          ref={buttonRef}
          size="small"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          {...aria}
          sx={{
            ...chassisButton(t.chassisMuted, t.chassisText),
            textTransform: 'none',
            fontSize: 13,
            fontWeight: 500,
            minWidth: 30,
            height: 30,
            px: 0.75,
            gap: 0.75,
            whiteSpace: 'nowrap',
          }}
        >
          <Box component="span" sx={{ position: 'relative', display: 'inline-flex' }}>
            <Icon icon={icon} width={18} height={18} />
            {dot && (
              <Box
                component="span"
                aria-hidden
                sx={{ position: 'absolute', top: -2, right: -3, width: 7, height: 7, borderRadius: '50%', background: dot }}
              />
            )}
          </Box>
          <span className="hangar-console-label">{label}</span>
          {endIcon && <Icon icon={endIcon} width={16} height={16} style={{ marginLeft: -4 }} />}
        </Button>
      </span>
    </Tooltip>
  );
}

/** LED and label of the connection, with optional extra text (resolution, progress). */
export function StatusReadout({
  tone,
  label,
  extra,
}: {
  tone: LedTone;
  label: string;
  extra?: React.ReactNode;
}) {
  const t = useTokens();
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        pl: 0.5,
        pr: 1,
        minWidth: 0,
        whiteSpace: 'nowrap',
      }}
    >
      <Led tone={tone} />
      <Box component="span" sx={{ fontWeight: 500 }}>
        {label}
      </Box>
      {extra && (
        <Box
          component="span"
          className="hangar-console-status-extra"
          sx={{
            color: t.chassisMuted,
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {extra}
        </Box>
      )}
    </Box>
  );
}

/** Tells where the keyboard goes; a button that captures or releases it. */
export function KeyboardIndicator({
  captured,
  disabled,
  onCapture,
  onRelease,
}: {
  captured: boolean;
  disabled?: boolean;
  onCapture: () => void;
  onRelease: () => void;
}) {
  const t = useTokens();
  const label = captured ? 'Keyboard captured' : 'Capture keyboard';
  const tooltip = captured
    ? 'Keys go to the VM. Click outside the screen, or here, to release them.'
    : 'Keys go to the page. Click the screen, or here, to type into the VM.';
  return (
    <Tooltip title={tooltip}>
      <span style={{ display: 'inline-flex' }}>
        <Button
          size="small"
          aria-pressed={captured}
          aria-label={label}
          disabled={disabled}
          // Keep focus on the screen: a mousedown here would blur it first.
          onMouseDown={e => e.preventDefault()}
          onClick={captured ? onRelease : onCapture}
          sx={{
            ...chassisButton(t.chassisMuted, t.chassisMuted),
            textTransform: 'none',
            fontSize: 12.5,
            height: 26,
            px: 1,
            gap: 0.75,
            border: `1px solid ${captured ? CHASSIS_FOCUS : t.chassisEdge}`,
            color: captured ? t.chassisText : t.chassisMuted,
            background: captured ? 'rgba(61,139,253,0.16)' : 'transparent',
            whiteSpace: 'nowrap',
          }}
        >
          <Icon icon={captured ? 'mdi:keyboard' : 'mdi:keyboard-outline'} width={16} height={16} />
          <span className="hangar-console-label">
            {captured ? 'Keyboard captured' : 'Click screen to type'}
          </span>
        </Button>
      </span>
    </Tooltip>
  );
}

/** The screen in its bezel; `focused` lights its edge. Children are layered. */
export function Bezel({ children, focused }: { children: React.ReactNode; focused?: boolean }) {
  const t = useTokens();
  return (
    <Box sx={{ flex: 1, minHeight: 0, p: '6px', background: t.chassis, display: 'flex' }}>
      <Box
        sx={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          background: t.screen,
          borderRadius: `${t.radius.small}px`,
          border: `6px solid ${t.bezel}`,
          boxShadow: focused ? `0 0 0 2px ${CHASSIS_FOCUS}` : 'none',
          overflow: 'hidden',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/** A message on the screen: what happened, and what to do. */
export function ScreenNotice({
  message,
  actions,
}: {
  message: ScreenMessage;
  /** Handlers for the actions this console can take; others are not shown. */
  actions: Partial<Record<ScreenAction, () => void>>;
}) {
  const t = useTokens();
  const run = message.action ? actions[message.action] : undefined;
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
        background: message.translucent ? 'rgba(5,7,6,0.62)' : t.screen,
        color: t.chassisText,
        textAlign: 'center',
      }}
    >
      <Box
        sx={{
          maxWidth: 420,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1.25,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Led tone={message.tone} size={10} />
          <Box component="span" sx={{ fontSize: 16, fontWeight: 600 }}>
            {message.title}
          </Box>
        </Box>
        {message.detail && (
          <Box component="p" sx={{ m: 0, fontSize: 13.5, lineHeight: 1.5, color: t.chassisMuted }}>
            {message.detail}
          </Box>
        )}
        {run && message.action && (
          <Button
            variant="contained"
            size="small"
            onClick={run}
            disableElevation
            sx={{
              mt: 0.5,
              textTransform: 'none',
              fontWeight: 600,
              // Light on the dark screen, whatever the theme's primary colour.
              color: t.chassis,
              background: t.chassisText,
              '&:hover': { background: '#FFFFFF' },
              '&.Mui-focusVisible': { outline: `2px solid ${CHASSIS_FOCUS}`, outlineOffset: '2px' },
            }}
          >
            {ACTION_LABEL[message.action]}
          </Button>
        )}
      </Box>
    </Box>
  );
}
