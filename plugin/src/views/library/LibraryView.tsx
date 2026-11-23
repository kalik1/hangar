/*
 * Storage → Images: the image library, disk images and ISOs every folder
 * can make VMs from. Import from a URL or a registry, upload from this
 * computer, edit, delete, start a new VM. Without the library namespace,
 * offer to create it with the sharing that lets every folder clone from it.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHangar } from '../../api/data';
import { createLibrary, deleteImage, shareLibrary, SharingState, sharingState } from '../../api/library';
import { cancelUpload, uploads, UploadState } from '../../api/upload';
import { clonesInProgress, LibraryItem, libraryItems, SourceRow,sourceRows } from '../../model/library';
import { DiskState } from '../../model/storage';
import { formatAge, formatBytes } from '../../model/units';
import { osIcon } from '../../model/vm';
import { useK8s, useSettings } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { confirm, openDialog } from '../../ui/dialogs';
import { Divider, Empty, IconAction, K8sName, Panel, Tag, Toolbar, ToolButton } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { OS_CHOICES } from '../../wizard/catalog';
import { openNewVmWizard } from '../../wizard/open';
import { Note, srOnly, StateLabel } from '../storage/parts';
import { EditImageDialog } from './EditImageDialog';
import { ImportDialog, ImportKind } from './ImportDialog';
import { UploadDialog } from './UploadDialog';

type Filter = 'all' | 'disk' | 'iso';

function useUploads(): UploadState[] {
  return React.useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
}

/** The row's state, with the upload this browser is sending, if any. */
function liveState(item: LibraryItem, up: UploadState | undefined): DiskState {
  if (!up || item.state.ready) return item.state;
  if (up.phase === 'preparing') return { label: 'Preparing the upload', tone: 'busy', ready: false };
  if (up.phase === 'uploading') {
    const pct = up.total ? (up.loaded / up.total) * 100 : 0;
    return {
      label: `Uploading ${Math.floor(pct)}%`,
      tone: 'busy',
      progress: pct,
      detail: `${formatBytes(up.loaded)} of ${formatBytes(up.total)}${up.rate ? `, ${formatBytes(up.rate)}/s` : ''}`,
      ready: false,
    };
  }
  if (up.phase === 'processing') return { label: 'Processing the image', tone: 'busy', ready: false };
  if (up.phase === 'failed' && item.dv?.status?.phase === 'UploadReady') return { label: 'Upload failed', tone: 'fault', detail: up.error, ready: false };
  return item.state;
}

const osLabel = (id: string) => OS_CHOICES.find(o => o.id === id)?.label ?? (id ? id : 'Other');

export function ImagesTab() {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const [settings] = useSettings();
  const ns = settings.libraryNamespace;
  const ups = useUploads();
  const items = React.useMemo(() => libraryItems(d.dvs, d.pvcs, ns), [d.dvs, d.pvcs, ns]);
  const exists = d.namespaces.some(n => n.metadata.name === ns) || items.some(i => i.namespace === ns);
  const [sharing, setSharing] = React.useState<SharingState>('unknown');
  const [filter, setFilter] = React.useState<Filter>('all');
  const [q, setQ] = React.useState('');
  const [menu, setMenu] = React.useState<HTMLElement | null>(null);
  const sources = sourceRows(d.dataSources, d.dataImportCrons);

  React.useEffect(() => {
    if (!exists) return;
    let alive = true;
    const look = () => sharingState(ns).then(s => alive && setSharing(s));
    look();
    const id = window.setInterval(look, 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [exists, ns]);

  const openImport = (kind: ImportKind) => openDialog(close => <ImportDialog d={d} namespace={ns} kind={kind} onClose={close} />);
  const openUpload = (into?: LibraryItem) => openDialog(close => <UploadDialog d={d} namespace={ns} into={into} onClose={close} />);

  if (!d.loading && !exists) {
    return (
      <Box>
        <Panel>
          <Empty
            icon="mdi:bookshelf"
            title="There is no image library yet"
            action={
              <Button variant="contained" sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={18} />} onClick={() => createLibrary(ns).catch(() => undefined)}>
                Create the library
              </Button>
            }
          >
            The library keeps disk images and ISOs that every folder can make VMs from. Hangar creates the namespace {ns}, and lets every
            folder copy its images (a role on datavolumes/source for all users and service accounts).
          </Empty>
        </Panel>
      </Box>
    );
  }

  const shown = items.filter(i => {
    if (filter !== 'all' && i.media !== filter) return false;
    if (q && ![i.displayName, i.name, i.os, osLabel(i.os), i.source.detail].join(' ').toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const isoCount = items.filter(i => i.media === 'iso').length;

  const remove = async (i: LibraryItem) => {
    const copying = clonesInProgress(i, d.dvs);
    const up = uploads.get(i.key);
    const ok = await confirm({
      title: `Delete ${i.displayName}?`,
      body: (
        <>
          <p>
            The {i.media === 'iso' ? 'ISO' : 'image'} and its {formatBytes(i.sizeBytes)} disk are deleted from the library.
          </p>
          <p>VMs made from it are not affected: each has its own copy of the disk.</p>
          {copying.length > 0 && (
            <p>
              <b>
                {copying.length} disk{copying.length === 1 ? ' is' : 's are'} being copied from it right now
              </b>{' '}
              ({copying.map(c => `${c.metadata.namespace}/${c.metadata.name}`).join(', ')}): {copying.length === 1 ? 'that copy fails' : 'those copies fail'}.
            </p>
          )}
          {up?.phase === 'uploading' && <p>The upload in progress is stopped.</p>}
        </>
      ),
      confirm: 'Delete image',
      danger: true,
      typeToConfirm: i.name,
    });
    if (!ok) return;
    if (up?.phase === 'uploading' || up?.phase === 'preparing') cancelUpload(i.key);
    else deleteImage(i).catch(() => undefined);
  };

  const columns: Column<LibraryItem>[] = [
    {
      id: 'name',
      header: 'Name',
      sort: i => i.displayName,
      width: 340,
      cell: i => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
          <Icon icon={i.media === 'iso' ? 'mdi:disc' : osIcon(i.os)} width={20} style={{ color: t.muted, flex: 'none' }} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.displayName}</Box>
            {i.description && <Box sx={{ fontSize: 12.5, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.description}</Box>}
            {k8s && (
              <K8sName>
                {i.dv ? 'DataVolume' : 'PVC'} {i.namespace}/{i.name}
              </K8sName>
            )}
          </Box>
        </Box>
      ),
    },
    { id: 'kind', header: 'Kind', sort: i => i.media, cell: i => (i.media === 'iso' ? 'ISO' : 'Disk image') },
    {
      id: 'os',
      header: 'Guest OS',
      sort: i => osLabel(i.os),
      cell: i => (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
          <Icon icon={osIcon(i.os)} width={16} style={{ color: t.muted }} />
          {osLabel(i.os)}
        </Box>
      ),
    },
    { id: 'size', header: 'Size', align: 'right', sort: i => i.sizeBytes, cell: i => formatBytes(i.sizeBytes) },
    {
      id: 'state',
      header: 'State',
      sort: i => liveState(i, ups.find(u => u.key === i.key)).label,
      width: 220,
      cell: i => <StateLabel state={liveState(i, ups.find(u => u.key === i.key))} />,
    },
    {
      id: 'source',
      header: 'Source',
      minWidth: 1100,
      sort: i => i.source.detail ?? i.source.kind,
      cell: i => (
        <Box sx={{ color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }} title={i.source.detail}>
          {i.source.kind === 'upload'
            ? 'Uploaded'
            : i.source.kind === 'registry'
            ? (i.source.detail ?? '').replace(/^docker:\/\//, '')
            : i.source.kind === 'http'
            ? (i.source.detail ?? '').replace(/^https?:\/\//, '')
            : i.source.kind === 'clone'
            ? `Copy of ${i.source.detail}`
            : '—'}
        </Box>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      minWidth: 900,
      sort: i => i.created ?? '',
      cell: i => <span title={i.created ? new Date(i.created).toLocaleString() : undefined}>{i.created ? `${formatAge(i.created)} ago` : '—'}</span>,
    },
    {
      id: 'actions',
      header: <Box component="span" sx={srOnly}>Actions</Box>,
      align: 'right',
      width: 150,
      cell: i => {
        const up = ups.find(u => u.key === i.key);
        const sending = up && (up.phase === 'uploading' || up.phase === 'preparing');
        const waiting = !sending && i.dv?.status?.phase === 'UploadReady';
        return (
          <Box sx={{ display: 'inline-flex' }}>
            {sending ? (
              <IconAction icon="mdi:cancel" label={`Stop uploading ${i.displayName}`} onClick={() => remove(i)} />
            ) : waiting ? (
              <IconAction icon="mdi:tray-arrow-up" label={`Upload a file into ${i.displayName}`} onClick={() => openUpload(i)} />
            ) : (
              <IconAction
                icon="mdi:plus-box-outline"
                label={i.state.ready ? `New VM from ${i.displayName}` : `New VM from ${i.displayName}: wait until it is ready`}
                disabled={!i.state.ready}
                onClick={() => openNewVmWizard({ image: { namespace: i.namespace, name: i.name } })}
              />
            )}
            <IconAction icon="mdi:pencil-outline" label={`Edit ${i.displayName}`} onClick={() => openDialog(close => <EditImageDialog item={i} onClose={close} />)} />
            <IconAction icon="mdi:delete-outline" label={`Delete ${i.displayName}`} onClick={() => remove(i)} />
          </Box>
        );
      },
    },
  ];

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography sx={{ color: t.muted, fontSize: 13.5, ...tabular }}>
          {items.length - isoCount} disk image{items.length - isoCount === 1 ? '' : 's'}, {isoCount} ISO{isoCount === 1 ? '' : 's'} in the library
          {sharing === 'shared' ? ', shared with every folder' : ''}
        </Typography>
        {k8s && <K8sName>namespace {ns}</K8sName>}
      </Box>

      {sharing === 'missing' && (
        <Note tone="warn" icon={<Icon icon="mdi:account-group-outline" width={18} style={{ color: '#B7791F', flex: 'none', marginTop: 1 }} />}>
          <b>Other folders cannot use these images yet.</b> CDI copies an image into a VM's folder only if the folder may read the library
          (datavolumes/source).{' '}
          <Box
            component="button"
            onClick={() => shareLibrary(ns).then(() => setSharing('shared')).catch(() => undefined)}
            sx={{ all: 'unset', cursor: 'pointer', color: t.accent, textDecoration: 'underline', '&:focus-visible': { outline: `2px solid ${t.accent}` } }}
          >
            Share with every folder
          </Box>
        </Note>
      )}

      <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
        <Toolbar>
          <ToolButton icon="mdi:cloud-download-outline" onClick={e => setMenu(e.currentTarget)} aria-haspopup="menu" aria-expanded={!!menu}>
            Import image
          </ToolButton>
          <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
            <MenuItem
              onClick={() => {
                setMenu(null);
                openImport('http');
              }}
            >
              <Icon icon="mdi:link-variant" width={18} style={{ marginRight: 10 }} />
              From a URL…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                openImport('registry');
              }}
            >
              <Icon icon="mdi:docker" width={18} style={{ marginRight: 10 }} />
              From a container registry…
            </MenuItem>
          </Menu>
          <ToolButton icon="mdi:tray-arrow-up" onClick={() => openUpload()}>
            Upload file
          </ToolButton>
          <Divider />
          <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['disk', 'Disk images'],
                ['iso', 'ISOs'],
              ] as [Filter, string][]
            ).map(([v, l]) => (
              <ToggleButton key={v} value={v} sx={{ textTransform: 'none', py: 0.25, px: 1.25, fontSize: 13 }}>
                {l}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Box sx={{ flex: 1 }} />
          <TextField
            size="small"
            placeholder="Filter"
            value={q}
            onChange={e => setQ(e.target.value)}
            inputProps={{ 'aria-label': 'Filter the images' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Icon icon="mdi:filter-variant" width={16} />
                </InputAdornment>
              ),
            }}
            sx={{ width: 180, my: 0.5, '& input': { py: 0.6, fontSize: 13.5 } }}
          />
        </Toolbar>
        <DataTable
          label="Library images"
          rows={shown}
          columns={columns}
          rowKey={i => i.key}
          initialSort={{ id: 'name', dir: 'asc' }}
          empty={
            items.length === 0 ? (
              <Empty
                icon="mdi:bookshelf"
                title="The library is empty"
                action={
                  <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }}>
                    <ToolButton icon="mdi:cloud-download-outline" variant="outlined" onClick={() => openImport('http')}>
                      Import image
                    </ToolButton>
                    <ToolButton icon="mdi:tray-arrow-up" variant="outlined" onClick={() => openUpload()}>
                      Upload file
                    </ToolButton>
                  </Box>
                }
              >
                Import a cloud image (Fedora, Ubuntu, Debian…) from its URL or a container registry, or upload an ISO to install from.
              </Empty>
            ) : (
              <Empty icon="mdi:filter-variant" title="Nothing matches the filter" />
            )
          }
        />
      </Box>

      {sources.length > 0 && <SourcesPanel rows={sources} />}
    </Box>
  );
}

function SourcesPanel({ rows }: { rows: SourceRow[] }) {
  const t = useTokens();
  const k8s = useK8s();
  const columns: Column<SourceRow>[] = [
    {
      id: 'name',
      header: 'Name',
      sort: r => r.name,
      cell: r => (
        <Box>
          <Box sx={{ fontWeight: 600 }}>{r.name}</Box>
          {k8s && <K8sName>DataSource {r.key}</K8sName>}
        </Box>
      ),
    },
    { id: 'folder', header: k8s ? 'Namespace' : 'Folder', sort: r => r.namespace, cell: r => r.namespace },
    {
      id: 'updates',
      header: 'Kept up to date',
      cell: r =>
        r.cron ? (
          <Box sx={{ minWidth: 0 }} title={r.cron.source}>
            <Box>
              From {(r.cron.source ?? '').replace(/^docker:\/\//, '') || 'a registry'}
              {r.cron.upToDate === false && (
                <Box component="span" sx={{ ml: 1 }}>
                  <Tag tone="warn">Updating</Tag>
                </Box>
              )}
            </Box>
            <Box sx={{ fontSize: 12.5, color: t.muted }}>
              {r.cron.schedule ? `Schedule ${r.cron.schedule}` : ''}
              {r.cron.lastImport ? `, last import ${formatAge(r.cron.lastImport)} ago` : ''}
            </Box>
          </Box>
        ) : (
          <Box sx={{ color: t.muted }}>No, it points at a fixed disk</Box>
        ),
    },
    { id: 'target', header: 'Disk', minWidth: 900, cell: r => <Box sx={{ color: t.muted }}>{r.target ?? '—'}</Box> },
    {
      id: 'state',
      header: 'State',
      sort: r => (r.ready ? 'a' : 'b'),
      cell: r => <StateLabel state={r.ready ? { label: 'Ready', tone: 'on', ready: true } : { label: 'Not ready', tone: 'standby', detail: r.message, ready: false }} />,
    },
  ];
  return (
    <Panel title={`Boot sources (${rows.length})`} icon="mdi:layers-outline" dense>
      <Box sx={{ px: 2, py: 1, fontSize: 13, color: t.muted, borderBottom: `1px solid ${t.rule}` }}>
        CDI DataSources: images the cluster keeps, often refreshed from a registry on a schedule (DataImportCron).
      </Box>
      <DataTable label="Boot sources" rows={rows} columns={columns} rowKey={r => r.key} initialSort={{ id: 'name', dir: 'asc' }} />
    </Panel>
  );
}
