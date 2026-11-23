/*
 * The top bar: where you are (datacenter), the views, search across the
 * inventory, the Kubernetes details switch and New VM.
 */

import { Icon } from '@iconify/react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputAdornment from '@mui/material/InputAdornment';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { useHangar } from '../api/data';
import { datacenterName } from '../model/inventory';
import { hostState } from '../model/inventory';
import { key, nics, powerState, primaryIp, tags } from '../model/vm';
import { Led } from '../ui/Led';
import { LedTone } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import { openNewVmWizard } from '../wizard/open';
import { hrefFor, useNav, View } from './nav';
import { useSettings } from './settings';

const TABS: { view: View; label: string; also?: View[] }[] = [
  { view: 'dashboard', label: 'Dashboard' },
  { view: 'vms', label: 'Virtual machines', also: ['vm'] },
  { view: 'hosts', label: 'Hosts', also: ['host', 'devices'] },
  { view: 'storage', label: 'Storage', also: ['library', 'templates'] },
  { view: 'networks', label: 'Networks' },
  { view: 'flavors', label: 'Flavors' },
  { view: 'tasks', label: 'Tasks & events' },
  { view: 'settings', label: 'Settings' },
];

interface Hit {
  kind: 'vm' | 'host' | 'folder';
  id: string;
  label: string;
  sub: string;
  led?: LedTone;
  href: string;
  haystack: string;
}

function Search() {
  const d = useHangar();
  const t = useTokens();
  const history = useHistory();
  const [input, setInput] = React.useState('');
  const hits = React.useMemo<Hit[]>(() => {
    const out: Hit[] = [];
    for (const vm of d.vms) {
      const vmi = d.idx.vmi.get(key(vm));
      const p = powerState(vm, vmi);
      const ips = nics(vm, vmi).flatMap(n => n.ips);
      out.push({
        kind: 'vm',
        id: `vm:${key(vm)}`,
        label: vm.metadata.name,
        sub: [vm.metadata.namespace, p.label, primaryIp(vmi), vmi?.status?.nodeName].filter(Boolean).join(' · '),
        led: p.tone,
        href: hrefFor('vm', vm.metadata.namespace, vm.metadata.name),
        haystack: [vm.metadata.name, vm.metadata.namespace, ...ips, vmi?.status?.nodeName, ...tags(vm).map(([k, v]) => `${k}=${v}`), vm.metadata.annotations?.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      });
    }
    for (const n of d.nodes) {
      const s = hostState(n);
      const addr = (n.status?.addresses ?? []).map((a: any) => a.address).join(' ');
      out.push({
        kind: 'host',
        id: `host:${n.metadata.name}`,
        label: n.metadata.name,
        sub: `Host · ${s.label}`,
        led: s.tone,
        href: hrefFor('host', n.metadata.name),
        haystack: `${n.metadata.name} ${addr}`.toLowerCase(),
      });
    }
    return out;
  }, [d]);
  return (
    <Autocomplete<Hit, false, false, false>
      size="small"
      options={hits}
      inputValue={input}
      onInputChange={(_, v) => setInput(v)}
      filterOptions={(opts, s) => {
        const q = s.inputValue.trim().toLowerCase();
        if (!q) return [];
        return opts.filter(o => o.haystack.includes(q)).slice(0, 12);
      }}
      getOptionLabel={o => o.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(_, v) => {
        if (v) {
          history.push(v.href);
          setInput('');
        }
      }}
      noOptionsText={input ? 'Nothing matches' : 'Type a name, IP, host or tag'}
      openOnFocus={false}
      sx={{ width: 300 }}
      renderOption={(props, o) => (
        <Box component="li" {...props} key={o.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {o.led ? <Led tone={o.led} /> : <Icon icon="mdi:folder-outline" width={16} />}
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ fontSize: 14 }}>{o.label}</Box>
            <Box sx={{ fontSize: 12, color: t.muted }}>{o.sub}</Box>
          </Box>
        </Box>
      )}
      renderInput={p => (
        <TextField
          {...p}
          placeholder="Search VMs, IPs, hosts, tags"
          inputProps={{ ...p.inputProps, 'aria-label': 'Search the inventory' }}
          InputProps={{
            ...p.InputProps,
            startAdornment: (
              <InputAdornment position="start">
                <Icon icon="mdi:magnify" width={18} />
              </InputAdornment>
            ),
          }}
        />
      )}
    />
  );
}

/** The product mark: a tiny rack with one lit unit. */
function RackMark() {
  const t = useTokens();
  return (
    <Box
      aria-hidden
      sx={{
        width: 22,
        height: 22,
        borderRadius: '5px',
        background: t.chassis,
        display: 'grid',
        gridTemplateRows: 'repeat(3, 1fr)',
        gap: '2px',
        p: '4px',
        flex: 'none',
      }}
    >
      {[0, 1, 2].map(i => (
        <Box key={i} sx={{ background: '#3A444E', borderRadius: '1px', position: 'relative' }}>
          <Box
            sx={{
              position: 'absolute',
              right: 1,
              top: '50%',
              mt: '-1px',
              width: 2,
              height: 2,
              borderRadius: '50%',
              background: i === 0 ? '#2FBF71' : '#5B6672',
            }}
          />
        </Box>
      ))}
    </Box>
  );
}

export function TopBar() {
  const d = useHangar();
  const t = useTokens();
  const nav = useNav();
  const history = useHistory();
  const [settings, update] = useSettings();
  const current = TABS.find(x => x.view === nav.view || x.also?.includes(nav.view))?.view ?? 'dashboard';
  const running = d.vmis.length;
  return (
    <Box component="header" sx={{ borderBottom: `1px solid ${t.rule}`, background: t.surface, flex: 'none' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, minHeight: 50, flexWrap: 'wrap' }}>
        <Tooltip title={settings.treeHidden ? 'Show the inventory' : 'Hide the inventory'}>
          <Button
            size="small"
            color="inherit"
            onClick={() => update({ treeHidden: !settings.treeHidden })}
            aria-label={settings.treeHidden ? 'Show the inventory' : 'Hide the inventory'}
            sx={{ minWidth: 0, px: 0.75 }}
          >
            <Icon icon="mdi:file-tree" width={20} />
          </Button>
        </Tooltip>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
          <RackMark />
          <Box sx={{ fontWeight: 700, fontSize: 16, letterSpacing: 0.2 }}>Hangar</Box>
          <Icon icon="mdi:chevron-right" width={18} style={{ color: t.muted }} />
          <Box sx={{ fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Datacenter (cluster)">
            {datacenterName(d.cluster, d.nodes)}
          </Box>
          <Box component="span" sx={{ fontSize: 13, color: t.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {d.nodes.length} host{d.nodes.length === 1 ? '' : 's'}, {running} of {d.vms.length} VMs on
          </Box>
        </Box>
        <Search />
        <Tooltip title="Show Kubernetes names, objects and YAML next to the virtualization view">
          <FormControlLabel
            sx={{ mr: 0, '& .MuiFormControlLabel-label': { fontSize: 13.5 } }}
            control={<Switch size="small" checked={settings.k8s} onChange={e => update({ k8s: e.target.checked })} />}
            label="Kubernetes"
          />
        </Tooltip>
        <Button
          variant="contained"
          disableElevation
          startIcon={<Icon icon="mdi:plus" width={18} />}
          onClick={() => openNewVmWizard({ folder: nav.view === 'vms' ? nav.a : nav.view === 'vm' ? nav.a : undefined })}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          New VM
        </Button>
      </Box>
      <Tabs
        value={current}
        onChange={(_, v: View) => history.push(hrefFor(v))}
        variant="scrollable"
        scrollButtons={false}
        aria-label="Hangar views"
        sx={{
          minHeight: 40,
          px: 1,
          '& .MuiTab-root': { minHeight: 40, textTransform: 'none', fontSize: 14, px: 1.75, minWidth: 0 },
        }}
      >
        {TABS.map(x => (
          <Tab key={x.view} value={x.view} label={x.label} />
        ))}
      </Tabs>
    </Box>
  );
}
