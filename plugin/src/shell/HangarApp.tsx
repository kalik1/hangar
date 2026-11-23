/*
 * The Hangar app: top bar, inventory tree, the current view, recent tasks.
 * Fills Headlamp's content area and scrolls inside, like a desktop
 * virtualization client.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Redirect } from 'react-router-dom';
import { HangarDataProvider, useHangar } from '../api/data';
import { useMetricsPolling } from '../api/metrics';
import { DialogHost } from '../ui/dialogs';
import { Empty } from '../ui/kit';
import { useTokens } from '../ui/useTokens';
import { Dashboard } from '../views/dashboard/Dashboard';
import { DevicesView } from '../views/devices/DevicesView';
import { FlavorsView } from '../views/flavors/FlavorsView';
import { HostPage } from '../views/hosts/HostPage';
import { HostsList } from '../views/hosts/HostsList';
import { NetworksView } from '../views/networks/NetworksView';
import { StorageView } from '../views/storage/StorageView';
import { TasksView } from '../views/tasks/TasksView';
import { VmPage } from '../views/vm/VmPage';
import { VmList } from '../views/vms/VmList';
import { Inventory } from './Inventory';
import { hrefFor, useNav } from './nav';
import { SettingsProvider, useSettings } from './settings';
import { TasksDock } from './TasksDock';
import { TopBar } from './TopBar';

function Resizer({ onResize }: { onResize: (dx: number) => void }) {
  const t = useTokens();
  const start = React.useRef<number | null>(null);
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the inventory"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') onResize(-16);
        if (e.key === 'ArrowRight') onResize(16);
      }}
      onPointerDown={e => {
        start.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (start.current === null) return;
        onResize(e.clientX - start.current);
        start.current = e.clientX;
      }}
      onPointerUp={() => (start.current = null)}
      sx={{
        width: 5,
        cursor: 'col-resize',
        flex: 'none',
        borderRight: `1px solid ${t.rule}`,
        '&:hover, &:focus-visible': { background: t.selected, outline: 'none' },
      }}
    />
  );
}

function Main() {
  const nav = useNav();
  const d = useHangar();
  if (d.fatal) {
    return (
      <Empty icon="mdi:server-off" title={d.fatal.status === 403 ? 'You cannot see virtual machines here' : 'KubeVirt is not answering'}>
        {d.fatal.status === 404
          ? 'This cluster has no KubeVirt: install it (or turn on the virtualization feature of your distribution) to manage VMs here.'
          : d.fatal.status === 403
          ? 'Your user may not list VirtualMachines. Ask an administrator for a role that allows it.'
          : d.fatal.message}
      </Empty>
    );
  }
  switch (nav.view) {
    case 'vms':
      return <VmList folder={nav.a} />;
    case 'templates':
      // Templates live under Storage now; old links keep working.
      return <Redirect to={hrefFor('storage', 'templates', nav.a)} />;
    case 'vm':
      return nav.a && nav.b ? <VmPage key={`${nav.a}/${nav.b}`} namespace={nav.a} name={nav.b} tab={nav.c} /> : null;
    case 'hosts':
      return <HostsList />;
    case 'host':
      return nav.a ? <HostPage key={nav.a} name={nav.a} tab={nav.b} /> : null;
    case 'storage':
      return <StorageView section={nav.a} folder={nav.b} />;
    case 'networks':
      return <NetworksView />;
    case 'library':
      // The library is Storage → Images now; old links keep working.
      return <Redirect to={hrefFor('storage', 'images')} />;
    case 'devices':
      return <DevicesView />;
    case 'flavors':
      return <FlavorsView section={nav.a} />;
    case 'tasks':
      return <TasksView />;
    default:
      return <Dashboard />;
  }
}

function Layout() {
  const t = useTokens();
  const nav = useNav();
  const [settings, update] = useSettings();
  useMetricsPolling();
  const treeMode = ['dashboard', 'vms', 'vm', 'templates'].includes(nav.view)
    ? 'vms'
    : ['hosts', 'host', 'devices'].includes(nav.view)
    ? 'hosts'
    : null;
  const showTree = !!treeMode && !settings.treeHidden;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // Fill exactly the area Headlamp gives the route (its full-width
        // wrappers are height: 100% down to its scrolling <main>), whatever
        // the app bar's height: a fixed calc(100vh - 64px) overflowed by the
        // app bar's border and gave the page a scrollbar of a few pixels.
        // Hangar scrolls inside its own panes.
        height: '100%',
        minHeight: 480,
        background: t.sunken,
        color: t.text,
      }}
    >
      <TopBar />
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {showTree && treeMode && (
          <>
            <Box
              component="nav"
              aria-label="Inventory"
              sx={{ width: settings.treeWidth, flex: 'none', overflow: 'auto', background: t.surface }}
            >
              <Typography sx={{ px: 1.5, pt: 1.25, pb: 0.5, fontSize: 12.5, color: t.muted, fontWeight: 600 }}>
                {treeMode === 'vms' ? 'VMs and templates' : 'Hosts and clusters'}
              </Typography>
              <Inventory mode={treeMode} />
            </Box>
            <Resizer onResize={dx => update({ treeWidth: Math.max(180, Math.min(560, settings.treeWidth + dx)) })} />
          </>
        )}
        <Box component="main" sx={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <Main />
        </Box>
      </Box>
      <TasksDock />
      <DialogHost />
    </Box>
  );
}

export function HangarApp() {
  return (
    <SettingsProvider>
      <HangarDataProvider>
        <Layout />
      </HangarDataProvider>
    </SettingsProvider>
  );
}
