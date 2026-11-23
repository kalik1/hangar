/*
 * Host page → Storage on this host: each local datastore's pool on this
 * host (thin pool written of its real size, metadata, free space vs the
 * room TopoLVM advertises) and the disks and VMs kept here.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { useTopolvmPools } from '../../api/storage';
import { datastores } from '../../model/capacity';
import { diskInventory } from '../../model/storage';
import { hrefFor } from '../../shell/nav';
import { useSettings } from '../../shell/settings';
import { Panel } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { datastoreHostPools, HostPoolList, isLocalDatastore } from './HostPools';

export function HostStoragePanel({ host }: { host: string }) {
  const d = useHangar();
  const t = useTokens();
  const [settings] = useSettings();
  const libNs = settings.libraryNamespace;
  const hasTopolvm = d.storageClasses.some(s => s.provisioner === 'topolvm.io');
  const pools = useTopolvmPools(hasTopolvm);
  const inv = React.useMemo(() => diskInventory(d.pvcs, d.dvs, d.vms, d.idx.vmi, libNs), [d.pvcs, d.dvs, d.vms, d.idx.vmi, libNs]);
  const local = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses).filter(x => isLocalDatastore(x.provisioner, x.shared));
  const entries = local
    .map(ds => ({ ds, pool: datastoreHostPools(d, inv, pools, ds.name).find(p => p.host === host) }))
    .filter(x => x.pool);
  if (!entries.length) return null;
  return (
    <Panel
      title="Storage on this host"
      icon="mdi:harddisk"
      actions={
        <Box component={RouterLink} to={hrefFor('storage', 'datastores')} sx={{ fontSize: 13, color: t.accent }}>
          All datastores
        </Box>
      }
    >
      <Box sx={{ display: 'grid', gap: 2 }}>
        {entries.map(({ ds, pool }) => (
          <Box key={ds.name} sx={{ display: 'grid', gap: 0.75 }}>
            <Typography component="h4" sx={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Icon icon="mdi:database-outline" width={16} style={{ color: t.muted }} />
              {ds.name}
            </Typography>
            <HostPoolList pools={[pool!]} hostLinks={false} unavailable={pools.unavailable} />
          </Box>
        ))}
      </Box>
    </Panel>
  );
}
