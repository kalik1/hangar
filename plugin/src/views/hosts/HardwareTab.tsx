/*
 * A host's hardware, like the PCI and USB lists of a classic hypervisor:
 * every device with its driver, IOMMU group and who has it, and the
 * actions that give a device to VMs or back to the host. The node agent
 * reads the host; KubeVirt's device mappings say what VMs can ask for.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { kreq } from '../../api/client';
import { useHangar } from '../../api/data';
import * as H from '../../api/hardware';
import { NOT_ALLOWED, useCan } from '../../api/permissions';
import {
  availability,
  canPassThrough,
  diskFree,
  iommuOn,
  mappingForPci,
  mappingForUsb,
  mappingsOf,
  passthroughEnabled,
  PCI_KINDS,
  PciDevice,
  pciKind,
  pciKindLabel,
  pciName,
  pciState,
  pciVendor,
  pvForDisk,
  usbName,
  usbVendor,
  withDeviceKinds,
} from '../../model/hardware';
import { Obj } from '../../model/types';
import { formatAge, formatBytes } from '../../model/units';
import { hrefFor } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { confirm, openDialog } from '../../ui/dialogs';
import { Empty, K8sName, KV, Panel, Tag } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { DeviceStateLabel, GiveDiskDialog, GivePciDialog, MdevMappingDialog, NoAgent, UsbMappingDialog } from '../devices/parts';
import { Note } from '../storage/parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

function useHandlerStart(kv: Obj | null, host: string): number | null {
  const [at, setAt] = React.useState<number | null>(null);
  React.useEffect(() => {
    let alive = true;
    const ns = kv?.metadata.namespace ?? 'kubevirt';
    const run = () =>
      kreq<{ items: Obj[] }>(`/api/v1/namespaces/${ns}/pods`, { query: { labelSelector: 'kubevirt.io=virt-handler', fieldSelector: `spec.nodeName=${host}` } })
        .then(r => {
          const p = (r.items ?? []).find(x => x.status?.phase === 'Running');
          const s = p?.status?.containerStatuses?.[0]?.state?.running?.startedAt ?? p?.status?.startTime;
          if (alive) setAt(s ? Date.parse(s) : null);
        })
        .catch(() => undefined);
    run();
    const id = window.setInterval(run, 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [kv?.metadata.namespace, host]);
  return at;
}

/** Summary | Hardware, under the host's title. */
export function HostTabs({ name, tab }: { name: string; tab?: string }) {
  const t = useTokens();
  const history = useHistory();
  const current = tab === 'hardware' ? 'hardware' : 'summary';
  return (
    <Box sx={{ borderBottom: `1px solid ${t.rule}`, mt: -1 }}>
      <Tabs
        value={current}
        onChange={(_, v) => history.push(hrefFor('host', name, v === 'summary' ? undefined : v))}
        aria-label={`${name} sections`}
        sx={{ minHeight: 40, '& .MuiTab-root': { minHeight: 40, textTransform: 'none', fontSize: 14, minWidth: 0, px: 2 } }}
      >
        <Tab value="summary" label="Summary" />
        <Tab value="hardware" label="Hardware" />
      </Tabs>
    </Box>
  );
}

function Cell({ children, sub, mono }: { children: React.ReactNode; sub?: React.ReactNode; mono?: boolean }) {
  const t = useTokens();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ fontSize: 13.5, ...(mono ? { fontFamily: t.font.mono, fontSize: 12.5, whiteSpace: 'nowrap' } : { overflowWrap: 'anywhere' }) }}>{children}</Box>
      {sub && <Box sx={{ fontSize: 12, color: t.muted, overflowWrap: 'anywhere' }}>{sub}</Box>}
    </Box>
  );
}

function Table({ head, children, label }: { head: React.ReactNode[]; children: React.ReactNode; label: string }) {
  const t = useTokens();
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box
        component="table"
        aria-label={label}
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13.5,
          ...tabular,
          '& th': { textAlign: 'left', color: t.muted, fontWeight: 600, fontSize: 12.5, px: 2, py: 0.75, whiteSpace: 'nowrap' },
          '& td': { px: 2, py: 0.75, borderTop: `1px solid ${t.rule}`, verticalAlign: 'top' },
        }}
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </Box>
    </Box>
  );
}

export function HardwareTab({ host }: { host: string }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const agents = H.useInventories(15000);
  const kv = H.useKubevirt(d.kubevirt);
  const mappings = withDeviceKinds(
    mappingsOf(kv),
    [...agents.hosts.values()].flatMap(r => (r.inv ? [r.inv] : []))
  );
  const reading = agents.hosts.get(host);
  const inv = reading?.inv;
  const handlerStart = useHandlerStart(kv, host);
  const [showBridges, setShowBridges] = React.useState(false);
  const kvNs = kv?.metadata.namespace ?? 'kubevirt';
  const canBind = useCan({ verb: 'update', group: '', resource: 'configmaps', namespace: H.AGENT_NS });
  const canMap = useCan({ verb: 'update', group: 'kubevirt.io', resource: 'kubevirts', namespace: kvNs });
  const canReload = useCan({ verb: 'delete', group: '', resource: 'pods', namespace: kvNs });
  const canDisk = useCan({ verb: 'create', group: '', resource: 'persistentvolumes' });
  const pvs = H.useHostDiskVolumes(true);

  if (!agents.loaded) return <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>Reading the host…</Box>;
  if (agents.missing || agents.denied)
    return (
      <Panel>
        <NoAgent denied={agents.denied} />
      </Panel>
    );
  if (!inv)
    return (
      <Empty icon="mdi:chip" title="The host agent does not answer on this host">
        {reading?.error ?? 'No hangar-node-agent pod runs here yet. It starts on every host; a new host may need a minute.'}
      </Empty>
    );

  const ready = inv.pci.filter(p => p.driver === 'vfio-pci');
  const used = inv.pci.filter(p => p.usedBy);
  const stale = !!inv.lastBind && !!handlerStart && inv.lastBind * 1000 > handlerStart + 2000;
  const gate = passthroughEnabled(kv);
  const bindWhy = !canBind ? NOT_ALLOWED : !canMap ? NOT_ALLOWED : !canReload ? `${NOT_ALLOWED}: restarting KubeVirt's agent on the host` : undefined;

  const give = (p: PciDevice) => kv && openDialog(close => <GivePciDialog host={host} inv={inv} device={p} mappings={mappings} kv={kv} onClose={close} />);
  const giveBack = async (p: PciDevice) => {
    const ok = await confirm({
      title: `Give ${pciName(p)} back to the host?`,
      body: (
        <>
          <p>The host's own driver takes it again, and VMs can no longer get it on {host.split('.')[0]}.</p>
          <p>VMs that ask for it still start where another one is free.</p>
        </>
      ),
      confirm: 'Give back to the host',
    });
    if (ok) quiet(H.returnPciToHost({ kv, host, devices: [p], title: `Give ${p.address} back to the host` }));
  };

  const rowsByKind = new Map<string, PciDevice[]>();
  for (const p of inv.pci) {
    const k = pciKind(p.class);
    rowsByKind.set(k, [...(rowsByKind.get(k) ?? []), p]);
  }

  const pciRow = (p: PciDevice) => {
    const s = pciState(p);
    const m = mappingForPci(mappings, p);
    const pass = canPassThrough(inv, p);
    const vfs = inv.pci.filter(x => x.physfn === p.address).length;
    const owned = p.desired || p.managed;
    let action: React.ReactNode = null;
    if (s.kind === 'assigned') action = null;
    else if (p.driver === 'vfio-pci' && owned)
      action = (
        <Button size="small" color="inherit" sx={{ textTransform: 'none' }} disabled={!canBind} title={canBind ? undefined : NOT_ALLOWED} onClick={() => giveBack(p)}>
          Give back to host
        </Button>
      );
    else if (s.kind !== 'preparing' && s.kind !== 'returning')
      action = (
        <span title={!pass.ok ? pass.why : bindWhy}>
          <Button size="small" variant="outlined" sx={{ textTransform: 'none', whiteSpace: 'nowrap' }} disabled={!pass.ok || !!bindWhy || !kv} onClick={() => give(p)}>
            {p.driver === 'vfio-pci' ? 'Manage for VMs' : 'Give to VMs'}
          </Button>
        </span>
      );
    return (
      <React.Fragment key={p.address}>
        <tr>
          <td>
            <Cell
              sub={
                <>
                  {pciVendor(p)} · {pciKindLabel(p)}
                  {p.physfn ? ` · virtual function of ${p.physfn}` : ''}
                  {(p.sriovTotalVfs ?? 0) > 0 ? ` · SR-IOV: ${p.sriovNumVfs ?? 0} of ${p.sriovTotalVfs} virtual functions on` : ''}
                  {vfs && !(p.sriovTotalVfs ?? 0) ? ` · ${vfs} virtual functions` : ''}
                </>
              }
            >
              <Box component="span" sx={{ pl: p.physfn ? 2 : 0 }}>
                {pciName(p)}
              </Box>
            </Cell>
          </td>
          <td>
            <Cell mono sub={`${p.vendor}:${p.device}`}>
              {p.address}
            </Cell>
          </td>
          <td>
            <Cell sub={p.iommuGroup !== null ? `IOMMU group ${p.iommuGroup}` : 'No IOMMU group'}>{p.driver ?? '—'}</Cell>
          </td>
          <td>
            <DeviceStateLabel
              state={s}
              sub={
                p.driver === 'vfio-pci'
                  ? m
                    ? `Mapping ${m.label}`
                    : 'In no mapping: VMs cannot ask for it'
                  : !pass.ok && s.kind !== 'failed'
                  ? pass.why
                  : undefined
              }
            />
          </td>
          <Box component="td" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
            {action}
          </Box>
        </tr>
        {p.mdevTypes.length > 0 && (
          <tr>
            <td colSpan={5} style={{ borderTop: 'none', paddingTop: 0 }}>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, color: t.muted }}>
                vGPU profiles:
                {p.mdevTypes.map(mt => {
                  const mapped = mappings.find(x => x.kind === 'mdev' && x.selector.replace(/\s+/g, '_') === (mt.name || mt.id).replace(/\s+/g, '_'));
                  return (
                    <Box key={mt.id} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      <Tag tone={mapped ? 'accent' : undefined}>
                        {mt.name || mt.id} · {mt.available ?? '?'} free
                      </Tag>
                      {!mapped && kv && (
                        <Button size="small" sx={{ textTransform: 'none', minWidth: 0 }} disabled={!canMap} onClick={() => openDialog(close => <MdevMappingDialog host={host} parent={p} type={mt} mappings={mappings} kv={kv} onClose={close} />)}>
                          Offer
                        </Button>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  const vmsUsingClaim = (ns: string, claim: string) =>
    d.vms.filter(v => v.metadata.namespace === ns && (v.spec?.template?.spec?.volumes ?? []).some((x: any) => x.persistentVolumeClaim?.claimName === claim));

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Panel
        title="Passthrough"
        icon="mdi:expansion-card-variant"
        actions={
          <>
            <Box component="span" sx={{ fontSize: 12.5, color: t.muted }}>
              Read {formatAge(inv.generated)} ago
            </Box>
            <Button size="small" sx={{ textTransform: 'none' }} onClick={() => H.refreshInventories()} startIcon={<Icon icon="mdi:refresh" width={16} />}>
              Refresh
            </Button>
            <span title={canReload ? "Restarts KubeVirt's agent on this host so it lists the devices again. Running VMs are not affected." : NOT_ALLOWED}>
              <Button size="small" sx={{ textTransform: 'none' }} disabled={!canReload} onClick={() => quiet(H.reloadDevices(kv, host))}>
                Reload devices
              </Button>
            </span>
          </>
        }
      >
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {!iommuOn(inv) && (
            <Note tone="warn">
              The IOMMU is off on this host, so no device can go to a VM. Turn on VT-d (Intel) or AMD-Vi in the firmware, add{' '}
              <code>intel_iommu=on iommu=pt</code> or <code>amd_iommu=on iommu=pt</code> to the kernel arguments, and restart the host.
            </Note>
          )}
          {stale && (
            <Note tone="warn">
              Devices were prepared after KubeVirt's agent started on this host: VMs may not get them yet.{' '}
              <Button size="small" sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }} disabled={!canReload} onClick={() => quiet(H.reloadDevices(kv, host))}>
                Reload devices
              </Button>
            </Note>
          )}
          {!gate && kv && (
            <Note tone="warn">
              Device passthrough is off in KubeVirt.{' '}
              <Button size="small" sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }} disabled={!canMap} onClick={() => quiet(H.turnOnPassthrough(kv))}>
                Turn it on
              </Button>
            </Note>
          )}
          <KV
            rows={[
              ['IOMMU', iommuOn(inv) ? `On, ${inv.iommuGroups} groups` : 'Off'],
              ['Ready for VMs', ready.length ? `${ready.length} device${ready.length === 1 ? '' : 's'}, ${used.length} in use` : 'None yet'],
              [
                'Mappings here',
                mappings.length
                  ? mappings
                      .map(m => ({ m, a: availability(m.resourceName, d.nodes.filter(n => n.metadata.name === host), d.launchers)[0] }))
                      .filter(x => x.a)
                      .map(x => `${x.m.label}: ${x.a.free} free of ${x.a.total}`)
                      .join(' · ') || 'None of the mappings has a device on this host'
                  : 'No device mappings yet',
              ],
              ['Kernel', <>{inv.kernel}{k8s && <> <K8sName>agent {inv.agent}</K8sName></>}</>],
            ]}
          />
        </Box>
      </Panel>

      {PCI_KINDS.filter(k => k.kind !== 'bridge' || showBridges).map(k => {
        const rows = rowsByKind.get(k.kind) ?? [];
        if (!rows.length) return null;
        return (
          <Panel key={k.kind} title={`${k.label} (${rows.length})`} icon={k.icon} dense>
            <Table label={k.label} head={['Device', 'Address', 'Driver', 'State', '']}>
              {rows.map(pciRow)}
            </Table>
          </Panel>
        );
      })}
      <FormControlLabel
        sx={{ m: 0, mt: -1 }}
        control={<Switch size="small" checked={showBridges} onChange={e => setShowBridges(e.target.checked)} />}
        label={<Box sx={{ fontSize: 13 }}>Show bridges and chipset devices ({rowsByKind.get('bridge')?.length ?? 0})</Box>}
      />

      <Panel title={`USB devices (${inv.usb.length})`} icon="mdi:usb" dense>
        {inv.usb.length === 0 ? (
          <Box sx={{ p: 2, color: t.muted, fontSize: 14 }}>No USB devices are plugged in.</Box>
        ) : (
          <Table label="USB devices" head={['Device', 'Port', 'Kind', 'State', '']}>
            {inv.usb.map(u => {
              const m = mappingForUsb(mappings, u);
              return (
                <tr key={u.path}>
                  <td>
                    <Cell sub={`${usbVendor(u)}${u.serial ? ` · serial ${u.serial}` : ''}`}>{usbName(u)}</Cell>
                  </td>
                  <td>
                    <Cell mono sub={`${u.vendor}:${u.product}`}>
                      {u.path}
                    </Cell>
                  </td>
                  <td>
                    <Cell sub={u.speed ? `${u.speed} Mb/s` : undefined}>{u.interfaceClassNames.join(', ') || u.className || '—'}</Cell>
                  </td>
                  <td>
                    {u.usedBy ? (
                      <DeviceStateLabel state={{ kind: 'assigned', vm: u.usedBy, label: '' }} />
                    ) : m ? (
                      <DeviceStateLabel state={{ kind: 'ready', label: `Offered as ${m.label}` }} sub="The host keeps it until a VM takes it" />
                    ) : (
                      <DeviceStateLabel state={{ kind: 'host', label: u.drivers.length ? `Host driver ${u.drivers.join(', ')}` : 'Host', driver: '' }} />
                    )}
                  </td>
                  <Box component="td" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {!m && !u.usedBy && kv && (
                      <span title={canMap ? undefined : NOT_ALLOWED}>
                        <Button size="small" variant="outlined" sx={{ textTransform: 'none' }} disabled={!canMap} onClick={() => openDialog(close => <UsbMappingDialog host={host} usb={u} mappings={mappings} kv={kv} onClose={close} />)}>
                          Offer to VMs
                        </Button>
                      </span>
                    )}
                  </Box>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>

      <Panel title={`Disks (${inv.disks.length})`} icon="mdi:harddisk" dense>
        <Table label="Disks" head={['Disk', 'Size', 'Connection', 'State', '']}>
          {inv.disks.map(b => {
            const free = diskFree(b);
            const pv = pvForDisk(pvs, host, b);
            const claim = pv?.spec?.claimRef;
            const users = claim ? vmsUsingClaim(claim.namespace, claim.name) : [];
            return (
              <tr key={b.name}>
                <td>
                  <Cell sub={[b.vendor, b.model].filter(Boolean).join(' ') + (b.serial ? ` · serial ${b.serial}` : '')}>{b.name}</Cell>
                </td>
                <td>{formatBytes(b.sizeBytes ?? 0)}</td>
                <td>
                  <Cell sub={b.controller ?? undefined}>
                    {b.transport}
                    {b.rotational && b.transport !== 'cdrom' ? ', rotating' : ''}
                  </Cell>
                </td>
                <td>
                  {pv ? (
                    users.length ? (
                      <DeviceStateLabel state={{ kind: 'assigned', vm: `${users[0].metadata.namespace}/${users[0].metadata.name}`, label: '' }} sub="Given whole to the VM" />
                    ) : (
                      <DeviceStateLabel state={{ kind: 'ready', label: 'Set aside for VMs' }} sub={claim ? `Disk ${claim.name} in ${claim.namespace}, attached to no VM` : undefined} />
                    )
                  ) : free.ok ? (
                    <DeviceStateLabel state={{ kind: 'idle', label: 'Free' }} />
                  ) : (
                    <DeviceStateLabel state={{ kind: 'host', label: 'Used by the host', driver: '' }} sub={free.why} />
                  )}
                  {k8s && pv && <K8sName>pv/{pv.metadata.name}</K8sName>}
                </td>
                <Box component="td" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {pv && !users.length && (
                    <Button
                      size="small"
                      color="inherit"
                      sx={{ textTransform: 'none' }}
                      onClick={async () => {
                        const ok = await confirm({ title: `Take ${b.name} back?`, body: <p>Hangar forgets the disk; the data on it stays.</p>, confirm: 'Take back' });
                        if (ok) quiet(H.releaseHostDisk({ host, pv }));
                      }}
                    >
                      Take back
                    </Button>
                  )}
                  {!pv && free.ok && (
                    <span title={canDisk ? undefined : NOT_ALLOWED}>
                      <Button size="small" variant="outlined" sx={{ textTransform: 'none' }} disabled={!canDisk} onClick={() => openDialog(close => <GiveDiskDialog host={host} disk={b} vms={d.vms} onClose={close} />)}>
                        Give to a VM
                      </Button>
                    </span>
                  )}
                </Box>
              </tr>
            );
          })}
        </Table>
      </Panel>
      <Box sx={{ fontSize: 12.5, color: t.muted, display: 'flex', gap: 0.75, alignItems: 'center' }}>
        <Led tone="on" size={7} /> ready for VMs or in use · <Led tone="busy" size={7} /> changing · <Led tone="off" size={7} /> with the host
      </Box>
    </Box>
  );
}

