/*
 * The Console tab: the graphical console or the serial console, embedded,
 * with a button to open it in its own browser window. KubeVirt serves one
 * console client per VM, so while the window is open the tab steps aside.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { closePopup, consolePopupKey, resolveCluster, SerialConsole, useConsolePopupOpen, VncConsole } from '../../console';
import { Obj } from '../../model/types';
import { PowerState } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useTokens } from '../../ui/useTokens';
import { useOpenConsole } from './hooks';

/** Smallest console in the tab (toolbar + screen): it fits a 1280x720 window under the faceplate. */
export const CONSOLE_MIN = 180;

export function ConsoleTab({ vm, serial }: { vm: Obj; p: PowerState; serial?: boolean }) {
  const t = useTokens();
  const history = useHistory();
  const openConsole = useOpenConsole();
  const ns = vm.metadata.namespace as string;
  const name = vm.metadata.name;
  const popupKey = consolePopupKey(resolveCluster(), ns, name);
  const inWindow = useConsolePopupOpen(popupKey);
  const powerOn = React.useCallback(() => A.powerOn(vm).catch(() => undefined), [vm]);
  const resume = React.useCallback(() => A.resume(vm).catch(() => undefined), [vm]);
  return (
    // Fills the space VmPage gives it (flex), whatever the heights above.
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, borderBottom: `1px solid ${t.rule}`, background: t.surface }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={serial ? 'serial' : 'vnc'}
          onChange={(_, v) => v && history.replace(hrefFor('vm', ns, name, v === 'serial' ? 'serial' : 'console'))}
          aria-label="Console type"
        >
          <ToggleButton value="vnc" sx={{ textTransform: 'none', py: 0.25, px: 1.5 }}>
            <Icon icon="mdi:monitor" width={16} style={{ marginRight: 6 }} /> Graphical
          </ToggleButton>
          <ToggleButton value="serial" sx={{ textTransform: 'none', py: 0.25, px: 1.5 }}>
            <Icon icon="mdi:console-line" width={16} style={{ marginRight: 6 }} /> Serial
          </ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<Icon icon="mdi:open-in-new" width={16} />}
          onClick={() => openConsole(vm, serial ? 'serial' : 'vnc', { focusOnly: inWindow })}
          sx={{ textTransform: 'none' }}
        >
          {inWindow ? 'Show its window' : 'Open in a window'}
        </Button>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* autoFocus here gives the console the keyboard, as a console should. */}
        {inWindow ? (
          <Box sx={{ flex: 1, minHeight: 180, display: 'grid', placeItems: 'center', background: t.chassis, color: t.chassisText, p: 3 }}>
            <Box sx={{ textAlign: 'center', maxWidth: 460 }}>
              <Icon icon="mdi:open-in-new" width={28} style={{ opacity: 0.8 }} />
              <Box sx={{ fontSize: 16, fontWeight: 600, mt: 1 }}>The console of {name} is open in its own window</Box>
              <Box sx={{ fontSize: 13.5, color: t.chassisMuted, mt: 0.75 }}>
                A VM has one console at a time. Use the window, or bring the console back here: the window closes.
              </Box>
              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', mt: 2 }}>
                <Button variant="contained" disableElevation size="small" sx={{ textTransform: 'none' }} onClick={() => openConsole(vm, serial ? 'serial' : 'vnc', { focusOnly: true })}>
                  Show its window
                </Button>
                <Button size="small" sx={{ textTransform: 'none', color: t.chassisText }} onClick={() => closePopup(popupKey)}>
                  Use it here
                </Button>
              </Box>
            </Box>
          </Box>
        ) : serial ? (
          // eslint-disable-next-line jsx-a11y/no-autofocus
          <SerialConsole key={`s-${ns}/${name}`} namespace={ns} name={name} autoFocus minHeight={CONSOLE_MIN} onRequestPowerOn={powerOn} onRequestResume={resume} />
        ) : (
          // eslint-disable-next-line jsx-a11y/no-autofocus
          <VncConsole key={`v-${ns}/${name}`} namespace={ns} name={name} autoFocus minHeight={CONSOLE_MIN} onRequestPowerOn={powerOn} onRequestResume={resume} />
        )}
      </Box>
    </Box>
  );
}
