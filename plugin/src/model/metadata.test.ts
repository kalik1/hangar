import {
  CHASSIS_ASSET,
  chassisAssetWarning,
  L_METADATA,
  L_SERVICE_ACCOUNT,
  metadataChoice,
  metadataEvents,
  metadataService,
  metadataVerdict,
  serviceAccountProblem,
  usesMetadata,
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
/** Five minutes after the fixtures' Events. */
const NOW = Date.parse('2026-11-24T10:05:00Z');

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

  it('serves every VM with scope All but those that opt out; k4all tags the chassis of those it serves', () => {
    const all = metadataService(clusterConfig({ enabled: true, scope: 'All' }));
    const v = metadataVerdict({ vm: vm(), namespace: ns(), service: all, events: [] });
    expect(v.state).toBe('on');
    expect(v.notes).toEqual([]);
    const out = metadataVerdict({ vm: vm({ [L_METADATA]: 'disabled' }), namespace: ns(), service: all, events: [] });
    expect(out.state).toBe('not-asked');
    expect(out.why).toMatch(`${L_METADATA}: disabled`);
  });

  it('says when a custom chassis asset tag keeps cloud-init from finding the service', () => {
    const custom = metadataVerdict({ vm: vm(ON, { domain: { chassis: { asset: 'Rack 12' } } }), namespace: ns(), service: svc, events: [] });
    expect(custom.state).toBe('on');
    expect(custom.notes.join(' ')).toMatch(/OpenStack datasource/);
    const tagged = metadataVerdict({ vm: vm(ON, { domain: { chassis: { asset: CHASSIS_ASSET } } }), namespace: ns(), service: svc, events: [] });
    expect(tagged.notes).toEqual([]);
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

  it('says the VM is not served when k4all says so and Hangar cannot read the folder', () => {
    const evs = [event('MetadataNotServed', 'namespace demo enforces PodSecurity "baseline", which forbids the NET_ADMIN capability')];
    const v = metadataVerdict({ vm: vm(ON), service: svc, events: evs, now: NOW });
    expect(v.state).toBe('skipped');
    expect(v.why).toBe('k4all, 5m ago: namespace demo enforces PodSecurity "baseline", which forbids the NET_ADMIN capability');
    // with the folder in hand its labels are current, the Event may be an hour old
    expect(metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: evs }).state).toBe('on');
    // other components' events, other reasons and other objects do not count
    const other = [event('MetadataNotServed', 'x', 'Warning', 'virt-controller'), event('FailedCreate', 'x'), { ...event('MetadataNotServed', 'x'), involvedObject: { kind: 'VirtualMachine', name: 'db', namespace: 'demo' } }];
    expect(metadataVerdict({ vm: vm(ON), service: svc, events: other }).state).toBe('on');
  });

  it('keeps a served VM served when k4all warns about what it serves', () => {
    const evs = [
      event('MetadataIncomplete', 'the metadata service serves this VM without what is missing: Secret web-ci not found'),
      event('MetadataSecretTaken', 'Secret k4all-md-web exists and is not k4all’s'),
    ];
    const v = metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: evs, now: NOW });
    expect(v.state).toBe('on');
    // Events are history (k4all cannot clear them): each note says how old it is
    expect(v.notes).toEqual(['k4all, 5m ago: the metadata service serves this VM without what is missing: Secret web-ci not found', 'k4all, 5m ago: Secret k4all-md-web exists and is not k4all’s']);
  });

  it('drops k4all’s Events older than the running instance', () => {
    const evs = [
      event('MetadataIncomplete', 'before the restart', 'Warning', 'k4all-operator', '2026-11-24T09:58:00Z'),
      event('MetadataSecretTaken', 'since the restart', 'Warning', 'k4all-operator', '2026-11-24T10:01:00Z'),
      event('MetadataNotServed', 'before the restart', 'Warning', 'k4all-operator', '2026-11-24T09:59:00Z'),
    ];
    const vmi = { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachineInstance', metadata: { name: 'web', namespace: 'demo', creationTimestamp: '2026-11-24T10:00:00Z' } };
    const v = metadataVerdict({ vm: vm(ON), service: svc, events: evs, vmi, now: NOW });
    expect(v.state).toBe('on');
    expect(v.notes).toEqual(['k4all, 4m ago: since the restart']);
    // a stopped VM keeps them all
    expect(metadataVerdict({ vm: vm(ON), service: svc, events: evs, now: NOW }).state).toBe('skipped');
  });

  it('leaves the asset tag to the VM spec: k4all’s Event outlives a fix', () => {
    const evs = [event('MetadataChassisAsset', 'the VM’s chassis asset tag is "Rack 12"')];
    const fixed = metadataVerdict({ vm: vm(ON), namespace: ns(), service: svc, events: evs });
    expect(fixed.state).toBe('on');
    expect(fixed.notes).toEqual([]);
    const tagged = metadataVerdict({ vm: vm(ON, { domain: { chassis: { asset: 'Rack 12' } } }), namespace: ns(), service: svc, events: evs });
    expect(tagged.notes).toHaveLength(1);
    expect(tagged.notes[0]).toMatch(/OpenStack datasource/);
  });

  it('keeps the newest k4all metadata event of each reason', () => {
    const evs = [
      event('MetadataIncomplete', 'old', 'Warning', 'k4all-operator', '2026-11-24T09:00:00Z'),
      event('MetadataIncomplete', 'new', 'Warning', 'k4all-operator', '2026-11-24T10:00:00Z'),
      event('MetadataSecretTaken', 'taken', 'Warning', 'k4all-operator', '2026-11-24T09:30:00Z'),
    ];
    expect(metadataEvents(evs, vm(ON)).map(e => e.message)).toEqual(['new', 'taken']);
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

describe('chassis asset tag and the metadata service', () => {
  const on = (scope: 'Labelled' | 'All') => metadataService(clusterConfig({ enabled: true, scope }));
  it('knows which VMs use the service', () => {
    expect(usesMetadata(vm({ [L_METADATA]: 'enabled' }), on('Labelled'))).toBe(true);
    expect(usesMetadata(vm(), on('Labelled'))).toBe(false);
    expect(usesMetadata(vm(), on('All'))).toBe(true);
    expect(usesMetadata(vm({ [L_METADATA]: 'disabled' }), on('All'))).toBe(false);
    expect(usesMetadata(vm(), metadataService(clusterConfig({ enabled: false, scope: 'All' })))).toBe(false);
    // Hangar cannot read k4all's settings: only a VM that asks counts.
    expect(usesMetadata(vm({ [L_METADATA]: 'enabled' }), 'unknown')).toBe(true);
    expect(usesMetadata(vm(), 'unknown')).toBe(false);
  });
  it('warns about a custom asset tag on a VM that uses the service', () => {
    const asks = vm({ [L_METADATA]: 'enabled' });
    expect(chassisAssetWarning('Rack 12', asks, on('Labelled'))).toMatch(/OpenStack datasource/);
    expect(chassisAssetWarning('  Rack 12 ', vm(), on('All'))).toMatch(/"Rack 12"/);
    // Empty (k4all sets it) or k4all's own tag: fine.
    expect(chassisAssetWarning('', asks, on('Labelled'))).toBeNull();
    expect(chassisAssetWarning(CHASSIS_ASSET, asks, on('Labelled'))).toBeNull();
    // VMs without the service may tag their chassis freely.
    expect(chassisAssetWarning('Rack 12', vm(), on('Labelled'))).toBeNull();
    expect(chassisAssetWarning('Rack 12', asks, null)).toBeNull();
  });
});
