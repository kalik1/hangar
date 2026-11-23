/*
 * A section on Headlamp's Namespace page (where Headlamp offers Delete):
 * the VMs and disks of the namespace that are protected from deletion,
 * because deleting the namespace then stays in Terminating until their
 * protection is turned off. Hangar itself offers no folder delete.
 */

import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { kreq } from '../../api/client';
import { PATHS } from '../../api/resources';
import { PROTECTED_LABEL } from '../../model/protection';
import { Obj } from '../../model/types';
import { hrefFor } from '../../shell/nav';

const SEL = `labelSelector=${encodeURIComponent(`${PROTECTED_LABEL}=true,!cdi.kubevirt.io/OwnedByUID`)}`;

export function NamespaceProtection({ resource }: { resource: any }) {
  const ns: string | undefined = resource?.kind === 'Namespace' ? resource?.metadata?.name ?? resource?.jsonData?.metadata?.name : undefined;
  const [items, setItems] = React.useState<{ vms: string[]; disks: string[] } | null>(null);
  React.useEffect(() => {
    if (!ns) return;
    let alive = true;
    const names = (r: any) => ((r?.items ?? []) as Obj[]).map(o => o.metadata.name);
    Promise.all([kreq(`${PATHS.vm(ns)}?${SEL}`).then(names, () => []), kreq(`${PATHS.pvc(ns)}?${SEL}`).then(names, () => [])]).then(
      ([vms, disks]) => alive && setItems({ vms, disks })
    );
    return () => {
      alive = false;
    };
  }, [ns]);
  if (!ns || !items || (!items.vms.length && !items.disks.length)) return null;
  return (
    <SectionBox title="Protected from deletion (Hangar)">
      <Box sx={{ fontSize: 14, lineHeight: 1.6, '& p': { m: 0, mb: 1 } }}>
        <p>
          Deleting this namespace stops halfway: it stays in Terminating until the protection of these is turned off (Hangar: the VM&apos;s Configure →
          Options).
        </p>
        {items.vms.length > 0 && (
          <p>
            VMs:{' '}
            {items.vms.map((n, i) => (
              <React.Fragment key={n}>
                {i > 0 && ', '}
                <RouterLink to={hrefFor('vm', ns, n, 'configure')}>{n}</RouterLink>
              </React.Fragment>
            ))}
          </p>
        )}
        {items.disks.length > 0 && <p>Disks: {items.disks.join(', ')}</p>}
      </Box>
    </SectionBox>
  );
}
