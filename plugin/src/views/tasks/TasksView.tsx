/*
 * Tasks and events: what was done from Hangar, and what the cluster says
 * about VMs, disks and migrations.
 */

import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useTasks } from '../../api/data';
import { Obj } from '../../model/types';
import { TaskRows } from '../../shell/TasksDock';
import { Empty, Panel } from '../../ui/kit';
import { EventsTable, useEvents } from '../vm/EventsTab';

const VM_KINDS = new Set([
  'VirtualMachine',
  'VirtualMachineInstance',
  'VirtualMachineInstanceMigration',
  'DataVolume',
  'VirtualMachineSnapshot',
  'VirtualMachineRestore',
  'VirtualMachineClone',
]);

export function TasksView() {
  const tasks = useTasks();
  const [only, setOnly] = React.useState<'all' | 'warn'>('all');
  const { events } = useEvents(undefined, null, 15000);
  const vmEvents = (events ?? []).filter(
    (e: Obj) =>
      (VM_KINDS.has(e.involvedObject?.kind) || (e.involvedObject?.kind === 'Pod' && String(e.involvedObject?.name).startsWith('virt-launcher-'))) &&
      (only === 'all' || e.type === 'Warning')
  );
  return (
    <Box sx={{ p: 2, display: 'grid', gap: 2 }}>
      <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
        Tasks and events
      </Typography>
      <Panel title="Tasks started from Hangar" icon="mdi:progress-clock" dense>
        {tasks.length ? (
          <TaskRows list={tasks} now={Date.now()} />
        ) : (
          <Empty icon="mdi:progress-clock" title="No tasks yet">
            Power operations, migrations, clones, snapshots and imports appear here, with their outcome.
          </Empty>
        )}
      </Panel>
      <Panel
        title="Virtualization events"
        icon="mdi:history"
        dense
        actions={
          <ToggleButtonGroup size="small" exclusive value={only} onChange={(_, v) => v && setOnly(v)} aria-label="Which events">
            <ToggleButton value="all" sx={{ textTransform: 'none', py: 0.25 }}>
              All
            </ToggleButton>
            <ToggleButton value="warn" sx={{ textTransform: 'none', py: 0.25 }}>
              Warnings
            </ToggleButton>
          </ToggleButtonGroup>
        }
      >
        {vmEvents.length ? <EventsTable events={vmEvents.slice(0, 200)} /> : <Empty icon="mdi:history" title="No recent events" />}
      </Panel>
    </Box>
  );
}
