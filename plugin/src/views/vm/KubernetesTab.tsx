/*
 * The Kubernetes side of a VM (shown with Kubernetes details on): the
 * objects behind it, links to Headlamp's own pages, and the YAML editor.
 */

import { Icon } from '@iconify/react';
import { Router } from '@kinvolk/headlamp-plugin/lib';
import { EditorDialog } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { Obj } from '../../model/types';
import { claimNames, key, launcherVmName } from '../../model/vm';
import { K8sName, Panel } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

function headlampHref(kind: string, o: Obj): string | undefined {
  const ns = o.metadata.namespace;
  const name = o.metadata.name;
  try {
    switch (kind) {
      case 'Pod':
        return Router.createRouteURL('pod', { namespace: ns, name });
      case 'PersistentVolumeClaim':
        return Router.createRouteURL('persistentVolumeClaim', { namespace: ns, name });
      default: {
        const [group] = String(o.apiVersion ?? '').split('/');
        const plural: Record<string, string> = {
          VirtualMachine: 'virtualmachines',
          VirtualMachineInstance: 'virtualmachineinstances',
          DataVolume: 'datavolumes',
          VirtualMachineInstanceMigration: 'virtualmachineinstancemigrations',
          VirtualMachineSnapshot: 'virtualmachinesnapshots',
        };
        if (!plural[kind] || !group) return undefined;
        return Router.createRouteURL('customresource', { crd: `${plural[kind]}.${group}`, namespace: ns, crName: name });
      }
    }
  } catch {
    return undefined;
  }
}

function status(kind: string, o: Obj): string {
  switch (kind) {
    case 'VirtualMachine':
      return o.status?.printableStatus ?? '';
    case 'VirtualMachineInstance':
      return o.status?.phase ?? '';
    case 'Pod':
      return o.status?.phase ?? '';
    case 'DataVolume':
      return `${o.status?.phase ?? ''} ${o.status?.progress ?? ''}`.trim();
    case 'PersistentVolumeClaim':
      return `${o.status?.phase ?? ''} ${o.status?.capacity?.storage ?? ''}`.trim();
    case 'VirtualMachineInstanceMigration':
      return o.status?.phase ?? '';
    case 'VirtualMachineSnapshot':
      return o.status?.phase ?? '';
    default:
      return '';
  }
}

export function KubernetesTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const [editing, setEditing] = React.useState(false);
  const k = key(vm);
  const rows: [string, Obj][] = [['VirtualMachine', { apiVersion: 'kubevirt.io/v1', ...vm }]];
  const vmi = d.idx.vmi.get(k);
  if (vmi) rows.push(['VirtualMachineInstance', { apiVersion: 'kubevirt.io/v1', ...vmi }]);
  for (const p of d.launchers.filter(p => p.metadata.namespace === vm.metadata.namespace && launcherVmName(p) === vm.metadata.name))
    rows.push(['Pod', p]);
  for (const c of claimNames(vm)) {
    const dv = d.idx.dv.get(`${vm.metadata.namespace}/${c}`);
    if (dv) rows.push(['DataVolume', { apiVersion: 'cdi.kubevirt.io/v1beta1', ...dv }]);
    const pvc = d.idx.pvc.get(`${vm.metadata.namespace}/${c}`);
    if (pvc) rows.push(['PersistentVolumeClaim', pvc]);
  }
  for (const m of d.idx.migrations.get(k) ?? []) rows.push(['VirtualMachineInstanceMigration', { apiVersion: 'kubevirt.io/v1', ...m }]);
  for (const s of d.idx.snapshots.get(k) ?? []) rows.push(['VirtualMachineSnapshot', { apiVersion: 'snapshot.kubevirt.io/v1beta1', ...s }]);
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Panel
        title="Objects behind this VM"
        icon="mdi:kubernetes"
        dense
        actions={
          <Button size="small" startIcon={<Icon icon="mdi:pencil-outline" width={16} />} onClick={() => setEditing(true)} sx={{ textTransform: 'none' }}>
            Edit YAML
          </Button>
        }
      >
        <Box
          component="table"
          sx={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13.5,
            ...tabular,
            '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 1.5, py: 0.75 },
            '& td': { px: 1.5, py: 0.75, borderTop: `1px solid ${t.rule}` },
          }}
        >
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([kind, o]) => {
              const href = headlampHref(kind, o);
              return (
                <tr key={`${kind}/${o.metadata.name}`}>
                  <td>
                    <K8sName>{kind}</K8sName>
                  </td>
                  <td>
                    {href ? (
                      <Box component={RouterLink} to={href} sx={{ color: 'inherit' }}>
                        {o.metadata.name}
                      </Box>
                    ) : (
                      o.metadata.name
                    )}
                  </td>
                  <td>{status(kind, o)}</td>
                  <td>{o.metadata.creationTimestamp ? new Date(o.metadata.creationTimestamp).toLocaleString() : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </Box>
      </Panel>
      {editing && (
        <EditorDialog
          open
          item={{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', ...vm }}
          onClose={() => setEditing(false)}
          onSave="default"
          title={`VirtualMachine ${vm.metadata.namespace}/${vm.metadata.name}`}
        />
      )}
    </Box>
  );
}
