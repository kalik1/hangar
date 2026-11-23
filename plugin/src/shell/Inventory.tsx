/*
 * The inventory tree on the left. In the VM views: the datacenter, its
 * folders and their VMs and templates. In the host views: the hosts and the
 * VMs running on each. Arrow keys move, Right/Left expand and collapse,
 * Enter opens, the context menu key or right-click opens the VM menu.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { useHangar } from '../api/data';
import { datacenterName } from '../model/inventory';
import { folders, hostState, hostTree } from '../model/inventory';
import { Obj } from '../model/types';
import { key, powerState } from '../model/vm';
import { Led } from '../ui/Led';
import { LedTone } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import { VmContextMenu } from '../views/vm/actions';
import { hrefFor, useNav } from './nav';
import { useK8s, useSettings } from './settings';

interface Item {
  id: string;
  depth: number;
  label: string;
  sub?: string;
  icon?: string;
  led?: LedTone;
  href?: string;
  expandable?: boolean;
  vm?: Obj;
  dim?: boolean;
}

export function Inventory({ mode }: { mode: 'vms' | 'hosts' }) {
  const d = useHangar();
  const t = useTokens();
  const nav = useNav();
  const history = useHistory();
  const k8s = useK8s();
  const [settings, update] = useSettings();
  const collapsed = new Set(settings.collapsed);
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update({ collapsed: [...next] });
  };
  const items: Item[] = [];
  const dcId = `dc:${d.cluster}`;
  const vmItem = (vm: Obj, depth: number, tpl = false): Item => {
    const p = powerState(vm, d.idx.vmi.get(key(vm)));
    return {
      id: `vm:${key(vm)}`,
      depth,
      label: vm.metadata.name,
      led: tpl ? undefined : p.tone,
      icon: tpl ? 'mdi:file-document-outline' : undefined,
      href: hrefFor('vm', vm.metadata.namespace, vm.metadata.name),
      vm,
      dim: tpl,
    };
  };
  if (mode === 'vms') {
    items.push({
      id: dcId,
      depth: 0,
      label: datacenterName(d.cluster, d.nodes),
      icon: 'mdi:office-building-outline',
      href: hrefFor('vms'),
      expandable: true,
    });
    if (!collapsed.has(dcId)) {
      for (const f of folders(d.vms, d.namespaces, d.vmis, settings.libraryNamespace)) {
        const fid = `folder:${f.name}`;
        items.push({
          id: fid,
          depth: 1,
          label: f.name,
          sub: k8s ? 'namespace' : `${f.running}/${f.vms.length}`,
          icon: collapsed.has(fid) ? 'mdi:folder-outline' : 'mdi:folder-open-outline',
          href: hrefFor('vms', f.name),
          expandable: f.vms.length + f.templates.length > 0,
        });
        if (!collapsed.has(fid)) {
          for (const vm of f.vms) items.push(vmItem(vm, 2));
          for (const vm of f.templates) items.push(vmItem(vm, 2, true));
        }
      }
    }
  } else {
    items.push({ id: dcId, depth: 0, label: datacenterName(d.cluster, d.nodes), icon: 'mdi:office-building-outline', href: hrefFor('hosts'), expandable: true });
    if (!collapsed.has(dcId)) {
      for (const h of hostTree(d.nodes, d.vmis)) {
        const s = hostState(h.node);
        const hid = `host:${h.node.metadata.name}`;
        items.push({
          id: hid,
          depth: 1,
          label: h.node.metadata.name,
          led: s.tone,
          sub: `${h.vmis.length}`,
          href: hrefFor('host', h.node.metadata.name),
          expandable: h.vmis.length > 0,
        });
        if (!collapsed.has(hid)) {
          for (const vmi of h.vmis) {
            const vm = d.idx.vm.get(key(vmi));
            if (vm) items.push(vmItem(vm, 2));
          }
        }
      }
    }
  }
  const activeId =
    nav.view === 'vm'
      ? `vm:${nav.a}/${nav.b}`
      : nav.view === 'vms' && nav.a
      ? `folder:${nav.a}`
      : nav.view === 'host'
      ? `host:${nav.a}`
      : nav.view === 'vms' || nav.view === 'hosts'
      ? dcId
      : '';
  const [focus, setFocus] = React.useState<string>(activeId);
  // One item is reachable with Tab: the focused one if still shown, else the open one, else the first.
  const tabStop = items.some(x => x.id === focus) ? focus : items.some(x => x.id === activeId) ? activeId : items[0]?.id;
  const refs = React.useRef(new Map<string, HTMLDivElement>());
  const [menu, setMenu] = React.useState<{ vm: Obj; x?: number; y?: number; el?: HTMLElement } | null>(null);
  const move = (id: string) => {
    setFocus(id);
    refs.current.get(id)?.focus();
  };
  const onKey = (e: React.KeyboardEvent, it: Item, i: number) => {
    if (e.key === 'ArrowDown' && i < items.length - 1) {
      e.preventDefault();
      move(items[i + 1].id);
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      move(items[i - 1].id);
    } else if (e.key === 'ArrowRight' && it.expandable && collapsed.has(it.id)) {
      e.preventDefault();
      toggle(it.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (it.expandable && !collapsed.has(it.id)) toggle(it.id);
      else {
        const parent = [...items.slice(0, i)].reverse().find(x => x.depth < it.depth);
        if (parent) move(parent.id);
      }
    } else if (e.key === 'Enter' && it.href) {
      history.push(it.href);
    } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && it.vm) {
      e.preventDefault();
      setMenu({ vm: it.vm, el: e.currentTarget as HTMLElement });
    }
  };
  return (
    <Box role="tree" aria-label={mode === 'vms' ? 'Virtual machines and templates' : 'Hosts'} sx={{ py: 0.5, fontSize: 13.5 }}>
      {items.map((it, i) => {
        const active = it.id === activeId;
        return (
          <Box
            key={it.id}
            ref={(el: HTMLDivElement | null) => {
              if (el) refs.current.set(it.id, el);
              else refs.current.delete(it.id);
            }}
            role="treeitem"
            aria-level={it.depth + 1}
            aria-expanded={it.expandable ? !collapsed.has(it.id) : undefined}
            aria-selected={active}
            tabIndex={it.id === tabStop ? 0 : -1}
            onFocus={() => setFocus(it.id)}
            onKeyDown={e => onKey(e, it, i)}
            onClick={() => it.href && history.push(it.href)}
            onContextMenu={e => {
              if (!it.vm) return;
              e.preventDefault();
              setMenu({ vm: it.vm, x: e.clientX, y: e.clientY });
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              height: 28,
              pl: 0.5 + it.depth * 1.75,
              pr: 1,
              cursor: 'pointer',
              userSelect: 'none',
              color: it.dim ? t.muted : t.text,
              background: active ? t.selected : 'transparent',
              borderLeft: `2px solid ${active ? t.meterUsed : 'transparent'}`,
              '&:hover': { background: active ? t.selected : t.hover },
              '&:focus-visible': { outline: `2px solid ${t.meterUsed}`, outlineOffset: -2 },
            }}
          >
            <Box
              component="span"
              onClick={e => {
                if (!it.expandable) return;
                e.stopPropagation();
                toggle(it.id);
              }}
              sx={{ width: 16, display: 'inline-flex', color: t.muted, flex: 'none' }}
              aria-hidden
            >
              {it.expandable && <Icon icon={collapsed.has(it.id) ? 'mdi:chevron-right' : 'mdi:chevron-down'} width={16} />}
            </Box>
            {it.led && <Led tone={it.led} size={8} />}
            {it.icon && <Icon icon={it.icon} width={16} style={{ flex: 'none', color: t.muted }} />}
            <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.label}
            </Box>
            {it.sub && (
              <Box component="span" sx={{ fontSize: 12, color: t.muted, fontVariantNumeric: 'tabular-nums' }}>
                {it.sub}
              </Box>
            )}
          </Box>
        );
      })}
      {menu && (
        <VmContextMenu vm={menu.vm} anchor={{ el: menu.el, x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
    </Box>
  );
}
