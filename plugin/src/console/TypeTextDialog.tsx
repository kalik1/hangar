/*
 * "Type text": the guest has no clipboard, so pasted text is typed into
 * it as key presses on a US keyboard.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import React from 'react';
import { useTokens } from '../ui/useTokens';
import { describeChar, planTyping } from './keys';

export function TypeTextDialog({
  open,
  vmName,
  onClose,
  onType,
}: {
  open: boolean;
  vmName: string;
  onClose: () => void;
  onType: (text: string) => void;
}) {
  const t = useTokens();
  const [text, setText] = React.useState('');
  const plan = React.useMemo(() => planTyping(text), [text]);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const titleId = 'hangar-type-text-title';
  const helpId = 'hangar-type-text-help';

  const submit = () => {
    if (!plan.strokes.length) return;
    onType(text);
    setText('');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="sm"
      // The text box is what the dialog is for.
      TransitionProps={{ onEntered: () => inputRef.current?.focus() }}
    >
      <DialogTitle id={titleId} sx={{ pb: 1 }}>
        Type text into {vmName}
      </DialogTitle>
      <DialogContent>
        <Box id={helpId} component="p" sx={{ mt: 0, mb: 1.5, fontSize: 14, color: t.muted }}>
          The text is typed as key presses, as on a US keyboard. Line breaks press Enter. Click
          where the text should go in the VM before typing.
        </Box>
        <TextField
          inputRef={inputRef}
          multiline
          minRows={5}
          maxRows={14}
          fullWidth
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
          inputProps={{
            'aria-label': 'Text to type',
            'aria-describedby': helpId,
            spellCheck: false,
            autoCapitalize: 'off',
            autoCorrect: 'off',
            style: { fontFamily: t.font.mono, fontSize: 13 },
          }}
          placeholder="Paste or write the text to type"
        />
        <Box
          sx={{ mt: 1, fontSize: 13, color: t.muted, display: 'flex', gap: 2, flexWrap: 'wrap' }}
        >
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {plan.strokes.length} {plan.strokes.length === 1 ? 'key' : 'keys'} to type
          </span>
          {plan.skipped.length > 0 && (
            <Box component="span" role="note" sx={{ color: 'warning.main' }}>
              Skipped, not on a US keyboard: {plan.skipped.slice(0, 12).map(describeChar).join(' ')}
              {plan.skipped.length > 12 ? ' …' : ''}
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          onClick={submit}
          disabled={!plan.strokes.length}
          sx={{ textTransform: 'none' }}
        >
          Type
        </Button>
      </DialogActions>
    </Dialog>
  );
}
