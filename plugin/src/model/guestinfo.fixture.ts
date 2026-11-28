/*
 * KubeVirt's side of a VM's guest agent, for guestinfo.test.ts and the Guest
 * tab's tests: the VM and VMI of the bridge's Linux fixtures
 * (bridge/internal/guestinfo/testdata: disks with the serials rootdisk and
 * datadisk, eth0 with the MAC 02:5e:7a:00:00:01), and the answers of
 * guestosinfo, userlist and filesystemlist, in KubeVirt v1.9's shape.
 */

import { KvFilesystem, KvGuestAgentInfo, KvUser } from './guestinfo';
import { Obj } from './types';

export const linuxVm = (userData?: string): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'VirtualMachine',
  metadata: { name: 'vm', namespace: 'vms', uid: 'uid-vm' },
  spec: {
    template: {
      spec: {
        domain: {
          memory: { guest: '2Gi' },
          cpu: { cores: 2 },
          devices: {
            disks: [
              { name: 'rootdisk', serial: 'rootdisk', bootOrder: 1, disk: { bus: 'virtio' } },
              { name: 'datadisk', serial: 'datadisk', disk: { bus: 'virtio' } },
              { name: 'scratch', disk: { bus: 'virtio' } },
              { name: 'cloudinitdisk', disk: { bus: 'virtio' } },
            ],
            interfaces: [
              { name: 'default', masquerade: {}, macAddress: '02:5e:7a:00:00:01' },
              { name: 'lan', bridge: {}, macAddress: '02:5e:7a:00:00:09' },
            ],
          },
        },
        networks: [
          { name: 'default', pod: {} },
          { name: 'lan', multus: { networkName: 'vms/lan' } },
        ],
        volumes: [
          { name: 'rootdisk', dataVolume: { name: 'vm-root' } },
          { name: 'datadisk', persistentVolumeClaim: { claimName: 'vm-data' } },
          { name: 'scratch', emptyDisk: { capacity: '1Gi' } },
          {
            name: 'cloudinitdisk',
            cloudInitNoCloud: {
              userData:
                userData ??
                '#cloud-config\nhostname: vm\nusers:\n  - name: k4all\n    sudo: "ALL=(ALL) NOPASSWD:ALL"\n    ssh_authorized_keys:\n      - "ssh-ed25519 AAAA user@example"\nruncmd:\n  - [sh, -c, "true"]\n',
            },
          },
        ],
      },
    },
  },
});

export const linuxVmi = (connected = true): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'VirtualMachineInstance',
  metadata: { name: 'vm', namespace: 'vms', uid: 'uid-vmi' },
  status: {
    phase: 'Running',
    nodeName: 'node-a',
    conditions: connected ? [{ type: 'AgentConnected', status: 'True', lastTransitionTime: '2026-11-28T03:10:00Z' }] : [],
    guestOSInfo: connected
      ? { id: 'fedora', name: 'Fedora Linux', prettyName: 'Fedora Linux 45 (Cloud Edition)', version: '45 (Cloud Edition)', versionId: '45', kernelRelease: '7.2.11-300.fc45.x86_64', machine: 'x86_64' }
      : {},
    interfaces: [
      {
        name: 'default',
        mac: '02:5e:7a:00:00:01',
        interfaceName: 'eth0',
        ipAddress: '10.0.2.2',
        ipAddresses: ['10.0.2.2', 'fe80::5e:7aff:fe00:1'],
        infoSource: connected ? 'domain, guest-agent' : 'domain',
      },
      { name: 'lan', mac: '02:5e:7a:00:00:09', infoSource: 'domain' },
    ],
    volumeStatus: [
      { name: 'rootdisk', target: 'vda' },
      { name: 'datadisk', target: 'vdb' },
      { name: 'scratch', target: 'vdc' },
      { name: 'cloudinitdisk', target: 'vdd' },
    ],
  },
});

/** guestosinfo of the Fedora guest. */
export const kvFedoraInfo: KvGuestAgentInfo = {
  guestAgentVersion: '11.1.2',
  supportedCommands: [
    { name: 'guest-info', enabled: true },
    { name: 'guest-exec', enabled: true },
  ],
  hostname: 'fedora',
  os: {
    id: 'fedora',
    name: 'Fedora Linux',
    prettyName: 'Fedora Linux 45 (Cloud Edition)',
    version: '45 (Cloud Edition)',
    versionId: '45',
    kernelRelease: '7.2.11-300.fc45.x86_64',
    kernelVersion: '#1 SMP PREEMPT_DYNAMIC Thu Oct 15 17:29:26 UTC 2026',
    machine: 'x86_64',
  },
  timezone: 'UTC, 0',
  fsInfo: {
    disks: [{ diskName: 'vda4', mountPoint: '/', fileSystemType: 'xfs', usedBytes: 4473618432, totalBytes: 5267337216, disk: [{ serial: 'rootdisk', busType: 'virtio' }] }],
  },
};

export const kvFedoraUsers: KvUser[] = [{ userName: 'fedora', loginTime: 1795836000.125 }];

export const kvFedoraFilesystems: KvFilesystem[] = [
  { diskName: 'vda4', mountPoint: '/', fileSystemType: 'xfs', usedBytes: 4473618432, totalBytes: 5267337216, disk: [{ serial: 'rootdisk', busType: 'virtio' }] },
  { diskName: 'vda2', mountPoint: '/boot/efi', fileSystemType: 'vfat', usedBytes: 22591488, totalBytes: 104607744, disk: [{ serial: 'rootdisk', busType: 'virtio' }] },
  { diskName: 'vdb1', mountPoint: '/data', fileSystemType: 'ext4', usedBytes: 9500000000, totalBytes: 10000000000, disk: [{ serial: 'datadisk', busType: 'virtio' }] },
  { diskName: 'tmpfs', mountPoint: '/run/empty', fileSystemType: 'tmpfs', usedBytes: 0, totalBytes: 0 },
];

/** guestosinfo of the Windows guest (KubeVirt reports the domain user too). */
export const kvWindowsInfo: KvGuestAgentInfo = {
  guestAgentVersion: '9.2.0',
  hostname: 'WIN-GUEST',
  os: { id: 'mswindows', name: 'Microsoft Windows', prettyName: 'Windows Server 2022 Standard', version: 'Microsoft Windows Server 2022', versionId: '2022', kernelRelease: '20348', machine: 'x86_64' },
  timezone: 'Pacific Standard Time, -28800',
};

export const kvWindowsUsers: KvUser[] = [{ userName: 'Administrator', domain: 'WIN-GUEST', loginTime: 1795835000 }];

export const windowsVm = (): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'VirtualMachine',
  metadata: { name: 'win', namespace: 'vms', uid: 'uid-win', annotations: { 'hangar.magesgate.com/os': 'windows' } },
  spec: {
    template: {
      spec: {
        domain: {
          devices: {
            disks: [{ name: 'rootdisk', serial: 'rootdisk', bootOrder: 1, disk: { bus: 'sata' } }],
            interfaces: [{ name: 'default', masquerade: {}, model: 'e1000e', macAddress: '02:5e:7a:00:00:02' }],
          },
        },
        networks: [{ name: 'default', pod: {} }],
        volumes: [{ name: 'rootdisk', dataVolume: { name: 'win-root' } }],
      },
    },
  },
});

export const windowsVmi = (): Obj => ({
  metadata: { name: 'win', namespace: 'vms' },
  status: {
    phase: 'Running',
    nodeName: 'node-a',
    conditions: [{ type: 'AgentConnected', status: 'True', lastTransitionTime: '2026-11-28T03:00:00Z' }],
    guestOSInfo: { id: 'mswindows', prettyName: 'Windows Server 2022 Standard', kernelRelease: '20348', machine: 'x86_64' },
    interfaces: [{ name: 'default', mac: '02:5e:7a:00:00:02', interfaceName: 'Ethernet Instance 0', ipAddresses: ['10.0.2.2'], infoSource: 'domain, guest-agent' }],
    volumeStatus: [{ name: 'rootdisk', target: 'sda' }],
  },
});
