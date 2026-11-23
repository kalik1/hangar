/*
 * Storage → Disks: every VM disk with the VM using it, size, datastore and
 * the host it lives on when local, its snapshots, its state; unattached
 * disks are called out. Actions: move to another datastore, expand,
 * attach an unattached disk to a VM, delete it, open its image in Ceph.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { HangarData } from '../../api/data';
import { deleteDisk } from '../../api/storage';
import { rbdImageOf, snapshotsByClaim } from '../../model/datastoreSpec';
import { claimLocality, localityLabel } from '../../model/placement';
import { DiskInventory, DiskRow, expandProblem, requestedSize } from '../../model/storage';
import { formatBytes } from '../../model/units';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Column, DataTable } from '../../ui/DataTable';
import { confirm, openDialog } from '../../ui/dialogs';
import { Empty, IconAction, K8sName, Tag, Toolbar } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { MoveDiskDialog } from '../vm/MoveDiskDialog';
import { AttachDiskDialog } from './AttachDiskDialog';
import { CephRoutes, cephUrl, useCephRoutes } from './cephLinks';
import { SearchField } from './DatastoresTab';
import { ExpandDiskDialog } from './ExpandDiskDialog';
import { Note, srOnly, StateLabel } from './parts';

type Filter = 'all' | 'vm' | 'unattached' | 'image';

export function DisksTab({ d, inv }: { d: HangarData; inv: DiskInventory }) {
  const t = useTokens();
  const k8s = useK8s();
  const ceph = useCephRoutes();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [containers, setContainers] = React.useState(false);
  const [q, setQ] = React.useState('');
  const snaps = React.useMemo(() => snapshotsByClaim(d.volumeSnapshots), [d.volumeSnapshots]);

  const counts = {
    vm: inv.rows.filter(r => r.kind === 'vm').length,
    unattached: inv.rows.filter(r => r.kind === 'unattached').length,
    image: inv.rows.filter(r => r.kind === 'image').length,
    container: inv.rows.filter(r => r.kind === 'container').length,
  };
  const unattachedBytes = inv.rows.filter(r => r.kind === 'unattached').reduce((s, r) => s + r.sizeBytes, 0);
  const hostOf = (r: DiskRow) => {
    const pv = r.pvc?.spec?.volumeName ? d.idx.pv.get(r.pvc.spec.volumeName) : undefined;
    const loc = r.pvc ? claimLocality(r.pvc, pv, d.nodes) : undefined;
    return loc?.kind === 'local' ? loc.hosts.join(', ') : '';
  };
  const rows = inv.rows.filter(r => {
    if (r.kind === 'container' && !(containers && filter === 'all')) return false;
    if (filter !== 'all' && r.kind !== filter) return false;
    if (q) {
      const hay = [r.name, r.namespace, r.datastore, hostOf(r), ...r.uses.map(u => u.vm.metadata.name), r.state.label].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
      {counts.unattached > 0 && filter !== 'unattached' && (
        <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
          <Note tone="warn" icon={<Icon icon="mdi:alert-outline" width={18} style={{ color: '#B7791F', flex: 'none', marginTop: 1 }} />}>
            <b>
              {counts.unattached} disk{counts.unattached === 1 ? ' is' : 's are'} not attached to any VM
            </b>{' '}
            ({formatBytes(unattachedBytes)}), for example kept when a VM was deleted.{' '}
            <Box component="button" onClick={() => setFilter('unattached')} sx={{ all: 'unset', cursor: 'pointer', color: t.accent, textDecoration: 'underline', '&:focus-visible': { outline: `2px solid ${t.accent}` } }}>
              Show them
            </Box>
          </Note>
        </Box>
      )}
      <Toolbar sx={{ gap: 1, py: 0.5 }}>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} aria-label="Show disks">
          {(
            [
              ['all', 'All'],
              ['vm', `Attached (${counts.vm})`],
              ['unattached', `Unattached (${counts.unattached})`],
              ['image', `Images (${counts.image})`],
            ] as [Filter, string][]
          ).map(([v, l]) => (
            <ToggleButton key={v} value={v} sx={{ textTransform: 'none', py: 0.25, px: 1.25, fontSize: 13 }}>
              {l}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {counts.container > 0 && (
          <FormControlLabel
            sx={{ ml: 1, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
            control={<Switch size="small" checked={containers} onChange={e => setContainers(e.target.checked)} disabled={filter !== 'all'} />}
            label={`Container volumes (${counts.container})`}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {inv.hidden > 0 && k8s && <K8sName>{inv.hidden} CDI working claims hidden</K8sName>}
        <SearchField value={q} onChange={setQ} label="Filter the disks" />
      </Toolbar>
      <DiskTable rows={rows} d={d} empty={inv.rows.length === 0} filter={filter} snaps={snaps} ceph={ceph} />
    </Box>
  );
}

function UsedBy({ row, d }: { row: DiskRow; d: HangarData }) {
  const t = useTokens();
  if (row.uses.length) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {row.uses.map(u => (
          <Box key={u.vm.metadata.uid ?? u.vm.metadata.name} sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline', minWidth: 0 }}>
            <Box component={RouterLink} to={hrefFor('vm', u.vm.metadata.namespace, u.vm.metadata.name)} sx={{ color: t.accent, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {u.vm.metadata.name}
            </Box>
            <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>
              {u.device === 'cdrom' ? 'CD-ROM' : u.device === 'state' ? 'TPM and UEFI state' : u.slot}
            </Box>
          </Box>
        ))}
      </Box>
    );
  }
  if (row.kind === 'image')
    return (
      <Box component={RouterLink} to={hrefFor('storage', 'images')} sx={{ color: t.accent }}>
        Library {row.media === 'iso' ? 'ISO' : 'image'}
      </Box>
    );
  if (row.kind === 'unattached') {
    const vmGone = row.formerVmUid && !d.vms.some(v => v.metadata.uid === row.formerVmUid);
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Tag tone="warn">Unattached</Tag>
        {vmGone && (
          <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>
            its VM was deleted
          </Box>
        )}
      </Box>
    );
  }
  return <Box sx={{ color: t.muted }}>Container volume</Box>;
}

const USED_ORDER: Record<DiskRow['kind'], number> = { vm: 1, unattached: 2, image: 3, container: 4, internal: 5 };

function DiskTable({
  rows,
  d,
  empty,
  filter,
  snaps,
  ceph,
}: {
  rows: DiskRow[];
  d: HangarData;
  empty: boolean;
  filter: Filter;
  snaps: Map<string, any[]>;
  ceph: CephRoutes;
}) {
  const t = useTokens();
  const k8s = useK8s();
  const scOf = (r: DiskRow) => d.storageClasses.find(s => s.metadata.name === r.datastore);
  const pvOf = (r: DiskRow) => (r.pvc?.spec?.volumeName ? d.idx.pv.get(r.pvc.spec.volumeName) : undefined);
  const remove = async (r: DiskRow) => {
    const ok = await confirm({
      title: `Delete disk ${r.name}?`,
      body: (
        <>
          <p>
            It is not attached to any VM. Its {formatBytes(r.sizeBytes)} of data {r.datastore ? `on ${r.datastore} ` : ''}are lost for good.
          </p>
          <p>Snapshots that hold a copy of it are not deleted.</p>
        </>
      ),
      confirm: 'Delete disk',
      danger: true,
      typeToConfirm: r.name,
    });
    if (ok) deleteDisk(r).catch(() => undefined);
  };
  const columns: Column<DiskRow>[] = [
    {
      id: 'name',
      header: 'Disk',
      sort: r => r.name,
      width: 280,
      cell: r => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Icon icon={r.media === 'iso' ? 'mdi:disc' : 'mdi:harddisk'} width={16} style={{ color: t.muted, flex: 'none' }} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</Box>
            {k8s && (
              <K8sName>
                {r.pvc ? 'PVC' : ''}
                {r.pvc && r.dv ? ' + ' : ''}
                {r.dv ? 'DataVolume' : ''} {r.namespace}/{r.name}
                {r.pvc?.spec?.volumeName ? ` → ${r.pvc.spec.volumeName}` : ''}
              </K8sName>
            )}
          </Box>
        </Box>
      ),
    },
    { id: 'vm', header: 'Used by', sort: r => `${USED_ORDER[r.kind]}-${r.uses[0]?.vm.metadata.name ?? ''}-${r.name}`, cell: r => <UsedBy row={r} d={d} /> },
    { id: 'folder', header: k8s ? 'Namespace' : 'Folder', sort: r => r.namespace, cell: r => r.namespace, minWidth: 820 },
    {
      id: 'size',
      header: 'Size',
      align: 'right',
      sort: r => r.sizeBytes,
      cell: r => {
        const req = requestedSize(r.pvc);
        return (
          <span title={req ? `Being expanded to ${formatBytes(req)}` : undefined}>
            {formatBytes(r.sizeBytes)}
            {req ? ` → ${formatBytes(req)}` : ''}
          </span>
        );
      },
    },
    {
      id: 'ds',
      header: 'Datastore',
      sort: r => r.datastore ?? '',
      minWidth: 960,
      cell: r => {
        const pv = pvOf(r);
        const loc = r.pvc ? claimLocality(r.pvc, pv, d.nodes) : undefined;
        const img = rbdImageOf(pv);
        const link = img ? cephUrl(ceph.rbd, [img.pool, img.image]) : null;
        return (
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <span>{r.datastore ?? '—'}</span>
            {loc && d.nodes.length > 1 && (loc.kind === 'local' || loc.kind === 'shared') && (
              <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>
                {localityLabel(loc, d.nodes.length)}
              </Box>
            )}
            {link && (
              <Box component={RouterLink} to={link} sx={{ color: t.accent, fontSize: 12.5, width: 'fit-content' }} title={`RBD image ${img!.pool}/${img!.image}`}>
                Open in Ceph
              </Box>
            )}
          </Box>
        );
      },
    },
    {
      id: 'snaps',
      header: 'Snapshots',
      align: 'right',
      minWidth: 1050,
      sort: r => snaps.get(r.key)?.length ?? 0,
      cell: r => {
        const list = snaps.get(r.key) ?? [];
        return list.length ? (
          <Box component="span" sx={{ ...tabular }} title={list.map(s => s.metadata.name).join('\n')}>
            {list.length}
          </Box>
        ) : (
          <Box component="span" sx={{ color: t.muted }}>
            —
          </Box>
        );
      },
    },
    ...(k8s
      ? [
          {
            id: 'mode',
            header: 'Access',
            minWidth: 1100,
            cell: (r: DiskRow) => (
              <K8sName>
                {(r.pvc?.spec?.accessModes ?? []).join(',') || '—'} {r.pvc?.spec?.volumeMode ?? ''}
              </K8sName>
            ),
          } as Column<DiskRow>,
        ]
      : []),
    { id: 'state', header: 'State', sort: r => r.state.label, cell: r => <StateLabel state={r.state} />, width: 200 },
    {
      id: 'actions',
      header: <Box component="span" sx={srOnly}>Actions</Box>,
      align: 'right',
      width: 168,
      cell: r => {
        const problem = expandProblem(r, scOf(r));
        const delWhy =
          r.kind === 'unattached'
            ? undefined
            : r.kind === 'vm'
            ? `Attached to ${r.uses.map(u => u.vm.metadata.name).join(', ')}: remove it from the VM first`
            : r.kind === 'image'
            ? 'Delete images from Images'
            : 'A container volume: manage it with its application';
        return (
          <Box sx={{ display: 'inline-flex' }}>
            {r.kind === 'vm' && r.uses.length === 1 && r.uses[0].device === 'disk' && (
              <IconAction
                icon="mdi:database-arrow-right-outline"
                label={`Move ${r.name} to another datastore`}
                onClick={() => openDialog(close => <MoveDiskDialog vm={r.uses[0].vm} only={r.uses[0].slot} onClose={close} />)}
              />
            )}
            {r.kind === 'unattached' && (
              <IconAction icon="mdi:link-variant-plus" label={`Attach ${r.name} to a VM`} onClick={() => openDialog(close => <AttachDiskDialog row={r} d={d} onClose={close} />)} />
            )}
            <IconAction
              icon="mdi:arrow-expand-horizontal"
              label={problem ? `Expand ${r.name}: ${problem}` : `Expand ${r.name}`}
              disabled={!!problem}
              onClick={() => openDialog(close => <ExpandDiskDialog row={r} d={d} onClose={close} />)}
            />
            <IconAction icon="mdi:delete-outline" label={delWhy ? `Delete ${r.name}: ${delWhy}` : `Delete ${r.name}`} disabled={!!delWhy} onClick={() => remove(r)} />
          </Box>
        );
      },
    },
  ];
  return (
    <DataTable
      label="Disks"
      rows={rows}
      columns={columns}
      rowKey={r => r.key}
      initialSort={{ id: 'vm', dir: 'asc' }}
      empty={
        empty ? (
          <Empty icon="mdi:harddisk" title="No disks yet">
            Disks appear here when you create VMs or import images.
          </Empty>
        ) : filter === 'unattached' ? (
          <Empty icon="mdi:check-circle-outline" title="Every disk is attached">
            No disk is left without a VM.
          </Empty>
        ) : (
          <Empty icon="mdi:filter-variant" title="Nothing matches the filter" />
        )
      }
    />
  );
}
