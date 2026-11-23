/*
 * Recent tasks, docked at the bottom like in a classic virtualizer. Closed:
 * one line with what is running and the latest result. Open: the list.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useTasks } from '../api/data';
import { Task, tasks as store } from '../model/tasks';
import { formatAge } from '../model/units';
import { tabular } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import { hrefFor } from './nav';
import { useSettings } from './settings';

export function taskStatusIcon(s: Task['status']): { icon: string; color: string; label: string } {
  switch (s) {
    case 'running':
      return { icon: 'mdi:progress-clock', color: '#3D8BFD', label: 'Running' };
    case 'done':
      return { icon: 'mdi:check-circle-outline', color: '#2FBF71', label: 'Completed' };
    case 'failed':
      return { icon: 'mdi:alert-circle-outline', color: '#E5484D', label: 'Failed' };
    default:
      return { icon: 'mdi:alert-outline', color: '#E8A33D', label: 'Check' };
  }
}

export function TaskTarget({ task }: { task: Task }) {
  const tg = task.target;
  if (!tg) return <span>—</span>;
  const href =
    tg.kind === 'vm' || tg.kind === 'template'
      ? hrefFor('vm', tg.namespace, tg.name)
      : tg.kind === 'host'
      ? hrefFor('host', tg.name)
      : tg.kind === 'image'
      ? hrefFor('storage', 'images')
      : tg.kind === 'folder'
      ? hrefFor('vms', tg.name)
      : tg.kind === 'network'
      ? hrefFor('networks')
      : tg.kind === 'datastore'
      ? hrefFor('storage', 'datastores')
      : tg.kind === 'snapshot' && tg.namespace
      ? hrefFor('vms', tg.namespace)
      : tg.kind === 'device'
      ? hrefFor('devices')
      : tg.kind === 'flavor'
      ? hrefFor('flavors')
      : tg.kind === 'datacenter'
      ? hrefFor('settings')
      : undefined;
  const text = tg.namespace && tg.kind !== 'folder' ? `${tg.name}` : tg.name;
  return href ? (
    <Box component={RouterLink} to={href} sx={{ color: 'inherit', textDecorationColor: 'rgba(127,127,127,.5)' }} title={tg.namespace ? `${tg.namespace}/${tg.name}` : tg.name}>
      {text}
    </Box>
  ) : (
    <span>{text}</span>
  );
}

function duration(t: Task, now: number) {
  return formatAge(t.started, t.finished ?? now);
}

export function TaskRows({ list, now }: { list: Task[]; now: number }) {
  const t = useTokens();
  return (
    <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, ...tabular }} aria-label="Recent tasks">
      <Box component="thead">
        <Box component="tr" sx={{ color: t.muted, textAlign: 'left', '& th': { fontWeight: 600, fontSize: 12.5, px: 1.25, py: 0.5 } }}>
          <th>Task</th>
          <th>Target</th>
          <th>Status</th>
          <th>Details</th>
          <th>Started</th>
          <th>Duration</th>
        </Box>
      </Box>
      <Box component="tbody">
        {list.map(task => {
          const s = taskStatusIcon(task.status);
          return (
            <Box component="tr" key={task.id} sx={{ borderTop: `1px solid ${t.rule}`, '& td': { px: 1.25, py: 0.5, whiteSpace: 'nowrap' } }}>
              <td>{task.title}</td>
              <td>
                <TaskTarget task={task} />
              </td>
              <td>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: s.color }}>
                  <Icon icon={s.icon} width={16} />
                  <span>{task.status === 'running' && task.progress !== undefined ? `${Math.round(task.progress)}%` : s.label}</span>
                </Box>
              </td>
              <Box component="td" sx={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', color: t.muted }} title={task.message}>
                {task.message ?? ''}
              </Box>
              <td>{new Date(task.started).toLocaleTimeString()}</td>
              <td>{duration(task, now)}</td>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export function TasksDock() {
  const t = useTokens();
  const list = useTasks();
  const [settings, update] = useSettings();
  const open = settings.tasksOpen;
  const [now, setNow] = React.useState(Date.now());
  const running = list.filter(x => x.status === 'running');
  React.useEffect(() => {
    if (!running.length && !open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running.length, open]);
  const latest = list[0];
  const s = latest ? taskStatusIcon(latest.status) : null;
  const progress = running.find(r => r.progress !== undefined)?.progress;
  return (
    <Box component="section" aria-label="Recent tasks" sx={{ borderTop: `1px solid ${t.rule}`, background: t.surface, flex: 'none' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1, height: 34, fontSize: 13, ...tabular }}>
        <Button
          size="small"
          color="inherit"
          onClick={() => update({ tasksOpen: !open })}
          aria-expanded={open}
          startIcon={<Icon icon={open ? 'mdi:chevron-down' : 'mdi:chevron-up'} width={18} />}
          sx={{ textTransform: 'none', fontWeight: 600, fontSize: 13 }}
        >
          Recent tasks
        </Button>
        {running.length > 0 && (
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, color: '#3D8BFD' }}>
            <Icon icon="mdi:progress-clock" width={16} />
            {running.length} running
            {progress !== undefined && (
              <LinearProgress variant="determinate" value={progress} sx={{ width: 80, height: 4, borderRadius: 2 }} aria-label="Progress" />
            )}
          </Box>
        )}
        {latest && s && (
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, color: t.muted }}>
            <Icon icon={s.icon} width={16} style={{ color: s.color, flex: 'none' }} />
            <Box component="span" sx={{ color: t.text }}>
              {latest.title}
            </Box>
            <TaskTarget task={latest} />
            <span>· {formatAge(latest.finished ?? latest.started, now)} ago</span>
            {latest.status === 'failed' && latest.message && (
              <Box component="span" sx={{ color: '#E5484D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }}>
                {latest.message}
              </Box>
            )}
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        {open && list.some(x => x.status !== 'running') && (
          <Button size="small" color="inherit" onClick={() => store.clearFinished()} sx={{ textTransform: 'none', fontSize: 12.5 }}>
            Clear finished
          </Button>
        )}
      </Box>
      {open && (
        <Box sx={{ maxHeight: 220, overflow: 'auto', borderTop: `1px solid ${t.rule}` }}>
          {list.length ? (
            <TaskRows list={list} now={now} />
          ) : (
            <Box sx={{ p: 2, color: t.muted, fontSize: 13 }}>Operations you start from Hangar appear here.</Box>
          )}
        </Box>
      )}
    </Box>
  );
}
