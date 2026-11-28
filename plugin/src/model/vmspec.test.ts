import { addNic } from './edit';
import {
  buildVm,
  CLOUD_INIT_INLINE_MAX,
  cloudInitOverflow,
  cloudInitRefusal,
  cloudInitSecret,
  cloudInitSecretName,
  cloudInitSecretRefs,
  cloudInitUserData,
  copiedCloudInit,
  copyVm,
  localMac,
  nameProblem,
  slugify,
  userNameProblem,
  withCloudInitSecret,
  withHostname,
  withoutVolumes,
  WizardInput,
} from './vmspec';

const LOCAL_MAC = /^02(:[0-9a-f]{2}){5}$/;

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
    expect(t.domain.devices.interfaces).toEqual([{ name: 'default', masquerade: {}, model: 'virtio', macAddress: expect.stringMatching(LOCAL_MAC) }]);
    expect(t.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud.userData).toContain('hostname: web-03');
  });
  it('gives NAT adapters a fixed MAC (the wizard’s, else a new one) and leaves bridged ones to the network', () => {
    const vm = buildVm({
      ...base,
      nics: [
        { name: 'default', network: '', model: 'virtio', mac: '02:12:34:56:78:9a' },
        { name: 'lan', network: 'prod/vlan', model: 'virtio', mac: '02:00:00:00:00:01' },
      ],
    });
    const [nat, lan] = vm.spec.template.spec.domain.devices.interfaces;
    expect(nat.macAddress).toBe('02:12:34:56:78:9a');
    expect(lan.macAddress).toBeUndefined();
    expect(buildVm(base).spec.template.spec.domain.devices.interfaces[0].macAddress).toMatch(LOCAL_MAC);
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
});

describe('cloudInitUserData (hangar#7)', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample me@laptop';
  const AGENT = '  - [sh, -c, "systemctl enable --now qemu-guest-agent || rc-update add qemu-guest-agent default || true"]';
  const form = { user: 'k4all', password: 's3cret', sshKeys: [KEY, ' '] };
  const userBlock = (shell: boolean) => [
    'users:',
    '  - name: k4all',
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
    ...(shell ? ['    shell: /bin/bash'] : []),
    '    lock_passwd: false',
    '    plain_text_passwd: "s3cret"',
    '    ssh_authorized_keys:',
    `      - "${KEY}"`,
    'ssh_pwauth: true',
  ];

  it('Fedora, CentOS Stream, RHEL: the users list with k4all, no packages (the agent is in the image)', () => {
    const want = ['#cloud-config', 'hostname: web-03', ...userBlock(true), 'runcmd:', AGENT, ''].join('\n');
    for (const os of ['fedora', 'centos', 'rhel']) expect(cloudInitUserData(form, 'web-03', os)).toBe(want);
  });

  it('Ubuntu and Debian: the same, and packages installs the agent', () => {
    const want = ['#cloud-config', 'hostname: web-03', ...userBlock(true), 'packages: [qemu-guest-agent]', 'runcmd:', AGENT, ''].join('\n');
    expect(cloudInitUserData(form, 'web-03', 'ubuntu')).toBe(want);
    expect(cloudInitUserData(form, 'web-03', 'debian')).toBe(want);
  });

  it('Alpine and an unknown OS: no shell (the image’s default), no packages', () => {
    const want = ['#cloud-config', 'hostname: web-03', ...userBlock(false), 'runcmd:', AGENT, ''].join('\n');
    expect(cloudInitUserData(form, 'web-03', 'alpine')).toBe(want);
    expect(cloudInitUserData(form, 'web-03')).toBe(want);
  });

  it('never writes the deprecated user: key', () => {
    for (const os of ['fedora', 'ubuntu', 'debian', 'alpine', undefined]) expect(cloudInitUserData(form, 'h', os)).not.toMatch(/^user:/m);
  });

  it('without a password the user keeps a locked password and logs in with its keys', () => {
    expect(cloudInitUserData({ user: 'k4all', sshKeys: [KEY] }, 'h', 'fedora')).toBe(
      [
        '#cloud-config',
        'hostname: h',
        'users:',
        '  - name: k4all',
        '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
        '    shell: /bin/bash',
        '    ssh_authorized_keys:',
        `      - "${KEY}"`,
        'runcmd:',
        AGENT,
        '',
      ].join('\n')
    );
  });

  it('without a user the image’s default user gets the password and keys', () => {
    expect(cloudInitUserData({ password: 'p"w', sshKeys: ['k1', ' '] }, 'h', 'ubuntu')).toBe(
      [
        '#cloud-config',
        'hostname: h',
        'password: "p\\"w"',
        'chpasswd: { expire: false }',
        'ssh_pwauth: true',
        'ssh_authorized_keys:',
        '  - "k1"',
        'packages: [qemu-guest-agent]',
        'runcmd:',
        AGENT,
        '',
      ].join('\n')
    );
  });

  it('quotes a user name that is not a plain Linux name, and the wizard flags it', () => {
    expect(cloudInitUserData({ user: 'Bad: name' }, 'h', 'fedora')).toContain('  - name: "Bad: name"');
    expect(userNameProblem('Bad: name')).toMatch(/lowercase/);
    expect(userNameProblem('k4all')).toBeNull();
    expect(userNameProblem('')).toBeNull();
  });

  it('returns custom user data unchanged', () => {
    expect(cloudInitUserData({ custom: '#cloud-config\nusers: [default]\n', user: 'k4all' }, 'h', 'ubuntu')).toBe('#cloud-config\nusers: [default]\n');
  });

  it('buildVm passes the guest OS: an Ubuntu VM installs the agent', () => {
    const ud = (osId?: string) => buildVm({ ...base, osId, cloudInit: { user: 'k4all' } }).spec.template.spec.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud.userData;
    expect(ud('ubuntu')).toContain('packages: [qemu-guest-agent]');
    expect(ud('fedora')).not.toContain('packages:');
  });
});

describe('cloud-init over KubeVirt’s inline limit (hangar#7)', () => {
  /** Custom user data of exactly n bytes (ASCII). */
  const sized = (n: number) => '#cloud-config\n#' + 'x'.repeat(n - 16) + '\n';
  const vmWith = (userData: string) => buildVm({ ...base, cloudInit: { custom: userData } });

  it('keeps 2048 bytes inline and moves 2049 bytes out', () => {
    expect(sized(2048).length).toBe(2048);
    expect(cloudInitOverflow(vmWith(sized(CLOUD_INIT_INLINE_MAX)))).toEqual([]);
    const over = cloudInitOverflow(vmWith(sized(2049)));
    expect(over).toEqual([{ volume: 'cloudinitdisk', data: { stringData: { userdata: sized(2049) } }, bytes: 2049 }]);
  });

  it('counts bytes, not characters, as KubeVirt does', () => {
    const two = '#cloud-config\n#' + 'é'.repeat(1) + 'x'.repeat(2048 - 16 - 2) + '\n'; // 2047 characters, 2048 bytes
    expect(cloudInitOverflow(vmWith(two))).toEqual([]);
    expect(cloudInitOverflow(vmWith(two.replace('x', 'é')))[0].bytes).toBe(2049);
  });

  it('measures userDataBase64 decoded, and keeps it base64 in the Secret', () => {
    const vm = buildVm(base);
    const b64 = btoa(sized(2049));
    vm.spec.template.spec.volumes.push({ name: 'ci2', cloudInitConfigDrive: { userDataBase64: b64 } } as any);
    expect(cloudInitOverflow(vm)).toEqual([{ volume: 'ci2', data: { data: { userdata: b64 } }, bytes: 2049 }]);
  });

  it('the Secret: a name chosen before the VM, the VM’s folder, the key KubeVirt reads, owned by the VM from its creation; the VM refers to it instead', () => {
    const vm = vmWith(sized(3000));
    const [o] = cloudInitOverflow(vm);
    expect(cloudInitSecretName('web-03', n => Uint8Array.from({ length: n }, (_, i) => i * 9))).toBe('web-03-cloudinit-ajs1a');
    expect(cloudInitSecretName('web-03')).toMatch(/^web-03-cloudinit-[a-z0-9]{5}$/);
    const labels = { 'hangar.magesgate.com/cloud-init-of': 'web-03', 'app.kubernetes.io/managed-by': 'hangar' };
    expect(cloudInitSecret(vm, o, 'web-03-cloudinit-abcde')).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'web-03-cloudinit-abcde', namespace: 'prod', labels },
      type: 'Opaque',
      stringData: { userdata: sized(3000) },
    });
    expect(cloudInitSecret(vm, o, 'web-03-cloudinit-abcde', 'vm-uid').metadata).toEqual({
      name: 'web-03-cloudinit-abcde',
      namespace: 'prod',
      labels,
      ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'web-03', uid: 'vm-uid' }],
    });
    const out = withCloudInitSecret(vm, 'cloudinitdisk', 'web-03-cloudinit-abcde');
    expect(out.spec.template.spec.volumes.find((v: any) => v.name === 'cloudinitdisk')).toEqual({ name: 'cloudinitdisk', cloudInitNoCloud: { secretRef: { name: 'web-03-cloudinit-abcde' } } });
    expect(vm.spec.template.spec.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud.userData).toBe(sized(3000));
    expect(cloudInitOverflow(out)).toEqual([]);
    expect(cloudInitSecretRefs(out)).toEqual([{ volume: 'cloudinitdisk', secret: 'web-03-cloudinit-abcde' }]);
    expect(cloudInitSecretRefs(vm)).toEqual([]);
  });

  it('withoutVolumes drops a volume and its disk (a copy whose cloud-init Secret is not in its folder)', () => {
    const vm = withoutVolumes(vmWith('#cloud-config\n'), ['cloudinitdisk']);
    expect(vm.spec.template.spec.volumes.map((v: any) => v.name)).toEqual(['rootdisk']);
    expect(vm.spec.template.spec.domain.devices.disks.map((d: any) => d.name)).toEqual(['rootdisk']);
  });

  it('says why it refuses', () => {
    const [o] = cloudInitOverflow(vmWith(sized(2400)));
    expect(cloudInitRefusal(o, 'Not allowed: secrets is forbidden')).toBe(
      'The cloud-init user data is 2,400 bytes, more than the 2,048 KubeVirt takes inline, and Hangar could not keep it in a Secret: Not allowed: secrets is forbidden'
    );
  });

  it('a copy takes the source’s Secret-held user data into a Secret of its own, with its hostname, whatever its size', () => {
    const src = withCloudInitSecret(vmWith('#cloud-config\nhostname: web-03\n'), 'cloudinitdisk', 'web-03-cloudinit-abcde');
    const copy = copyVm(src, { name: 'web-09', namespace: 'test', runStrategy: 'Halted', pvcs: new Map() });
    expect(copy.spec.template.spec.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud).toEqual({ secretRef: { name: 'web-03-cloudinit-abcde' } });
    const [o] = copiedCloudInit(copy, new Map([['cloudinitdisk', '#cloud-config\nhostname: web-03\n']]));
    expect(o).toEqual({ volume: 'cloudinitdisk', data: { stringData: { userdata: '#cloud-config\nhostname: web-09\n' } }, bytes: 31, copied: true });
    expect(cloudInitRefusal(o, 'denied')).toBe('The source keeps its cloud-init user data in a Secret, and Hangar could not make one for the copy: denied');
    expect(copiedCloudInit(copy, new Map())).toEqual([]);
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
    expect(t.domain.devices.interfaces[0].macAddress).toMatch(LOCAL_MAC);
    expect(t.domain.firmware).toEqual({});
    expect(t.volumes[1].cloudInitNoCloud.userData).toContain('hostname: web-04');
    expect(vm.spec.template.metadata.labels['kubevirt.io/domain']).toBeUndefined();
    expect(vm.spec.runStrategy).toBe('Always');
    expect(vm.metadata.annotations['hangar.magesgate.com/copied-from']).toBe('demo/tpl-fedora');
  });
  it('gives NAT adapters a new fixed MAC and drops bridged and SR-IOV ones', () => {
    const nics = {
      ...src,
      spec: {
        ...src.spec,
        template: {
          ...src.spec.template,
          spec: {
            ...src.spec.template.spec,
            domain: {
              devices: {
                interfaces: [
                  { name: 'default', masquerade: {}, macAddress: '02:12:34:56:78:9a' },
                  { name: 'lan', bridge: {}, macAddress: '52:54:00:12:34:56' },
                  { name: 'fast', sriov: {}, macAddress: '52:54:00:ab:cd:ef' },
                ],
              },
            },
          },
        },
      },
    };
    const a = copyVm(nics, { name: 'web-05', namespace: 'prod', runStrategy: 'Always', pvcs }).spec.template.spec.domain.devices.interfaces;
    const b = copyVm(nics, { name: 'web-06', namespace: 'prod', runStrategy: 'Always', pvcs }).spec.template.spec.domain.devices.interfaces;
    expect(a[0].macAddress).toMatch(LOCAL_MAC);
    expect(a[0].macAddress).not.toBe('02:12:34:56:78:9a');
    expect(b[0].macAddress).not.toBe(a[0].macAddress);
    expect(a[1].macAddress).toBeUndefined();
    expect(a[2].macAddress).toBeUndefined();
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

describe('localMac', () => {
  it('is a locally administered unicast address', () => {
    expect(localMac(() => new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]))).toBe('02:de:ad:be:ef:01');
    expect(localMac()).toMatch(LOCAL_MAC);
    expect(localMac()).not.toBe(localMac());
  });
  it('is what a new NAT adapter gets; bridged ones get none', () => {
    const vm = buildVm({ ...base, nics: [{ name: 'lan', network: 'prod/vlan', model: 'virtio' }] });
    const nat = addNic(vm, '', 'virtio');
    expect(nat.vm.spec.template.spec.domain.devices.interfaces.find((i: any) => i.name === nat.name).macAddress).toMatch(LOCAL_MAC);
    const br = addNic(vm, 'prod/vlan2', 'virtio');
    expect(br.vm.spec.template.spec.domain.devices.interfaces.find((i: any) => i.name === br.name).macAddress).toBeUndefined();
  });
});
