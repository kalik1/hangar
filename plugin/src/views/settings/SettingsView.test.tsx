import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { K4ALL_MANAGED } from '../../model/ownership';
import { Obj } from '../../model/types';
import { SettingsView } from './SettingsView';

/** kv: the listed KubeVirt CR; got: what a GET of it returns (an Error: the GET fails); gets: the paths read. */
const state: { kv: Obj | null; got: Obj | Error | null; gets: string[]; k4all: boolean; addon: boolean } = { kv: null, got: null, gets: [], k4all: true, addon: true };

vi.mock('../../api/data', () => ({
  useHangar: () => ({ kubevirt: state.kv, vms: [], storageClasses: [], storageProfiles: [], pvcs: [], namespaces: [] }),
}));
vi.mock('../../api/client', () => ({
  currentCluster: () => 'main',
  kreq: async (path: string) => {
    state.gets.push(path);
    if (!state.got) throw Object.assign(new Error('not found'), { status: 404 });
    if (state.got instanceof Error) throw state.got;
    return state.got;
  },
}));
vi.mock('../../api/gates', () => ({
  setFeatureGate: vi.fn(),
  useCanPatchKubevirt: () => true,
  kubevirtPath: (kv: Obj) => `/apis/kubevirt.io/v1/namespaces/${kv.metadata.namespace}/kubevirts/${kv.metadata.name}`,
}));
vi.mock('../../api/k4all', () => ({ useK4all: () => state.k4all }));
vi.mock('../../api/protection', () => ({ useProtectionPolicy: () => ({ state: 'missing', recheck: () => undefined }) }));
vi.mock('../../shell/nav', async orig => ({
  ...((await orig()) as object),
  hrefFor: () => '/c/main/hangar/settings',
  k4allHref: (page: string, anchor?: string) => (state.addon ? `/c/main/k4all/settings/${page}${anchor ? `#${anchor}` : ''}` : null),
}));

/**
 * The KubeVirt CR on k4all v2.7 (KubeVirt 1.9): k4all's ClusterConfig
 * turns Sidecar on and the Beta Snapshot off (the annotations), its operator
 * applies useEmulation, vmStateStorageClass and the release's
 * workloadUpdateMethods. VSOCK was turned on from Hangar.
 */
function kubevirt(): Obj {
  return {
    apiVersion: 'kubevirt.io/v1',
    kind: 'KubeVirt',
    metadata: {
      name: 'kubevirt',
      namespace: 'kubevirt',
      annotations: { 'k4all.magesgate.com/feature-gates': 'Sidecar', 'k4all.magesgate.com/disabled-feature-gates': 'Snapshot' },
      managedFields: [
        {
          manager: 'k4all-operator',
          operation: 'Apply',
          fieldsType: 'FieldsV1',
          fieldsV1: {
            'f:metadata': { 'f:annotations': { 'f:k4all.magesgate.com/disabled-feature-gates': {}, 'f:k4all.magesgate.com/feature-gates': {} } },
            'f:spec': {
              'f:configuration': { 'f:developerConfiguration': { 'f:disabledFeatureGates': {}, 'f:featureGates': {}, 'f:useEmulation': {} }, 'f:vmStateStorageClass': {} },
              'f:workloadUpdateStrategy': { 'f:workloadUpdateMethods': {} },
            },
          },
        },
        { manager: 'Headlamp unknown (linux', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:configuration': { 'f:cpuModel': {} } } } },
      ],
    },
    spec: {
      configuration: {
        developerConfiguration: { featureGates: ['Sidecar', 'VSOCK'], disabledFeatureGates: ['Snapshot'], useEmulation: false },
        vmStateStorageClass: 'ceph-rbd',
        cpuModel: 'host-model',
      },
      workloadUpdateStrategy: { workloadUpdateMethods: ['LiveMigrate'] },
    },
    status: { observedKubeVirtVersion: 'v1.9.1' },
  };
}

/** The KubeVirt CR as Headlamp's list hands it out: v0.46 deletes metadata.managedFields from listed objects. */
function listed(): Obj {
  const o = kubevirt();
  delete o.metadata.managedFields;
  return o;
}

const gateSwitch = (gate: string) => document.querySelector(`input[aria-label^="${gate}:"]`) as HTMLInputElement;
/** Renders the page and lets the GET of the KubeVirt CR answer. */
async function page() {
  const r = render(
    <MemoryRouter>
      <SettingsView section="features" />
    </MemoryRouter>
  );
  await act(() => new Promise(done => setTimeout(done, 0)));
  return r;
}

describe('Settings → Features on k4all', () => {
  beforeEach(() => {
    state.kv = listed();
    state.got = kubevirt();
    state.gets = [];
    state.k4all = true;
    state.addon = true;
  });

  it('shows the gates k4all lists read-only, with a link to the addon’s feature gates', async () => {
    await page();
    expect(gateSwitch('Sidecar').disabled).toBe(true);
    expect(gateSwitch('Sidecar').checked).toBe(true);
    expect(gateSwitch('Snapshot').disabled).toBe(true);
    expect(gateSwitch('Snapshot').checked).toBe(false);
    expect(screen.getAllByText(/Managed by k4all — change it in the k4all addon \(k4all turns it (on|off)\)/)).toHaveLength(2);
    const links = screen.getAllByText('Open the k4all addon').map(a => a.getAttribute('href'));
    expect(links).toContain('/c/main/k4all/settings/virtualization#feature-gates');
  });

  it('leaves the other gates editable (D2)', async () => {
    await page();
    expect(gateSwitch('VSOCK').disabled).toBe(false);
    expect(gateSwitch('HostDevices').disabled).toBe(false);
    expect(gateSwitch('DeclarativeHotplugVolumes').disabled).toBe(false);
  });

  it('shows the settings k4all applies read-only: VM state datastore, emulation, update methods (D3)', async () => {
    await page();
    expect(screen.getByText('Set by the k4all release.')).toBeTruthy();
    const hrefs = screen.getAllByText('Open the k4all addon').map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/c/main/k4all/settings/virtualization#vm-state');
    expect(hrefs).toContain('/c/main/k4all/settings/virtualization');
    expect(screen.queryByText(/Set spec.configuration.vmStateStorageClass/)).toBeNull();
  });

  it('reads what k4all applies from a GET of the KubeVirt CR: the listed copy has no managedFields', async () => {
    await page();
    expect(screen.getByText('Set by the k4all release.')).toBeTruthy();
    expect(state.gets).toContain('/apis/kubevirt.io/v1/namespaces/kubevirt/kubevirts/kubevirt');
  });

  it('when the GET fails, the gates stay k4all’s (annotation) and the settings are not marked', async () => {
    state.got = Object.assign(new Error('Forbidden'), { status: 403 });
    await page();
    expect(state.gets).toHaveLength(1);
    expect(gateSwitch('Sidecar').disabled).toBe(true);
    expect(gateSwitch('Snapshot').disabled).toBe(true);
    expect(screen.queryByText('Set by the k4all release.')).toBeNull();
    const hrefs = screen.getAllByText('Open the k4all addon').map(a => a.getAttribute('href'));
    expect(hrefs).not.toContain('/c/main/k4all/settings/virtualization#vm-state');
  });

  it('keeps the words without a link when the k4all plugin is not loaded', async () => {
    state.addon = false;
    await page();
    expect(screen.getAllByText(new RegExp(K4ALL_MANAGED)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Open the k4all addon')).toBeNull();
  });

  it('without k4all every gate and setting is Hangar’s, whatever the annotation and managedFields say', async () => {
    state.k4all = false;
    state.kv = kubevirt();
    await page();
    expect(gateSwitch('Sidecar').disabled).toBe(false);
    expect(gateSwitch('Snapshot').disabled).toBe(false);
    expect(screen.queryByText(new RegExp(K4ALL_MANAGED))).toBeNull();
    expect(screen.queryByText('Set by the k4all release.')).toBeNull();
    expect(state.gets).toEqual([]);
  });
});
