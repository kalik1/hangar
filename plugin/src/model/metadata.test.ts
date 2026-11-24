import {
  CHASSIS_ASSET,
  L_METADATA,
  L_SERVICE_ACCOUNT,
  metadataChoice,
  metadataEvent,
  metadataService,
  metadataVerdict,
  serviceAccountProblem,
  withMetadata,
} from './metadata';
import { Obj } from './types';

/** The ClusterConfig of a new v2.7 install with virt (D10). */
const clusterConfig = (metadata: any, conditions: any[] = []): Obj => ({
  apiVersion: 'k4all.magesgate.com/v1alpha1',
  kind: 'ClusterConfig',
  metadata: { name: 'k4all-cluster-config' },
  spec: { features: { virt: { enabled: true, emulation: 'auto', ...(metadata ? { metadata } : {}) } } },
  status: { conditions },
});

const vm = (labels: Record<string, string> = {}, extra: any = {}): Obj => ({
  apiVersion: 'kubevirt.io/v1',
  kind: 'VirtualMachine',
  metadata: { name: 'web', namespace: 'demo', uid: '6f1c2a9e-0000-4000-8000-000000000001' },
  spec: {
    template: {
      metadata: { labels },
      spec: {
        domain: { devices: { interfaces: [{ name: 'default', masquerade: {} }] }, ...extra.domain },
        networks: [{ name: 'default', pod: {} }],
        volumes: extra.volumes ?? [{ name: 'cloudinitdisk', cloudInitNoCloud: { userData: '#cloud-config\n' } }],
      },
    },
  },
});

const ns = (labels: Record<string, string> = {}): Obj => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'demo', labels } });

const event = (reason: string, message: string, type = 'Warning', component = 'k4all-operator', at = '2026-11-24T10:00:00Z'): Obj => ({
  apiVersion: 'v1',
  kind: 'Event',
  metadata: { name: `web.${reason}`, namespace: 'demo' },
  involvedObject: { kind: 'VirtualMachine', name: 'web', namespace: 'demo', apiVersion: 'kubevirt.io/v1' },
  reason,
  message,
  type,
  source: { component },
  lastTimestamp: at,
});

const ON = { [L_METADATA]: 'enabled' };

describe('the metadata service in the ClusterConfig', () => {
  it('reads it on, with scope and audiences', () => {
    expect(metadataService(clusterConfig({ enabled: true, tokens: { audiences: ['vault'] } }))).toEqual({ enabled: true, scope: 'Labelled', audiences: ['vault'] });
    expect(metadataService(clusterConfig({ enabled: true, scope: 'All' }))?.scope).toBe('All');
  });
  it('is off when absent or disabled', () => {
    expect(metadataService(clusterConfig(undefined))?.enabled).toBe(false);
    expect(metadataService(clusterConfig({ enabled: false }))?.enabled).toBe(false);
    expect(metadataService(null)).toBeNull();
  });
  it('carries the MetadataService condition', () => {
    const c = metadataService(clusterConfig({ enabled: true }, [{ type: 'MetadataService', status: 'False', reason: 'PolicyMissing', message: 'MutatingAdmissionPolicy is not served' }]));
    expect(c?.condition).toEqual({ status: 'False', reason: 'PolicyMissing', message: 'MutatingAdmissionPolicy is not served' });
  });
});

describe('a VM asking for the metadata service', () => {
  it('sets the template label, the ServiceAccount label and the chassis asset tag', () => {
    const spec = { template: { metadata: { labels: { app: 'web' } }, spec: { domain: { devices: {} } } } };
    const out = withMetadata(spec, { serviceAccount: 'builder' });
    expect(out.template.metadata.labels).toEqual({ app: 'web', [L_METADATA]: 'enabled', [L_SERVICE_ACCOUNT]: 'builder' });
    expect(out.template.spec.domain.chassis).toEqual({ asset: CHASSIS_ASSET });
    expect(spec.template.metadata.labels).toEqual({ app: 'web' });
  });
  it('uses the namespace’s default ServiceAccount without a label, and keeps a chassis set by hand', () => {
    const spec = { template: { spec: { domain: { chassis: { asset: 'Mine', manufacturer: 'ACME' } } } } };
    const out = withMetadata(spec, { serviceAccount: 'default' });
    expect(out.template.metadata.labels).toEqual({ [L_METADATA]: 'enabled' });
    expect(out.template.spec.domain.chassis).toEqual({ asset: 'Mine', manufacturer: 'ACME' });
    expect(withMetadata(spec, {}).template.metadata.labels[L_SERVICE_ACCOUNT]).toBeUndefined();
  });
  it('checks the ServiceAccount fits in a label value', () => {
    expect(serviceAccountProblem('')).toBeNull();
    expect(serviceAccountProblem('builder')).toBeNull();
    expect(serviceAccountProblem('ci.runner-1')).toBeNull();
    expect(serviceAccountProblem('Builder')).toMatch(/lowercase/);
    expect(serviceAccountProblem('a'.repeat(64))).toMatch(/63/);
  });
});

describe('whether a VM gets the metadata service, and why not', () => {
  const svc = metadataService(clusterConfig({ enabled: true }));

  it('serves a labelled VM on the pod network', () => {
    const v = metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: [] });
    expect(v.state).toBe('on');
    expect(v.serviceAccount).toBe('default');
    expect(v.serves).toContain('instance-id 6f1c2a9e-0000-4000-8000-000000000001 (the VM’s UID)');
    expect(v.serves.join(' ')).toMatch(/k4all-metadata/);
  });

  it('is off when k4all’s service is off, and not asked without the label (scope Labelled)', () => {
    expect(metadataVerdict({ vm: vm(ON), namespace: ns(), service: metadataService(clusterConfig(undefined)), events: [] }).state).toBe('off');
    const v = metadataVerdict({ vm: vm(), namespace: ns(), service: svc, events: [] });
    expect(v.state).toBe('not-asked');
    expect(v.why).toMatch(L_METADATA);
  });

  it('serves every VM with scope All, and says when the guest will not look for it', () => {
    const v = metadataVerdict({ vm: vm(), namespace: ns(), service: metadataService(clusterConfig({ enabled: true, scope: 'All' })), events: [] });
    expect(v.state).toBe('on');
    expect(v.notes.join(' ')).toMatch(/OpenStack Nova/);
    const tagged = metadataVerdict({ vm: vm({}, { domain: { chassis: { asset: CHASSIS_ASSET } } }), namespace: ns(), service: metadataService(clusterConfig({ enabled: true, scope: 'All' })), events: [] });
    expect(tagged.notes.join(' ')).not.toMatch(/OpenStack Nova/);
  });

  it('skips a namespace enforcing PodSecurity baseline or restricted (D8): the VM keeps its cloud-init disk', () => {
    for (const level of ['baseline', 'restricted']) {
      const v = metadataVerdict({ vm: vm(ON), namespace: ns({ 'pod-security.kubernetes.io/enforce': level }), service: svc, events: [] });
      expect(v.state).toBe('skipped');
      expect(v.why).toMatch(new RegExp(`PodSecurity ${level}`));
      expect(v.why).toMatch(/cloud-init disk/);
    }
    const noDisk = metadataVerdict({ vm: vm(ON, { volumes: [] }), namespace: ns({ 'pod-security.kubernetes.io/enforce': 'baseline' }), service: svc, events: [] });
    expect(noDisk.notes.join(' ')).toMatch(/no cloud-init disk/);
    // privileged, or only warn/audit: injected
    expect(metadataVerdict({ vm: vm(ON), namespace: ns({ 'pod-security.kubernetes.io/enforce': 'privileged', 'pod-security.kubernetes.io/warn': 'restricted' }), service: svc, events: [] }).state).toBe('on');
  });

  it('skips a VM with no pod network (NAT) adapter', () => {
    const bridged = vm(ON);
    bridged.spec.template.spec.domain.devices.interfaces = [{ name: 'lan', bridge: {} }];
    bridged.spec.template.spec.networks = [{ name: 'lan', multus: { networkName: 'demo/vlan100' } }];
    const v = metadataVerdict({ vm: bridged, namespace: ns(), service: svc, events: [] });
    expect(v.state).toBe('skipped');
    expect(v.why).toMatch(/pod network/);
  });

  it('shows the reason k4all gives in an Event on the VM', () => {
    const evs = [event('MetadataSkipped', 'namespace demo enforces PodSecurity baseline: no metadata injection', 'Warning', 'k4all-operator', '2026-11-24T10:00:00Z')];
    const v = metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: evs });
    expect(v.state).toBe('skipped');
    expect(v.why).toBe('k4all: namespace demo enforces PodSecurity baseline: no metadata injection');
    // other components' events, other reasons and other objects do not count
    const other = [event('MetadataSkipped', 'x', 'Warning', 'virt-controller'), event('FailedCreate', 'x'), { ...event('MetadataSkipped', 'x'), involvedObject: { kind: 'VirtualMachine', name: 'db', namespace: 'demo' } }];
    expect(metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: other }).state).toBe('on');
  });

  it('picks the newest k4all metadata event of the VM', () => {
    const evs = [event('MetadataSkipped', 'old', 'Warning', 'k4all-operator', '2026-11-24T09:00:00Z'), event('MetadataInjected', 'served', 'Normal', 'k4all-operator', '2026-11-24T10:00:00Z')];
    expect(metadataEvent(evs, vm(ON))?.message).toBe('served');
    expect(metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: evs }).state).toBe('on');
  });

  it('warns when the chosen ServiceAccount does not exist', () => {
    const v = metadataVerdict({ vm: vm({ ...ON, [L_SERVICE_ACCOUNT]: 'builder' }), namespace: ns(), service: svc, events: [], serviceAccounts: ['default'] });
    expect(v.serviceAccount).toBe('builder');
    expect(v.notes.join(' ')).toMatch(/builder does not exist/);
    expect(metadataVerdict({ vm: vm({ ...ON, [L_SERVICE_ACCOUNT]: 'builder' }), namespace: ns(), service: svc, events: [], serviceAccounts: null }).notes).toEqual([]);
  });

  it('says when k4all reports the service is not ready', () => {
    const v = metadataVerdict({ vm: vm(ON), namespace: ns(), service: metadataService(clusterConfig({ enabled: true }, [{ type: 'MetadataService', status: 'False', message: 'policy not served' }])), events: [] });
    expect(v.notes.join(' ')).toMatch(/policy not served/);
  });

  it('cannot tell without k4all’s settings, but says whether the VM asks', () => {
    const v = metadataVerdict({ vm: vm(ON), namespace: ns(), service: 'unknown', events: [] });
    expect(v.state).toBe('unknown');
    expect(v.why).toMatch(/asks for it/);
  });
});

describe('the wizard’s metadata switch', () => {
  const on = metadataService(clusterConfig({ enabled: true }));
  const off = metadataService(clusterConfig(undefined));
  it('is on by default when k4all’s service is on, off otherwise', () => {
    expect(metadataChoice(true, on, null)).toBe(true);
    expect(metadataChoice(true, off, null)).toBe(false);
    expect(metadataChoice(true, 'unknown', null)).toBe(false);
    expect(metadataChoice(true, undefined, null)).toBe(false);
  });
  it('follows the user’s pick, and is never on without k4all', () => {
    expect(metadataChoice(true, on, false)).toBe(false);
    expect(metadataChoice(true, off, true)).toBe(true);
    expect(metadataChoice(false, on, true)).toBe(false);
  });
});
