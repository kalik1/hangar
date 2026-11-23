/*
 * Storage → Datastores: each StorageClass as a datastore card with its kind
 * in plain words, honest capacity (TopoLVM thin pools read from the hosts,
 * Ceph pools after replication), what it can do (move with running VMs,
 * snapshots, grow disks, copy disks) and the actions: new datastore, make
 * the default for new VMs, delete an empty one, open its pool in Ceph.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { HangarData } from '../../api/data';
import { deleteDatastore, setDefaultDatastore } from '../../api/datastores';
import { NOT_ALLOWED, useCan } from '../../api/permissions';
import { PoolReading, useTopolvmPools } from '../../api/storage';
import { datastores } from '../../model/capacity';
import { A_CLUSTER_DEFAULT, A_VIRT_DEFAULT, deleteProblem, effectiveVmDefault, isClusterDefault, isVirtDefault } from '../../model/datastoreSpec';
import { datastoreReach, reachLabel } from '../../model/placement';
import { cloneLabel, DatastoreRow, datastoreRows, DiskInventory, poolSummary, topolvmDeviceClass } from '../../model/storage';
import { formatBytes } from '../../model/units';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { Empty, IconAction, K8sName, KV, Meter, Panel, Tag, Toolbar, ToolButton } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { CephCapacity, cephFor } from './Ceph';
import { cephUrl, useCephRoutes } from './cephLinks';
import { NewDatastoreDialog } from './DatastoreDialog';
import { datastoreHostPools, HostPoolList, isLocalDatastore, LEVEL_COLOR, shortHost } from './HostPools';
import { kindIcon, Note, YesNo } from './parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
const SC_PERM = { group: 'storage.k8s.io', resource: 'storageclasses' };

export function DatastoresTab({ d, inv }: { d: HangarData; inv: DiskInventory }) {
  const t = useTokens();
  const hasTopolvm = d.storageClasses.some(s => s.provisioner === 'topolvm.io');
  const pools = useTopolvmPools(hasTopolvm);
  const canCreate = useCan({ verb: 'create', ...SC_PERM });
  const [q, setQ] = React.useState('');
  const stores = React.useMemo(() => {
    const base = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
    return datastoreRows(base, d.storageClasses, inv).map(r => {
      if (r.provisioner !== 'topolvm.io') return r;
      const sc = d.storageClasses.find(s => s.metadata.name === r.name);
      const dc = sc ? topolvmDeviceClass(sc, d.nodes) : undefined;
      return { ...r, deviceClass: dc, pool: poolSummary(pools.samples, dc, r.provisionedBytes) };
    });
  }, [d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses, inv, pools.samples]);
  const vmDefault = effectiveVmDefault(d.storageClasses);
  const shown = stores.filter(s => !q || [s.name, s.kind.label, s.provisioner].join(' ').toLowerCase().includes(q.toLowerCase()));

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.panel}px`, background: t.surface }}>
        <Toolbar sx={{ borderBottom: 'none' }}>
          <ToolButton
            icon="mdi:database-plus-outline"
            disabled={!canCreate || !d.storageClasses.length}
            tooltip={!canCreate ? NOT_ALLOWED : !d.storageClasses.length ? 'Install a storage driver first' : undefined}
            onClick={() => openDialog(close => <NewDatastoreDialog d={d} onClose={close} />)}
          >
            New datastore
          </ToolButton>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 13, color: t.muted, mr: 1.5 }}>
            New VM disks go to <b style={{ color: t.text }}>{vmDefault ?? 'the datastore picked in the wizard'}</b>
          </Typography>
          <SearchField value={q} onChange={setQ} label="Filter the datastores" />
        </Toolbar>
      </Box>
      {stores.length === 0 && !d.loading ? (
        <Panel>
          <Empty icon="mdi:database-off-outline" title="No datastore">
            The cluster has no StorageClass, so VMs cannot get disks. Install a storage driver (TopoLVM, Ceph, Longhorn, NFS…) and
            make one of its classes the default.
          </Empty>
        </Panel>
      ) : shown.length === 0 ? (
        <Panel>
          <Empty icon="mdi:filter-variant" title="Nothing matches the filter" />
        </Panel>
      ) : (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, alignItems: 'start' }}>
          {shown.map(s => (
            <DatastoreCard key={s.name} ds={s} pools={pools} d={d} vmDefault={vmDefault} inv={inv} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export function SearchField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <TextField
      size="small"
      placeholder="Filter"
      value={value}
      onChange={e => onChange(e.target.value)}
      inputProps={{ 'aria-label': label }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <Icon icon="mdi:filter-variant" width={16} />
          </InputAdornment>
        ),
      }}
      sx={{ width: 200, my: 0.5, '& input': { py: 0.6, fontSize: 13.5 } }}
    />
  );
}

function DatastoreCard({ ds, pools, d, vmDefault, inv }: { ds: DatastoreRow; pools: PoolReading; d: HangarData; vmDefault?: string; inv: DiskInventory }) {
  const t = useTokens();
  const k8s = useK8s();
  const cephRoutes = useCephRoutes();
  const canPatch = useCan({ verb: 'patch', ...SC_PERM });
  const canDelete = useCan({ verb: 'delete', ...SC_PERM });
  const canCreate = useCan({ verb: 'create', ...SC_PERM });
  const sc = d.storageClasses.find(s => s.metadata.name === ds.name);
  const snapClass = d.snapshotClasses.find(c => c.driver === ds.provisioner);
  const topolvm = ds.provisioner === 'topolvm.io';
  const disks = ds.vmDisks + ds.unattached;
  const ceph = cephFor(sc, d);
  const local = !ds.missing && isLocalDatastore(ds.provisioner, ds.shared);
  const perHost = local ? datastoreHostPools(d, inv, pools, ds.name) : [];
  const hot = perHost.filter(p => p.level !== 'ok').sort((a, b) => (a.level === 'fault' ? -1 : 0) - (b.level === 'fault' ? -1 : 0));
  const poolLink = ceph?.poolName ? cephUrl(cephRoutes.pool, [ceph.poolName]) : null;
  const isVmDefault = ds.name === vmDefault;
  const delWhy = !sc ? 'It is not a StorageClass' : deleteProblem(ds.name, d.pvcs);

  let capacity: React.ReactNode;
  if (ceph) {
    capacity = <CephCapacity ceph={ceph} provisionedBytes={ds.provisionedBytes} />;
  } else if (ds.pool && ds.pool.thin) {
    const p = ds.pool;
    const physFree = Math.max(0, p.sizeBytes - p.usedBytes);
    capacity = (
      <Box sx={{ display: 'grid', gap: 1 }}>
        <Meter
          label="Thin pool"
          used={p.usedBytes}
          total={p.sizeBytes}
          format={n => formatBytes(n)}
          caption={`${formatBytes(physFree)} physically free on ${p.hosts} host${p.hosts === 1 ? '' : 's'}`}
        />
        <Typography sx={{ fontSize: 13, color: t.muted, lineHeight: 1.5 }}>
          <b style={{ color: t.text }}>{formatBytes(ds.provisionedBytes)} provisioned</b>
          {p.overcommit !== undefined && p.overcommit > 1 ? `, ${p.overcommit.toFixed(1)}× the pool (thin provisioning)` : ''}. Disks take space only as
          guests write.
          {p.provisionableBytes !== undefined &&
            ` TopoLVM accepts ${formatBytes(p.provisionableBytes)} more: that is its overprovisioning limit, not free space.`}
        </Typography>
      </Box>
    );
  } else if (ds.pool) {
    capacity = (
      <Meter
        label="Volume group"
        used={ds.pool.usedBytes}
        total={ds.pool.sizeBytes}
        format={n => formatBytes(n)}
        caption={`${formatBytes(ds.provisionedBytes)} provisioned, ${formatBytes(ds.pool.sizeBytes - ds.pool.usedBytes)} free`}
      />
    );
  } else if (ds.freeBytes !== undefined) {
    capacity = (
      <Box sx={{ display: 'grid', gap: 1 }}>
        <Meter label="Provisioned" allocated={ds.provisionedBytes} total={ds.provisionedBytes + ds.freeBytes} format={n => formatBytes(n)} />
        <Typography sx={{ fontSize: 13, color: t.muted, lineHeight: 1.5 }}>
          {topolvm ? (
            <>
              TopoLVM reports {formatBytes(ds.freeBytes)} free. On thin pools that number includes overprovisioning: the physical
              pool may be much smaller. {pools.unavailable ? `Hangar cannot read the pool size: ${pools.unavailable}` : pools.loaded ? '' : 'Reading the pool size…'}
            </>
          ) : (
            `${formatBytes(ds.freeBytes)} free, as the storage reports it.`
          )}
        </Typography>
      </Box>
    );
  } else {
    capacity = (
      <Typography sx={{ fontSize: 13.5 }}>
        <b>{formatBytes(ds.provisionedBytes)} provisioned.</b> <span style={{ color: t.muted }}>This storage does not report its free space.</span>
      </Typography>
    );
  }

  const makeDefault = () => quiet(setDefaultDatastore(d.storageClasses, ds.name).then(() => d.refresh()));
  const remove = async () => {
    const ok = await confirm({
      title: `Delete datastore ${ds.name}?`,
      body: (
        <>
          <p>No disk is on it. VMs and the wizard will no longer offer it.</p>
          <p>The storage behind it ({ds.kind.label}) is not touched: only the datastore's definition goes.</p>
        </>
      ),
      confirm: 'Delete datastore',
      danger: true,
      typeToConfirm: ds.name,
    });
    if (ok) quiet(deleteDatastore(ds.name).then(() => d.refresh()));
  };

  return (
    <Panel
      title={
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          {ds.name}
          {isVmDefault && <Tag tone="accent">Default for VMs</Tag>}
        </Box>
      }
      icon={kindIcon(ds.kind)}
      actions={
        <Box sx={{ display: 'inline-flex' }}>
          {poolLink && (
            <Box
              component={RouterLink}
              to={poolLink}
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.accent, mr: 0.5, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
            >
              <Icon icon="mdi:open-in-app" width={16} /> Open in Ceph
            </Box>
          )}
          {sc && (
            <IconAction
              icon="mdi:star-outline"
              label={isVmDefault ? `${ds.name} is the default for new VMs` : !canPatch ? NOT_ALLOWED : `Make ${ds.name} the default for new VMs`}
              disabled={isVmDefault || !canPatch}
              onClick={makeDefault}
            />
          )}
          {sc && (
            <IconAction
              icon="mdi:content-copy"
              label={!canCreate ? NOT_ALLOWED : `New datastore like ${ds.name}`}
              disabled={!canCreate}
              onClick={() => openDialog(close => <NewDatastoreDialog d={d} from={ds.name} onClose={close} />)}
            />
          )}
          <IconAction
            icon="mdi:delete-outline"
            label={delWhy ? `Delete ${ds.name}: ${delWhy}` : !canDelete ? NOT_ALLOWED : `Delete ${ds.name}`}
            disabled={!!delWhy || !canDelete}
            onClick={remove}
          />
        </Box>
      }
    >
      <Box sx={{ display: 'grid', gap: 1.75 }}>
        <Box>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
            {ds.kind.label}
            {ds.pool?.thin ? ', thin provisioned' : ''}
          </Typography>
          <Typography sx={{ fontSize: 13, color: t.muted }}>{sc?.metadata.annotations?.description || ds.kind.detail}</Typography>
        </Box>
        {hot.length > 0 && (
          <Note tone="warn" icon={<Icon icon="mdi:alert-outline" width={18} style={{ color: LEVEL_COLOR[hot[0].level] ?? undefined, flex: 'none', marginTop: 1 }} />}>
            {hot.map(p => (
              <Box key={p.host}>
                <b>{shortHost(p.host)}</b>: {p.reason}.
              </Box>
            ))}
          </Note>
        )}
        {capacity}
        {perHost.length > 0 && (
          <Box component="section" aria-label={`${ds.name} on each host`} sx={{ display: 'grid', gap: 1, pt: 1.5, borderTop: `1px solid ${t.rule}` }}>
            <Typography component="h4" sx={{ fontSize: 13, fontWeight: 600, color: t.muted }}>
              On each host
            </Typography>
            <HostPoolList pools={perHost} unavailable={pools.unavailable} />
          </Box>
        )}
        <KV
          labelWidth={140}
          rows={[
            [
              'Disks',
              `${disks} VM disk${disks === 1 ? '' : 's'}${ds.unattached ? ` (${ds.unattached} unattached)` : ''}, ${ds.images} image${ds.images === 1 ? '' : 's'}${ds.containers ? `, ${ds.containers} container volume${ds.containers === 1 ? '' : 's'}` : ''}`,
            ],
            [
              'Hosts',
              ds.missing ? (
                'Depends on each volume'
              ) : (
                <YesNo key="m" yes={ds.shared}>
                  {reachLabel(datastoreReach(ds), d.nodes.length).long}
                </YesNo>
              ),
            ],
            [
              'Snapshots',
              <YesNo key="s" yes={ds.snapshots}>
                {ds.snapshots ? (k8s && snapClass ? `class ${snapClass.metadata.name}` : 'VM snapshots include its disks') : 'no snapshot class for this driver'}
              </YesNo>,
            ],
            ['Grow disks', <YesNo key="e" yes={ds.expandable}>{ds.expandable ? 'disks can be expanded' : 'sizes are fixed'}</YesNo>],
            ['Copying disks', ds.missing ? '—' : cloneLabel(ds.cloneStrategy)],
            ['Deleted disks', sc ? (sc.reclaimPolicy === 'Retain' ? 'The volume is kept for an admin' : 'Their space is freed') : '—'],
            ...(k8s
              ? ([
                  ['Driver', <K8sName key="p">{ds.provisioner || '—'}</K8sName>],
                  ['Volume modes', ds.volumeModes.join(', ') || '—'],
                  ['Binding', ds.binding ?? '—'],
                  ['Reclaim', ds.reclaim ?? '—'],
                  ...(ds.deviceClass ? ([['Device class', ds.deviceClass]] as [string, React.ReactNode][]) : []),
                  ...(ceph?.poolName ? ([['Pool', <K8sName key="pool">{ceph.poolName}</K8sName>]] as [string, React.ReactNode][]) : []),
                  [
                    'Default',
                    <Box key="def" component="span" sx={{ display: 'inline-flex', gap: 0.75, flexWrap: 'wrap' }}>
                      {sc && isVirtDefault(sc) && <K8sName>{A_VIRT_DEFAULT}</K8sName>}
                      {sc && isClusterDefault(sc) && <K8sName>{A_CLUSTER_DEFAULT}</K8sName>}
                      {sc && !isVirtDefault(sc) && !isClusterDefault(sc) && '—'}
                    </Box>,
                  ],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
        {!sc && ds.missing && (
          <Note>Disks here name a StorageClass that does not exist: they were made by hand. Hangar cannot create or grow disks on it.</Note>
        )}
      </Box>
    </Panel>
  );
}

