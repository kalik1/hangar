/*
 * New virtual machine: the classic step-by-step wizard. Name and folder,
 * operating system and boot source, CPU and memory, disks, network, guest
 * customization, then a review. With Kubernetes details on, the review can
 * open the VirtualMachine YAML before creating it. On k4all, guest
 * customization also asks for k4all's metadata service (on by default when
 * k4all's ClusterConfig turns the service on) and the ServiceAccount whose
 * tokens the guest gets (model/metadata.ts).
 */

import { Icon } from '@iconify/react';
import { EditorDialog } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory } from 'react-router-dom';
import * as A from '../api/actions';
import { kpost } from '../api/client';
import { prepareClipboard } from '../api/clipboard';
import { HangarData, useHangar } from '../api/data';
import { useClusterDns } from '../api/dns';
import { useK4allMetadata, useServiceAccounts } from '../api/k4all';
import { useNetFacts } from '../api/podnet';
import { useProtectionPolicy } from '../api/protection';
import { datastores } from '../model/capacity';
import { setClipboardAnnotation, sidecarGateOn, sidecarImage } from '../model/clipboard';
import { DNS_POLICIES, dnsProblems, DnsSettings, hostSearchHint, isDefaultDns } from '../model/dns';
import { flavorFrom, KIND_CLUSTER, KIND_NS } from '../model/flavors';
import { folders, L_FOLDER } from '../model/inventory';
import { CHASSIS_ASSET, L_METADATA, metadataChoice, PSA_ENFORCE, serviceAccountProblem } from '../model/metadata';
import { preferredDatastore } from '../model/placement';
import { cidrConflicts, DEFAULT_VM_CIDR, freeVmCidr } from '../model/podnet';
import { formatBytes, GiB, MiB, parseQuantity } from '../model/units';
import { RUN_STRATEGIES } from '../model/vm';
import { BootSource, buildVm, nameProblem, WizardDisk, WizardInput, WizardNic } from '../model/vmspec';
import { hrefFor } from '../shell/nav';
import { useK8s, useSettings } from '../shell/settings';
import { K8sName,KV } from '../ui/kit';
import { tabular } from '../ui/tokens';
import { useTokens } from '../ui/useTokens';
import { CpuModelSelect, FlavorPicker, useFlavorFamilies } from '../views/flavors/parts';
import { K4allLink } from '../views/settings/K4allManaged';
import { datastoreItems, renderDatastore } from '../views/storage/DatastorePick';
import { confirmSidecarGate } from '../views/vm/ClipboardPanel';
import { DnsFields, DnsResult } from '../views/vm/DnsPanel';
import { libraryImages, OS_CHOICES, osChoice, preferenceFor, sizeProfiles } from './catalog';

export interface WizardPreset {
  folder?: string;
  image?: { namespace: string; name: string };
}

type SourceKind = 'image' | 'iso' | 'url' | 'registry' | 'blank';

interface State {
  name: string;
  folder: string;
  notes: string;
  tags: string;
  sourceKind: SourceKind;
  image: string; // "ns/name"
  iso: string;
  url: string;
  registry: string;
  osId: string;
  sizeMode: 'profile' | 'custom';
  profile: string;
  /** Cluster-wide or folder flavor. */
  profileKind: string;
  /** '' = not set on the VM (flavor's or cluster default). */
  cpuModel: string;
  vcpus: number;
  sockets: number;
  cores: number;
  threads: number;
  topology: boolean;
  memGiB: number;
  firmware: 'bios' | 'uefi' | 'uefi-secure';
  tpm: boolean;
  rootGiB: number;
  datastore: string;
  bus: WizardDisk['bus'];
  extraDisks: WizardDisk[];
  nics: WizardNic[];
  dns: DnsSettings;
  dnsOpen: boolean;
  clipboard: boolean;
  ciEnabled: boolean;
  ciUser: string;
  ciPassword: string;
  ciKeys: string;
  ciCustom: string;
  ciMode: 'simple' | 'custom';
  powerOn: boolean;
  runStrategy: string;
  eviction: string;
  protect: boolean;
  startPaused: boolean;
  headless: boolean;
  sound: '' | 'ich9' | 'ac97';
  /** k4all's metadata service; null: k4all's default (on when its service is on). */
  metadata: boolean | null;
  /** Whose tokens the guest gets; '' = the folder's default ServiceAccount. */
  serviceAccount: string;
}

const STEPS: { id: string; label: string }[] = [
  { id: 'name', label: 'Name and folder' },
  { id: 'source', label: 'Operating system' },
  { id: 'compute', label: 'CPU and memory' },
  { id: 'storage', label: 'Disks' },
  { id: 'network', label: 'Network' },
  { id: 'customize', label: 'Guest customization' },
  { id: 'review', label: 'Ready to complete' },
];

function Field({ label, help, children }: { label: string; help?: React.ReactNode; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr' }, gap: 2, alignItems: 'start', py: 1 }}>
      <Box sx={{ pt: 1 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{label}</Typography>
        {help && <Typography sx={{ fontSize: 12.5, color: t.muted }}>{help}</Typography>}
      </Box>
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

/** A number input that lets you type freely ("0.", "") and reports valid numbers. */
function NumField({
  value,
  onValue,
  min,
  step,
  label,
  unit,
  width = 130,
  error,
}: {
  value: number;
  onValue: (n: number) => void;
  min: number;
  step?: number;
  label: string;
  unit?: string;
  width?: number;
  error?: boolean;
}) {
  const t = useTokens();
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const n = Number(text);
  const bad = text.trim() === '' || !isFinite(n) || n < min;
  return (
    <TextField
      type="number"
      size="small"
      value={text}
      onChange={e => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== '' && isFinite(v) && v >= min) onValue(v);
      }}
      onBlur={() => bad && setText(String(value))}
      error={bad || error}
      inputProps={{ min, step, 'aria-label': label }}
      sx={{ width }}
      InputProps={unit ? { endAdornment: <Box sx={{ color: t.muted, fontSize: 13, pl: 0.5 }}>{unit}</Box> } : undefined}
    />
  );
}

function Choice({
  selected,
  onSelect,
  icon,
  title,
  sub,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: string;
  title: string;
  sub?: React.ReactNode;
  disabled?: boolean;
}) {
  const t = useTokens();
  return (
    <Box
      component="label"
      sx={{
        display: 'flex',
        gap: 1.25,
        alignItems: 'flex-start',
        p: 1.25,
        border: `1px solid ${selected ? t.meterUsed : t.rule}`,
        borderRadius: `${t.radius.panel}px`,
        background: selected ? t.selected : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Radio size="small" checked={selected} onChange={onSelect} disabled={disabled} sx={{ p: 0.25 }} />
      <Icon icon={icon} width={22} style={{ flex: 'none', marginTop: 2, color: t.muted }} />
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ fontSize: 14, fontWeight: 600 }}>{title}</Box>
        {sub && <Box sx={{ fontSize: 12.5, color: t.muted }}>{sub}</Box>}
      </Box>
    </Box>
  );
}

function initialState(d: HangarData, preset: WizardPreset, libraryNs: string): State {
  const imgs = libraryImages(d.dvs, d.pvcs, libraryNs);
  const presetImg = preset.image ? imgs.find(i => i.namespace === preset.image!.namespace && i.name === preset.image!.name) : undefined;
  const firstDisk = imgs.find(i => i.media === 'disk' && i.ready);
  const img = presetImg && presetImg.media === 'disk' ? presetImg : firstDisk;
  const iso = presetImg && presetImg.media === 'iso' ? presetImg : imgs.find(i => i.media === 'iso' && i.ready);
  const osId = presetImg?.os ?? img?.os ?? 'fedora';
  const os = osChoice(osId);
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  const def = preferredDatastore(ds, d.nodes.length);
  return {
    name: '',
    folder: preset.folder ?? folders(d.vms, d.namespaces, d.vmis, libraryNs)[0]?.name ?? 'default',
    notes: '',
    tags: '',
    sourceKind: presetImg?.media === 'iso' ? 'iso' : img ? 'image' : iso ? 'iso' : 'url',
    image: img ? `${img.namespace}/${img.name}` : '',
    iso: iso ? `${iso.namespace}/${iso.name}` : '',
    url: '',
    registry: 'quay.io/containerdisks/fedora:latest',
    osId,
    sizeMode: 'custom',
    profile: 'u1.small',
    profileKind: KIND_CLUSTER,
    cpuModel: '',
    vcpus: 2,
    sockets: 1,
    cores: 2,
    threads: 1,
    topology: false,
    memGiB: Math.max(2, os.minMemGiB),
    firmware: os.firmware,
    tpm: !!os.tpm,
    rootGiB: Math.max(20, img ? Math.ceil(img.sizeBytes / GiB) : 20),
    datastore: def?.name ?? '',
    bus: 'virtio',
    extraDisks: [],
    nics: [{ name: 'default', network: '', model: 'virtio' }],
    dns: { policy: 'ClusterFirst', nameservers: [], searches: [] },
    dnsOpen: false,
    clipboard: false,
    ciEnabled: os.cloudInit,
    ciUser: 'admin',
    ciPassword: '',
    ciKeys: '',
    ciCustom: '',
    ciMode: 'simple',
    powerOn: true,
    runStrategy: 'Always',
    eviction: '',
    protect: false,
    startPaused: false,
    headless: false,
    sound: '',
    metadata: null,
    serviceAccount: '',
  };
}

export function NewVmWizard({ preset, onClose }: { preset: WizardPreset; onClose: () => void }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const history = useHistory();
  const [settings] = useSettings();
  const libraryNs = settings.libraryNamespace;
  const [s, setS] = React.useState<State>(() => initialState(d, preset, libraryNs));
  const set = (p: Partial<State>) => setS(prev => ({ ...prev, ...p }));
  const [step, setStep] = React.useState(0);
  const [yaml, setYaml] = React.useState(false);
  const policy = useProtectionPolicy();
  // A NAT range for pod-network adapters that overlaps none of the cluster's (k4all #72).
  const netFacts = useNetFacts(d.nodes);
  const vmCidr = netFacts ? freeVmCidr(netFacts) : null;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const imgs = libraryImages(d.dvs, d.pvcs, libraryNs);
  const diskImgs = imgs.filter(i => i.media === 'disk');
  const isoImgs = imgs.filter(i => i.media === 'iso');
  const folderList = folders(d.vms, d.namespaces, d.vmis, libraryNs).map(f => f.name);
  const nsExists = d.namespaces.some(n => n.metadata.name === s.folder);
  const ds = datastores(d.storageClasses, d.pvcs, d.nodes, d.storageProfiles, d.snapshotClasses);
  const profiles = sizeProfiles(d.instancetypes);
  const os = osChoice(s.osId);
  const pref = preferenceFor(os, d.preferences);
  const maxCpu = Math.max(0, ...d.nodes.map(n => parseQuantity(n.status?.allocatable?.cpu) || 0));
  const maxMem = Math.max(0, ...d.nodes.map(n => parseQuantity(n.status?.allocatable?.memory) || 0));
  const selectedImg = imgs.find(i => `${i.namespace}/${i.name}` === s.image);
  const minRoot = s.sourceKind === 'image' && selectedImg ? Math.max(1, Math.ceil(selectedImg.sizeBytes / GiB)) : 1;
  const flavorList = useFlavorFamilies(s.folder).all;
  const chosenFlavor = flavorList.find(o => o.metadata.name === s.profile && (s.profileKind === KIND_NS ? o.metadata.namespace === s.folder : !o.metadata.namespace));
  const profile = chosenFlavor ? flavorFrom(chosenFlavor) : undefined;
  const flavorModel = s.sizeMode === 'profile' ? profile?.cpuModel : undefined;
  const vcpus = s.sizeMode === 'profile' ? profile?.vcpus ?? 1 : s.topology ? s.sockets * s.cores * s.threads : s.vcpus;
  const memBytes = s.sizeMode === 'profile' ? profile?.memBytes ?? GiB : Math.round(s.memGiB * GiB);
  const nads = d.nads.filter(n => n.metadata.namespace === s.folder || n.metadata.namespace === 'default');
  const clusterDns = useClusterDns();
  const iso = s.sourceKind === 'iso';
  const useCloudInit = s.ciEnabled && !iso && os.cloudInit;
  const k4 = useK4allMetadata();
  const mdService = k4.metadata && k4.metadata !== 'unknown' ? k4.metadata : null;
  const mdOn = metadataChoice(k4.on, k4.metadata, s.metadata);
  const serviceAccounts = useServiceAccounts(k4.on ? s.folder : undefined, nsExists);

  const prefObj = d.preferences.find(p => p.metadata.name === pref);
  const needMem = parseQuantity(prefObj?.spec?.requirements?.memory?.guest);
  const needCpu = Number(prefObj?.spec?.requirements?.cpu?.guest ?? 0);
  const taken = d.vms.some(v => v.metadata.namespace === s.folder && v.metadata.name === s.name);
  const problems: Record<string, string | null> = {
    name:
      nameProblem(s.name) ??
      (taken ? `A VM named ${s.name} is already in ${s.folder}.` : null) ??
      (nameProblem(s.folder) ? `Folder: ${nameProblem(s.folder)}` : null),
    source:
      s.sourceKind === 'image' && !selectedImg
        ? 'Pick an image.'
        : s.sourceKind === 'iso' && !s.iso
        ? 'Pick an ISO.'
        : s.sourceKind === 'url' && !/^https?:\/\/\S+$/.test(s.url)
        ? 'Enter the http(s) address of a disk image (qcow2, raw, img, iso, optionally .gz or .xz).'
        : s.sourceKind === 'registry' && !s.registry.trim()
        ? 'Enter a container image that holds a disk.'
        : null,
    compute:
      vcpus < 1
        ? 'At least 1 vCPU.'
        : memBytes < 128 * MiB
        ? 'At least 128 MiB.'
        : isFinite(needMem) && memBytes < needMem
        ? `${os.label} needs at least ${formatBytes(needMem)} of memory.`
        : needCpu && vcpus < needCpu
        ? `${os.label} needs at least ${needCpu} vCPU.`
        : null,
    storage: s.rootGiB < minRoot ? `The image needs at least ${minRoot} GiB.` : null,
    network: s.nics.some(n => !n.network) && dnsProblems(s.dns, clusterDns?.servers.length || 1).length ? 'Fix the DNS settings.' : null,
    customize: mdOn ? (serviceAccountProblem(s.serviceAccount.trim()) ? `ServiceAccount: ${serviceAccountProblem(s.serviceAccount.trim())}` : null) : null,
    review: null,
  };
  const stepOk = (i: number) => !problems[STEPS[i].id];
  const allOk = STEPS.every((_, i) => stepOk(i));

  const tagMap = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of s.tags.split(/[,\s]+/).filter(Boolean)) {
      const [k, v = ''] = part.split(/[=:]/);
      if (k) out[k] = v;
    }
    return out;
  };

  const input = (): WizardInput => {
    const [ns, nm] = (s.sourceKind === 'iso' ? s.iso : s.image).split('/');
    const source: BootSource =
      s.sourceKind === 'image'
        ? { kind: 'image', namespace: ns, name: nm }
        : s.sourceKind === 'iso'
        ? { kind: 'iso', namespace: ns, name: nm }
        : s.sourceKind === 'url'
        ? { kind: 'url', url: s.url.trim() }
        : s.sourceKind === 'registry'
        ? { kind: 'registry', image: s.registry.trim() }
        : { kind: 'blank' };
    return {
      name: s.name,
      namespace: s.folder,
      description: s.notes || undefined,
      osId: os.id !== 'other' ? os.id : undefined,
      preference: pref,
      instancetype: s.sizeMode === 'profile' ? s.profile : undefined,
      instancetypeKind: s.sizeMode === 'profile' ? s.profileKind : undefined,
      cpuModel: flavorModel ? undefined : s.cpuModel || undefined,
      sockets: s.topology ? s.sockets : 1,
      cores: s.topology ? s.cores : s.vcpus,
      threads: s.topology ? s.threads : 1,
      memoryBytes: memBytes,
      firmware: s.firmware,
      tpm: s.tpm,
      source,
      rootDisk: { name: 'rootdisk', sizeBytes: s.rootGiB * GiB, storageClass: s.datastore || undefined, bus: s.bus },
      extraDisks: s.extraDisks,
      nics: s.nics,
      dns: s.nics.some(n => !n.network) && !isDefaultDns(s.dns) ? s.dns : undefined,
      cloudInit: useCloudInit
        ? s.ciMode === 'custom'
          ? { custom: s.ciCustom }
          : { user: s.ciUser || undefined, password: s.ciPassword || undefined, sshKeys: s.ciKeys.split('\n'), hostname: s.name }
        : undefined,
      runStrategy: s.powerOn || s.runStrategy === 'Manual' ? s.runStrategy : 'Halted',
      evictionStrategy: s.eviction || undefined,
      labels: tagMap(),
      templateAnnotations: s.clipboard ? setClipboardAnnotation({}, true, sidecarImage(d.kubevirt)) : undefined,
      vmNetworkCidr: vmCidr ?? undefined,
      protected: s.protect && policy.state === 'installed',
      startPaused: s.startPaused,
      headless: s.headless,
      sound: s.sound || undefined,
      metadata: mdOn ? { serviceAccount: s.serviceAccount.trim() || undefined } : undefined,
    };
  };

  const create = async (vm = buildVm(input())) => {
    if (s.clipboard && !sidecarGateOn(d.kubevirt) && !(await confirmSidecarGate())) return;
    setBusy(true);
    setError(null);
    try {
      if (!nsExists) {
        await A.runTask({ title: 'Create folder', target: { kind: 'folder', name: s.folder } }, () =>
          kpost('/api/v1/namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: s.folder, labels: { [L_FOLDER]: 'true' } } })
        );
      }
      if (s.clipboard) {
        await A.runTask({ title: 'Prepare clipboard sharing', target: { kind: 'folder', name: s.folder } }, () => prepareClipboard(s.folder, d.kubevirt));
      }
      await A.createVm(vm);
      // Manual VMs are created stopped: start this one if asked.
      if (s.powerOn && vm.spec?.runStrategy === 'Manual') A.powerOn(vm).catch(() => undefined);
      onClose();
      history.push(hrefFor('vm', s.folder, s.name));
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  };

  const go = (i: number) => {
    if (i <= step || STEPS.slice(0, i).every((_, j) => stepOk(j))) setStep(i);
  };
  const id = STEPS[step].id;
  const dsInfo = ds.find(x => x.name === s.datastore);

  /* ------------------------------------------------------------ steps */
  const body = (() => {
    switch (id) {
      case 'name':
        return (
          <>
            <Field label="Name" help="Lowercase letters, digits and hyphens. It is also the guest's hostname.">
              <TextField
               
                fullWidth
                size="small"
                value={s.name}
                onChange={e => set({ name: e.target.value.toLowerCase() })}
                error={!!s.name && !!problems.name}
                helperText={(s.name && problems.name) || ' '}
                inputProps={{ 'aria-label': 'VM name' }}
                placeholder="web-03"
              />
            </Field>
            <Field label="Folder" help={k8s ? 'The namespace of the VM.' : 'Where the VM lives. Pick one or type a new name.'}>
              <Autocomplete
                freeSolo
                options={folderList}
                value={s.folder}
                onInputChange={(_, v) => set({ folder: v.toLowerCase() })}
                renderInput={p => (
                  <TextField {...p} size="small" helperText={s.folder && !nsExists ? `A new folder ${s.folder} will be created.` : ' '} inputProps={{ ...p.inputProps, 'aria-label': 'Folder' }} />
                )}
              />
            </Field>
            <Field label="Notes" help="What it is for, who owns it.">
              <TextField fullWidth size="small" multiline minRows={2} value={s.notes} onChange={e => set({ notes: e.target.value })} inputProps={{ 'aria-label': 'Notes' }} />
            </Field>
            <Field label="Tags" help="key=value, separated by commas.">
              <TextField fullWidth size="small" value={s.tags} onChange={e => set({ tags: e.target.value })} placeholder="app=shop, tier=web" inputProps={{ 'aria-label': 'Tags' }} />
            </Field>
          </>
        );
      case 'source':
        return (
          <>
            <Field label="Boot from">
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
                <Choice
                  selected={s.sourceKind === 'image'}
                  onSelect={() => set({ sourceKind: 'image' })}
                  icon="mdi:harddisk"
                  title="An image from the library"
                  sub="Ready-to-boot cloud image, copied for this VM."
                  disabled={!diskImgs.length}
                />
                <Choice
                  selected={s.sourceKind === 'iso'}
                  onSelect={() => set({ sourceKind: 'iso', ciEnabled: false })}
                  icon="mdi:disc"
                  title="Install from an ISO"
                  sub="Boots the installer on an empty disk."
                  disabled={!isoImgs.length}
                />
                <Choice selected={s.sourceKind === 'url'} onSelect={() => set({ sourceKind: 'url' })} icon="mdi:cloud-download-outline" title="Import a disk from a URL" sub="Downloaded straight into the VM's disk." />
                <Choice
                  selected={s.sourceKind === 'registry'}
                  onSelect={() => set({ sourceKind: 'registry' })}
                  icon="mdi:package-variant-closed"
                  title="Import from a container registry"
                  sub="A containerdisk image, e.g. quay.io/containerdisks."
                />
                <Choice selected={s.sourceKind === 'blank'} onSelect={() => set({ sourceKind: 'blank' })} icon="mdi:harddisk-plus" title="Empty disk" sub="For network boot (PXE) or a later install." />
              </Box>
            </Field>
            {s.sourceKind === 'image' && (
              <Field label="Image">
                <Box sx={{ display: 'grid', gap: 0.75 }}>
                  {diskImgs.map(i => (
                    <Choice
                      key={`${i.namespace}/${i.name}`}
                      selected={s.image === `${i.namespace}/${i.name}`}
                      onSelect={() => {
                        const o = osChoice(i.os ?? s.osId);
                        set({
                          image: `${i.namespace}/${i.name}`,
                          osId: i.os ?? s.osId,
                          rootGiB: Math.max(s.rootGiB, Math.ceil(i.sizeBytes / GiB)),
                          firmware: o.firmware,
                          tpm: !!o.tpm,
                          ciEnabled: o.cloudInit,
                        });
                      }}
                      icon={osChoice(i.os).icon}
                      title={i.displayName}
                      sub={`${formatBytes(i.sizeBytes)}${i.ready ? '' : `, importing ${i.progress ?? ''}`}${k8s ? `, ${i.namespace}/${i.name}` : ''}`}
                      disabled={!i.ready}
                    />
                  ))}
                </Box>
              </Field>
            )}
            {s.sourceKind === 'iso' && (
              <Field label="ISO">
                <TextField select fullWidth size="small" value={s.iso} onChange={e => {
                  const i = isoImgs.find(x => `${x.namespace}/${x.name}` === e.target.value);
                  set({ iso: e.target.value, osId: i?.os ?? s.osId });
                }} inputProps={{ 'aria-label': 'ISO' }}>
                  {isoImgs.map(i => (
                    <MenuItem key={`${i.namespace}/${i.name}`} value={`${i.namespace}/${i.name}`} disabled={!i.ready}>
                      {i.displayName} ({formatBytes(i.sizeBytes)})
                    </MenuItem>
                  ))}
                </TextField>
              </Field>
            )}
            {s.sourceKind === 'url' && (
              <Field label="Disk image URL">
                <TextField fullWidth size="small" value={s.url} onChange={e => set({ url: e.target.value })} placeholder="https://cloud-images.ubuntu.com/…/ubuntu-24.04-server-cloudimg-amd64.img" inputProps={{ 'aria-label': 'Disk image URL' }} />
              </Field>
            )}
            {s.sourceKind === 'registry' && (
              <Field label="Container image">
                <TextField fullWidth size="small" value={s.registry} onChange={e => set({ registry: e.target.value })} inputProps={{ 'aria-label': 'Container image' }} />
              </Field>
            )}
            <Field label="Guest OS" help="Tunes the virtual hardware for it.">
              <TextField
                select
                fullWidth
                size="small"
                value={s.osId}
                onChange={e => {
                  const o = osChoice(e.target.value);
                  set({ osId: o.id, firmware: o.firmware, tpm: !!o.tpm, ciEnabled: o.cloudInit && !iso, memGiB: Math.max(s.memGiB, o.minMemGiB) });
                }}
                inputProps={{ 'aria-label': 'Guest OS' }}
              >
                {OS_CHOICES.map(o => (
                  <MenuItem key={o.id} value={o.id}>
                    <Box sx={{ display: 'inline-flex', gap: 1, alignItems: 'center' }}>
                      <Icon icon={o.icon} width={18} /> {o.label}
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
              {k8s && <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.5 }}>Preference: {pref ?? 'none'}</Typography>}
            </Field>
          </>
        );
      case 'compute':
        return (
          <>
            <Field label="Sizing">
              <ToggleButtonGroup size="small" exclusive value={s.sizeMode} onChange={(_, v) => v && set({ sizeMode: v })} aria-label="Sizing">
                <ToggleButton value="custom" sx={{ textTransform: 'none', px: 2 }}>
                  Custom
                </ToggleButton>
                <ToggleButton value="profile" sx={{ textTransform: 'none', px: 2 }} disabled={!profiles.length}>
                  Flavor
                </ToggleButton>
              </ToggleButtonGroup>
            </Field>
            {s.sizeMode === 'custom' ? (
              <>
                <Field label="CPU" help={`The largest host has ${maxCpu} CPUs.`}>
                  {!s.topology ? (
                    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      <NumField value={s.vcpus} onValue={v => set({ vcpus: Math.round(v) })} min={1} label="vCPUs" unit="vCPU" width={120} />
                      <Button size="small" onClick={() => set({ topology: true, sockets: 1, cores: s.vcpus, threads: 1 })} sx={{ textTransform: 'none' }}>
                        Set sockets and cores
                      </Button>
                    </Box>
                  ) : (
                    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                      {(['sockets', 'cores', 'threads'] as const).map(k => (
                        <Box key={k}>
                          <Typography sx={{ fontSize: 12, color: t.muted }}>{k[0].toUpperCase() + k.slice(1)}</Typography>
                          <NumField value={s[k]} onValue={v => set({ [k]: Math.round(v) } as any)} min={1} label={k} width={90} />
                        </Box>
                      ))}
                      <Box sx={{ fontSize: 14, ...tabular }}>= {s.sockets * s.cores * s.threads} vCPU</Box>
                      <Button size="small" onClick={() => set({ topology: false, vcpus: s.sockets * s.cores * s.threads })} sx={{ textTransform: 'none' }}>
                        Simple
                      </Button>
                    </Box>
                  )}
                  {vcpus > maxCpu && maxCpu > 0 && <Typography sx={{ color: '#B7791F', fontSize: 13, mt: 0.5 }}>More vCPUs than any host has: it will share them (overcommit).</Typography>}
                </Field>
                <Field label="Memory" help={`The largest host has ${formatBytes(maxMem)}.`}>
                  <NumField value={s.memGiB} onValue={v => set({ memGiB: v })} min={0.125} step={0.5} label="Memory in GiB" unit="GiB" width={140} />
                  {memBytes > maxMem && maxMem > 0 && <Typography sx={{ color: '#E5484D', fontSize: 13, mt: 0.5 }}>No host has this much memory: the VM will not start.</Typography>}
                </Field>
              </>
            ) : (
              <Field label="Flavor" help="Sizes by family, from Flavors. Greyed sizes need something no host has.">
                <FlavorPicker value={{ kind: s.profileKind, name: s.profile }} onChange={v => set({ profile: v.name, profileKind: v.kind })} namespace={s.folder} nodes={d.nodes} />
              </Field>
            )}
            <Field label="CPU model" help="Portable models let the VM start on every host and move between them while running.">
              <CpuModelSelect
                value={s.cpuModel}
                onChange={cpuModel => set({ cpuModel })}
                nodes={d.nodes}
                clusterDefault={d.kubevirt?.spec?.configuration?.cpuModel}
                lockedBy={flavorModel ? { flavor: s.profile, model: flavorModel } : undefined}
              />
            </Field>
            <Field label="Firmware" help="UEFI with Secure Boot for Windows 11 and modern installers.">
              <ToggleButtonGroup size="small" exclusive value={s.firmware} onChange={(_, v) => v && set({ firmware: v })} aria-label="Firmware">
                <ToggleButton value="bios" sx={{ textTransform: 'none' }}>
                  BIOS
                </ToggleButton>
                <ToggleButton value="uefi" sx={{ textTransform: 'none' }}>
                  UEFI
                </ToggleButton>
                <ToggleButton value="uefi-secure" sx={{ textTransform: 'none' }}>
                  UEFI, Secure Boot
                </ToggleButton>
              </ToggleButtonGroup>
              <FormControlLabel sx={{ display: 'flex', mt: 1 }} control={<Checkbox checked={s.tpm} onChange={e => set({ tpm: e.target.checked })} />} label="Virtual TPM (persistent)" />
            </Field>
          </>
        );
      case 'storage':
        return (
          <>
            <Field label={iso ? 'System disk' : 'Boot disk'} help={s.sourceKind === 'image' ? `The image needs at least ${minRoot} GiB.` : iso ? 'Empty: the installer writes to it.' : undefined}>
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <NumField value={s.rootGiB} onValue={v => set({ rootGiB: Math.ceil(v) })} min={1} label="Boot disk size in GiB" unit="GiB" error={!!problems.storage} />
                <TextField select size="small" value={s.bus} onChange={e => set({ bus: e.target.value as any })} sx={{ width: 140 }} inputProps={{ 'aria-label': 'Disk bus' }}>
                  <MenuItem value="virtio">VirtIO</MenuItem>
                  <MenuItem value="scsi">SCSI</MenuItem>
                  <MenuItem value="sata">SATA</MenuItem>
                </TextField>
              </Box>
              {problems.storage && <Typography sx={{ color: '#E5484D', fontSize: 13, mt: 0.5 }}>{problems.storage}</Typography>}
              {s.bus === 'virtio' && s.osId === 'windows' && (
                <Typography sx={{ color: t.muted, fontSize: 12.5, mt: 0.5 }}>Windows needs the VirtIO drivers during setup, or pick SATA.</Typography>
              )}
            </Field>
            <Field label={k8s ? 'StorageClass' : 'Datastore'}>
              <TextField
                select
                fullWidth
                size="small"
                value={s.datastore}
                onChange={e => set({ datastore: e.target.value })}
                inputProps={{ 'aria-label': 'Datastore' }}
                SelectProps={{ renderValue: renderDatastore(ds, d.nodes.length) }}
              >
                {datastoreItems(ds, d.nodes.length, t, { snapshots: true })}
              </TextField>
              {dsInfo && !dsInfo.shared && (
                <Typography sx={{ color: t.muted, fontSize: 12.5, mt: 0.5 }}>
                  {d.nodes.length > 1 && ds.some(x => x.shared)
                    ? `Disks on ${dsInfo.name} belong to one host: the VM cannot move to another host while running. Pick a shared datastore to keep it movable.`
                    : 'Disks here belong to one host: the VM cannot move to another host while running.'}
                </Typography>
              )}
            </Field>
            <Field label="More disks">
              <Box sx={{ display: 'grid', gap: 1 }}>
                {s.extraDisks.map((x, i) => (
                  <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <TextField size="small" label="Name" value={x.name} onChange={e => set({ extraDisks: s.extraDisks.map((y, j) => (j === i ? { ...y, name: e.target.value.toLowerCase() } : y)) })} sx={{ width: 150 }} />
                    <NumField value={Math.round(x.sizeBytes / GiB)} onValue={v => set({ extraDisks: s.extraDisks.map((y, j) => (j === i ? { ...y, sizeBytes: Math.ceil(v) * GiB } : y)) })} min={1} label={`Size of ${x.name} in GiB`} unit="GiB" width={110} />
                    <TextField select size="small" label="Datastore" value={x.storageClass ?? s.datastore} onChange={e => set({ extraDisks: s.extraDisks.map((y, j) => (j === i ? { ...y, storageClass: e.target.value } : y)) })} sx={{ width: 200 }}>
                      {datastoreItems(ds, d.nodes.length, t)}
                    </TextField>
                    <IconButton aria-label={`Remove disk ${x.name}`} onClick={() => set({ extraDisks: s.extraDisks.filter((_, j) => j !== i) })}>
                      <Icon icon="mdi:delete-outline" width={18} />
                    </IconButton>
                  </Box>
                ))}
                <Box>
                  <Button size="small" startIcon={<Icon icon="mdi:plus" width={16} />} onClick={() => set({ extraDisks: [...s.extraDisks, { name: `data${s.extraDisks.length + 1}`, sizeBytes: 10 * GiB, storageClass: s.datastore, bus: 'virtio' }] })} sx={{ textTransform: 'none' }}>
                    Add disk
                  </Button>
                </Box>
              </Box>
            </Field>
          </>
        );
      case 'network':
        return (
          <>
          <Field label="Network adapters" help="The pod network gives NAT access; bridged networks put the VM on a host LAN or VLAN.">
            <Box sx={{ display: 'grid', gap: 1 }}>
              {s.nics.map((n, i) => (
                <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Icon icon="mdi:ethernet" width={20} style={{ color: t.muted }} />
                  <TextField select size="small" label="Network" value={n.network} onChange={e => set({ nics: s.nics.map((y, j) => (j === i ? { ...y, network: e.target.value } : y)) })} sx={{ minWidth: 260 }}>
                    <MenuItem value="" disabled={s.nics.some((y, j) => j !== i && !y.network)}>
                      Pod network (NAT)
                    </MenuItem>
                    {nads.map(x => (
                      <MenuItem key={`${x.metadata.namespace}/${x.metadata.name}`} value={`${x.metadata.namespace}/${x.metadata.name}`}>
                        {x.metadata.name} {x.metadata.namespace === 'default' && s.folder !== 'default' ? '(shared)' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField select size="small" label="Adapter" value={n.model} onChange={e => set({ nics: s.nics.map((y, j) => (j === i ? { ...y, model: e.target.value as any } : y)) })} sx={{ width: 150 }}>
                    <MenuItem value="virtio">VirtIO</MenuItem>
                    <MenuItem value="e1000e">Intel e1000e</MenuItem>
                  </TextField>
                  {s.nics.length > 1 && (
                    <IconButton aria-label="Remove adapter" onClick={() => set({ nics: s.nics.filter((_, j) => j !== i) })}>
                      <Icon icon="mdi:delete-outline" width={18} />
                    </IconButton>
                  )}
                </Box>
              ))}
              <Box>
                <Button
                  size="small"
                  startIcon={<Icon icon="mdi:plus" width={16} />}
                  disabled={!nads.length && s.nics.some(x => !x.network)}
                  onClick={() => {
                    const free = nads.find(x => !s.nics.some(y => y.network === `${x.metadata.namespace}/${x.metadata.name}`));
                    set({ nics: [...s.nics, { name: `nic${s.nics.length}`, network: free ? `${free.metadata.namespace}/${free.metadata.name}` : '', model: 'virtio' }] });
                  }}
                  sx={{ textTransform: 'none' }}
                >
                  Add network adapter
                </Button>
                {!nads.length && <Typography sx={{ color: t.muted, fontSize: 12.5, mt: 0.5 }}>No bridged networks yet: create one in Networks.</Typography>}
              </Box>
            </Box>
          </Field>
          {k8s && s.nics.some(n => !n.network) && (
            <Field label="NAT range" help="The network between the guest and its pod.">
              <Box sx={{ fontSize: 14, pt: 1 }}>
                {!netFacts ? 'Checking the cluster…' : vmCidr ?? DEFAULT_VM_CIDR} <K8sName>networks[].pod.vmNetworkCIDR</K8sName>
                <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.5 }}>
                  {!netFacts
                    ? ''
                    : !vmCidr
                    ? 'No free /24 found: KubeVirt default 10.0.2.0/24.'
                    : vmCidr === DEFAULT_VM_CIDR
                    ? "KubeVirt's default; no host pod network, service network or host address uses it."
                    : `KubeVirt's default ${DEFAULT_VM_CIDR} is ${cidrConflicts(DEFAULT_VM_CIDR, netFacts).join(', ')}: the VM could not reach it.`}
                </Typography>
              </Box>
            </Field>
          )}
          {s.nics.some(n => !n.network) && (
            <Field label="DNS" help="What the pod network adapter gets by DHCP.">
              <Box sx={{ display: 'grid', gap: 1.5 }}>
                <Box sx={{ border: `1px solid ${t.rule}`, borderRadius: `${t.radius.small}px`, px: 1.5, py: 0.5 }}>
                  <DnsResult s={s.dns} namespace={s.folder || 'default'} cluster={clusterDns} hostSearch={hostSearchHint(d.nodes)} />
                </Box>
                {s.dnsOpen ? (
                  <DnsFields value={s.dns} onChange={dns => set({ dns })} clusterServers={clusterDns?.servers.length ?? 1} />
                ) : (
                  <Box>
                    <Button size="small" onClick={() => set({ dnsOpen: true })} startIcon={<Icon icon="mdi:pencil-outline" width={16} />} sx={{ textTransform: 'none' }}>
                      Change DNS
                    </Button>
                  </Box>
                )}
              </Box>
            </Field>
          )}
          </>
        );
      case 'customize': {
        const sa = s.serviceAccount.trim();
        const psa = d.namespaces.find(n => n.metadata.name === s.folder)?.metadata.labels?.[PSA_ENFORCE];
        const podNic = s.nics.some(n => !n.network);
        const metadataFields = k4.on && (
          <>
            <Field
              label="Metadata service"
              help={<>k4all&apos;s, at 169.254.169.254</>}
            >
              <FormControlLabel
                control={<Checkbox checked={mdOn} onChange={e => set({ metadata: e.target.checked })} />}
                label="Serve instance data and tokens to the guest"
              />
              <Typography sx={{ fontSize: 12.5, color: t.muted, ml: 4, mt: -0.5 }}>
                {k4.metadata === 'unknown'
                  ? 'Hangar cannot read k4all’s settings to tell whether the service is on in this datacenter.'
                  : !mdService?.enabled
                  ? 'k4all’s metadata service is off in this datacenter: the VM gets it once it is turned on.'
                  : mdService.scope === 'All'
                  ? 'k4all serves every VM of the datacenter (scope All); this also sets the chassis tag cloud-init looks for.'
                  : 'OpenStack and EC2 style: instance-id, hostname, SSH keys and user-data from the settings above, and tokens of the ServiceAccount below.'}{' '}
                {k8s && (
                  <>
                    Sets the template label <code>{L_METADATA}</code> and <code>chassis.asset: {CHASSIS_ASSET}</code>.{' '}
                  </>
                )}
                <K4allLink page="virtualization" anchor="metadata">
                  k4all&apos;s metadata settings
                </K4allLink>
              </Typography>
              {mdOn && (psa === 'baseline' || psa === 'restricted') && (
                <Typography sx={{ fontSize: 12.5, color: '#B7791F', ml: 4, mt: 0.5 }}>
                  Folder {s.folder} enforces PodSecurity {psa}: k4all does not inject the service there, the VM keeps its cloud-init disk.
                </Typography>
              )}
              {mdOn && !podNic && (
                <Typography sx={{ fontSize: 12.5, color: '#B7791F', ml: 4, mt: 0.5 }}>
                  The VM has no pod network (NAT) adapter: the service is reached through the pod network only.
                </Typography>
              )}
            </Field>
            {mdOn && (
              <Field label="ServiceAccount" help="Whose tokens the guest gets.">
                <Autocomplete
                  freeSolo
                  size="small"
                  options={serviceAccounts ?? []}
                  value={s.serviceAccount}
                  onInputChange={(_, v) => set({ serviceAccount: v })}
                  sx={{ maxWidth: 320 }}
                  renderInput={params => <TextField {...params} placeholder="default" inputProps={{ ...params.inputProps, 'aria-label': 'ServiceAccount' }} />}
                />
                <Typography sx={{ fontSize: 12.5, color: serviceAccountProblem(sa) || (sa && serviceAccounts && !serviceAccounts.includes(sa)) ? '#B7791F' : t.muted, mt: 0.5 }}>
                  {serviceAccountProblem(sa) ??
                    (!nsExists
                      ? `Folder ${s.folder} is new: only its default ServiceAccount exists at first.`
                      : sa && serviceAccounts && !serviceAccounts.includes(sa)
                      ? `${sa} does not exist in ${s.folder}: the VM cannot start until it does.`
                      : `Empty: ${s.folder}'s default ServiceAccount.`)}
                </Typography>
              </Field>
            )}
          </>
        );
        return !os.cloudInit || iso ? (
          <>
          <Typography sx={{ fontSize: 14, color: t.muted, py: 2 }}>
            {iso ? 'Installing from an ISO: you set the users and the hostname in the installer.' : `${os.label} images are not customized here: set them up in the guest.`}
          </Typography>
          {metadataFields}
          </>
        ) : (
          <>
            <Field label="Customize the guest" help="With cloud-init, at first boot.">
              <FormControlLabel control={<Checkbox checked={s.ciEnabled} onChange={e => set({ ciEnabled: e.target.checked })} />} label="Set hostname, user and keys" />
            </Field>
            {s.ciEnabled && (
              <>
                <Field label="How">
                  <ToggleButtonGroup size="small" exclusive value={s.ciMode} onChange={(_, v) => v && set({ ciMode: v })}>
                    <ToggleButton value="simple" sx={{ textTransform: 'none' }}>
                      Form
                    </ToggleButton>
                    <ToggleButton value="custom" sx={{ textTransform: 'none' }}>
                      My own cloud-config
                    </ToggleButton>
                  </ToggleButtonGroup>
                </Field>
                {s.ciMode === 'simple' ? (
                  <>
                    <Field label="Hostname">
                      <Box sx={{ fontSize: 14, pt: 1 }}>{s.name || '(the VM name)'}</Box>
                    </Field>
                    <Field label="User">
                      <TextField size="small" value={s.ciUser} onChange={e => set({ ciUser: e.target.value })} inputProps={{ 'aria-label': 'User' }} />
                    </Field>
                    <Field label="Password" help="Stored in the VM settings: prefer SSH keys.">
                      <TextField size="small" type="password" value={s.ciPassword} onChange={e => set({ ciPassword: e.target.value })} inputProps={{ 'aria-label': 'Password' }} autoComplete="new-password" />
                    </Field>
                    <Field label="SSH public keys" help="One per line.">
                      <TextField fullWidth multiline minRows={2} size="small" value={s.ciKeys} onChange={e => set({ ciKeys: e.target.value })} placeholder="ssh-ed25519 AAAA… you@laptop" inputProps={{ 'aria-label': 'SSH public keys' }} />
                    </Field>
                  </>
                ) : (
                  <Field label="cloud-config">
                    <TextField fullWidth multiline minRows={10} size="small" value={s.ciCustom} onChange={e => set({ ciCustom: e.target.value })} placeholder={'#cloud-config\n'} inputProps={{ 'aria-label': 'cloud-config', style: { fontFamily: t.font.mono, fontSize: 13 } }} />
                  </Field>
                )}
              </>
            )}
            {metadataFields}
          </>
        );
      }
      default: {
        const w = input();
        const src =
          s.sourceKind === 'image'
            ? `Copy of ${selectedImg?.displayName}`
            : s.sourceKind === 'iso'
            ? `Installer ${imgs.find(i => `${i.namespace}/${i.name}` === s.iso)?.displayName}`
            : s.sourceKind === 'url'
            ? `Import from ${s.url}`
            : s.sourceKind === 'registry'
            ? `Import from ${s.registry}`
            : 'Empty disk';
        return (
          <>
            <KV
              labelWidth={170}
              rows={[
                ['Name', s.name],
                [k8s ? 'Namespace' : 'Folder', `${s.folder}${nsExists ? '' : ' (new)'}`],
                ['Guest OS', os.label],
                ['Boot source', src],
                ['CPU and memory', `${vcpus} vCPU, ${formatBytes(memBytes)}${s.sizeMode === 'profile' ? ` (${s.profile})` : ''}`],
                ['CPU model', flavorModel ? `${flavorModel} (from the flavor)` : s.cpuModel || `Cluster default (${d.kubevirt?.spec?.configuration?.cpuModel || 'host model'})`],
                ['Firmware', `${s.firmware === 'bios' ? 'BIOS' : s.firmware === 'uefi' ? 'UEFI' : 'UEFI, Secure Boot'}${s.tpm ? ', TPM' : ''}`],
                ['Disks', [`${s.rootGiB} GiB boot disk`, ...s.extraDisks.map(x => `${Math.round(x.sizeBytes / GiB)} GiB ${x.name}`)].join(', ') + ` on ${s.datastore}`],
                ['Network', s.nics.map(n => (n.network ? n.network.split('/')[1] : 'Pod network (NAT)')).join(', ')],
                ...(s.nics.some(n => !n.network) && !isDefaultDns(s.dns)
                  ? [['DNS', [DNS_POLICIES.find(p => p.value === s.dns.policy)!.label, ...s.dns.nameservers, ...s.dns.searches.map(x => `search ${x}`)].join(', ')] as [string, string]]
                  : []),
                ['Customization', useCloudInit ? (s.ciMode === 'custom' ? 'Your cloud-config' : `User ${s.ciUser || '(image default)'}${s.ciKeys.trim() ? ', SSH keys' : ''}${s.ciPassword ? ', password' : ''}`) : 'None'],
                ...(k4.on ? [['Metadata service', mdOn ? `On, ServiceAccount ${s.serviceAccount.trim() || 'default'}` : 'Off'] as [string, string]] : []),
              ]}
            />
            <Box sx={{ mt: 2, pt: 2, borderTop: `1px solid ${t.rule}`, display: 'grid', gap: 1 }}>
              <FormControlLabel control={<Checkbox checked={s.powerOn} onChange={e => set({ powerOn: e.target.checked })} />} label="Power on when the disks are ready" />
              <Box>
                <FormControlLabel
                  control={<Checkbox checked={s.protect && policy.state === 'installed'} disabled={policy.state !== 'installed'} onChange={e => set({ protect: e.target.checked })} />}
                  label="Protect from deletion (the VM and its disks)"
                />
                <Typography sx={{ fontSize: 12.5, color: t.muted, ml: 4, mt: -0.5 }}>
                  {policy.state === 'installed'
                    ? 'Nobody can delete it until protection is turned off in Configure → Options.'
                    : 'Needs the delete protection policy, not installed in this datacenter (Settings → Delete protection).'}
                </Typography>
              </Box>
              <Box>
                <FormControlLabel control={<Checkbox checked={s.startPaused} onChange={e => set({ startPaused: e.target.checked })} />} label="Start paused" />
                <Typography sx={{ fontSize: 12.5, color: t.muted, ml: 4, mt: -0.5 }}>Power-on leaves it suspended, so you can open the console before the guest boots.</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
                <FormControlLabel control={<Checkbox checked={s.headless} onChange={e => set({ headless: e.target.checked, ...(e.target.checked ? { clipboard: false } : {}) })} />} label="Headless (no graphics card, serial console only)" />
                <TextField select size="small" value={s.sound} onChange={e => set({ sound: e.target.value as State['sound'] })} sx={{ minWidth: 200 }} SelectProps={{ displayEmpty: true }} inputProps={{ 'aria-label': 'Audio' }}>
                  <MenuItem value="">No audio</MenuItem>
                  <MenuItem value="ich9">Audio: Intel HD Audio</MenuItem>
                  <MenuItem value="ac97">Audio: AC97</MenuItem>
                </TextField>
              </Box>
              <Box>
                <FormControlLabel
                  control={<Checkbox checked={s.clipboard} disabled={s.headless} onChange={e => set({ clipboard: e.target.checked })} />}
                  label="Share the clipboard with the console"
                />
                <Typography sx={{ fontSize: 12.5, color: t.muted, ml: 4, mt: -0.5 }}>
                  Copy and paste between this computer and the VM&apos;s desktop. The guest needs the SPICE agent (spice-vdagent: Fedora and Ubuntu desktops have it; Windows: spice-guest-tools).
                </Typography>
              </Box>
              <Field label="Power policy">
                <TextField select size="small" value={s.runStrategy} onChange={e => set({ runStrategy: e.target.value })} sx={{ minWidth: 260 }} inputProps={{ 'aria-label': 'Power policy' }}>
                  {RUN_STRATEGIES.filter(r => r.value !== 'Halted' && r.value !== 'Once').map(r => (
                    <MenuItem key={r.value} value={r.value}>
                      {r.label}
                    </MenuItem>
                  ))}
                </TextField>
                <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.5 }}>{RUN_STRATEGIES.find(r => r.value === s.runStrategy)?.help}</Typography>
              </Field>
              <Field label="On host maintenance">
                <TextField select size="small" value={s.eviction} onChange={e => set({ eviction: e.target.value })} sx={{ minWidth: 260 }} SelectProps={{ displayEmpty: true }} inputProps={{ 'aria-label': 'On host maintenance' }}>
                  <MenuItem value="">Cluster default</MenuItem>
                  <MenuItem value="LiveMigrate" disabled={!dsInfo?.shared}>
                    Move it while running
                  </MenuItem>
                  <MenuItem value="LiveMigrateIfPossible">Move it if it can, else shut it down</MenuItem>
                  <MenuItem value="None">Shut it down</MenuItem>
                </TextField>
              </Field>
            </Box>
            {error && <Box sx={{ mt: 2, p: 1.5, border: '1px solid #E5484D', borderRadius: 1, fontSize: 14 }}>{error}</Box>}
            {yaml && (
              <EditorDialog
                open
                item={buildVm(w)}
                onClose={() => setYaml(false)}
                onSave={(items: any) => {
                  const vm = Array.isArray(items) ? items[0] : items;
                  setYaml(false);
                  create(vm);
                }}
                saveLabel="Create"
                title="VirtualMachine to create"
              />
            )}
          </>
        );
      }
    }
  })();

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="lg" fullWidth aria-labelledby="hangar-wizard-title" PaperProps={{ sx: { height: 'min(760px, 92vh)' } }}>
      <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
        <Box component="nav" aria-label="Steps" sx={{ width: 230, flex: 'none', background: t.chassis, color: t.chassisText, py: 2, display: { xs: 'none', md: 'block' } }}>
          <Typography id="hangar-wizard-title" sx={{ px: 2.5, pb: 2, fontSize: 17, fontWeight: 600 }}>
            New virtual machine
          </Typography>
          {STEPS.map((x, i) => {
            const done = i < step && stepOk(i);
            const reachable = i <= step || STEPS.slice(0, i).every((_, j) => stepOk(j));
            return (
              <Box
                key={x.id}
                component="button"
                onClick={() => go(i)}
                disabled={!reachable}
                aria-current={i === step ? 'step' : undefined}
                sx={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  display: 'flex',
                  gap: 1.25,
                  alignItems: 'center',
                  width: '100%',
                  px: 2.5,
                  py: 1,
                  cursor: reachable ? 'pointer' : 'default',
                  color: i === step ? t.chassisText : reachable ? t.chassisMuted : 'rgba(154,165,175,0.45)',
                  background: i === step ? 'rgba(255,255,255,0.06)' : 'transparent',
                  borderLeft: `3px solid ${i === step ? '#3D8BFD' : 'transparent'}`,
                  fontSize: 14,
                  '&:focus-visible': { outline: '2px solid #3D8BFD', outlineOffset: -2 },
                }}
              >
                <Box
                  sx={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    flex: 'none',
                    border: `1.5px solid ${done ? '#2FBF71' : i === step ? '#3D8BFD' : 'rgba(154,165,175,0.5)'}`,
                    color: done ? '#2FBF71' : 'inherit',
                  }}
                >
                  {done ? <Icon icon="mdi:check" width={14} /> : i + 1}
                </Box>
                {x.label}
              </Box>
            );
          })}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', px: 3, pt: 2.5, pb: 1 }}>
            <Typography component="h2" sx={{ fontSize: 20, fontWeight: 600, flex: 1 }}>
              {STEPS[step].label}
            </Typography>
            <IconButton aria-label="Close" onClick={onClose} disabled={busy}>
              <Icon icon="mdi:close" width={20} />
            </IconButton>
          </Box>
          <Box sx={{ flex: 1, overflow: 'auto', px: 3, pb: 2 }}>{body}</Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', px: 3, py: 1.5, borderTop: `1px solid ${t.rule}` }}>
            <Typography sx={{ fontSize: 13, color: '#B7791F', flex: 1 }}>{problems[id] && id !== 'name' ? problems[id] : ''}</Typography>
            <Button color="inherit" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => setStep(step - 1)} disabled={step === 0 || busy}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="contained" disableElevation onClick={() => setStep(step + 1)} disabled={!stepOk(step)}>
                Next
              </Button>
            ) : (
              <>
                {k8s && (
                  <Button onClick={() => setYaml(true)} disabled={!allOk || busy} startIcon={<Icon icon="mdi:kubernetes" width={18} />}>
                    Review YAML
                  </Button>
                )}
                <Button variant="contained" disableElevation onClick={() => create()} disabled={!allOk || busy}>
                  {busy ? 'Creating…' : 'Create VM'}
                </Button>
              </>
            )}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
