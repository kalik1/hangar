/*
 * Datacenter settings: what Proxmox keeps under Datacenter → Options and
 * vSphere under the cluster's Configure tab.
 *   Features         — KubeVirt's feature gates in plain words: on or off,
 *                      how mature, what they unlock in Hangar, the cluster
 *                      settings some of them need; turn them on and off.
 *   Delete protection — whether the admission policy that enforces
 *                      Configure → Options → Protection is installed, and
 *                      what it protects.
 * Deep links: /hangar/settings/<section>[/<gate>] (the gate is highlighted).
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import { HangarData, useHangar } from '../../api/data';
import { setFeatureGate, useCanPatchKubevirt, useK4all } from '../../api/gates';
import { NOT_ALLOWED } from '../../api/permissions';
import { useProtectionPolicy } from '../../api/protection';
import {
  clusterSettings,
  GateArea,
  gateProblems,
  GateRow,
  gateRows,
  GateState,
  gateTable,
  HOTPLUG_DECLARATIVE,
  HOTPLUG_OLD,
  kubevirtVersion,
  listedGates,
  nextGates,
  vmStateAccess,
  vmStateDatastore,
  vmsUsingGate,
} from '../../model/gates';
import { isProtected, PROTECTED_LABEL, PROTECTION_POLICY, PROTECTION_POLICY_URL } from '../../model/protection';
import { Obj } from '../../model/types';
import { EVICTION_LABELS, key } from '../../model/vm';
import { hrefFor, vmHref } from '../../shell/nav';
import { useK8s } from '../../shell/settings';
import { confirm } from '../../ui/dialogs';
import { K8sName, Panel, Tag } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { LedTone, tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';

const quiet = (p: Promise<unknown>) => p.catch(() => undefined);

export const SETTINGS_SECTIONS = ['features', 'protection'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const LABELS: Record<SettingsSection, { label: string; icon: string }> = {
  features: { label: 'Features', icon: 'mdi:toggle-switch-outline' },
  protection: { label: 'Delete protection', icon: 'mdi:shield-lock-outline' },
};

const AREAS: { id: GateArea; title: string; icon: string }[] = [
  { id: 'disks', title: 'Disks and snapshots', icon: 'mdi:harddisk' },
  { id: 'devices', title: 'Devices', icon: 'mdi:expansion-card-variant' },
  { id: 'sharing', title: 'Sharing with the guest', icon: 'mdi:folder-network-outline' },
  { id: 'compute', title: 'CPU, memory and firmware', icon: 'mdi:chip' },
  { id: 'network', title: 'Network', icon: 'mdi:ethernet' },
];

export function settingsSection(a?: string): SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(a ?? '') ? (a as SettingsSection) : 'features';
}

export function SettingsView({ section: raw, focus }: { section?: string; focus?: string }) {
  const d = useHangar();
  const t = useTokens();
  const history = useHistory();
  const section = settingsSection(raw);
  const kv = d.kubevirt;
  const version = kubevirtVersion(kv);
  const rows = gateRows(kv);
  const onCount = [...rows.hangar, ...rows.listedOther].filter(r => r.on).length;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          <Icon icon="mdi:cog-outline" width={22} style={{ verticalAlign: -3, marginRight: 8, color: t.muted }} />
          Datacenter settings
        </Typography>
        <Typography sx={{ color: t.muted, fontSize: 14, ...tabular }}>
          {kv ? `KubeVirt ${version ?? '(version unknown)'}, ${onCount} of ${rows.hangar.length + rows.listedOther.length} features on` : 'KubeVirt is not readable'}
        </Typography>
      </Box>
      <Box sx={{ borderBottom: `1px solid ${t.rule}`, px: 1 }}>
        <Tabs
          value={section}
          onChange={(_, v: SettingsSection) => history.push(hrefFor('settings', v))}
          aria-label="Settings sections"
          variant="scrollable"
          scrollButtons={false}
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, textTransform: 'none', fontSize: 14, minWidth: 0, px: 2 } }}
        >
          {SETTINGS_SECTIONS.map(s => (
            <Tab
              key={s}
              value={s}
              id={`hangar-settings-tab-${s}`}
              aria-controls={`hangar-settings-panel-${s}`}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <Icon icon={LABELS[s].icon} width={17} />
                  {LABELS[s].label}
                </Box>
              }
            />
          ))}
        </Tabs>
      </Box>
      <Box role="tabpanel" id={`hangar-settings-panel-${section}`} aria-labelledby={`hangar-settings-tab-${section}`} sx={{ p: 2, flex: 1 }}>
        {section === 'features' && <Features d={d} focus={focus} />}
        {section === 'protection' && <Protection d={d} />}
      </Box>
    </Box>
  );
}

/* --------------------------------------------------------------- features */

function stateOf(r: GateState): { tone: LedTone; text: string } {
  if (r.maturity === 'GA') return { tone: 'on', text: 'Always on' };
  if (r.maturity === 'Discontinued') return { tone: 'off', text: 'Removed' };
  if (r.on === true) return { tone: 'on', text: 'On' };
  if (r.on === false) return { tone: r.listed ? 'standby' : 'off', text: 'Off' };
  return { tone: 'off', text: 'Unknown' };
}

function MaturityTag({ m }: { m: GateState['maturity'] }) {
  if (!m) return <Tag>maturity unknown</Tag>;
  const words: Record<string, string> = { GA: 'GA', Beta: 'Beta', Alpha: 'Alpha, experimental', Deprecated: 'Deprecated', Discontinued: 'Discontinued' };
  return <Tag tone={m === 'Alpha' || m === 'Deprecated' ? 'warn' : m === 'GA' ? 'accent' : undefined}>{words[m]}</Tag>;
}

async function toggleGate(d: HangarData, kv: Obj, r: GateRow, on: boolean, k4all: boolean) {
  const { removed } = nextGates(listedGates(kv), r.name, on);
  // VMs that lose a feature: this gate's when turning it off, the rival's when turning this one on.
  const losing = on ? removed : [r.name];
  const users = losing.flatMap(g => vmsUsingGate(d.vms, g));
  const what = r.feature?.unlocks ?? r.name;
  const ok = await confirm({
    title: `${on ? 'Turn on' : 'Turn off'} ${r.name}?`,
    body: (
      <>
        <p>
          <b>{what}</b>: {on ? 'on' : 'off'} for the whole datacenter.
        </p>
        <p>
          Hangar {on ? 'adds' : 'removes'} <code>{r.name}</code> {on ? 'to' : 'from'} the feature gates of the KubeVirt resource; the other gates stay as they are.
        </p>
        {on && r.maturity === 'Alpha' && (
          <p>
            <b>Alpha features are experimental:</b> KubeVirt may change or drop them in a later release, and they are not meant for production.
          </p>
        )}
        {on && r.maturity === 'Beta' && <p>Beta: tested and on its way to GA, but its details may still change.</p>}
        {on && r.feature?.note && <p>{r.feature.note}</p>}
        {removed.length > 0 && (
          <p>
            <b>{removed.join(', ')}</b> goes off at the same time: KubeVirt cannot use both.
          </p>
        )}
        {users.length > 0 && (
          <p>
            {users.length} VM{users.length > 1 ? 's use' : ' uses'} {on ? removed.join(', ') : 'it'} ({users.slice(0, 5).map(v => v.metadata.name).join(', ')}
            {users.length > 5 ? ', …' : ''}): running ones keep it until they power off, then KubeVirt refuses to start them until it is back on.
          </p>
        )}
        {k4all && <p>On k4all, a coming release manages KubeVirt&apos;s features from its KubeVirt addon; until then the change is made here.</p>}
      </>
    ),
    confirm: on ? 'Turn on' : 'Turn off',
    danger: users.length > 0,
  });
  if (ok) quiet(setFeatureGate(kv, r.name, on));
}

function GateLine({ r, d, kv, canPatch, k4all, focus }: { r: GateRow; d: HangarData; kv: Obj | null; canPatch: boolean; k4all: boolean; focus?: string }) {
  const t = useTokens();
  const k8s = useK8s();
  const ref = React.useRef<HTMLDivElement>(null);
  const focused = focus === r.name;
  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const s = stateOf(r);
  const toggleable = !!kv && r.maturity !== 'GA' && r.maturity !== 'Discontinued' && (r.maturity !== null || r.listed);
  const why = !kv ? 'KubeVirt is not readable' : !canPatch ? NOT_ALLOWED : undefined;
  const users = vmsUsingGate(d.vms, r.name);
  return (
    <Box
      ref={ref}
      id={`gate-${r.name}`}
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr auto', sm: '104px 1fr auto' },
        columnGap: 2,
        rowGap: 0.5,
        alignItems: 'center',
        px: 2,
        py: 1.25,
        borderTop: `1px solid ${t.rule}`,
        '&:first-of-type': { borderTop: 'none' },
        background: focused ? t.selected : undefined,
        transition: 'background 1.2s',
      }}
    >
      <Box sx={{ display: { xs: 'none', sm: 'inline-flex' }, alignItems: 'center', gap: 0.9, fontSize: 13.5 }}>
        <Led tone={s.tone} />
        {s.text}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ fontSize: 14, fontWeight: 600 }}>{r.feature?.unlocks ?? r.name}</Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center', mt: 0.5, fontSize: 12.5, color: t.muted }}>
          <Box sx={{ display: { xs: 'inline-flex', sm: 'none' }, alignItems: 'center', gap: 0.75 }}>
            <Led tone={s.tone} size={8} />
            {s.text}
          </Box>
          <K8sName>{r.name}</K8sName>
          <MaturityTag m={r.maturity} />
          {r.feature && <span>{r.feature.where}</span>}
          {users.length > 0 && <Tag>{users.length} VM{users.length > 1 ? 's use' : ' uses'} it</Tag>}
        </Box>
        {(r.note || (r.feature?.note && r.on !== true)) && <Box sx={{ fontSize: 12.5, color: r.note ? '#B7791F' : t.muted, mt: 0.5 }}>{r.note ?? r.feature?.note}</Box>}
        {k8s && r.listed && r.maturity === 'GA' && <Box sx={{ fontSize: 12.5, color: t.muted, mt: 0.25 }}>Listed in developerConfiguration.featureGates</Box>}
      </Box>
      <Box>
        {toggleable ? (
          <Tooltip title={why ?? (r.on ? `Turn off ${r.name}` : `Turn on ${r.name}`)}>
            <span>
              <Switch
                checked={r.listed}
                disabled={!!why}
                onChange={e => kv && toggleGate(d, kv, r, e.target.checked, k4all)}
                inputProps={{ 'aria-label': `${r.name}: ${r.feature?.unlocks ?? ''}` }}
              />
            </span>
          </Tooltip>
        ) : (
          <Box sx={{ fontSize: 12.5, color: t.muted, textAlign: 'right', width: 58 }}>{r.maturity === 'GA' ? 'built in' : '—'}</Box>
        )}
      </Box>
    </Box>
  );
}

function SettingRow({ label, ok, children, k8sName }: { label: string; ok?: boolean; children: React.ReactNode; k8sName?: string }) {
  const t = useTokens();
  const k8s = useK8s();
  return (
    <Box sx={{ py: 1.1, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none', pt: 0 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, fontSize: 13.5, fontWeight: 600 }}>
        {ok !== undefined && <Led tone={ok ? 'on' : 'standby'} size={8} />}
        {label}
      </Box>
      <Box sx={{ fontSize: 13, color: t.muted, mt: 0.25, lineHeight: 1.5 }}>{children}</Box>
      {k8s && k8sName && (
        <Box sx={{ mt: 0.5 }}>
          <K8sName>{k8sName}</K8sName>
        </Box>
      )}
    </Box>
  );
}

function ClusterSettingsPanel({ d }: { d: HangarData }) {
  const kv = d.kubevirt;
  const c = clusterSettings(kv);
  const state = vmStateDatastore(kv, d.storageClasses);
  const evict = c.evictionStrategy ?? 'None';
  return (
    <Panel title="Settings these features need" icon="mdi:tune-vertical">
      <SettingRow label="KubeVirt may move running VMs" ok={c.liveMigrateUpdates} k8sName={`workloadUpdateStrategy.workloadUpdateMethods: [${c.workloadUpdateMethods.join(', ')}]`}>
        {c.liveMigrateUpdates
          ? 'Yes (LiveMigrate): CPUs and memory can be added while a VM runs, disks move live, KubeVirt updates do not stop VMs.'
          : 'No: adding CPUs or memory and live disk moves wait for a restart. Add LiveMigrate to spec.workloadUpdateStrategy.workloadUpdateMethods of the KubeVirt resource.'}
      </SettingRow>
      <SettingRow label="Changes reach running VMs" ok={c.rollout === 'LiveUpdate'} k8sName={`vmRolloutStrategy: ${c.rollout}${c.rolloutSet ? '' : ' (default)'}`}>
        {c.rollout === 'LiveUpdate'
          ? 'When KubeVirt can (CPU sockets, memory, hot-plug disks, network links, host pinning); the rest at the next restart.'
          : 'Only at the next restart (Stage): no hot-add.'}
      </SettingRow>
      <SettingRow
        label="How far a running VM can grow"
        k8sName={`liveUpdateConfiguration: maxHotplugRatio ${c.maxHotplugRatio}${c.maxCpuSockets ? `, maxCpuSockets ${c.maxCpuSockets}` : ''}${c.maxGuest ? `, maxGuest ${c.maxGuest}` : ''}`}
      >
        Up to {c.maxHotplugRatio}× the CPUs and memory it was powered on with
        {c.maxCpuSockets ? `, at most ${c.maxCpuSockets} sockets` : ''}
        {c.maxGuest ? `, at most ${c.maxGuest} of memory` : ''}, unless the VM sets its own limits (Configure → CPU and memory).
      </SettingRow>
      <SettingRow label="Where UEFI variables and TPM state are kept" ok={state.how !== 'none'} k8sName={`vmStateStorageClass: ${c.vmStateStorageClass ?? '(not set)'}`}>
        {state.how === 'set' && <>On {state.name}, chosen for VM state.</>}
        {state.how === 'virt-default' && <>Not chosen: KubeVirt uses the default VM datastore, {state.name}.</>}
        {state.how === 'default' && <>Not chosen: KubeVirt uses the cluster&apos;s default datastore, {state.name}.</>}
        {state.how === 'none' && <>Not chosen and there is no default datastore: VMs with a persistent TPM or UEFI variables cannot start.</>}
        {state.how !== 'none' && ` Access: ${vmStateAccess(kv, d.storageProfiles, state.name) === 'RWX' ? 'shared (RWX).' : 'one host at a time (RWO): KubeVirt copies the state to a new disk when the VM moves live.'}`}
        {state.how !== 'set' && ' Set spec.configuration.vmStateStorageClass of the KubeVirt resource to a shared (RWX file) datastore to choose.'}
      </SettingRow>
      <SettingRow label="On host maintenance (default)" k8sName={`evictionStrategy: ${c.evictionStrategy ?? '(not set)'}`}>
        {EVICTION_LABELS[evict] ?? evict}. Each VM can choose its own in Configure → Power and availability.
      </SettingRow>
    </Panel>
  );
}

function Features({ d, focus }: { d: HangarData; focus?: string }) {
  const t = useTokens();
  const kv = d.kubevirt;
  const canPatch = useCanPatchKubevirt(kv);
  const k4all = useK4all();
  const [more, setMore] = React.useState(false);
  const rows = gateRows(kv);
  const table = gateTable(kv);
  const problems = gateProblems(kv);
  const focusOther = !!focus && rows.other.some(r => r.name === focus);
  React.useEffect(() => {
    if (focusOther) setMore(true);
  }, [focusOther]);
  if (!kv)
    return (
      <Note tone="warn">
        Hangar cannot read the KubeVirt resource, so it cannot tell which features are on. Your role needs <b>get</b> on <code>kubevirts</code> (hangar-viewer has it).
      </Note>
    );
  const versionLine = table
    ? `Maturity for KubeVirt ${table.version}.x, from the ${table.source}.`
    : `Hangar has no maturity table for KubeVirt ${kubevirtVersion(kv) ?? '(unknown version)'}: maturity is unknown, and features not listed in the KubeVirt resource may still be on (GA).`;
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1.7fr) minmax(300px,1fr)' }, alignItems: 'start' }}>
      <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
        {k4all && (
          <Note icon={<Icon icon="mdi:information-outline" width={16} style={{ marginTop: 2 }} />}>
            This datacenter runs <b>k4all</b>. A coming k4all release manages KubeVirt&apos;s features from its own KubeVirt addon; until then you can turn them on and off here.
          </Note>
        )}
        {problems.map(p => (
          <Note key={p} tone="warn" icon={<Icon icon="mdi:alert-outline" width={16} style={{ marginTop: 2 }} />}>
            {p}
          </Note>
        ))}
        {!table && <Note tone="warn">{versionLine}</Note>}
        {AREAS.map(a => {
          const list = rows.hangar.filter(r => r.feature?.area === a.id);
          if (!list.length) return null;
          return (
            <Panel key={a.id} title={a.title} icon={a.icon} dense>
              {list.map(r => (
                <GateLine key={r.name} r={r} d={d} kv={kv} canPatch={canPatch} k4all={k4all} focus={focus} />
              ))}
            </Panel>
          );
        })}
        {rows.listedOther.length > 0 && (
          <Panel title="Other features listed in KubeVirt" icon="mdi:format-list-bulleted" dense>
            {rows.listedOther.map(r => (
              <GateLine key={r.name} r={r} d={d} kv={kv} canPatch={false} k4all={k4all} focus={focus} />
            ))}
          </Panel>
        )}
        <Panel
          title={`More KubeVirt features (${rows.other.length})`}
          icon="mdi:dots-horizontal-circle-outline"
          dense
          actions={
            <Button size="small" onClick={() => setMore(!more)} sx={{ textTransform: 'none' }} aria-expanded={more}>
              {more ? 'Hide' : 'Show'}
            </Button>
          }
        >
          {more ? (
            rows.other.map(r => <GateLine key={r.name} r={r} d={d} kv={kv} canPatch={false} k4all={k4all} focus={focus} />)
          ) : (
            <Box sx={{ px: 2, py: 1.25, fontSize: 13, color: t.muted }}>
              Features Hangar does not use (security, encryption, other architectures, KubeVirt internals). Hangar shows them, KubeVirt&apos;s administrators decide about them.
            </Box>
          )}
        </Panel>
        {table && <Box sx={{ fontSize: 12.5, color: t.muted }}>{versionLine}</Box>}
      </Box>
      <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <ClusterSettingsPanel d={d} />
        <Panel title="Not in KubeVirt" icon="mdi:information-outline">
          <Box component="ul" sx={{ m: 0, pl: 2.25, fontSize: 13, color: t.muted, lineHeight: 1.6 }}>
            <li>Start and shutdown order or delays between VMs: each VM has its own power policy.</li>
            <li>KVM on or off per VM: KubeVirt always uses KVM (software emulation is a cluster setting, useEmulation).</li>
            <li>SPICE: consoles are VNC and serial.</li>
            <li>Saving a VM&apos;s memory to disk (hibernate): suspend keeps it in memory.</li>
            <li>Disk bandwidth and IOPS limits, SSD emulation: set them on the datastore (StorageClass QoS).</li>
            <li>PCI ROM-Bar, primary GPU (x-vga), vIOMMU, USB hot-plug.</li>
          </Box>
        </Panel>
        <Box sx={{ fontSize: 12.5, color: t.muted }}>
          {HOTPLUG_OLD} and {HOTPLUG_DECLARATIVE} are never on together: turning one on turns the other off.
        </Box>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------- delete protection */

function Protection({ d }: { d: HangarData }) {
  const t = useTokens();
  const k8s = useK8s();
  const { state, recheck } = useProtectionPolicy();
  const vms = d.vms.filter(isProtected);
  // CDI's temporary claims copy the label; they are not the VMs' disks.
  const disks = d.pvcs.filter(p => isProtected(p) && !p.metadata.labels?.['cdi.kubevirt.io/OwnedByUID']);
  const status: { tone: LedTone; title: string; text: React.ReactNode } =
    state === 'installed'
      ? { tone: 'on', title: 'Installed', text: 'Protected VMs and their disks cannot be deleted, from Hangar, kubectl or anything else, until protection is turned off.' }
      : state === 'unbound'
      ? { tone: 'standby', title: 'Installed but not enforced', text: `The policy ${PROTECTION_POLICY} exists, its binding (with the Deny action) does not: nothing is protected.` }
      : state === 'missing'
      ? { tone: 'off', title: 'Not installed', text: 'The protection label alone protects nothing, so Hangar does not offer the switch.' }
      : state === 'unknown'
      ? { tone: 'off', title: 'Hangar cannot tell', text: 'Your role cannot read admission policies. Ask an administrator whether it is installed.' }
      : { tone: 'busy', title: 'Checking', text: '' };
  const cmd = `kubectl apply -f ${PROTECTION_POLICY_URL}`;
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1.4fr) minmax(300px,1fr)' }, alignItems: 'start' }}>
      <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <Panel
          title="Delete protection policy"
          icon="mdi:shield-lock-outline"
          actions={
            <Button size="small" onClick={recheck} sx={{ textTransform: 'none' }} startIcon={<Icon icon="mdi:refresh" width={16} />}>
              Check again
            </Button>
          }
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 15, fontWeight: 600 }}>
            <Led tone={status.tone} />
            {status.title}
          </Box>
          <Typography sx={{ fontSize: 13.5, color: t.muted, mt: 0.75 }}>{status.text}</Typography>
          {(state === 'missing' || state === 'unbound' || state === 'unknown') && (
            <Box sx={{ mt: 1.5 }}>
              <Typography sx={{ fontSize: 13.5, mb: 0.75 }}>A cluster administrator installs it once (Kubernetes 1.30 or later, no webhook to run):</Typography>
              <Box component="pre" sx={{ m: 0, p: 1.25, fontFamily: t.font.mono, fontSize: 12.5, background: t.hover, border: `1px solid ${t.rule}`, borderRadius: `${t.radius.small}px`, overflowX: 'auto' }}>
                {cmd}
              </Box>
              <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.75 }}>
                The file is distribution/protection-policy.yaml in Hangar&apos;s repository: a ValidatingAdmissionPolicy and its binding.
              </Typography>
            </Box>
          )}
          {k8s && (
            <Box sx={{ mt: 1.5, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
              <K8sName>validatingadmissionpolicy/{PROTECTION_POLICY}</K8sName>
              <K8sName>validatingadmissionpolicybinding/{PROTECTION_POLICY}</K8sName>
              <K8sName>{PROTECTED_LABEL}=true</K8sName>
            </Box>
          )}
        </Panel>
        <Panel title={`Protected VMs (${vms.length})`} icon="mdi:server-security" dense>
          {vms.length === 0 && <Box sx={{ px: 2, py: 1.5, fontSize: 13.5, color: t.muted }}>None. Turn protection on in a VM&apos;s Configure → Options.</Box>}
          {vms.map(vm => (
            <Box key={key(vm)} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', px: 2, py: 1, borderTop: `1px solid ${t.rule}`, '&:first-of-type': { borderTop: 'none' }, fontSize: 14 }}>
              <Icon icon="mdi:shield-lock" width={16} style={{ color: t.muted }} />
              <Box component={RouterLink} to={vmHref(vm.metadata.namespace as string, vm.metadata.name, 'configure')} sx={{ color: 'inherit', fontWeight: 600 }}>
                {vm.metadata.name}
              </Box>
              <Box sx={{ color: t.muted, fontSize: 13 }}>{vm.metadata.namespace}</Box>
            </Box>
          ))}
          {disks.length > 0 && (
            <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}`, fontSize: 13, color: t.muted }}>
              {disks.length} disk{disks.length > 1 ? 's' : ''} protected with them.
            </Box>
          )}
        </Panel>
      </Box>
      <Panel title="How it works" icon="mdi:help-circle-outline">
        <Box sx={{ fontSize: 13.5, lineHeight: 1.6, color: t.muted, '& p': { m: 0, mb: 1 } }}>
          <p>Configure → Options → Protection labels the VM and its disks. The policy refuses to delete anything with that label, for every user and tool.</p>
          <p>Deleting a folder (namespace) with a protected VM stops halfway: the folder stays in Terminating until protection is turned off.</p>
          <p>Turning protection off removes the label from the disks first, then from the VM, so a VM never becomes deletable while its disks are not.</p>
          <p>CD/DVD media (copies of library ISOs) are not protected.</p>
        </Box>
      </Panel>
    </Box>
  );
}
