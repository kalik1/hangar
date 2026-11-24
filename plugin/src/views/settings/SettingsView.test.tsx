import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { K4ALL_MANAGED } from '../../model/ownership';
import { Obj } from '../../model/types';
import { SettingsView } from './SettingsView';

const state: { kv: Obj | null; k4all: boolean; addon: boolean } = { kv: null, k4all: true, addon: true };

vi.mock('../../api/data', () => ({
  useHangar: () => ({ kubevirt: state.kv, vms: [], storageClasses: [], storageProfiles: [], pvcs: [], namespaces: [] }),
}));
vi.mock('../../api/gates', () => ({ setFeatureGate: vi.fn(), useCanPatchKubevirt: () => true }));
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

const gateSwitch = (gate: string) => document.querySelector(`input[aria-label^="${gate}:"]`) as HTMLInputElement;
const page = () =>
  render(
    <MemoryRouter>
      <SettingsView section="features" />
    </MemoryRouter>
  );

describe('Settings → Features on k4all', () => {
  beforeEach(() => {
    state.kv = kubevirt();
    state.k4all = true;
    state.addon = true;
  });

  it('shows the gates k4all lists read-only, with a link to the addon’s feature gates', () => {
    page();
    expect(gateSwitch('Sidecar').disabled).toBe(true);
    expect(gateSwitch('Sidecar').checked).toBe(true);
    expect(gateSwitch('Snapshot').disabled).toBe(true);
    expect(gateSwitch('Snapshot').checked).toBe(false);
    expect(screen.getAllByText(/Managed by k4all — change it in the k4all addon \(k4all turns it (on|off)\)/)).toHaveLength(2);
    const links = screen.getAllByText('Open the k4all addon').map(a => a.getAttribute('href'));
    expect(links).toContain('/c/main/k4all/settings/virtualization#feature-gates');
  });

  it('leaves the other gates editable (D2)', () => {
    page();
    expect(gateSwitch('VSOCK').disabled).toBe(false);
    expect(gateSwitch('HostDevices').disabled).toBe(false);
    expect(gateSwitch('DeclarativeHotplugVolumes').disabled).toBe(false);
  });

  it('shows the settings k4all applies read-only: VM state datastore, emulation, update methods (D3)', () => {
    page();
    const hrefs = screen.getAllByText('Open the k4all addon').map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/c/main/k4all/settings/virtualization#vm-state');
    expect(hrefs).toContain('/c/main/k4all/settings/virtualization');
    expect(screen.getByText('Set by the k4all release.')).toBeTruthy();
    expect(screen.queryByText(/Set spec.configuration.vmStateStorageClass/)).toBeNull();
  });

  it('keeps the words without a link when the k4all plugin is not loaded', () => {
    state.addon = false;
    page();
    expect(screen.getAllByText(new RegExp(K4ALL_MANAGED)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Open the k4all addon')).toBeNull();
  });

  it('without k4all every gate and setting is Hangar’s, whatever the annotation and managedFields say', () => {
    state.k4all = false;
    page();
    expect(gateSwitch('Sidecar').disabled).toBe(false);
    expect(gateSwitch('Snapshot').disabled).toBe(false);
    expect(screen.queryByText(new RegExp(K4ALL_MANAGED))).toBeNull();
    expect(screen.queryByText('Set by the k4all release.')).toBeNull();
  });
});
