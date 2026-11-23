/*
 * A VM's page: the faceplate, a pending-restart notice, then the tabs.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { useHangar } from '../../api/data';
import { isTemplate, key, pendingRestart, powerState } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Empty } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { ConfigureTab } from './ConfigureTab';
import { CONSOLE_MIN, ConsoleTab } from './ConsoleTab';
import { EventsTab } from './EventsTab';
import { Faceplate } from './Faceplate';
import { KubernetesTab } from './KubernetesTab';
import { MonitorTab } from './MonitorTab';
import { SnapshotsTab } from './SnapshotsTab';
import { SummaryTab } from './SummaryTab';

export function VmPage({ namespace, name, tab }: { namespace: string; name: string; tab?: string }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const history = useHistory();
  const vm = d.idx.vm.get(`${namespace}/${name}`);
  if (!vm) {
    return d.loading ? null : (
      <Empty icon="mdi:server-off" title={`${name} is not in ${namespace}`}>
        It may have been deleted or renamed. Pick a VM in the inventory.
      </Empty>
    );
  }
  const vmi = d.idx.vmi.get(key(vm));
  const p = powerState(vm, vmi);
  const tpl = isTemplate(vm);
  const tabs: [string, string][] = [
    ['summary', 'Summary'],
    ...(!tpl ? ([['console', 'Console']] as [string, string][]) : []),
    ['configure', 'Configure'],
    ...(!tpl ? ([['snapshots', 'Snapshots']] as [string, string][]) : []),
    ...(!tpl ? ([['monitor', 'Monitor']] as [string, string][]) : []),
    ['events', 'Events'],
    ...(k8s ? ([['kubernetes', 'Kubernetes']] as [string, string][]) : []),
  ];
  const current = tab === 'serial' ? 'console' : tabs.some(([id]) => id === tab) ? (tab as string) : 'summary';
  const restart = pendingRestart(vm);
  return (
    // The Console tab fills exactly the pane below the tabs (no page scroll);
    // the other tabs grow with their content and the pane scrolls.
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%', ...(current === 'console' ? { height: '100%' } : {}) }}>
      <Faceplate vm={vm} p={p} />
      {restart && !tpl && (
        <Box
          role="status"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 1,
            background: t.dark ? 'rgba(232,163,61,0.14)' : '#FFF6E5',
            borderBottom: `1px solid ${t.rule}`,
            fontSize: 14,
          }}
        >
          <Icon icon="mdi:restart-alert" width={20} style={{ color: '#B7791F', flex: 'none' }} />
          <Box sx={{ flex: 1 }}>
            <b>Restart to apply your changes.</b> {restart}
          </Box>
          {(p.kind === 'on' || p.kind === 'paused') && (
            <Button size="small" variant="outlined" color="inherit" onClick={() => A.restart(vm).catch(() => undefined)} sx={{ textTransform: 'none' }}>
              Restart now
            </Button>
          )}
        </Box>
      )}
      <Box sx={{ borderBottom: `1px solid ${t.rule}`, background: t.surface, px: 1 }}>
        <Tabs
          value={current}
          onChange={(_, v) => history.push(hrefFor('vm', namespace, name, v === 'summary' ? undefined : v))}
          aria-label={`${name} sections`}
          variant="scrollable"
          scrollButtons={false}
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, textTransform: 'none', fontSize: 14, minWidth: 0, px: 2 } }}
        >
          {tabs.map(([id, label]) => (
            <Tab key={id} value={id} label={label} />
          ))}
        </Tabs>
      </Box>
      <Box sx={current === 'console' ? { flex: 1, minHeight: 44 + CONSOLE_MIN, display: 'flex', flexDirection: 'column' } : { flex: 1, p: 2 }}>
        {current === 'summary' && <SummaryTab vm={vm} />}
        {current === 'console' && <ConsoleTab vm={vm} p={p} serial={tab === 'serial'} />}
        {current === 'configure' && <ConfigureTab vm={vm} />}
        {current === 'snapshots' && <SnapshotsTab vm={vm} />}
        {current === 'monitor' && <MonitorTab vm={vm} />}
        {current === 'events' && <EventsTab vm={vm} />}
        {current === 'kubernetes' && <KubernetesTab vm={vm} />}
      </Box>
    </Box>
  );
}
