import { CLIPBOARD_NOT_LIVE_WHY, setClipboardAnnotation } from './clipboard';
import { disks, guestOs, hardware, liveMigratable, nics, osFromSources, powerActions, powerState } from './vm';

const vm = (status: any, spec: any = {}, meta: any = {}) => ({ metadata: { name: 'web', namespace: 'prod', ...meta }, spec, status });

describe('power state', () => {
  it('maps printable statuses to virtualizer words and LEDs', () => {
    expect(powerState(vm({ printableStatus: 'Running' }), { metadata: { name: 'web' }, status: {} })).toMatchObject({ kind: 'on', label: 'Powered on', tone: 'on' });
    expect(powerState(vm({ printableStatus: 'Stopped' }))).toMatchObject({ kind: 'off', tone: 'off' });
    expect(powerState(vm({ printableStatus: 'Paused' }))).toMatchObject({ kind: 'paused', label: 'Suspended' });
    expect(powerState(vm({ printableStatus: 'Starting' }))).toMatchObject({ kind: 'starting', tone: 'busy' });
    expect(powerState(vm({ printableStatus: 'ErrorUnschedulable' }))).toMatchObject({ kind: 'error', label: 'No host can run it', tone: 'fault' });
  });
  it('treats a disk still importing as a wait, not an error', () => {
    const p = powerState(
      vm({ printableStatus: 'DataVolumeError', conditions: [{ type: 'Failure', status: 'True', message: 'source PVC not ready' }] })
    );
    expect(p.kind).toBe('provisioning');
  });
  it('sees a migration and a pause on the running instance', () => {
    const vmi = { metadata: { name: 'web' }, status: { migrationState: { completed: false } } };
    expect(powerState(vm({ printableStatus: 'Running' }), vmi).kind).toBe('migrating');
    const paused = { metadata: { name: 'web' }, status: { conditions: [{ type: 'Paused', status: 'True' }] } };
    expect(powerState(vm({ printableStatus: 'Running' }), paused).kind).toBe('paused');
  });
  it('offers the power actions that make sense', () => {
    const on = powerActions(powerState(vm({ printableStatus: 'Running' }), { metadata: { name: 'web' } }), 'Always');
    expect(on).toMatchObject({ start: false, shutdown: true, restart: true, suspend: true, resume: false });
    const off = powerActions(powerState(vm({ printableStatus: 'Stopped' })), 'Halted');
    expect(off).toMatchObject({ start: true, shutdown: false, powerOff: false });
  });
});

describe('hardware', () => {
  it('reads topology and memory', () => {
    const h = hardware(vm({}, { template: { spec: { domain: { cpu: { sockets: 2, cores: 2, threads: 1 }, memory: { guest: '4Gi' }, firmware: { bootloader: { efi: { secureBoot: false } } } } } } }));
    expect(h).toMatchObject({ vcpus: 4, sockets: 2, cores: 2, memoryBytes: 4 * 2 ** 30, firmware: 'UEFI' });
  });
  it('takes CPU and memory from the size profile', () => {
    const its = [{ metadata: { name: 'u1.small' }, spec: { cpu: { guest: 1 }, memory: { guest: '2Gi' } } }];
    const h = hardware(vm({}, { instancetype: { name: 'u1.small' }, template: { spec: { domain: {} } } }), null, its);
    expect(h).toMatchObject({ vcpus: 1, memoryBytes: 2 * 2 ** 30, instancetype: { name: 'u1.small' } });
  });
});

describe('devices', () => {
  const spec = {
    template: {
      spec: {
        domain: {
          devices: {
            disks: [
              { name: 'cdrom', cdrom: { bus: 'sata' }, bootOrder: 1 },
              { name: 'root', disk: { bus: 'virtio' }, bootOrder: 2 },
            ],
            interfaces: [{ name: 'default', masquerade: {} }, { name: 'lan', bridge: {} }],
          },
        },
        volumes: [
          { name: 'root', dataVolume: { name: 'web-root' } },
          { name: 'cdrom', dataVolume: { name: 'web-iso' } },
          { name: 'ci', cloudInitNoCloud: { userData: '' } },
        ],
        networks: [{ name: 'default', pod: {} }, { name: 'lan', multus: { networkName: 'default/vlan10' } }],
      },
    },
  };
  it('lists disks in boot order, with implicit ones', () => {
    const d = disks(vm({}, spec));
    expect(d.map(x => [x.name, x.device, x.claimName ?? null, x.config])).toEqual([
      ['cdrom', 'cdrom', 'web-iso', false],
      ['root', 'disk', 'web-root', false],
      ['ci', 'disk', null, true],
    ]);
  });
  it('lists adapters with their networks and guest addresses', () => {
    const vmi = { metadata: { name: 'web' }, status: { interfaces: [{ name: 'lan', ipAddress: '10.1.0.5', ipAddresses: ['10.1.0.5', 'fe80::1'], mac: '02:00:00:00:00:01' }] } };
    const n = nics(vm({}, spec), vmi);
    expect(n[0]).toMatchObject({ binding: 'NAT', network: 'Pod network', isPodNetwork: true });
    expect(n[1]).toMatchObject({ binding: 'Bridge', network: 'default/vlan10', ips: ['10.1.0.5'], mac: '02:00:00:00:00:01' });
  });
});

describe('guest OS', () => {
  it('prefers the guest agent, then settings, then the source image', () => {
    const agent = { metadata: { name: 'web' }, status: { guestOSInfo: { prettyName: 'Fedora Linux 45', id: 'fedora' } } };
    expect(guestOs(vm({}), agent)).toMatchObject({ name: 'Fedora Linux 45', fromAgent: true, id: 'fedora' });
    expect(guestOs(vm({}, { preference: { name: 'ubuntu' } }))).toMatchObject({ name: 'Ubuntu', fromAgent: false });
    const fromLib = vm({}, { dataVolumeTemplates: [{ spec: { source: { pvc: { namespace: 'lib', name: 'cirros' } } } }] });
    const hint = osFromSources(fromLib, new Map([['lib/cirros', 'cirros']]));
    expect(guestOs(fromLib, null, hint).name).toBe('CirrOS');
    expect(guestOs(vm({})).name).toBe('Unknown OS');
  });
});

describe('live migratable (CPU and memory hot-add)', () => {
  const vmi = (annotations?: Record<string, string>) => ({
    metadata: { name: 'v', namespace: 'demo', annotations },
    status: { conditions: [{ type: 'LiveMigratable', status: 'True' }] },
  });
  it('is not with the clipboard port, though KubeVirt says it is', () => {
    expect(liveMigratable({ metadata: { name: 'v' } }, vmi()).ok).toBe(true);
    expect(liveMigratable({ metadata: { name: 'v' } }, vmi(setClipboardAnnotation({}, true, 'quay.io/kubevirt/sidecar-shim:v1.9.1')))).toEqual({
      ok: false,
      why: CLIPBOARD_NOT_LIVE_WHY,
    });
  });
});
