/*
 * The VM faceplate: Hangar's one loud element. A dark band like the front
 * panel of a rack server, with its ears and screws, the live console
 * screen, the status LED, the asset label strip and the hardware buttons.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { useHangar } from '../../api/data';
import { useVmPerms } from '../../api/permissions';
import { Obj } from '../../model/types';
import { formatAge, formatBytes } from '../../model/units';
import {
  hardware,
  isTemplate,
  key,
  osIcon,
  powerActions,
  PowerState,
  primaryIp,
  runningSince,
  runStrategy,
} from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { Led } from '../../ui/Led';
import { LED, tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { vmOs } from '../os';
import { vmDiskBytes } from '../vms/VmList';
import { vmActions,VmActionsMenu } from './actions';
import { useOpenConsole, useTakeSnapshot } from './hooks';
import { Screen } from './Screen';

function Ear({ side }: { side: 'left' | 'right' }) {
  const t = useTokens();
  const screw = (
    <Box
      sx={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: '#0B0E10',
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 1px ${t.chassisEdge}`,
      }}
    />
  );
  return (
    <Box
      aria-hidden
      sx={{
        width: 16,
        flex: 'none',
        alignSelf: 'stretch',
        background: t.chassisEdge,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        py: 1.25,
        [side === 'left' ? 'borderRight' : 'borderLeft']: `1px solid rgba(0,0,0,0.35)`,
      }}
    >
      {screw}
      {screw}
    </Box>
  );
}

function PanelButton({
  icon,
  label,
  onClick,
  disabled,
  lit,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  lit?: string;
}) {
  const t = useTokens();
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          sx={{
            width: 40,
            height: 40,
            borderRadius: '8px',
            color: lit ?? t.chassisText,
            background: t.chassisEdge,
            border: '1px solid rgba(0,0,0,0.45)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)',
            '&:hover': { background: '#384049' },
            '&.Mui-disabled': { color: 'rgba(236,239,242,0.28)', background: 'rgba(45,53,61,0.55)' },
            '&:focus-visible': { outline: `2px solid ${LED.busy}`, outlineOffset: 2 },
          }}
        >
          <Icon icon={icon} width={20} />
        </IconButton>
      </span>
    </Tooltip>
  );
}

function LabelCell({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  const t = useTokens();
  return (
    <Box sx={{ px: 1.5, py: 0.75, borderLeft: `1px solid ${t.chassisEdge}`, minWidth: 0, '&:first-of-type': { borderLeft: 'none', pl: 0 } }}>
      <Box sx={{ fontSize: 11.5, color: t.chassisMuted, whiteSpace: 'nowrap' }}>{label}</Box>
      <Box
        title={title}
        sx={{ fontSize: 14, color: t.chassisText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...tabular }}
      >
        {children}
      </Box>
    </Box>
  );
}

export function Faceplate({ vm, p }: { vm: Obj; p: PowerState }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const history = useHistory();
  const openConsole = useOpenConsole();
  const takeSnapshot = useTakeSnapshot();
  const [menuEl, setMenuEl] = React.useState<HTMLElement | null>(null);
  const vmi = d.idx.vmi.get(key(vm));
  const hw = hardware(vm, vmi, d.instancetypes);
  const os = vmOs(vm, d);
  const perms = useVmPerms(vm.metadata.namespace);
  const raw = powerActions(p, runStrategy(vm));
  const can = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v && perms.power])) as typeof raw;
  const tpl = isTemplate(vm);
  const ip = primaryIp(vmi);
  const since = runningSince(vmi);
  const node = vmi?.status?.nodeName;
  const running = p.kind === 'on' || p.kind === 'paused' || p.kind === 'migrating' || p.kind === 'starting';
  const quiet = (x: Promise<unknown>) => x.catch(() => undefined);

  return (
    <Box
      sx={{
        display: 'flex',
        background: t.chassis,
        color: t.chassisText,
        borderBottom: '1px solid rgba(0,0,0,0.5)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        minHeight: 196,
      }}
    >
      <Ear side="left" />
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', gap: 2.5, p: 2, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <Screen vm={vm} p={p} onOpen={() => (running ? openConsole(vm, 'vnc') : undefined)} />
        <Box sx={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
            <Box component="h1" sx={{ m: 0, fontSize: 26, fontWeight: 600, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {vm.metadata.name}
            </Box>
            {tpl && (
              <Box sx={{ fontSize: 12.5, px: 0.75, py: 0.25, border: `1px solid ${t.chassisMuted}`, borderRadius: '4px', color: t.chassisMuted }}>
                Template
              </Box>
            )}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14, flexWrap: 'wrap' }}>
            {!tpl && <Led tone={p.tone} size={11} />}
            <Box component="span" sx={{ fontWeight: 600, color: p.tone === 'fault' ? LED.fault : t.chassisText }}>
              {tpl ? 'Powered-off template' : p.label}
            </Box>
            {p.kind === 'on' && since && <Box component="span" sx={{ color: t.chassisMuted }}>for {formatAge(since)}</Box>}
            {p.detail && (p.tone === 'fault' || p.kind === 'migrating') && (
              <Box component="span" sx={{ color: t.chassisMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }} title={p.detail}>
                {p.detail}
              </Box>
            )}
            {k8s && (
              <Box component="code" sx={{ fontFamily: t.font.mono, fontSize: 12, color: t.chassisMuted }}>
                {p.printable}
              </Box>
            )}
          </Box>
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              rowGap: 0.5,
              mt: 'auto',
              border: `1px solid ${t.chassisEdge}`,
              borderRadius: '5px',
              background: 'rgba(0,0,0,0.18)',
              px: 1.5,
            }}
          >
            <LabelCell label="Guest OS" title={os.name}>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                <Icon icon={osIcon(os.id)} width={15} />
                {os.name}
              </Box>
            </LabelCell>
            <LabelCell label="CPU">{hw.vcpus} vCPU</LabelCell>
            <LabelCell label="Memory">{formatBytes(hw.memoryBytes)}</LabelCell>
            <LabelCell label="Storage">{formatBytes(vmDiskBytes(vm, d))}</LabelCell>
            <LabelCell label="IP address">{ip ?? '—'}</LabelCell>
            <LabelCell label="Host">
              {node ? (
                <Box component={RouterLink} to={hrefFor('host', node)} sx={{ color: 'inherit' }}>
                  {node}
                </Box>
              ) : (
                '—'
              )}
            </LabelCell>
            <LabelCell label={k8s ? 'Namespace' : 'Folder'}>
              <Box component={RouterLink} to={hrefFor('vms', vm.metadata.namespace)} sx={{ color: 'inherit' }}>
                {vm.metadata.namespace}
              </Box>
            </LabelCell>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end', justifyContent: 'space-between' }}>
          {!tpl && (
            <Box role="group" aria-label="Power" sx={{ display: 'flex', gap: 1 }}>
              {can.start ? (
                <PanelButton icon="mdi:power" label="Power on" lit={LED.on} onClick={() => quiet(A.powerOn(vm))} />
              ) : (
                <PanelButton icon="mdi:power" label="Shut down guest" onClick={() => quiet(A.shutDown(vm))} disabled={!can.shutdown} />
              )}
              <PanelButton icon="mdi:restart" label="Restart guest" onClick={() => quiet(A.restart(vm))} disabled={!can.restart} />
              {p.kind === 'paused' ? (
                <PanelButton icon="mdi:play-pause" label="Resume" lit={LED.standby} onClick={() => quiet(A.resume(vm))} />
              ) : (
                <PanelButton icon="mdi:pause" label="Suspend" onClick={() => quiet(A.suspend(vm))} disabled={!can.suspend} />
              )}
              <PanelButton icon="mdi:monitor" label="Open console" onClick={() => openConsole(vm, 'vnc')} disabled={!running || !perms.console} />
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 1 }}>
            {tpl && (
              <Button
                variant="contained"
                disableElevation
                startIcon={<Icon icon="mdi:rocket-launch-outline" width={18} />}
                onClick={() => vmActions(vm, d, h => history.push(h)).find(a => a.id === 'clone')?.run()}
                sx={{ textTransform: 'none' }}
              >
                New VM from template
              </Button>
            )}
            <Button
              variant="outlined"
              onClick={e => setMenuEl(e.currentTarget)}
              endIcon={<Icon icon="mdi:chevron-down" width={18} />}
              aria-haspopup="menu"
              sx={{
                textTransform: 'none',
                color: t.chassisText,
                borderColor: t.chassisMuted,
                '&:hover': { borderColor: t.chassisText, background: 'rgba(255,255,255,0.05)' },
              }}
            >
              Actions
            </Button>
          </Box>
        </Box>
      </Box>
      <Ear side="right" />
      <VmActionsMenu
        anchor={menuEl ? { el: menuEl } : null}
        onClose={() => setMenuEl(null)}
        title={`Actions for ${vm.metadata.name}`}
        actions={vmActions(vm, d, h => history.push(h), { openConsole, snapshot: takeSnapshot, perms })}
      />
    </Box>
  );
}
