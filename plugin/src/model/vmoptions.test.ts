import * as E from './edit';
import * as P from './protection';
import * as O from './vmoptions';

const vm = (): any => ({
  metadata: { name: 'web', namespace: 'lab', labels: { app: 'shop' }, resourceVersion: '3' },
  spec: {
    runStrategy: 'Always',
    dataVolumeTemplates: [
      { metadata: { name: 'web-rootdisk' }, spec: {} },
      { metadata: { name: 'web-cdrom' }, spec: {} },
    ],
    template: {
      spec: {
        domain: {
          cpu: { sockets: 2, cores: 1, threads: 1 },
          memory: { guest: '2Gi' },
          firmware: { bootloader: { efi: { secureBoot: false } }, uuid: 'old' },
          devices: {
            disks: [
              { name: 'rootdisk', disk: { bus: 'virtio' }, bootOrder: 1 },
              { name: 'cdrom', cdrom: { bus: 'sata', readonly: true } },
              { name: 'data', disk: { bus: 'sata' } },
            ],
            inputs: [{ name: 'tablet', type: 'tablet', bus: 'usb' }],
            interfaces: [{ name: 'default', masquerade: {} }],
            tpm: {},
          },
        },
        volumes: [
          { name: 'rootdisk', dataVolume: { name: 'web-rootdisk' } },
          { name: 'cdrom', dataVolume: { name: 'web-cdrom' } },
          { name: 'data', persistentVolumeClaim: { claimName: 'shared-data' } },
        ],
      },
    },
  },
});

const dom = (v: any) => v.spec.template.spec.domain;

describe('options', () => {
  it('sets the guest clock and keeps timers', () => {
    const a = vm();
    dom(a).clock = { utc: {}, timer: { hpet: { present: false } } };
    expect(O.clockOf(a)).toEqual({ mode: 'utc' });
    const tz = O.setClock(a, { mode: 'timezone', timezone: 'Europe/Rome' });
    expect(dom(tz).clock).toEqual({ timezone: 'Europe/Rome', timer: { hpet: { present: false } } });
    const off = O.setClock(vm(), { mode: 'offset', offsetSeconds: 3600.4 });
    expect(dom(off).clock).toEqual({ utc: { offsetSeconds: 3600 } });
    expect(O.clockOf(off)).toEqual({ mode: 'offset', offsetSeconds: 3600 });
    expect(dom(O.setClock(vm(), { mode: 'default' })).clock).toBeUndefined();
  });
  it('starts paused', () => {
    const p = O.setStartPaused(vm(), true);
    expect(p.spec.template.spec.startStrategy).toBe('Paused');
    expect(O.startPaused(p)).toBe(true);
    expect(O.setStartPaused(p, false).spec.template.spec.startStrategy).toBeUndefined();
  });
  it('turns the tablet and ACPI on and off', () => {
    const noTab = O.setTablet(vm(), false);
    expect(dom(noTab).devices.inputs).toBeUndefined();
    expect(O.tabletOf(noTab)).toBe(false);
    expect(dom(O.setTablet(noTab, true)).devices.inputs).toEqual([{ name: 'tablet', type: 'tablet', bus: 'usb' }]);
    const off = O.setAcpi(vm(), false);
    expect(dom(off).features).toEqual({ acpi: { enabled: false } });
    expect(O.acpiOf(off)).toBe(false);
    expect(dom(O.setAcpi(off, true)).features).toBeUndefined();
  });
  it('sets SMBIOS and drops empty fields', () => {
    const s = O.smbiosOf(vm());
    expect(s.uuid).toBe('old');
    const next = O.setSmbios(vm(), { uuid: ' 9854a2a1-749a-4343-8f4d-781c36dd2599 ', serial: 'SN1', chassis: { ...s.chassis, manufacturer: 'ACME', asset: 'A-17' } });
    expect(dom(next).firmware).toMatchObject({ uuid: '9854a2a1-749a-4343-8f4d-781c36dd2599', serial: 'SN1', bootloader: { efi: { secureBoot: false } } });
    expect(dom(next).chassis).toEqual({ manufacturer: 'ACME', asset: 'A-17' });
    expect(dom(O.setSmbios(next, { uuid: '', serial: '', chassis: { manufacturer: '', version: '', serial: '', asset: '', sku: '' } })).chassis).toBeUndefined();
    expect(O.UUID_RE.test('9854a2a1-749a-4343-8f4d-781c36dd2599')).toBe(true);
  });
  it('changes the guest OS tuning and lets KubeVirt pick the revision', () => {
    const a = vm();
    a.spec.preference = { kind: 'VirtualMachineClusterPreference', name: 'fedora', revisionName: 'r1' };
    expect(O.setPreference(a, { kind: 'VirtualMachineClusterPreference', name: 'rhel.9' }).spec.preference).toEqual({ kind: 'VirtualMachineClusterPreference', name: 'rhel.9' });
    expect(O.setPreference(a, null).spec.preference).toBeUndefined();
  });
});

describe('devices', () => {
  it('reads and sets every device option', () => {
    expect(O.deviceOptions(vm())).toMatchObject({ graphics: true, video: '', sound: '', rng: false, watchdog: '', panic: '', vsock: false });
    const next = O.setDevices(vm(), {
      graphics: false,
      video: 'virtio',
      sound: 'ac97',
      rng: true,
      watchdog: 'poweroff',
      panic: 'isa',
      vsock: true,
      downwardMetrics: true,
      blockMultiQueue: true,
      nicMultiQueue: true,
      ioThreadsPolicy: 'supplementalPool',
      ioThreadsCount: 4,
    });
    const dv = dom(next).devices;
    expect(dv).toMatchObject({
      autoattachGraphicsDevice: false,
      video: { type: 'virtio' },
      sound: { name: 'sound', model: 'ac97' },
      rng: {},
      watchdog: { name: 'watchdog', i6300esb: { action: 'poweroff' } },
      panicDevices: [{ model: 'isa' }],
      autoattachVSOCK: true,
      downwardMetrics: {},
      blockMultiQueue: true,
      networkInterfaceMultiqueue: true,
    });
    expect(dom(next)).toMatchObject({ ioThreadsPolicy: 'supplementalPool', ioThreads: { supplementalPoolThreadCount: 4 } });
    expect(O.deviceOptions(next)).toMatchObject({ graphics: false, video: 'virtio', sound: 'ac97', watchdog: 'poweroff', panic: 'isa', ioThreadsCount: 4 });
    const back = O.setDevices(next, { graphics: true, video: '', sound: '', rng: false, watchdog: '', panic: '', vsock: false, downwardMetrics: false, blockMultiQueue: false, nicMultiQueue: false, ioThreadsPolicy: '' });
    const b = dom(back);
    for (const k of ['autoattachGraphicsDevice', 'video', 'sound', 'rng', 'watchdog', 'panicDevices', 'autoattachVSOCK', 'downwardMetrics', 'blockMultiQueue', 'networkInterfaceMultiqueue'])
      expect(b.devices[k]).toBeUndefined();
    expect(b.ioThreadsPolicy).toBeUndefined();
    expect(b.ioThreads).toBeUndefined();
  });
});

describe('CPU', () => {
  it('sets CPU flags without duplicates and removes them', () => {
    const f = O.setCpuFlags(vm(), [
      { name: 'vmx', policy: 'require' },
      { name: 'vmx', policy: 'disable' },
      { name: 'avx512f', policy: 'disable' },
    ]);
    expect(dom(f).cpu.features).toEqual([
      { name: 'vmx', policy: 'require' },
      { name: 'avx512f', policy: 'disable' },
    ]);
    expect(dom(O.setCpuFlags(f, [])).cpu).toEqual({ sockets: 2, cores: 1, threads: 1 });
  });
  it('lists the flags each host offers', () => {
    const m = O.hostFlags([
      { metadata: { name: 'a', labels: { 'cpu-feature.node.kubevirt.io/vmx': 'true', 'cpu-feature.node.kubevirt.io/avx2': 'true' } } },
      { metadata: { name: 'b', labels: { 'cpu-feature.node.kubevirt.io/svm': 'true', 'cpu-feature.node.kubevirt.io/avx2': 'true' } } },
    ]);
    expect(m.get('avx2')).toEqual(['a', 'b']);
    expect(m.get('vmx')).toEqual(['a']);
  });
  it('sets reservation and limits, and checks them', () => {
    const r = O.setReservation(vm(), { cpuRequest: '500m', cpuLimit: '2', memoryRequest: '1Gi', memoryLimit: '' });
    expect(dom(r).resources).toEqual({ requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2' } });
    expect(O.reservationOf(r)).toEqual({ cpuRequest: '500m', cpuLimit: '2', memoryRequest: '1Gi', memoryLimit: '' });
    expect(dom(O.setReservation(r, { cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '' })).resources).toEqual({});
    const G = 2 ** 30;
    expect(O.reservationProblem({ cpuRequest: '3', cpuLimit: '2', memoryRequest: '', memoryLimit: '' }, 2 * G)).toMatch(/above the limit/);
    expect(O.reservationProblem({ cpuRequest: '', cpuLimit: '', memoryRequest: '', memoryLimit: '1Gi' }, 2 * G)).toMatch(/killed/);
    expect(O.reservationProblem({ cpuRequest: 'lots', cpuLimit: '', memoryRequest: '', memoryLimit: '' }, 2 * G)).toMatch(/millicores/);
    expect(O.reservationProblem({ cpuRequest: '250m', cpuLimit: '1', memoryRequest: '1Gi', memoryLimit: '3Gi' }, 2 * G)).toBeNull();
  });
  it('sets hot-add ceilings', () => {
    const h = O.setHotAddLimits(vm(), { maxSockets: 8, maxGuestBytes: 8 * 2 ** 30 });
    expect(dom(h).cpu.maxSockets).toBe(8);
    expect(dom(h).memory).toEqual({ guest: '2Gi', maxGuest: '8Gi' });
    expect(O.hotAddLimitsOf(h)).toEqual({ maxSockets: 8, maxGuest: '8Gi' });
    const back = O.setHotAddLimits(h, { maxSockets: null, maxGuestBytes: null });
    expect(dom(back).cpu.maxSockets).toBeUndefined();
    expect(dom(back).memory).toEqual({ guest: '2Gi' });
  });
  it('says what a running VM takes at once', () => {
    const G = 2 ** 30;
    const vmi = { spec: { domain: { cpu: { sockets: 2, cores: 1, threads: 1, maxSockets: 8 }, memory: { guest: '2Gi', maxGuest: '8Gi' } } }, status: { memory: { guestAtBoot: '2Gi' } } };
    const ok = { liveUpdate: true, liveMigrateUpdates: true, migratable: { ok: true } };
    expect(O.liveCompute(vmi, { sockets: 4, cores: 1, threads: 1, memoryBytes: 4 * G }, ok)).toEqual({ cpu: 'live', memory: 'live', why: [] });
    expect(O.liveCompute(vmi, { sockets: 2, cores: 2, threads: 1, memoryBytes: 2 * G }, ok)).toMatchObject({ cpu: 'restart', memory: 'same' });
    expect(O.liveCompute(vmi, { sockets: 1, cores: 1, threads: 1, memoryBytes: 1 * G }, ok)).toMatchObject({ cpu: 'restart', memory: 'restart' });
    expect(O.liveCompute(vmi, { sockets: 9, cores: 1, threads: 1, memoryBytes: 9 * G }, ok).why.join(' ')).toMatch(/8 sockets.*8 GiB/);
    const stuck = O.liveCompute(vmi, { sockets: 3, cores: 1, threads: 1, memoryBytes: 2 * G }, { ...ok, migratable: { ok: false, why: 'a local disk' } });
    expect(stuck.cpu).toBe('restart');
    expect(stuck.why[0]).toMatch(/a local disk/);
    expect(O.liveCompute(vmi, { sockets: 3, cores: 1, threads: 1, memoryBytes: 2 * G }, { ...ok, liveMigrateUpdates: false }).why[0]).toMatch(/LiveMigrate/);
    expect(O.liveCompute({ spec: { domain: { cpu: { sockets: 1 }, memory: { guest: '512Mi' } } } }, { sockets: 1, cores: 1, threads: 1, memoryBytes: G }, ok).why[0]).toMatch(/maxGuest/);
  });
});

describe('disk settings', () => {
  it('reads and writes cache, I/O, serial, block size and the rest', () => {
    const s = O.diskSettingsOf(vm(), 'rootdisk')!;
    expect(s).toMatchObject({ cache: '', io: '', dedicatedIOThread: false, readonly: false, blockSize: { mode: 'default' } });
    const next = O.setDiskSettings(vm(), 'rootdisk', {
      ...s,
      cache: 'none',
      io: 'native',
      dedicatedIOThread: true,
      serial: 'ROOT-01',
      readonly: true,
      shareable: true,
      errorPolicy: 'report',
      blockSize: { mode: 'custom', logical: 512, physical: 4096 },
    });
    expect(dom(next).devices.disks[0]).toEqual({
      name: 'rootdisk',
      disk: { bus: 'virtio', readonly: true },
      bootOrder: 1,
      cache: 'none',
      io: 'native',
      dedicatedIOThread: true,
      serial: 'ROOT-01',
      shareable: true,
      errorPolicy: 'report',
      blockSize: { custom: { logical: 512, physical: 4096 } },
    });
    const back = O.setDiskSettings(next, 'rootdisk', { ...s, blockSize: { mode: 'match' } });
    expect(dom(back).devices.disks[0]).toEqual({ name: 'rootdisk', disk: { bus: 'virtio' }, bootOrder: 1, blockSize: { matchVolume: { enabled: true } } });
  });
  it('follows KubeVirt rules per bus', () => {
    const base = O.diskSettingsOf(vm(), 'data')!;
    expect(O.diskSettingsProblem({ ...base, dedicatedIOThread: true }, 'sata')).toMatch(/VirtIO/);
    expect(O.diskSettingsProblem({ ...base, readonly: true }, 'sata')).toMatch(/SATA/);
    expect(O.diskSettingsProblem({ ...base, shareable: true, cache: 'writeback' }, 'virtio')).toMatch(/none/);
    expect(O.diskSettingsProblem({ ...base, serial: 'bad serial!' }, 'virtio')).toMatch(/serial/);
    expect(O.diskSettingsProblem({ ...base, blockSize: { mode: 'custom', logical: 4096, physical: 512 } }, 'virtio')).toMatch(/logical/);
    expect(O.diskSettingsProblem({ ...base, blockSize: { mode: 'custom', logical: 1000, physical: 4096 } }, 'virtio')).toMatch(/powers of 2/);
    expect(O.diskSettingsProblem({ ...base, blockSize: { mode: 'custom', logical: 4096, physical: 4096 } }, 'sata')).toMatch(/512-byte/);
    expect(O.diskSettingsProblem({ ...base, cache: 'none', io: 'native', serial: 'ok_1.2+3-4' }, 'virtio')).toBeNull();
  });
});

describe('shared folders', () => {
  it('adds and removes virtiofs shares from a disk, a ConfigMap or a Secret', () => {
    let v = O.addShare(vm(), 'data2', { kind: 'pvc', claimName: 'team-files' });
    v = O.addShare(v, 'conf', { kind: 'configMap', name: 'app-config' });
    v = O.addShare(v, 'keys', { kind: 'secret', name: 'app-keys' });
    expect(dom(v).devices.filesystems).toEqual([
      { name: 'data2', virtiofs: {} },
      { name: 'conf', virtiofs: {} },
      { name: 'keys', virtiofs: {} },
    ]);
    expect(O.sharesOf(v).map(s => s.source)).toEqual([
      { kind: 'pvc', claimName: 'team-files' },
      { kind: 'configMap', name: 'app-config' },
      { kind: 'secret', name: 'app-keys' },
    ]);
    expect(O.shareGate({ kind: 'pvc', claimName: 'x' })).toBe('EnableVirtioFsStorageVolumes');
    expect(O.shareGate({ kind: 'secret', name: 'x' })).toBe('EnableVirtioFsConfigVolumes');
    const r = O.removeShare(O.removeShare(O.removeShare(v, 'data2'), 'conf'), 'keys');
    expect(dom(r).devices.filesystems).toBeUndefined();
    expect(r.spec.template.spec.volumes).toHaveLength(3);
    expect(O.mountCommand('conf')).toBe('sudo mkdir -p /mnt/conf && sudo mount -t virtiofs conf /mnt/conf');
  });
});

describe('GPU display and firmware state', () => {
  it('sets a vGPU display with its boot framebuffer', () => {
    const a = vm();
    dom(a).devices.gpus = [{ name: 'gpu1', deviceName: 'nvidia.com/GRID_T4-1Q' }];
    expect(O.gpuDisplayOf(dom(a).devices.gpus[0])).toEqual({ display: false, ramFB: true });
    const on = O.setGpuDisplay(a, 'gpu1', { display: true, ramFB: false });
    expect(dom(on).devices.gpus[0].virtualGPUOptions).toEqual({ display: { enabled: true, ramFB: { enabled: false } } });
    expect(O.gpuDisplayOf(dom(on).devices.gpus[0])).toEqual({ display: true, ramFB: false });
    expect(dom(O.setGpuDisplay(on, 'gpu1', { display: false, ramFB: true })).devices.gpus[0].virtualGPUOptions).toEqual({ display: { enabled: false } });
  });
  it('keeps UEFI variables and the TPM on a disk', () => {
    const p = O.setPersistence(vm(), { efi: true, tpm: true });
    expect(dom(p).firmware.bootloader.efi).toEqual({ secureBoot: false, persistent: true });
    expect(dom(p).devices.tpm).toEqual({ persistent: true });
    expect(O.persistenceOf(p)).toEqual({ efi: true, tpm: true });
    expect(O.persistenceOf(O.setPersistence(p, { efi: false, tpm: false }))).toEqual({ efi: false, tpm: false });
  });
});

describe('hot-plug edits', () => {
  it('adds hot-pluggable disks and resets a left-over volume migration strategy', () => {
    const a = vm();
    a.spec.updateVolumesStrategy = 'Migration';
    const { vm: b, name } = E.addBlankDisk(a, { sizeBytes: 2 ** 30, storageClass: 'ceph-rbd', bus: 'scsi', hotplug: true });
    expect(b.spec.template.spec.volumes.find((v: any) => v.name === name)).toEqual({ name, dataVolume: { name: 'web-disk', hotpluggable: true } });
    expect(b.spec.updateVolumesStrategy).toBeUndefined();
    const { vm: c, name: n2 } = E.attachDisk(vm(), 'lab-spare', 'virtio', true);
    expect(c.spec.template.spec.volumes.find((v: any) => v.name === n2).persistentVolumeClaim).toEqual({ claimName: 'lab-spare', hotpluggable: true });
    expect(E.isHotpluggable(c, n2)).toBe(true);
    expect(E.isHotpluggable(c, 'rootdisk')).toBe(false);
  });
  it('ejects media and keeps the empty drive, then inserts an ISO into it live', () => {
    const r = E.ejectCdrom(vm(), 'cdrom', true);
    expect(r).toMatchObject({ claim: 'web-cdrom', owned: true });
    expect(dom(r.vm).devices.disks.find((d: any) => d.name === 'cdrom')).toBeTruthy();
    expect(r.vm.spec.template.spec.volumes.find((v: any) => v.name === 'cdrom')).toBeUndefined();
    expect(r.vm.spec.dataVolumeTemplates.map((d: any) => d.metadata.name)).toEqual(['web-rootdisk']);
    const ins = E.insertIso(r.vm, { namespace: 'hangar-library', name: 'alpine', sizeBytes: 100 }, false, { drive: 'cdrom', hotplug: true });
    expect(dom(ins).devices.disks.filter((d: any) => d.cdrom)).toHaveLength(1);
    expect(ins.spec.template.spec.volumes.find((v: any) => v.name === 'cdrom')).toEqual({ name: 'cdrom', dataVolume: { name: 'web-cdrom', hotpluggable: true } });
    expect(E.ejectCdrom(vm(), 'cdrom', false).vm.spec.template.spec.domain.devices.disks.find((d: any) => d.name === 'cdrom')).toBeUndefined();
  });
  it('adds an empty CD/DVD drive', () => {
    const r = E.ejectCdrom(vm(), 'cdrom', true);
    const { vm: v, name } = E.addCdromDrive(r.vm);
    expect(name).toBe('cdrom1');
    expect(dom(v).devices.disks.find((d: any) => d.name === name)).toEqual({ name: 'cdrom1', cdrom: { bus: 'sata', readonly: true } });
  });
});

describe('protection', () => {
  it('labels the VM and its disk templates, not CD/DVD media', () => {
    const p = P.withVmProtection(vm(), true);
    expect(P.isProtected(p)).toBe(true);
    expect(p.metadata.labels).toEqual({ app: 'shop', [P.PROTECTED_LABEL]: 'true' });
    expect(p.spec.dataVolumeTemplates[0].metadata.labels).toEqual({ [P.PROTECTED_LABEL]: 'true' });
    expect(p.spec.dataVolumeTemplates[1].metadata.labels).toBeUndefined();
    expect(P.protectedClaims(p)).toEqual(['web-rootdisk', 'shared-data']);
    const off = P.withVmProtection(p, false);
    expect(off.metadata.labels).toEqual({ app: 'shop' });
    expect(off.spec.dataVolumeTemplates[0].metadata.labels).toBeUndefined();
    expect(P.protectionReason(p, 'web')).toMatch(/web is protected/);
    expect(P.protectionReason(off)).toBeUndefined();
  });
  it('reads the policy state', () => {
    expect(P.policyState(null, null)).toBe('missing');
    expect(P.policyState({ metadata: { name: 'p' } }, null)).toBe('unbound');
    expect(P.policyState({ metadata: { name: 'p' } }, { metadata: { name: 'b' }, spec: { validationActions: ['Deny'] } })).toBe('installed');
    expect(P.policyState({ metadata: { name: 'p' } }, { metadata: { name: 'b' }, spec: { validationActions: ['Audit'] } })).toBe('unbound');
    expect(P.policyState('forbidden', null)).toBe('unknown');
  });
});

describe('machine type', () => {
  const nodes = [
    { metadata: { name: 'a', labels: { 'machine-type.node.kubevirt.io/q35': 'true', 'machine-type.node.kubevirt.io/pc-q35-rhel9.6.0': 'true', 'machine-type.node.kubevirt.io/pc-q35-rhel9.4.0': 'true', 'machine-type.node.kubevirt.io/pc-i440fx-rhel7.6.0': 'true' } } },
    { metadata: { name: 'b', labels: { 'machine-type.node.kubevirt.io/q35': 'true', 'machine-type.node.kubevirt.io/pc-q35-rhel9.6.0': 'true' } } },
  ];
  it('matches like Go filepath.Match', () => {
    expect(O.globMatch('q35*', 'q35')).toBe(true);
    expect(O.globMatch('pc-q35*', 'pc-q35-rhel9.6.0')).toBe(true);
    expect(O.globMatch('pc-q35*', 'pc-i440fx-rhel7.6.0')).toBe(false);
    expect(O.globMatch('pc-q35-rhel9.?.0', 'pc-q35-rhel9.4.0')).toBe(true);
    expect(O.globMatch('pc-q35-rhel[89].*', 'pc-q35-rhel8.6.0')).toBe(true);
    expect(O.globMatch('pc-q35-rhel9.6.0', 'pc-q35-rhel9x6.0')).toBe(false);
  });
  it('reads what KubeVirt accepts, with its defaults', () => {
    expect(O.clusterMachines(null)).toEqual({ emulated: ['q35*', 'pc-q35*'], default: 'q35', from: 'kubevirt' });
    expect(O.clusterMachines({ spec: { configuration: { architectureConfiguration: { amd64: { emulatedMachines: ['pc-q35-rhel9*'], machineType: 'pc-q35-rhel9.4.0' } } } } })).toEqual({
      emulated: ['pc-q35-rhel9*'],
      default: 'pc-q35-rhel9.4.0',
      from: 'architectureConfiguration',
    });
    expect(O.clusterMachines({ spec: { configuration: { machineType: 'q35', emulatedMachines: ['q35'] } } }).from).toBe('configuration');
  });
  it('lists the hosts types, accepted ones first and newest first', () => {
    const c = O.machineChoices(null, nodes);
    expect(c.map(x => `${x.type}:${x.allowed}:${x.hosts.length}`)).toEqual(['pc-q35-rhel9.6.0:true:2', 'pc-q35-rhel9.4.0:true:1', 'q35:true:2', 'pc-i440fx-rhel7.6.0:false:1']);
  });
  it('sets and clears the machine type', () => {
    const v = O.setMachineType(vm(), 'pc-q35-rhel9.4.0');
    expect(O.machineTypeOf(v)).toBe('pc-q35-rhel9.4.0');
    expect(O.machineTypeOf(O.setMachineType(v, ''))).toBeUndefined();
  });
});
