/*
 * The console's Clipboard panel: what the VM copied last (with a button that
 * puts it on this computer's clipboard), a field to send text to the VM's
 * clipboard, and typing as the fallback for VMs without clipboard sharing.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { ClipboardMode } from '../model/clipboard';
import { Led } from '../ui/Led';
import { useTokens } from '../ui/useTokens';

/** Puts text on this computer's clipboard. On plain http only within a click or key press (a user gesture). */
export async function writeHostClipboard(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through: no permission or no focus */
    }
  }
  return copyWithCommand(text);
}

/** document.execCommand('copy') with a one-shot copy handler: no selection or focus change needed. */
export function copyWithCommand(text: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, true);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

const MODE_TEXT: Record<ClipboardMode, { tone: 'on' | 'standby' | 'off'; title: string; help: string }> = {
  shared: {
    tone: 'on',
    title: 'Clipboard shared with the VM',
    help: "Ctrl+V in the console pastes this computer's clipboard. What you copy in the VM shows up here, and on this computer's clipboard when the browser allows it.",
  },
  pending: {
    tone: 'standby',
    title: 'Clipboard shared from the next power-on',
    help: 'Clipboard sharing is on for this VM but the running instance started without it. Until then, type text into the VM.',
  },
  'off-pending': {
    tone: 'standby',
    title: 'Clipboard shared until the next power-on',
    help: "Clipboard sharing was turned off; it stops at the next power-on.",
  },
  none: {
    tone: 'off',
    title: 'Clipboard not shared',
    help: "This VM does not share its clipboard: Hangar types the text as key presses (US layout). Turn on clipboard sharing in the VM's Configure tab; the guest needs the SPICE agent.",
  },
};

export function ClipboardTray({
  anchorEl,
  onClose,
  mode,
  vmText,
  vmTextAt,
  canType,
  onSend,
  onType,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  mode: ClipboardMode;
  vmText: string | null;
  vmTextAt: number | null;
  canType: boolean;
  onSend: (text: string) => void;
  onType: (text: string) => void;
}) {
  const t = useTokens();
  const [draft, setDraft] = React.useState('');
  const [copied, setCopied] = React.useState<'ok' | 'failed' | null>(null);
  const shared = mode === 'shared' || mode === 'off-pending';
  const m = MODE_TEXT[mode];

  React.useEffect(() => {
    if (!anchorEl) setCopied(null);
  }, [anchorEl]);

  // Ctrl+V into the field works on plain http too (a paste event, not the Clipboard API).
  return (
    <Popover
      open={!!anchorEl}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 380, p: 2, display: 'grid', gap: 1.5 } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Led tone={m.tone} />
        <Typography component="h2" sx={{ fontSize: 15, fontWeight: 600 }}>
          {m.title}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: 12.5, color: t.muted }}>{m.help}</Typography>

      {shared && (
        <Box>
          <Box sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>
            Copied in the VM
            {vmTextAt && (
              <Box component="span" sx={{ fontWeight: 400, color: t.muted, ml: 0.75 }}>
                {new Date(vmTextAt).toLocaleTimeString()}
              </Box>
            )}
          </Box>
          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={6}
            size="small"
            value={vmText ?? ''}
            placeholder="Nothing yet: copy something in the VM"
            InputProps={{ readOnly: true, sx: { fontFamily: t.font.mono, fontSize: 12.5 } }}
            inputProps={{ 'aria-label': 'Text copied in the VM' }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.75 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={!vmText}
              startIcon={<Icon icon="mdi:content-copy" width={16} />}
              sx={{ textTransform: 'none' }}
              onClick={() => setCopied(vmText && copyWithCommand(vmText) ? 'ok' : 'failed')}
            >
              Copy to this computer
            </Button>
            {copied && (
              <Box sx={{ fontSize: 12.5, color: copied === 'ok' ? t.muted : '#E5484D' }}>
                {copied === 'ok' ? 'Copied' : 'The browser refused: select the text and press Ctrl+C'}
              </Box>
            )}
          </Box>
        </Box>
      )}

      <Box>
        <Box sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>{shared ? 'Send to the VM' : 'Type into the VM'}</Box>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          size="small"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Paste text here"
          InputProps={{ sx: { fontFamily: t.font.mono, fontSize: 12.5 } }}
          inputProps={{ 'aria-label': shared ? 'Text for the VM clipboard' : 'Text to type into the VM' }}
        />
        <Box sx={{ display: 'flex', gap: 1, mt: 0.75, flexWrap: 'wrap' }}>
          {shared && (
            <Button
              size="small"
              variant="contained"
              disableElevation
              disabled={!draft || !canType}
              sx={{ textTransform: 'none' }}
              onClick={() => {
                onSend(draft);
                onClose();
              }}
            >
              Put on the VM&apos;s clipboard
            </Button>
          )}
          <Button
            size="small"
            variant={shared ? 'outlined' : 'contained'}
            disableElevation
            disabled={!draft || !canType}
            sx={{ textTransform: 'none' }}
            onClick={() => {
              onType(draft);
              onClose();
            }}
          >
            Type it
          </Button>
        </Box>
      </Box>
    </Popover>
  );
}
