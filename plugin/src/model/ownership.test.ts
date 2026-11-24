import { fieldManagers, fieldsCover, k4allAnnotationList, k4allOwnedFields, k4allOwns, ownedBy, ownedByK4all } from './ownership';
import { Obj } from './types';

/*
 * managedFields as the API server returns them (kubectl get -o yaml
 * --show-managed-fields), unrelated entries trimmed.
 */

/**
 * The KubeVirt CR of a k4all v2.6 cluster (lab capture, operator v0.5.x):
 * k4all-operator applied upstream's kubevirt-cr.yaml, empty structs
 * included (workloadUpdateStrategy: {}, customizeComponents: {}); an admin
 * then set workloadUpdateMethods, permittedHostDevices and infra with
 * kubectl patch, and Hangar wrote its device mappings annotation.
 */
const KV_V26: Obj = {
  apiVersion: 'kubevirt.io/v1',
  kind: 'KubeVirt',
  metadata: {
    name: 'kubevirt',
    namespace: 'kubevirt',
    managedFields: [
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: {
          'f:spec': {
            'f:certificateRotateStrategy': {},
            'f:configuration': { 'f:developerConfiguration': { 'f:featureGates': {} }, 'f:imagePullPolicy': {} },
            'f:customizeComponents': {},
            'f:imagePullPolicy': {},
            'f:workloadUpdateStrategy': {},
          },
        },
        manager: 'k4all-operator',
        operation: 'Apply',
      },
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: {
          'f:metadata': { 'f:annotations': { '.': {}, 'f:kubectl.kubernetes.io/last-applied-configuration': {} } },
          'f:spec': {
            '.': {},
            'f:certificateRotateStrategy': {},
            'f:configuration': { '.': {}, 'f:developerConfiguration': {}, 'f:imagePullPolicy': {} },
            'f:customizeComponents': {},
            'f:imagePullPolicy': {},
            'f:workloadUpdateStrategy': {},
          },
        },
        manager: 'kubectl-client-side-apply',
        operation: 'Update',
        time: '2026-11-20T00:03:23Z',
      },
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:metadata': { 'f:annotations': { 'f:hangar.magesgate.com/device-mappings': {} } } },
        manager: 'Headlamp unknown (linux',
        operation: 'Update',
        time: '2026-11-23T13:28:12Z',
      },
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: {
          'f:spec': {
            'f:configuration': {
              'f:developerConfiguration': { 'f:featureGates': {} },
              'f:permittedHostDevices': { '.': {}, 'f:pciHostDevices': {} },
            },
            'f:infra': {
              '.': {},
              'f:nodePlacement': { '.': {}, 'f:affinity': { '.': {}, 'f:nodeAffinity': { '.': {}, 'f:preferredDuringSchedulingIgnoredDuringExecution': {} } } },
              'f:replicas': {},
            },
            'f:workloadUpdateStrategy': { 'f:workloadUpdateMethods': {} },
          },
        },
        manager: 'kubectl-patch',
        operation: 'Update',
        time: '2026-11-23T15:50:09Z',
      },
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:status': { 'f:outdatedVirtualMachineInstanceWorkloads': {} } },
        manager: 'virt-controller',
        operation: 'Update',
        subresource: 'status',
      },
    ],
  },
  spec: {
    certificateRotateStrategy: {},
    configuration: {
      developerConfiguration: { featureGates: ['HostDevices', 'Snapshot', 'Sidecar', 'DeclarativeHotplugVolumes'] },
      imagePullPolicy: 'IfNotPresent',
      permittedHostDevices: { pciHostDevices: [{ pciVendorSelector: '8086:46a6', resourceName: 'hangar.magesgate.com/iris-xe-vf' }] },
    },
    customizeComponents: {},
    imagePullPolicy: 'IfNotPresent',
    infra: { replicas: 1 },
    workloadUpdateStrategy: { workloadUpdateMethods: ['LiveMigrate'] },
  },
};

/**
 * The same CR on k4all v2.7 (operator v0.6.0): empty upstream fields
 * stripped before the apply (R5), the release invariant
 * workloadUpdateMethods and the ClusterConfig settings folded into it
 * (useEmulation, vmStateStorageClass), the gates k4all added recorded in
 * the annotation (R6). Hangar later set cpuModel and evictionStrategy.
 */
const KV_V27: Obj = {
  apiVersion: 'kubevirt.io/v1',
  kind: 'KubeVirt',
  metadata: {
    name: 'kubevirt',
    namespace: 'kubevirt',
    annotations: {
      'k4all.magesgate.com/feature-gates': 'Sidecar,HostDevices',
      'k4all.magesgate.com/disabled-feature-gates': 'VideoConfig',
    },
    managedFields: [
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: {
          'f:metadata': { 'f:annotations': { 'f:k4all.magesgate.com/disabled-feature-gates': {}, 'f:k4all.magesgate.com/feature-gates': {} } },
          'f:spec': {
            'f:configuration': {
              'f:developerConfiguration': { 'f:disabledFeatureGates': {}, 'f:featureGates': {}, 'f:useEmulation': {} },
              'f:imagePullPolicy': {},
              'f:vmStateStorageClass': {},
            },
            'f:imagePullPolicy': {},
            'f:infra': { 'f:nodePlacement': { 'f:affinity': { 'f:nodeAffinity': { 'f:preferredDuringSchedulingIgnoredDuringExecution': {} } } } },
            'f:workloadUpdateStrategy': { 'f:workloadUpdateMethods': {} },
          },
        },
        manager: 'k4all-operator',
        operation: 'Apply',
      },
      {
        apiVersion: 'kubevirt.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:spec': { 'f:configuration': { 'f:cpuModel': {}, 'f:evictionStrategy': {} } } },
        manager: 'Headlamp unknown (linux',
        operation: 'Update',
      },
    ],
  },
  spec: {
    configuration: {
      developerConfiguration: { featureGates: ['Sidecar', 'HostDevices', 'Snapshot'], disabledFeatureGates: ['VideoConfig'], useEmulation: false },
      imagePullPolicy: 'IfNotPresent',
      vmStateStorageClass: 'ceph-rbd',
      cpuModel: 'host-model',
      evictionStrategy: 'LiveMigrate',
    },
    imagePullPolicy: 'IfNotPresent',
    workloadUpdateStrategy: { workloadUpdateMethods: ['LiveMigrate'] },
  },
};

const withFields = (manager: string, fieldsV1: Record<string, unknown>, spec: any): Obj => ({
  metadata: { name: 'x', managedFields: [{ manager, operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1 }] },
  spec,
});

describe('field ownership from managedFields', () => {
  it('an empty struct above the field owns none of its children (R9)', () => {
    // k4all-operator applied workloadUpdateStrategy: {}; kubectl patch set the methods.
    expect(fieldManagers(KV_V26, 'spec.workloadUpdateStrategy.workloadUpdateMethods')).toEqual(['kubectl-patch']);
    expect(ownedByK4all(KV_V26, 'spec.workloadUpdateStrategy.workloadUpdateMethods')).toBe(false);
    // the struct itself is still k4all's (and kubectl's)
    expect(fieldManagers(KV_V26, 'spec.workloadUpdateStrategy')).toEqual(['k4all-operator', 'kubectl-client-side-apply', 'kubectl-patch']);
    // developerConfiguration: {} of the client-side apply owns no gate list, useEmulation…
    expect(fieldManagers(KV_V26, 'spec.configuration.developerConfiguration.useEmulation')).toEqual([]);
    expect(ownedByK4all(KV_V26, 'spec.configuration.vmStateStorageClass')).toBe(false);
    expect(ownedByK4all(KV_V26, 'spec.configuration.permittedHostDevices')).toBe(false);
  });

  it('reads what the v2.7 operator owns on the KubeVirt CR', () => {
    expect(
      k4allOwnedFields(KV_V27, [
        'spec.configuration.developerConfiguration.useEmulation',
        'spec.configuration.vmStateStorageClass',
        'spec.workloadUpdateStrategy.workloadUpdateMethods',
        'spec.configuration.cpuModel',
        'spec.configuration.evictionStrategy',
        'spec.configuration.vmRolloutStrategy',
        'spec.configuration.permittedHostDevices',
      ])
    ).toEqual(['spec.configuration.developerConfiguration.useEmulation', 'spec.configuration.vmStateStorageClass', 'spec.workloadUpdateStrategy.workloadUpdateMethods']);
    expect(ownedBy(KV_V27, 'spec.configuration.cpuModel', 'Headlamp unknown (linux')).toBe(true);
  });

  it('a list or a scalar under {} is owned as a whole', () => {
    const f = { 'f:spec': { 'f:configuration': { 'f:permittedHostDevices': { 'f:pciHostDevices': {} } } } };
    const spec = { configuration: { permittedHostDevices: { pciHostDevices: [{ pciVendorSelector: '10de:1eb8', resourceName: 'nvidia.com/T4' }] } } };
    const o = withFields('k4all-operator', f, spec);
    expect(fieldsCover(f, ['spec', 'configuration', 'permittedHostDevices', 'pciHostDevices', 'i:0', 'resourceName'], o)).toBe(true);
    expect(fieldsCover(f, ['spec', 'configuration', 'permittedHostDevices', 'pciHostDevices', 'k:{"resourceName":"nvidia.com/T4"}'], o)).toBe(true);
    // a scalar: anything under it is its
    const s = withFields('k4all-operator', { 'f:spec': { 'f:mode': {} } }, { mode: 'x' });
    expect(fieldsCover(s.metadata.managedFields![0].fieldsV1, 'spec.mode.deeper', s)).toBe(true);
    // a map: nothing under it
    const m = withFields('k4all-operator', { 'f:spec': { 'f:mode': {} } }, { mode: { a: 1 } });
    expect(fieldsCover(m.metadata.managedFields![0].fieldsV1, 'spec.mode.a', m)).toBe(false);
    // no live value there: nothing to own
    expect(fieldsCover({ 'f:spec': { 'f:mode': {} } }, 'spec.mode.a', { metadata: { name: 'x' }, spec: {} })).toBe(false);
    expect(fieldsCover({ 'f:spec': { 'f:mode': {} } }, 'spec.mode.a')).toBe(false);
  });

  it('follows list entries kept as a map by key or by value', () => {
    const f = { 'f:spec': { 'f:items': { 'k:{"name":"a"}': { '.': {}, 'f:name': {}, 'f:opts': {} }, 'v:"x"': {} } } };
    const o = withFields('k4all-operator', f, { items: [{ name: 'a', opts: ['p', 'q'] }] });
    expect(fieldsCover(f, ['spec', 'items', 'k:{"name":"a"}', 'opts', 'i:1'], o)).toBe(true);
    expect(fieldsCover(f, ['spec', 'items', 'k:{"name":"b"}'], o)).toBe(false);
    expect(fieldsCover(f, ['spec', 'items', 'v:"x"'], o)).toBe(true);
  });

  it('a parent owned only for its existence does not own its children', () => {
    const f = { 'f:spec': { 'f:mgr': { '.': {} } } };
    expect(fieldsCover(f, 'spec.mgr.count', { metadata: { name: 'x' }, spec: { mgr: { count: 1 } } })).toBe(false);
    expect(fieldsCover(f, 'spec.mgr')).toBe(true);
  });

  it('counts only the k4all-operator manager, not the create-only seed', () => {
    const o: Obj = {
      metadata: {
        name: 'x',
        managedFields: [
          { manager: 'k4all-operator-seed', operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:a': {} } } },
          { manager: 'k4all-operator-x', operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:b': {} } } },
        ],
      },
      spec: { a: 1, b: 2 },
    };
    expect(ownedByK4all(o, 'spec.a')).toBe(false);
    expect(ownedByK4all(o, 'spec.b')).toBe(false);
    expect(fieldManagers(o, 'spec.a')).toEqual(['k4all-operator-seed']);
  });

  it('without k4all everything is the console’s', () => {
    expect(k4allOwns(KV_V27, 'spec.configuration.vmStateStorageClass', true)).toBe(true);
    expect(k4allOwns(KV_V27, 'spec.configuration.vmStateStorageClass', false)).toBe(false);
  });

  it('copes with missing or odd managedFields', () => {
    expect(fieldManagers(null, 'spec.a')).toEqual([]);
    expect(fieldManagers({ metadata: { name: 'x' } }, 'spec.a')).toEqual([]);
    expect(fieldManagers({ metadata: { name: 'x', managedFields: [null, { manager: 'k4all-operator' }] } as any }, 'spec.a')).toEqual([]);
    expect(fieldManagers({ metadata: { name: 'x', managedFields: [{ manager: 'k4all-operator', fieldsType: 'FieldsV2', fieldsV1: { 'f:spec': {} } }] } as any }, 'spec')).toEqual([]);
    expect(fieldsCover({}, 'spec')).toBe(false);
    expect(fieldsCover({ 'f:spec': {} }, '')).toBe(false);
  });
});

describe('list entries k4all added (R6 annotation)', () => {
  it('reads a comma-separated annotation', () => {
    expect(k4allAnnotationList(KV_V27, 'k4all.magesgate.com/feature-gates')).toEqual(['Sidecar', 'HostDevices']);
    expect(k4allAnnotationList({ metadata: { name: 'x', annotations: { a: ' A, B ,,C ' } } }, 'a')).toEqual(['A', 'B', 'C']);
    expect(k4allAnnotationList({ metadata: { name: 'x', annotations: { a: '' } } }, 'a')).toEqual([]);
    expect(k4allAnnotationList(KV_V26, 'k4all.magesgate.com/feature-gates')).toEqual([]);
    expect(k4allAnnotationList(null, 'a')).toEqual([]);
  });
});
