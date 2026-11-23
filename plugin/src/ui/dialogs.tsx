/*
 * Dialogs opened from anywhere (tree, tables, faceplate): a module-level
 * stack rendered by <DialogHost/> in the shell. `confirm()` covers the
 * common case, including "type the name to delete".
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

type Render = (close: () => void) => React.ReactNode;

let stack: { id: number; render: Render }[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Opens a dialog; `render` gets `close`. Returns a function that closes it. */
export function openDialog(render: Render): () => void {
  const id = ++seq;
  const close = () => {
    stack = stack.filter(d => d.id !== id);
    emit();
  };
  stack = [...stack, { id, render: () => render(close) }];
  emit();
  return close;
}

export function DialogHost() {
  const items = React.useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => stack
  );
  return (
    <>
      {items.map(d => (
        <React.Fragment key={d.id}>{d.render(() => undefined)}</React.Fragment>
      ))}
    </>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirm: string;
  danger?: boolean;
  /** The user must type this to enable the button. */
  typeToConfirm?: string;
  /** Optional checkbox, its value is returned. */
  option?: { label: string; help?: string; initial?: boolean };
}

/** Resolves to null when cancelled, else { option } (the checkbox value). */
export function confirm(o: ConfirmOptions): Promise<{ option: boolean } | null> {
  return new Promise(resolve => {
    openDialog(close => (
      <ConfirmDialog
        o={o}
        onClose={r => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function ConfirmDialog({ o, onClose }: { o: ConfirmOptions; onClose: (r: { option: boolean } | null) => void }) {
  const [typed, setTyped] = React.useState('');
  const [opt, setOpt] = React.useState(!!o.option?.initial);
  const ok = !o.typeToConfirm || typed === o.typeToConfirm;
  return (
    <Dialog open onClose={() => onClose(null)} maxWidth="xs" fullWidth aria-labelledby="hangar-confirm-title">
      <DialogTitle id="hangar-confirm-title" sx={{ fontSize: 18 }}>
        {o.title}
      </DialogTitle>
      <DialogContent>
        {o.body && <Box sx={{ fontSize: 14, lineHeight: 1.55, '& p': { m: 0, mb: 1 } }}>{o.body}</Box>}
        {o.option && (
          <FormControlLabel
            sx={{ mt: 1, alignItems: 'flex-start' }}
            control={<Checkbox checked={opt} onChange={e => setOpt(e.target.checked)} sx={{ mt: -0.75 }} />}
            label={
              <Box>
                <Typography sx={{ fontSize: 14 }}>{o.option.label}</Typography>
                {o.option.help && (
                  <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{o.option.help}</Typography>
                )}
              </Box>
            }
          />
        )}
        {o.typeToConfirm && (
          <TextField
           
            fullWidth
            size="small"
            sx={{ mt: 2 }}
            label={`Type ${o.typeToConfirm} to confirm`}
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && ok) onClose({ option: opt });
            }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(null)} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={() => onClose({ option: opt })}
          disabled={!ok}
          variant="contained"
          color={o.danger ? 'error' : 'primary'}
         
        >
          {o.confirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
