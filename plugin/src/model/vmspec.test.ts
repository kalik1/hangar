import { buildVm, cloudInitUserData, copyVm, nameProblem, slugify, withHostname,WizardInput } from './vmspec';

const base: WizardInput = {
  name: 'web-03',
  namespace: 'prod',
  sockets: 1,
  cores: 2,
  threads: 1,
  memoryBytes: 2 * 2 ** 30,
  firmware: 'bios',
  tpm: false,
  source: { kind: 'image', namespace: 'hangar-library', name: 'fedora' },
  rootDisk: { name: 'rootdisk', sizeBytes: 20 * 2 ** 30, storageClass: 'fast', bus: 'virtio' },
  extraDisks: [],
  nics: [{ name: 'default', network: '', model: 'virtio' }],
  runStrategy: 'Always',
};

describe('names', () => {
  it('checks DNS labels', () => {
    expect(nameProblem('web-03')).toBeNull();
    expect(nameProblem('Web')).toMatch(/lowercase/);
    expect(nameProblem('')).toMatch(/Enter/);
    expect(slugify('Web Server 01!')).toBe('web-server-01');
  });
});

describe('buildVm', () => {
  it('clones a library image into the boot disk', () => {
    const vm = buildVm({ ...base, cloudInit: { user: 'admin', sshKeys: ['ssh-ed25519 AAA me'] } });
    expect(vm.spec.dataVolumeTemplates[0]).toEqual({
      metadata: { name: 'web-03-rootdisk' },
      spec: {
        source: { pvc: { namespace: 'hangar-library', name: 'fedora' } },
        storage: { resources: { requests: { storage: '20Gi' } }, storageClassName: 'fast' },
      },
    });
    const t = vm.spec.template.spec;
    expect(t.domain.cpu).toEqual({ sockets: 1, cores: 2, threads: 1 });
    expect(t.domain.memory).toEqual({ guest: '2Gi' });
    expect(t.networks).toEqual([{ name: 'default', pod: {} }]);
    expect(t.domain.devices.interfaces).toEqual([{ name: 'default', masquerade: {}, model: 'virtio' }]);
    expect(t.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud.userData).toContain('hostname: web-03');
  });
  it('installs from an ISO: blank system disk, CD/DVD first, no cloud-init', () => {
    const vm = buildVm({ ...base, source: { kind: 'iso', namespace: 'lib', name: 'alpine' }, cloudInit: { user: 'x' } });
    const t = vm.spec.template.spec;
    expect(vm.spec.dataVolumeTemplates.map((d: any) => Object.keys(d.spec.source)[0])).toEqual(['blank', 'pvc']);
    expect(t.domain.devices.disks.find((d: any) => d.cdrom).bootOrder).toBe(1);
    expect(t.volumes.some((v: any) => v.cloudInitNoCloud)).toBe(false);
  });
  it('uses a size profile instead of custom sizing, bridges attachments, sets secure boot', () => {
    const vm = buildVm({ ...base, instancetype: 'u1.small', preference: 'fedora', firmware: 'uefi-secure', tpm: true, nics: [{ name: 'lan', network: 'prod/vlan10', model: 'virtio' }] });
    expect(vm.spec.instancetype).toEqual({ kind: 'VirtualMachineClusterInstancetype', name: 'u1.small' });
    const d = vm.spec.template.spec.domain;
    expect(d.cpu).toBeUndefined();
    expect(d.firmware.bootloader.efi.secureBoot).toBe(true);
    expect(d.features.smm.enabled).toBe(true);
    expect(d.devices.tpm).toEqual({ persistent: true });
    expect(vm.spec.template.spec.networks).toEqual([{ name: 'lan', multus: { networkName: 'prod/vlan10' } }]);
  });
  it('creates a protected, paused, headless VM with a sound card', () => {
    const vm = buildVm({ ...base, protected: true, startPaused: true, headless: true, sound: 'ich9' });
    expect(vm.metadata.labels['hangar.magesgate.com/protected']).toBe('true');
    expect(vm.spec.dataVolumeTemplates[0].metadata.labels).toEqual({ 'hangar.magesgate.com/protected': 'true' });
    const t = vm.spec.template.spec;
    expect(t.startStrategy).toBe('Paused');
    expect(t.domain.devices.autoattachGraphicsDevice).toBe(false);
    expect(t.domain.devices.inputs).toBeUndefined();
    expect(t.domain.devices.sound).toEqual({ name: 'sound', model: 'ich9' });
    const plain = buildVm(base);
    expect(plain.metadata.labels['hangar.magesgate.com/protected']).toBeUndefined();
    expect(plain.spec.template.spec.startStrategy).toBeUndefined();
    expect(plain.spec.template.spec.domain.devices.inputs).toHaveLength(1);
  });
  it('gives pod-network adapters the chosen NAT range', () => {
    const vm = buildVm({ ...base, vmNetworkCidr: '172.31.254.0/24', nics: [{ name: 'default', network: '', model: 'virtio' }, { name: 'lan', network: 'prod/vlan', model: 'virtio' }] });
    expect(vm.spec.template.spec.networks).toEqual([
      { name: 'default', pod: { vmNetworkCIDR: '172.31.254.0/24' } },
      { name: 'lan', multus: { networkName: 'prod/vlan' } },
    ]);
    expect(buildVm(base).spec.template.spec.networks[0]).toEqual({ name: 'default', pod: {} });
  });
  it('asks for k4all’s metadata service on the VM template, with the chassis tag cloud-init looks for', () => {
    const vm = buildVm({ ...base, labels: { team: 'web' }, metadata: { serviceAccount: 'builder' }, cloudInit: { user: 'admin' } });
    expect(vm.spec.template.metadata.labels).toEqual({ team: 'web', 'k4all.magesgate.com/metadata': 'enabled', 'k4all.magesgate.com/service-account': 'builder' });
    // on the template only: the VM object keeps its own tags
    expect(vm.metadata.labels).toEqual({ team: 'web' });
    expect(vm.spec.template.spec.domain.chassis).toEqual({ asset: 'OpenStack Nova' });
    // the cloud-init disk stays (PodSecurity baseline folders, D8)
    expect(vm.spec.template.spec.volumes.some((v: any) => v.cloudInitNoCloud)).toBe(true);
    const plain = buildVm(base);
    expect(plain.spec.template.metadata.labels['k4all.magesgate.com/metadata']).toBeUndefined();
    expect(plain.spec.template.spec.domain.chassis).toBeUndefined();
  });
  it('writes cloud-config with keys and password', () => {
    const u = cloudInitUserData({ user: 'admin', password: 'p"w', sshKeys: ['k1', ' '] }, 'h');
    expect(u).toContain('user: admin');
    expect(u).toContain('password: "p\\"w"');
    expect(u).toContain('- "k1"');
    expect(u).not.toContain('- ""');
  });
});

describe('copyVm', () => {
  const src = {
    metadata: { name: 'tpl-fedora', namespace: 'demo', labels: { 'hangar.magesgate.com/template': 'true', app: 'x' }, annotations: { description: 'Fedora' } },
    spec: {
      runStrategy: 'Halted',
      dataVolumeTemplates: [{ metadata: { name: 'tpl-fedora-rootdisk' }, spec: { storage: { resources: { requests: { storage: '10Gi' } } } } }],
      template: {
        metadata: { labels: { 'kubevirt.io/domain': 'tpl-fedora' } },
        spec: {
          domain: { devices: { interfaces: [{ name: 'default', masquerade: {}, macAddress: '02:aa' }] }, firmware: { uuid: 'u', serial: 's' } },
          volumes: [
            { name: 'rootdisk', dataVolume: { name: 'tpl-fedora-rootdisk' } },
            { name: 'cloudinitdisk', cloudInitNoCloud: { userData: '#cloud-config\nhostname: tpl\n' } },
          ],
        },
      },
    },
  };
  const pvcs = new Map([['demo/tpl-fedora-rootdisk', { metadata: { name: 'tpl-fedora-rootdisk' }, spec: { storageClassName: 'fast' }, status: { capacity: { storage: '12Gi' } } }]]);
  it('clones each disk and gives the copy its own identity', () => {
    const vm = copyVm(src, { name: 'web-04', namespace: 'prod', runStrategy: 'Always', pvcs });
    expect(vm.metadata.labels).toEqual({ app: 'x' });
    expect(vm.spec.dataVolumeTemplates).toEqual([
      {
        metadata: { name: 'web-04-rootdisk' },
        spec: { source: { pvc: { namespace: 'demo', name: 'tpl-fedora-rootdisk' } }, storage: { resources: { requests: { storage: '12Gi' } }, storageClassName: 'fast' } },
      },
    ]);
    const t = vm.spec.template.spec;
    expect(t.volumes[0]).toEqual({ name: 'rootdisk', dataVolume: { name: 'web-04-rootdisk' } });
    expect(t.domain.devices.interfaces[0].macAddress).toBeUndefined();
    expect(t.domain.firmware).toEqual({});
    expect(t.volumes[1].cloudInitNoCloud.userData).toContain('hostname: web-04');
    expect(vm.spec.template.metadata.labels['kubevirt.io/domain']).toBeUndefined();
    expect(vm.spec.runStrategy).toBe('Always');
    expect(vm.metadata.annotations['hangar.magesgate.com/copied-from']).toBe('demo/tpl-fedora');
  });
  it('keeps the template mark when cloning to a template', () => {
    const vm = copyVm(src, { name: 'tpl-2', namespace: 'demo', runStrategy: 'Halted', pvcs, asTemplate: true });
    expect(vm.metadata.labels['hangar.magesgate.com/template']).toBe('true');
  });
  it('sets a hostname in cloud-config', () => {
    expect(withHostname('#cloud-config\nuser: a\n', 'x')).toBe('#cloud-config\nhostname: x\nuser: a\n');
  });
});

describe('buildVm DNS', () => {
  it('writes custom DNS for the pod network', () => {
    const plain = buildVm(base);
    expect(plain.spec.template.spec.dnsPolicy).toBeUndefined();
    const vm = buildVm({ ...base, dns: { policy: 'None', nameservers: ['192.0.2.53'], searches: ['example.com'] } });
    expect(vm.spec.template.spec.dnsPolicy).toBe('None');
    expect(vm.spec.template.spec.dnsConfig).toEqual({ nameservers: ['192.0.2.53'], searches: ['example.com'] });
  });
});

describe('buildVm flavors and CPU model', () => {
  it('uses a folder flavor and a CPU model', () => {
    const vm = buildVm({ ...base, instancetype: 'db.large', instancetypeKind: 'VirtualMachineInstancetype', cpuModel: 'SandyBridge' });
    expect(vm.spec.instancetype).toEqual({ kind: 'VirtualMachineInstancetype', name: 'db.large' });
    expect(vm.spec.template.spec.domain.cpu).toEqual({ model: 'SandyBridge' });
    expect(vm.spec.template.spec.domain.memory).toBeUndefined();
  });
  it('keeps custom sizing with a CPU model', () => {
    const vm = buildVm({ ...base, cpuModel: 'Westmere' });
    expect(vm.spec.template.spec.domain.cpu).toEqual({ sockets: 1, cores: 2, threads: 1, model: 'Westmere' });
    expect(buildVm(base).spec.instancetype).toBeUndefined();
  });
});

describe('buildVm template annotations', () => {
  it('puts instance annotations on the template', () => {
    const vm = buildVm({ ...base, templateAnnotations: { 'hooks.kubevirt.io/hookSidecars': '[]' } });
    expect(vm.spec.template.metadata.annotations).toEqual({ 'hooks.kubevirt.io/hookSidecars': '[]' });
    expect(buildVm(base).spec.template.metadata.annotations).toBeUndefined();
  });
});
