/*
 * Configure → Published ports: the VM's ports reachable inside the cluster,
 * on every host's port, on an address of its own or at a web address
 * through the ingress (WebLine), each row with its live
 * state (the Service, whether the VM is behind it, the host port, the
 * LoadBalancer address and who announces it), and the publish / unpublish
 * changes with the pending → done | failed row state.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import * as A from '../../api/actions';
import { errorText } from '../../api/client';
import { useHangar } from '../../api/data';
import { NOT_ALLOWED, useCan, useVmPerms } from '../../api/permissions';
import { forwardToGuest, publishPorts, unpublishPort } from '../../api/ports';
import { publishWeb, useWebData } from '../../api/web';
import { accessProblem, hostAddresses, missingFromList, modeInfo, PortRow, Proto } from '../../model/ports';
import { Obj, VM } from '../../model/types';
import { key, powerState } from '../../model/vm';
import { webRows } from '../../model/web';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { IconAction, K8sName, Panel, Tag } from '../../ui/kit';
import { RowStatus, useRowChange } from '../../ui/rowState';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';
import { Help } from './configParts';
import { CopyButton, FirewalldNote, LbLine, LiveLabel, MODE_ICON, rowCopyLine, rowLive, useVmPorts, VmPorts, whereText } from './portParts';
import { PublishDialog, PublishSubmit } from './PublishDialog';
import { WebLine } from './WebLine';

interface Change extends PublishSubmit {
  id: number;
}

export function PortsPanel({ vm }: { vm: VM }) {
  const d = useHangar();
  const t = useTokens();
  const ports = useVmPorts(vm);
  const vmNs = vm.metadata.namespace as string;
  const canCreate = useCan({ verb: 'create', group: '', resource: 'services', namespace: vmNs });
  const canPatch = useCan({ verb: 'patch', group: '', resource: 'services', namespace: vmNs });
  const canDelete = useCan({ verb: 'delete', group: '', resource: 'services', namespace: vmNs });
  const perms = useVmPerms(vmNs);
  const web = useWebData(vmNs);
  const canIngress = useCan({ verb: 'create', group: 'networking.k8s.io', resource: 'ingresses', namespace: vmNs });
  const canDeleteIngress = useCan({ verb: 'delete', group: 'networking.k8s.io', resource: 'ingresses', namespace: vmNs });
  const webServed = web.ingresses !== 'missing';
  const canWeb = !canIngress ? `${NOT_ALLOWED}: a web address creates an Ingress (the hangar-vm-operator role)` : web.loaded && web.classes?.length === 0 ? 'No ingress class on this cluster' : null;
  const wrows = React.useMemo(() => webRows(Array.isArray(web.ingresses) ? web.ingresses : [], ports.services, vm.metadata.name), [web.ingresses, ports.services, vm.metadata.name]);
  const [changes, setChanges] = React.useState<Change[]>([]);
  const [listChangedAt, setListChangedAt] = React.useState<number | null>(null);
  const seq = React.useRef(0);
  const problem = accessProblem(ports.access);
  const vmi = d.idx.vmi.get(key(vm));
  const running = powerState(vm, vmi).kind !== 'off';
  const startedAt = vmi?.metadata?.creationTimestamp ? Date.parse(vmi.metadata.creationTimestamp) : 0;
  const restartDue = listChangedAt !== null && running && startedAt < listChangedAt;
  const hostRows = ports.rows.some(r => r.mode === 'host');
  const publish = () =>
    openDialog(close => (
      <PublishDialog
        vm={vm}
        ports={ports}
        web={webServed ? web : undefined}
        canWeb={canWeb}
        canEditVm={perms.edit}
        onClose={close}
        onSubmit={s => setChanges(c => [...c, { ...s, id: ++seq.current }])}
      />
    ));

  return (
    <Panel
      title="Published ports"
      icon="mdi:door-open"
      dense
      actions={
        <>
          <Button size="small" component={RouterLink} to={hrefFor('networks', 'ports')} sx={{ textTransform: 'none', display: { xs: 'none', md: 'inline-flex' } }}>
            All published ports
          </Button>
          <Tooltip title={!canCreate ? `${NOT_ALLOWED}: publishing creates a Service (the hangar-vm-operator role)` : problem ?? ''}>
            <span>
              <Button size="small" sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:plus" width={16} />} disabled={!canCreate || !!problem} onClick={publish}>
                Publish
              </Button>
            </span>
          </Tooltip>
        </>
      }
    >
      <Box sx={{ display: 'grid', gap: 1, px: 2, pt: problem || ports.access.list.kind !== 'all' || restartDue ? 1.5 : 0 }}>
        {problem && <Note tone={ports.access.state === 'secondary-only' ? 'info' : 'warn'}>{problem}</Note>}
        {ports.access.state === 'ok' && ports.access.list.kind !== 'all' && (
          <Help>
            {ports.access.nic} forwards only the ports in its list ({listText(ports.access.list)}). Hangar adds the ports you publish to it; the guest gets them at its next restart.
          </Help>
        )}
        {restartDue && (
          <Note tone="warn" icon={<Icon icon="mdi:restart-alert" width={16} style={{ flex: 'none', marginTop: 2 }} />}>
            <b>Restart to forward the new ports.</b> The adapter's port list changed: the running VM gets the ports at its next restart.{' '}
            <Button size="small" sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }} onClick={() => A.restart(vm).catch(() => undefined)}>
              Restart now
            </Button>
          </Note>
        )}
      </Box>
      {ports.access.secondary.some(s => s.ips.length) && (
        <Box sx={{ px: 2, py: 1, fontSize: 13.5, color: t.muted }}>
          {ports.access.secondary
            .filter(s => s.ips.length)
            .map(s => (
              <Box key={s.nic}>
                Reachable directly at <b style={{ color: t.text }}>{s.ips.join(', ')}</b> on {s.network.split('/').pop()} ({s.nic}): no Service needed.
              </Box>
            ))}
        </Box>
      )}
      {changes.map(c => (
        <ChangeLine
          key={c.id}
          change={c}
          onVmChanged={() => setListChangedAt(Date.now())}
          onSettled={() => {
            ports.world.refresh();
            web.refresh();
          }}
          onGone={() => setChanges(cs => cs.filter(x => x.id !== c.id))}
        />
      ))}
      {ports.rows.map(r => (
        <PortLine key={r.key} row={r} vm={vm} ports={ports} canChange={canPatch && canDelete} canEditVm={perms.edit} onVmChanged={() => setListChangedAt(Date.now())} />
      ))}
      {wrows.map(r => (
        <WebLine key={r.key} row={r} vm={vm} ports={ports} web={web} canDelete={canDeleteIngress} />
      ))}
      {!ports.rows.length && !wrows.length && !changes.length && !problem && (
        <Box sx={{ px: 2, py: 1.5, fontSize: 14, color: t.muted, borderTop: `1px solid ${t.rule}` }}>
          {ports.world.loaded
            ? ports.world.denied.services
              ? 'Your role cannot list Services in this folder: published ports cannot be shown.'
              : 'Nothing published: the VM is reachable only from its own pod. Publish SSH, RDP or a web port to reach it from the cluster, the hosts or the LAN.'
            : 'Reading the Services…'}
        </Box>
      )}
      {hostRows && (
        <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
          <FirewalldNote />
        </Box>
      )}
      {ports.selector.viaTemplate && (
        <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
          <Help>This KubeVirt (before v1.7) has no pod label for Services: Hangar's Services select its own template label, which reaches the pod at the VM's next start.</Help>
        </Box>
      )}
    </Panel>
  );
}

function listText(list: VmPorts['access']['list']): string {
  if (list.kind === 'ports') return list.ports.map(p => `${p.port}/${(p.protocol ?? 'TCP').toUpperCase()}`).join(', ');
  if (list.kind === 'ranges') return list.ranges.map(r => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`) + `/${r.protocol.toUpperCase()}`).join(', ');
  return 'all';
}

/** A change from the publish dialog, on its own row until the Service shows it. */
function ChangeLine({ change, onVmChanged, onSettled, onGone }: { change: Change; onVmChanged: () => void; onSettled: () => void; onGone: () => void }) {
  const t = useTokens();
  const row = useRowChange<Change>();
  const [result, setResult] = React.useState<{ service?: Obj; ingress?: Obj; vmChanged: boolean } | null>(null);
  const started = React.useRef(false);
  const isWeb = !!change.web;
  const mode = change.req?.mode ?? 'cluster';
  const m = isWeb ? { label: 'At a web address' } : modeInfo(mode);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    row.run(change, async () => {
      try {
        const r = change.web ? await publishWeb(change.web) : await publishPorts(change.req!);
        setResult(r);
        if (r.vmChanged) onVmChanged();
      } finally {
        onSettled();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Done shows for a few seconds (a failure until dismissed); then the Service's own row takes over.
  const seen = React.useRef(false);
  if (row.state.phase !== 'idle') seen.current = true;
  React.useEffect(() => {
    if (row.state.phase === 'idle' && seen.current) onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.state.phase]);
  const svc = result?.service;
  const nodePorts = svc && change.req ? ((svc.spec?.ports ?? []) as any[]).filter(p => change.req!.ports.some(x => x.port === p.port && x.protocol === (p.protocol ?? 'TCP'))).map(p => p.nodePort).filter(Boolean) : [];
  const done = isWeb
    ? `Published ${change.label}: the ingress routes it to the VM.`
    : mode === 'host'
      ? `Published ${change.label} on every host's port ${nodePorts.join(', ')}.`
      : mode === 'address'
      ? `Published ${change.label}: the Service waits for its address.`
      : `Published ${change.label} at ${svc?.metadata.name}.${svc?.metadata.namespace}.svc.`;
  return (
    <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, fontSize: 14 }}>
        <Icon icon={isWeb ? 'mdi:web' : MODE_ICON[mode]} width={18} style={{ color: t.muted, flex: 'none' }} />
        <b>{change.label}</b>
        <Box sx={{ color: t.muted }}>{m.label.toLowerCase()}</Box>
        <Box sx={{ flex: 1 }} />
        {row.state.phase === 'failed' && <IconAction icon="mdi:close" label="Dismiss" onClick={() => row.clear()} />}
      </Box>
      <RowStatus
        state={row.state}
        sx={{ mt: 0.25, ml: 3.75 }}
        pending={`Publishing ${m.label.toLowerCase()}${(change.req ?? change.web)?.listAdd ? ", then adding to the adapter's port list" : ''}…`}
        done={
          <>
            {done}
            {result?.vmChanged ? " Added to the adapter's port list: the guest gets it at the next restart." : ''}
          </>
        }
        failed={`Not published: ${errorText(row.state.error)}`}
      />
    </Box>
  );
}

function PortLine({ row, vm, ports, canChange, canEditVm, onVmChanged }: { row: PortRow; vm: VM; ports: VmPorts; canChange: boolean; canEditVm: boolean; onVmChanged: () => void }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const change = useRowChange<'remove' | 'forward'>();
  const live = rowLive(row, ports.world, ports.pools, ports.vmOn);
  const copy = rowCopyLine(row, d.nodes, live.lb, ports.user, ports.access.ipv6);
  const guestPort = typeof row.guest === 'number' ? { port: row.guest, protocol: row.protocol as Proto } : null;
  const notForwarded = guestPort && (row.protocol === 'TCP' || row.protocol === 'UDP') ? missingFromList(ports.access.list, [guestPort]).length > 0 : false;
  const hosts = row.mode === 'host' && row.nodePort ? hostAddresses(d.nodes, ports.access.ipv6) : [];
  const svc = row.service;
  const remove = async () => {
    const ok = await confirm({
      title: `Unpublish ${row.name ?? row.port} (${row.guest}/${row.protocol})?`,
      body: <p>It is no longer reachable {modeInfo(row.mode).label.toLowerCase()}. {row.mode === 'host' ? 'Its host port goes back to the cluster.' : ''}</p>,
      confirm: 'Unpublish',
      danger: true,
    });
    if (ok) await change.run('remove', () => unpublishPort(row, vm).finally(ports.world.refresh));
  };
  return (
    <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', fontSize: 14 }}>
        <Icon icon={MODE_ICON[row.mode]} width={18} style={{ color: t.muted, flex: 'none' }} />
        <Box sx={{ minWidth: 120 }}>
          <b>{row.name ?? `port ${row.port}`}</b>{' '}
          <Box component="span" sx={{ color: t.muted, ...tabular }}>
            {row.guest}/{row.protocol}
          </Box>
        </Box>
        <Box sx={{ flex: '1 1 200px', minWidth: 0, ...tabular }}>
          <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={whereText(row, live.lb)}>
            {whereText(row, live.lb)}
          </Box>
        </Box>
        <Box sx={{ fontSize: 13 }}>
          <LiveLabel tone={live.tone}>{live.text}</LiveLabel>
        </Box>
        {!row.managed && <Tag tone="muted">Made outside Hangar</Tag>}
        {copy && <CopyButton text={copy} label={`Copy how to reach ${row.name ?? row.port}`} />}
        {row.managed && (
          <IconAction icon="mdi:delete-outline" label={canChange ? `Unpublish ${row.name ?? row.port}` : NOT_ALLOWED} disabled={!canChange || change.state.phase === 'pending'} onClick={remove} />
        )}
      </Box>
      <Box sx={{ ml: 3.75, mt: 0.25, display: 'grid', gap: 0.25, fontSize: 12.5, color: t.muted, ...tabular }}>
        {row.mode === 'cluster' && <Box>Cluster IP {svc.spec?.clusterIP && svc.spec.clusterIP !== 'None' ? svc.spec.clusterIP : 'none (headless)'}, from pods and VMs of the cluster only</Box>}
        {row.mode === 'host' && hosts.length > 0 && (
          <Box>
            {hosts
              .slice(0, 4)
              .map(h => `${h.ip.includes(':') ? `[${h.ip}]` : h.ip}:${row.nodePort}`)
              .join(', ')}
            {hosts.length > 4 ? `, and ${hosts.length - 4} more` : ''}
          </Box>
        )}
        {live.lb && <LbLine lb={live.lb} svc={svc} />}
        {svc.spec?.externalTrafficPolicy === 'Local' && <Box>Keeps the client's address: only the host the VM runs on answers.</Box>}
        {!row.managed && <Box>Service {svc.metadata.name} selects this VM: change it where it was made.</Box>}
        {k8s && row.managed && (
          <Box>
            <K8sName>
              service/{svc.metadata.name} port {row.port}
              {row.nodePort ? ` nodePort ${row.nodePort}` : ''}
            </K8sName>
          </Box>
        )}
        {notForwarded && (
          <Box sx={{ color: '#B7791F' }}>
            Not in {ports.access.nic}'s port list: the guest does not get it.{' '}
            {canEditVm && guestPort && (
              <Button
                size="small"
                sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline', fontSize: 12.5 }}
                disabled={change.state.phase === 'pending'}
                onClick={() =>
                  change.run('forward', async () => {
                    await forwardToGuest(vm, ports.access.nic as string, [guestPort]);
                    onVmChanged();
                    ports.world.refresh();
                  })
                }
              >
                Add it (next restart)
              </Button>
            )}
          </Box>
        )}
      </Box>
      <RowStatus
        state={change.state}
        sx={{ ml: 3.75, mt: 0.25 }}
        pending={change.state.want === 'forward' ? "Adding to the adapter's port list…" : 'Unpublishing…'}
        done={change.state.want === 'forward' ? 'Added: the guest gets it at the next restart.' : 'Unpublished.'}
        failed={`${change.state.want === 'forward' ? 'Not added' : 'Not unpublished'}: ${errorText(change.state.error)}`}
      />
    </Box>
  );
}
