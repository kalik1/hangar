/*
 * The Files tab's dialogs and notices: the overwrite question (replace,
 * skip, keep both, apply to all), the edit conflict (keep the VM's,
 * overwrite it, save both), names, properties with the SHA-256, the file
 * list both panes share, and what the guest agent may reach in this guest
 * with the guest-side change that lets it reach every file.
 */

import { Icon } from '@iconify/react';
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
import { FileChannel, toFileError } from '../../api/guestfiles';
import {
  AgentReach,
  Answer,
  Conflict,
  EditConflictChoice,
  errorText,
  formatMode,
  FullAccess,
  GuestFile,
  GuestFileHash,
  GUESTFILES_ROLE,
  isDir,
  mtimeMs,
  ownerOf,
  SortKey,
  TYPE_LABEL,
} from '../../model/guestfiles';
import { formatBytes } from '../../model/units';
import { openDialog } from '../../ui/dialogs';
import { KV, Panel } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { GUEST_AGENT_OPTION } from '../../wizard/GuestAgentOption';
import { CommandBlock, Note } from './guestParts';

export const timeText = (mtime: string | undefined) => {
  const ms = mtimeMs(mtime);
  return ms === undefined ? '—' : new Date(ms).toLocaleString();
};

/* ------------------------------------------------------------- dialogs */

/** The overwrite question of one copy; null cancels the copy. */
export function askConflict(c: Conflict): Promise<Answer | null> {
  return new Promise(resolve => {
    openDialog(close => (
      <ConflictDialog
        c={c}
        onClose={a => {
          close();
          resolve(a);
        }}
      />
    ));
  });
}

function ConflictDialog({ c, onClose }: { c: Conflict; onClose: (a: Answer | null) => void }) {
  const t = useTokens();
  const [all, setAll] = React.useState(false);
  const side = (label: string, e: Conflict['existing']) => (
    <Box>
      <Box sx={{ fontWeight: 600 }}>{label}</Box>
      <Box sx={{ color: t.muted, ...tabular }}>
        {isDir(e) ? 'Folder' : formatBytes(e.size)}
        {e.mtime ? `, modified ${timeText(e.mtime)}` : ''}
      </Box>
    </Box>
  );
  const label: Record<string, string> = { replace: 'Replace', skip: 'Skip', keepBoth: 'Keep both' };
  return (
    <Dialog open onClose={() => onClose(null)} maxWidth="xs" fullWidth aria-labelledby="hangar-conflict-title">
      <DialogTitle id="hangar-conflict-title" sx={{ fontSize: 18 }}>
        {c.name} is already there
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 1.25, fontSize: 14 }}>
        <Box>
          {c.where} already has {isDir(c.existing) ? 'a folder' : 'a file'} named <b>{c.name}</b>.
          {!c.choices.includes('replace') && ' A folder and a file cannot replace each other.'}
        </Box>
        {side(`In ${c.where}`, c.existing)}
        {side('The one copied', c.incoming)}
        <FormControlLabel control={<Checkbox checked={all} onChange={e => setAll(e.target.checked)} />} label="Do the same for the other files of this copy" />
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={() => onClose(null)}>
          Cancel the copy
        </Button>
        {c.choices.map(ch => (
          <Button key={ch} variant={ch === 'replace' ? 'contained' : 'outlined'} disableElevation onClick={() => onClose({ choice: ch, all })} sx={{ textTransform: 'none' }}>
            {label[ch]}
          </Button>
        ))}
      </DialogActions>
    </Dialog>
  );
}

/** Both copies changed: which wins. null leaves it for later. */
export function askEditConflict(name: string, local: string): Promise<EditConflictChoice | null> {
  return new Promise(resolve => {
    openDialog(close => {
      const done = (c: EditConflictChoice | null) => {
        close();
        resolve(c);
      };
      return (
        <Dialog open onClose={() => done(null)} maxWidth="xs" fullWidth aria-labelledby="hangar-edit-conflict-title">
          <DialogTitle id="hangar-edit-conflict-title" sx={{ fontSize: 18 }}>
            {name} changed in the VM too
          </DialogTitle>
          <DialogContent sx={{ fontSize: 14, display: 'grid', gap: 1 }}>
            <Box>
              The VM’s copy is not the one Hangar read before (its size, time or SHA-256 differ). Writing {local} over it loses the VM’s changes.
            </Box>
          </DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            <Button color="inherit" onClick={() => done('keepVm')} sx={{ textTransform: 'none' }}>
              Keep the VM’s
            </Button>
            <Button variant="outlined" onClick={() => done('saveBoth')} sx={{ textTransform: 'none' }}>
              Save both
            </Button>
            <Button variant="contained" color="warning" disableElevation onClick={() => done('overwrite')} sx={{ textTransform: 'none' }}>
              Overwrite it
            </Button>
          </DialogActions>
        </Dialog>
      );
    });
  });
}

/** A name for a new folder or a rename; null when cancelled. */
export function promptName(o: { title: string; confirm: string; initial?: string; check: (s: string) => string | null }): Promise<string | null> {
  return new Promise(resolve => {
    openDialog(close => {
      const done = (v: string | null) => {
        close();
        resolve(v);
      };
      return <NameDialog o={o} onClose={done} />;
    });
  });
}

function NameDialog({ o, onClose }: { o: { title: string; confirm: string; initial?: string; check: (s: string) => string | null }; onClose: (v: string | null) => void }) {
  const [v, setV] = React.useState(o.initial ?? '');
  const problem = v ? o.check(v) : null;
  const ok = !!v && !problem && v !== o.initial;
  return (
    <Dialog open onClose={() => onClose(null)} maxWidth="xs" fullWidth aria-labelledby="hangar-name-title">
      <DialogTitle id="hangar-name-title" sx={{ fontSize: 18 }}>
        {o.title}
      </DialogTitle>
      <DialogContent>
        <TextField
          size="small"
          fullWidth
          sx={{ mt: 1 }}
          label="Name"
          value={v}
          onChange={e => setV(e.target.value)}
          error={!!problem}
          helperText={problem ?? ' '}
          onKeyDown={e => e.key === 'Enter' && ok && onClose(v)}
        />
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={() => onClose(null)}>
          Cancel
        </Button>
        <Button variant="contained" disableElevation disabled={!ok} onClick={() => onClose(v)}>
          {o.confirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A VM file's properties, its SHA-256 on demand (sha256sum, Get-FileHash). */
export function showProperties(ch: FileChannel, path: string, entry: GuestFile, osId: string) {
  openDialog(close => <PropertiesDialog ch={ch} path={path} entry={entry} osId={osId} onClose={close} />);
}

function PropertiesDialog({ ch, path, entry, osId, onClose }: { ch: FileChannel; path: string; entry: GuestFile; osId: string; onClose: () => void }) {
  const t = useTokens();
  const [e, setE] = React.useState<GuestFile>(entry);
  const [hash, setHash] = React.useState<GuestFileHash | 'busy' | { error: string } | null>(null);
  React.useEffect(() => {
    ch.stat(path).then(setE, () => undefined);
  }, [ch, path]);
  const compute = () => {
    setHash('busy');
    ch.hash(path).then(setHash, err => setHash({ error: errorText(toFileError(err), { path, osId }) }));
  };
  const rows: [React.ReactNode, React.ReactNode][] = [
    ['Path', <Box sx={{ fontFamily: t.font.mono, fontSize: 12.5, overflowWrap: 'anywhere' }}>{path}</Box>],
    ['Type', TYPE_LABEL[e.type] ?? e.type],
    ['Size', e.type === 'file' ? `${formatBytes(e.size)} (${e.size.toLocaleString()} bytes)` : '—'],
    ['Modified', timeText(e.mtime)],
  ];
  if (!ch.windows) {
    rows.push(['Permissions', <Box sx={{ fontFamily: t.font.mono, fontSize: 12.5 }}>{formatMode(e.type, e.mode)}{e.mode !== undefined ? ` (${e.mode.toString(8).padStart(4, '0')})` : ''}</Box>]);
    rows.push(['Owner', ownerOf(e) || '—']);
  }
  if (e.type === 'file')
    rows.push([
      'SHA-256',
      hash === null ? (
        <Button size="small" onClick={compute} sx={{ textTransform: 'none', p: 0, minWidth: 0 }}>
          Compute in the guest
        </Button>
      ) : hash === 'busy' ? (
        'Computing…'
      ) : 'error' in hash ? (
        <Box sx={{ color: '#C53030' }}>{hash.error}</Box>
      ) : (
        <Box sx={{ fontFamily: t.font.mono, fontSize: 12, overflowWrap: 'anywhere' }}>{hash.hash}</Box>
      ),
    ]);
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="hangar-props-title">
      <DialogTitle id="hangar-props-title" sx={{ fontSize: 18 }}>
        {e.name}
      </DialogTitle>
      <DialogContent>
        <KV rows={rows} labelWidth={110} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/* ----------------------------------------------------------- the list */

export interface ListColumns {
  mode: boolean;
  owner: boolean;
}

/** A pane's entries: select with the boxes (or a click), open a folder with its name or a double click, drag to the other pane. */
export function FileList({
  label,
  entries,
  selected,
  onSelect,
  onOpen,
  sort,
  onSort,
  columns,
  dragType,
  empty,
}: {
  label: string;
  entries: GuestFile[];
  selected: Set<string>;
  onSelect: (s: Set<string>) => void;
  onOpen: (e: GuestFile) => void;
  sort: { key: SortKey; desc: boolean };
  onSort: (s: { key: SortKey; desc: boolean }) => void;
  columns: ListColumns;
  /** The drag data type of this pane's rows. */
  dragType: string;
  empty?: React.ReactNode;
}) {
  const t = useTokens();
  const head = (key: SortKey, text: string, align: 'left' | 'right' = 'left') => (
    <Box component="th" sx={{ textAlign: align }} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <Box
        component="button"
        type="button"
        onClick={() => onSort({ key, desc: sort.key === key ? !sort.desc : false })}
        sx={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.25, '&:focus-visible': { outline: `2px solid ${t.accent}` } }}
      >
        {text}
        {sort.key === key && <Icon icon={sort.desc ? 'mdi:arrow-down' : 'mdi:arrow-up'} width={13} />}
      </Box>
    </Box>
  );
  const toggle = (n: string) => {
    const s = new Set(selected);
    if (s.has(n)) s.delete(n);
    else s.add(n);
    onSelect(s);
  };
  const allOn = entries.length > 0 && entries.every(e => selected.has(e.name));
  return (
    <Box sx={{ overflow: 'auto', flex: 1, minHeight: 240, maxHeight: 520 }}>
      <Box
        component="table"
        aria-label={label}
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13.5,
          ...tabular,
          '& th': { position: 'sticky', top: 0, background: t.surface, color: t.muted, fontWeight: 600, fontSize: 12.5, textAlign: 'left', px: 1, py: 0.5, whiteSpace: 'nowrap', zIndex: 1 },
          '& td': { px: 1, py: 0.25, borderTop: `1px solid ${t.rule}`, whiteSpace: 'nowrap' },
        }}
      >
        <thead>
          <tr>
            <Box component="th" sx={{ width: 32 }}>
              <Checkbox
                size="small"
                checked={allOn}
                indeterminate={!allOn && selected.size > 0}
                onChange={() => onSelect(allOn ? new Set() : new Set(entries.map(e => e.name)))}
                inputProps={{ 'aria-label': 'Select all' }}
                sx={{ p: 0.25 }}
              />
            </Box>
            {head('name', 'Name')}
            {head('size', 'Size', 'right')}
            {head('mtime', 'Modified')}
            {columns.mode && head('mode', 'Permissions')}
            {columns.owner && head('owner', 'Owner')}
          </tr>
        </thead>
        <tbody>
          {entries.map(e => {
            const on = selected.has(e.name);
            const folder = isDir(e);
            return (
              <Box
                component="tr"
                key={e.name}
                aria-selected={on}
                draggable
                onDragStart={(ev: React.DragEvent) => {
                  const names = on ? [...selected] : [e.name];
                  if (!on) onSelect(new Set([e.name]));
                  ev.dataTransfer.setData(dragType, JSON.stringify(names));
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={(ev: React.MouseEvent) => {
                  if ((ev.target as HTMLElement).closest('input,button')) return;
                  if (ev.ctrlKey || ev.metaKey) toggle(e.name);
                  else onSelect(new Set([e.name]));
                }}
                onDoubleClick={() => (folder || e.type === 'symlink') && onOpen(e)}
                sx={{ cursor: 'default', background: on ? t.selected : undefined, '&:hover': { background: on ? t.selected : t.hover } }}
              >
                <td>
                  <Checkbox size="small" checked={on} onChange={() => toggle(e.name)} inputProps={{ 'aria-label': `Select ${e.name}` }} sx={{ p: 0.25 }} />
                </td>
                <Box component="td" sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.name}>
                  <Icon
                    icon={folder ? 'mdi:folder' : e.type === 'symlink' ? 'mdi:link-variant' : e.type === 'file' ? 'mdi:file-outline' : 'mdi:file-cog-outline'}
                    width={16}
                    style={{ verticalAlign: '-3px', marginRight: 6, color: folder ? '#E8A33D' : t.muted }}
                  />
                  {folder ? (
                    <Box component="button" type="button" onClick={() => onOpen(e)} sx={{ all: 'unset', cursor: 'pointer', '&:hover': { textDecoration: 'underline' }, '&:focus-visible': { outline: `2px solid ${t.accent}` } }}>
                      {e.name}
                    </Box>
                  ) : (
                    e.name
                  )}
                </Box>
                <Box component="td" sx={{ textAlign: 'right', color: t.muted }}>
                  {folder ? '' : formatBytes(e.size)}
                </Box>
                <Box component="td" sx={{ color: t.muted }}>
                  {timeText(e.mtime)}
                </Box>
                {columns.mode && (
                  <Box component="td" sx={{ fontFamily: t.font.mono, fontSize: 12, color: t.muted }}>
                    {formatMode(e.type, e.mode)}
                  </Box>
                )}
                {columns.owner && (
                  <Box component="td" sx={{ color: t.muted }}>
                    {ownerOf(e) || '—'}
                  </Box>
                )}
              </Box>
            );
          })}
        </tbody>
      </Box>
      {!entries.length && empty && <Box sx={{ p: 2, color: t.muted, fontSize: 13.5 }}>{empty}</Box>}
    </Box>
  );
}

/* ------------------------------------------------- what the agent reaches */

/** One line on what the agent may touch in this guest, said up front. */
export function ReachNote({ reach, onShowChange }: { reach: AgentReach; onShowChange?: () => void }) {
  switch (reach) {
    case 'confined':
      return (
        <Note icon="mdi:shield-lock-outline">
          SELinux confines the guest agent in this guest (Fedora and the RHEL family): it sees only part of the guest, and writes only in /tmp and /var/tmp.{' '}
          {onShowChange && (
            <Box component="button" type="button" onClick={onShowChange} sx={{ all: 'unset', cursor: 'pointer', color: 'primary.main', textDecoration: 'underline' }}>
              Let it reach every file
            </Box>
          )}
        </Note>
      );
    case 'root':
      return (
        <Note icon="mdi:account-key-outline">
          The guest agent runs as root here: it reads every file whatever the guest’s permissions, and the files it creates are root’s unless you pick an owner below.
        </Note>
      );
    case 'system':
      return <Note icon="mdi:account-key-outline">The guest agent runs as SYSTEM here: it reads every file, and the files it creates are SYSTEM’s.</Note>;
    default:
      return null;
  }
}

/** A listing where the agent could not read every entry. */
export function PartialNote({ shown, reason }: { shown: number; reason?: string }) {
  return (
    <Note icon="mdi:eye-off-outline" tone="warn">
      <b>Partial listing:</b> some entries are hidden from the guest agent by SELinux. {shown.toLocaleString()} {shown === 1 ? 'entry' : 'entries'} could be read.
      {reason ? <Box sx={{ fontSize: 12.5, mt: 0.25 }}>{reason}</Box> : null}
    </Note>
  );
}

/** The guest-side change that lets the agent read and write every file, with its revert and its cost. */
export function FullAccessPanel({ fa, open, onToggle }: { fa: FullAccess; open: boolean; onToggle: () => void }) {
  const t = useTokens();
  return (
    <Box id="files-full-access">
      <Panel
        title="Let the guest agent reach every file"
        icon="mdi:shield-key-outline"
        actions={
          <Button size="small" onClick={onToggle} aria-expanded={open} sx={{ textTransform: 'none' }} endIcon={<Icon icon={open ? 'mdi:chevron-up' : 'mdi:chevron-down'} width={16} />}>
            {open ? 'Hide' : 'Show'}
          </Button>
        }
      >
        {!open ? (
          <Box sx={{ fontSize: 13.5, color: t.muted }}>The guest-side change for this guest, with how to undo it.</Box>
        ) : (
          <Box sx={{ display: 'grid', gap: 1.25, fontSize: 13.5, lineHeight: 1.55 }}>
            <Box>
              SELinux confines the QEMU guest agent here (<code>virt_qemu_ga_t</code>): it reads only part of the guest, writes only in /tmp and /var/tmp, and listings
              leave out what it cannot see. This change puts the agent’s domain in <code>files_unconfined_type</code>, with chown, fowner and fsetid, so it reads and
              writes every file while SELinux stays enforcing for the rest; a systemd drop-in empties <code>FILTER_RPC_ARGS</code>, so every agent command is on.
              {fa.overridesAllowList &&
                ' On this guest it also turns the allow-list of /etc/sysconfig/qemu-ga off, including any FILTER_RPC_ARGS the guest’s administrator set, a deliberate block of guest-exec too.'}
            </Box>
            <Box>
              Hangar cannot make it through the agent: the agent’s own programs run confined too, and on RHEL-family guests guest-exec stays off until the drop-in
              exists. The guest’s administrator runs it from the console or over SSH, as a sudoer:
            </Box>
            <CommandBlock lines={fa.enable} label="Let the guest agent reach every file" />
            <Note icon="mdi:alert-outline" tone="warn">
              With the change, whoever can call the agent through the guest bridge can read and change every file in the guest as root. The {GUESTFILES_ROLE} binding
              must therefore be at least as strict as root SSH into this guest.
            </Note>
            <Box>
              <Box sx={{ color: t.muted, fontSize: 12.5 }}>To undo it:</Box>
              <CommandBlock lines={fa.revert} label="Undo: let the guest agent reach every file" />
            </Box>
            <Box sx={{ color: t.muted, fontSize: 12.5 }}>
              The agent restarts, so the tab may say it is not connected for a moment. For new VMs, the New VM wizard’s option “{GUEST_AGENT_OPTION}” makes the
              same change at first boot.
            </Box>
          </Box>
        )}
      </Panel>
    </Box>
  );
}

/** Small typography helper for pane headers. */
export function PaneTitle({ icon, children }: { icon: string; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Typography component="h3" sx={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }} noWrap>
      <Icon icon={icon} width={18} style={{ color: t.muted, flex: 'none' }} />
      {children}
    </Typography>
  );
}
