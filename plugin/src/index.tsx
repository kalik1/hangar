/*
 * Hangar: a virtualization console for KubeVirt and CDI, as a Headlamp
 * plugin. Registrations only; the app lives in src/shell and src/views.
 */

import { registerDetailsViewSection, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { ConsolePopupPage, POPUP_ROUTE_NAME, POPUP_ROUTE_PATH } from './console';
import { registerIcons } from './icons';
import { HangarApp } from './shell/HangarApp';
import { ROUTE_NAME, ROUTE_PATH } from './shell/nav';
import { NamespaceProtection } from './views/settings/NamespaceProtection';

registerIcons();

registerSidebarEntry({
  parent: null,
  name: 'hangar',
  label: 'Hangar',
  url: '/hangar',
  icon: 'mdi:server-network',
});

// One route for the whole app, so the shell stays mounted (src/shell/nav.ts).
registerRoute({
  path: ROUTE_PATH,
  exact: false,
  name: ROUTE_NAME,
  sidebar: 'hangar',
  isFullWidth: true,
  component: () => <HangarApp />,
});

// A VM console in its own browser window: no app bar, no sidebar, just the console.
registerRoute({
  path: POPUP_ROUTE_PATH,
  exact: true,
  name: POPUP_ROUTE_NAME,
  sidebar: null,
  hideAppBar: true,
  isFullWidth: true,
  component: () => <ConsolePopupPage />,
});

// Headlamp's Namespace page offers Delete: say first what is protected there.
registerDetailsViewSection(({ resource }: { resource: any }) => <NamespaceProtection resource={resource} />);
