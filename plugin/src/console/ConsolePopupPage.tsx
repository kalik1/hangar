/*
 * The page of a console pop-up window: only the VM's console, the whole
 * window. A slim header names the VM, shows its power state and switches
 * between the graphical and the serial console; the console's own toolbar
 * does the rest (Ctrl+Alt+Del, keys, typing, screenshot, fullscreen).
 */

import { Icon } from '@iconify/react';
import { Router } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';
import { useHistory, useParams } from 'react-router-dom';
import * as A from '../api/actions';
import { hrefFor } from '../shell/nav';
import { PowerLabel } from '../ui/kit';
import { tabular } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import type { ConsoleKind } from './paths';
import { consolePopupKey, consolePopupTitle, POPUP_ROUTE_NAME } from './popup';
import { useAnnouncePopup } from './popupPresence';
import { SerialConsole } from './SerialConsole';
import { resolveCluster } from './useConsoleSession';
import { useVmStatus } from './useVmStatus';
import { VncConsole } from './VncConsole';

export function ConsolePopupPage() {
  const params = useParams<{ namespace: string; name: string; kind?: string }>();
  const { namespace, name } = params;
  const kind: ConsoleKind = params.kind === 'serial' ? 'serial' : 'vnc';
  const cluster = resolveCluster();
  const t = useTokens();
  const history = useHistory();
  const status = useVmStatus(namespace, name, cluster);
  const vm = status.vm;

  useAnnouncePopup(consolePopupKey(cluster, namespace, name), kind);

  React.useEffect(() => {
    const title = consolePopupTitle(name, kind);
    document.title = title;
    // Headlamp sets the title on navigation: keep ours.
    const id = window.setInterval(() => {
      if (document.title !== title) document.title = title;
    }, 1000);
    return () => window.clearInterval(id);
  }, [name, kind]);

  const powerOn = React.useCallback(() => {
    if (vm) A.powerOn(vm as any).catch(() => undefined);
  }, [vm]);
  const resume = React.useCallback(() => {
    if (vm) A.resume(vm as any).catch(() => undefined);
  }, [vm]);

  const switchKind = (k: ConsoleKind) =>
    history.replace(Router.createRouteURL(POPUP_ROUTE_NAME, { namespace, name, kind: k }));

  /** Back to the VM in Hangar: in the window that opened this one when it is still there. */
  const showInHangar = () => {
    const url = history.createHref({ pathname: hrefFor('vm', namespace, name) });
    const opener = window.opener as Window | null;
    try {
      if (opener && !opener.closed) {
        opener.location.href = url;
        opener.focus();
        return;
      }
    } catch {
      /* a different origin opened us: fall through */
    }
    window.open(url, '_blank');
  };

  return (
    // A layer over the whole window: no Headlamp chrome, whatever its layout.
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 1250,
        display: 'flex',
        flexDirection: 'column',
        background: t.chassis,
        color: t.chassisText,
      }}
    >
      <Box
        component="header"
        sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, minHeight: 44, flex: 'none', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <Icon icon={kind === 'serial' ? 'mdi:console-line' : 'mdi:monitor'} width={20} style={{ opacity: 0.8 }} />
        <Box component="h1" sx={{ m: 0, fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
        </Box>
        <Box sx={{ fontSize: 13, color: t.chassisMuted, ...tabular, whiteSpace: 'nowrap' }}>{namespace}</Box>
        {status.power && (
          <Box sx={{ '& span': { color: `${t.chassisText} !important` } }}>
            <PowerLabel p={status.power} size="sm" />
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={kind}
          onChange={(_, v) => v && switchKind(v)}
          aria-label="Console type"
          sx={{ '& .MuiToggleButton-root': { color: t.chassisMuted, borderColor: 'rgba(255,255,255,0.16)' }, '& .Mui-selected': { color: `${t.chassisText} !important`, background: 'rgba(255,255,255,0.10) !important' } }}
        >
          <ToggleButton value="vnc" sx={{ textTransform: 'none', py: 0.25, px: 1.25 }}>
            <Icon icon="mdi:monitor" width={16} style={{ marginRight: 6 }} /> Graphical
          </ToggleButton>
          <ToggleButton value="serial" sx={{ textTransform: 'none', py: 0.25, px: 1.25 }}>
            <Icon icon="mdi:console-line" width={16} style={{ marginRight: 6 }} /> Serial
          </ToggleButton>
        </ToggleButtonGroup>
        <Button
          size="small"
          onClick={showInHangar}
          startIcon={<Icon icon="mdi:arrow-top-left" width={16} />}
          sx={{ textTransform: 'none', color: t.chassisText }}
        >
          Show in Hangar
        </Button>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', p: 1 }}>
        {/* A console window exists to be typed into: it takes the keyboard. */}
        {kind === 'serial' ? (
          // eslint-disable-next-line jsx-a11y/no-autofocus
          <SerialConsole key={`s-${namespace}/${name}`} namespace={namespace} name={name} cluster={cluster} autoFocus minHeight={200} onRequestPowerOn={powerOn} onRequestResume={resume} />
        ) : (
          // eslint-disable-next-line jsx-a11y/no-autofocus
          <VncConsole key={`v-${namespace}/${name}`} namespace={namespace} name={name} cluster={cluster} autoFocus minHeight={200} onRequestPowerOn={powerOn} onRequestResume={resume} />
        )}
      </Box>
    </Box>
  );
}
