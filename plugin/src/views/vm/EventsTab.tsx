/*
 * Events of a VM and everything behind it (its running instance, host
 * process, disks), newest first, in words a virtualization admin reads.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { kreq } from '../../api/client';
import { useHangar } from '../../api/data';
import { Obj } from '../../model/types';
import { formatAge } from '../../model/units';
import { claimNames, key } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { Empty, K8sName, Panel } from '../../ui/kit';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';

export function friendlyKind(kind: string): string {
  switch (kind) {
    case 'VirtualMachine':
      return 'VM';
    case 'VirtualMachineInstance':
      return 'Running instance';
    case 'Pod':
      return 'Host process';
    case 'DataVolume':
    case 'PersistentVolumeClaim':
      return 'Disk';
    case 'VirtualMachineInstanceMigration':
      return 'Migration';
    case 'VirtualMachineSnapshot':
      return 'Snapshot';
    case 'Node':
      return 'Host';
    default:
      return kind;
  }
}

export function useEvents(namespace: string | undefined, names: Set<string> | null, everyMs = 10000) {
  const [events, setEvents] = React.useState<Obj[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const sig = names ? [...names].sort().join(',') : '*';
  React.useEffect(() => {
    let alive = true;
    const load = () =>
      kreq(namespace ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events')
        .then(r => {
          if (!alive) return;
          const items: Obj[] = (r.items ?? []).filter((e: any) => !names || names.has(e.involvedObject?.name));
          items.sort((a: any, b: any) => (b.lastTimestamp ?? b.eventTime ?? '').localeCompare(a.lastTimestamp ?? a.eventTime ?? ''));
          setEvents(items);
          setError(null);
        })
        .catch(e => alive && setError(String(e.message ?? e)));
    load();
    const id = window.setInterval(load, everyMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, sig, everyMs]);
  return { events, error };
}

export function EventsTable({ events, showObject = true }: { events: Obj[]; showObject?: boolean }) {
  const t = useTokens();
  const k8s = useK8s();
  return (
    <Box
      component="table"
      sx={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 13.5,
        ...tabular,
        '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 1.25, py: 0.75 },
        '& td': { px: 1.25, py: 0.75, borderTop: `1px solid ${t.rule}`, verticalAlign: 'top' },
      }}
    >
      <thead>
        <tr>
          <th style={{ width: 28 }} aria-label="Type" />
          <th>When</th>
          {showObject && <th>Object</th>}
          <th>What happened</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e: any) => {
          const warn = e.type === 'Warning';
          return (
            <tr key={e.metadata.uid}>
              <td>
                <Icon
                  icon={warn ? 'mdi:alert-outline' : 'mdi:information-outline'}
                  width={17}
                  style={{ color: warn ? '#E8A33D' : t.muted }}
                  aria-label={warn ? 'Warning' : 'Information'}
                />
              </td>
              <Box component="td" sx={{ whiteSpace: 'nowrap', color: t.muted }} title={e.lastTimestamp ?? e.eventTime}>
                {formatAge(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)} ago
              </Box>
              {showObject && (
                <Box component="td" sx={{ whiteSpace: 'nowrap' }}>
                  {friendlyKind(e.involvedObject?.kind)} {e.involvedObject?.kind !== 'VirtualMachine' ? e.involvedObject?.name : ''}
                  {k8s && (
                    <Box>
                      <K8sName>{e.involvedObject?.kind}</K8sName>
                    </Box>
                  )}
                </Box>
              )}
              <td>
                <Box sx={{ fontWeight: 600, fontSize: 13 }}>{e.reason}</Box>
                <Box sx={{ overflowWrap: 'anywhere' }}>{e.message}</Box>
              </td>
              <td>{e.count ?? 1}</td>
            </tr>
          );
        })}
      </tbody>
    </Box>
  );
}

export function EventsTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const launcher = d.idx.launcher.get(key(vm));
  const names = new Set<string>([vm.metadata.name, ...claimNames(vm)]);
  if (launcher) names.add(launcher.metadata.name);
  for (const m of d.idx.migrations.get(key(vm)) ?? []) names.add(m.metadata.name);
  const { events, error } = useEvents(vm.metadata.namespace, names);
  return (
    <Panel title="Events" icon="mdi:history" dense>
      {error && <Box sx={{ p: 2, color: '#E5484D' }}>{error}</Box>}
      {events && events.length === 0 && (
        <Empty icon="mdi:history" title="No recent events">
          The cluster keeps events for about an hour.
        </Empty>
      )}
      {events && events.length > 0 && <EventsTable events={events} />}
    </Panel>
  );
}
