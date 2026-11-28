/*
 * What you can do with a VM, in one place: the faceplate buttons, the
 * Actions menu, the right-click menu of the tree and tables, bulk actions.
 * Destructive actions confirm first and say what is lost.
 */

import { Icon } from '@iconify/react';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../../api/actions';
import { HangarData, useHangar } from '../../api/data';
import { ALL_PERMS, NOT_ALLOWED, useVmPerms, VmPerms } from '../../api/permissions';
import { isProtected } from '../../model/protection';
import { Obj } from '../../model/types';
import { isTemplate, key, powerActions, powerState, runStrategy } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { confirm, openDialog } from '../../ui/dialogs';
import { CloneDialog } from './CloneDialog';
import { useOpenConsole, useTakeSnapshot } from './hooks';
import { MigrateDialog } from './MigrateDialog';
import { confirmPutOldDisksBack, MoveDiskDialog, stuckMoveOf } from './MoveDiskDialog';

export interface VmAction {
  id: string;
  label: string;
  icon: string;
  group: 'power' | 'console' | 'manage' | 'danger';
  enabled: boolean;
  why?: string;
  run: () => void;
}

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

export function vmActions(
  vm: Obj,
  d: HangarData,
  go: (href: string) => void,
  extra: { openConsole?: (vm: Obj, kind: 'vnc' | 'serial') => void; snapshot?: (vm: Obj) => void; perms?: VmPerms } = {}
): VmAction[] {
  const vmi = d.idx.vmi.get(key(vm));
  const p = powerState(vm, vmi);
  const rs = runStrategy(vm);
  const can = powerActions(p, rs);
  const tpl = isTemplate(vm);
  const name = vm.metadata.name;
  const ns = vm.metadata.namespace as string;
  const otherHosts = d.nodes.filter(n => n.metadata.name !== vmi?.status?.nodeName && !n.spec?.unschedulable);
  const out: VmAction[] = [];
  if (!tpl) {
    out.push(
      { id: 'start', label: 'Power on', icon: 'mdi:play', group: 'power', enabled: can.start, run: () => quiet(A.powerOn(vm)) },
      {
        id: 'shutdown',
        label: 'Shut down guest',
        icon: 'mdi:power',
        group: 'power',
        enabled: can.shutdown,
        run: () => quiet(A.shutDown(vm)),
      },
      {
        id: 'restart',
        label: 'Restart guest',
        icon: 'mdi:restart',
        group: 'power',
        enabled: can.restart,
        run: () => quiet(A.restart(vm)),
      },
      { id: 'suspend', label: 'Suspend', icon: 'mdi:pause', group: 'power', enabled: can.suspend, run: () => quiet(A.suspend(vm)) },
      { id: 'resume', label: 'Resume', icon: 'mdi:play-pause', group: 'power', enabled: can.resume, run: () => quiet(A.resume(vm)) },
      {
        id: 'poweroff',
        label: 'Power off',
        icon: 'mdi:power-plug-off-outline',
        group: 'power',
        enabled: can.powerOff,
        run: async () => {
          const ok = await confirm({
            title: `Power off ${name}?`,
            body: (
              <p>
                The VM stops at once, like pulling the plug. Unsaved data in the guest is lost. Use Shut down guest for a
                clean stop.
              </p>
            ),
            confirm: 'Power off',
            danger: true,
          });
          if (ok) quiet(A.shutDown(vm, { force: true }));
        },
      },
      {
        id: 'reset',
        label: 'Reset',
        icon: 'mdi:backup-restore',
        group: 'power',
        enabled: can.reset,
        run: async () => {
          const ok = await confirm({
            title: `Reset ${name}?`,
            body: <p>The guest restarts at once without shutting down, like pressing the reset button.</p>,
            confirm: 'Reset',
            danger: true,
          });
          if (ok) quiet(A.reset(vm));
        },
      }
    );
    if (extra.openConsole) {
      out.push(
        {
          id: 'console',
          label: 'Open console',
          icon: 'mdi:monitor',
          group: 'console',
          enabled: p.kind === 'on' || p.kind === 'paused' || p.kind === 'starting',
          why: 'The VM is not running',
          run: () => extra.openConsole?.(vm, 'vnc'),
        },
        {
          id: 'serial',
          label: 'Open serial console',
          icon: 'mdi:console-line',
          group: 'console',
          enabled: p.kind === 'on' || p.kind === 'paused' || p.kind === 'starting',
          why: 'The VM is not running',
          run: () => extra.openConsole?.(vm, 'serial'),
        }
      );
    }
    const movable = can.migrate || p.kind === 'off';
    out.push({
      id: 'migrate',
      label: p.kind === 'off' ? 'Move to another host…' : 'Migrate…',
      icon: 'mdi:transit-transfer',
      group: 'manage',
      enabled: movable && otherHosts.length > 0,
      why: !movable ? 'Wait until it is running or powered off' : 'There is no other host to move to',
      run: () => openDialog(close => <MigrateDialog vm={vm} data={d} onClose={close} />),
    });
    const moving = (d.idx.migrations.get(key(vm)) ?? []).find(m => !['Succeeded', 'Failed'].includes(m.status?.phase ?? ''));
    if (moving) {
      out.push({
        id: 'cancel-migration',
        label: 'Cancel migration',
        icon: 'mdi:close-circle-outline',
        group: 'manage',
        enabled: true,
        run: () => quiet(A.cancelMigration(ns, moving.metadata.name, name)),
      });
    }
    const stuck = stuckMoveOf(vm, d);
    out.push({
      id: 'move-disks',
      label: 'Move disks…',
      icon: 'mdi:database-arrow-right-outline',
      group: 'manage',
      enabled: !stuck && (p.kind === 'off' || p.kind === 'on'),
      why: stuck ? 'A disk move cannot end: put the old disk back first' : 'Wait until it is running or powered off',
      run: () => openDialog(close => <MoveDiskDialog vm={vm} onClose={close} />),
    });
    if (stuck) {
      out.push({
        id: 'put-old-disks-back',
        label: stuck.volumes.length === 1 ? 'Put the old disk back…' : 'Put the old disks back…',
        icon: 'mdi:database-refresh-outline',
        group: 'manage',
        enabled: true,
        run: () => confirmPutOldDisksBack(vm, stuck, d),
      });
    }
  }
  out.push({
    id: 'clone',
    label: tpl ? 'New VM from this template…' : 'Clone…',
    icon: tpl ? 'mdi:rocket-launch-outline' : 'mdi:content-duplicate',
    group: 'manage',
    enabled: tpl || p.kind === 'off',
    why: 'Power off the VM first, so its disks are copied in a consistent state',
    run: () => openDialog(close => <CloneDialog source={vm} data={d} mode={tpl ? 'deploy' : 'clone'} onClose={close} />),
  });
  if (!tpl) {
    out.push({
      id: 'clone-template',
      label: 'Clone to template…',
      icon: 'mdi:file-document-multiple-outline',
      group: 'manage',
      enabled: p.kind === 'off',
      why: 'Power off the VM first',
      run: () => openDialog(close => <CloneDialog source={vm} data={d} mode="template" onClose={close} />),
    });
  }
  if (extra.snapshot && !tpl) {
    out.push({
      id: 'snapshot',
      label: 'Take snapshot…',
      icon: 'mdi:camera-outline',
      group: 'manage',
      enabled: d.has.snapshots,
      why: 'The cluster has no volume snapshot support',
      run: () => extra.snapshot?.(vm),
    });
  }
  out.push({
    id: 'edit',
    label: 'Edit settings…',
    icon: 'mdi:tune-variant',
    group: 'manage',
    enabled: true,
    run: () => go(hrefFor('vm', ns, name, 'configure')),
  });
  out.push({
    id: 'template',
    label: tpl ? 'Convert to VM' : 'Convert to template',
    icon: tpl ? 'mdi:server' : 'mdi:file-document-outline',
    group: 'manage',
    enabled: tpl || p.kind === 'off',
    why: 'Power off the VM first',
    run: async () => {
      if (!tpl) {
        const ok = await confirm({
          title: `Convert ${name} to a template?`,
          body: (
            <p>
              A template cannot be powered on. New VMs made from it get a copy of its disks. You can convert it back to a VM
              at any time.
            </p>
          ),
          confirm: 'Convert to template',
        });
        if (!ok) return;
      }
      quiet(
        A.patchVm(vm, tpl ? 'Convert to VM' : 'Convert to template', {
          metadata: { labels: { 'hangar.magesgate.com/template': tpl ? null : 'true' } },
          spec: tpl ? {} : { runStrategy: 'Halted', running: null },
        })
      );
    },
  });
  out.push({
    id: 'delete',
    label: tpl ? 'Delete template…' : 'Delete…',
    icon: 'mdi:delete-outline',
    group: 'danger',
    // A deletion left waiting by an older Hangar's "keep disks" can be sent again.
    enabled: (p.kind !== 'deleting' || A.deletionStuckOrphaning(vm)) && !isProtected(vm),
    why: isProtected(vm) ? 'Protected from deletion: turn protection off in Configure → Options first' : undefined,
    run: async () => {
      const r = await confirm({
        title: `Delete ${name}?`,
        body: (
          <>
            <p>
              {p.kind === 'deleting'
                ? "Its deletion is stuck: an earlier Hangar kept its disks by letting go of everything the VM owns, which KubeVirt's instancetype and preference records do not allow. Deleting again finishes it."
                : p.kind === 'off' || tpl
                ? 'The VM and its configuration are removed.'
                : 'The VM is running: it is powered off and removed.'}
            </p>
            <p>Disks created with it are deleted too, unless you keep them below.</p>
          </>
        ),
        confirm: 'Delete',
        danger: true,
        typeToConfirm: name,
        option: { label: 'Keep its disks', help: 'They stay in the folder as unattached disks.' },
      });
      if (r) {
        quiet(A.deleteVm(vm, { keepDisks: r.option }));
        go(hrefFor('vms', ns));
      }
    },
  });
  // Disable what the user's role does not allow, and say so.
  const perms = extra.perms ?? ALL_PERMS;
  const need: Record<string, keyof VmPerms> = {
    start: 'power',
    shutdown: 'power',
    restart: 'power',
    suspend: 'power',
    resume: 'power',
    poweroff: 'power',
    reset: 'power',
    console: 'console',
    serial: 'console',
    migrate: 'migrate',
    'cancel-migration': 'migrate',
    'move-disks': 'edit',
    'put-old-disks-back': 'edit',
    clone: 'edit',
    'clone-template': 'edit',
    snapshot: 'power',
    edit: 'edit',
    template: 'edit',
    delete: 'remove',
  };
  return out.map(a => (need[a.id] && !perms[need[a.id]] ? { ...a, enabled: false, why: NOT_ALLOWED } : a));
}

/** The Actions menu (also the right-click menu). */
export function VmActionsMenu({
  actions,
  anchor,
  onClose,
  title,
}: {
  actions: VmAction[];
  anchor: { el?: HTMLElement | null; x?: number; y?: number } | null;
  onClose: () => void;
  title?: string;
}) {
  const groups: [VmAction['group'], string][] = [
    ['power', 'Power'],
    ['console', 'Console'],
    ['manage', 'Manage'],
    ['danger', ''],
  ];
  const open = !!anchor;
  return (
    <Menu
      open={open}
      onClose={onClose}
      anchorEl={anchor?.el ?? undefined}
      anchorReference={anchor?.el ? 'anchorEl' : 'anchorPosition'}
      anchorPosition={anchor && anchor.x !== undefined ? { top: anchor.y ?? 0, left: anchor.x } : undefined}
      MenuListProps={{ dense: true, 'aria-label': title ?? 'VM actions', sx: { minWidth: 240 } }}
    >
      {groups.flatMap(([g, label], gi) => {
        const items = actions.filter(a => a.group === g);
        if (!items.length) return [];
        return [
          gi > 0 ? <Divider key={`d-${g}`} /> : null,
          label ? (
            <ListSubheader key={`h-${g}`} sx={{ lineHeight: '30px', fontSize: 12, background: 'transparent' }}>
              {label}
            </ListSubheader>
          ) : null,
          ...items.map(a => (
            <MenuItem
              key={a.id}
              disabled={!a.enabled}
              title={!a.enabled ? a.why : undefined}
              onClick={() => {
                onClose();
                a.run();
              }}
              sx={a.group === 'danger' ? { color: 'error.main' } : undefined}
            >
              <ListItemIcon sx={{ color: 'inherit' }}>
                <Icon icon={a.icon} width={18} />
              </ListItemIcon>
              <ListItemText primaryTypographyProps={{ fontSize: 14 }}>{a.label}</ListItemText>
            </MenuItem>
          )),
        ];
      })}
    </Menu>
  );
}

/** The right-click / Actions menu of one VM, with the user's permissions applied. */
export function VmContextMenu({
  vm,
  anchor,
  onClose,
}: {
  vm: Obj;
  anchor: { el?: HTMLElement | null; x?: number; y?: number } | null;
  onClose: () => void;
}) {
  const d = useHangar();
  const history = useHistory();
  const openConsole = useOpenConsole();
  const snapshot = useTakeSnapshot();
  const perms = useVmPerms(vm.metadata.namespace);
  return (
    <VmActionsMenu
      anchor={anchor}
      onClose={onClose}
      title={`Actions for ${vm.metadata.name}`}
      actions={vmActions(vm, d, h => history.push(h), { openConsole, snapshot, perms })}
    />
  );
}
