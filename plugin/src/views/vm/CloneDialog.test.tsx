import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import * as A from '../../api/actions';
import { readCloudInitSecrets } from '../../api/cloudInit';
import { HangarData } from '../../api/data';
import { Obj } from '../../model/types';
import { CloneDialog } from './CloneDialog';

const perms = { getSecrets: true };
vi.mock('../../api/actions', () => ({ createVm: vi.fn(async () => ({})) }));
vi.mock('../../api/cloudInit', () => ({ readCloudInitSecrets: vi.fn() }));
vi.mock('../../api/permissions', () => ({ useCan: (a: any) => (a?.resource === 'secrets' ? perms.getSecrets : true) }));

/** A VM whose cloud-init user data is in a Secret (made by Hangar's 2048-byte guard). */
const source: Obj = {
  apiVersion: 'kubevirt.io/v1',
  kind: 'VirtualMachine',
  metadata: { name: 'web-03', namespace: 'prod' },
  spec: {
    runStrategy: 'Halted',
    template: {
      spec: {
        domain: { devices: { disks: [{ name: 'cloudinitdisk', disk: { bus: 'virtio' } }], interfaces: [] } },
        volumes: [{ name: 'cloudinitdisk', cloudInitNoCloud: { secretRef: { name: 'web-03-cloudinit-abcde' } } }],
      },
    },
  },
};
const data = { vms: [source], namespaces: [{ metadata: { name: 'prod' } }, { metadata: { name: 'test' } }], vmis: [], idx: { pvc: new Map() } } as unknown as HangarData;

async function cloneTo(folder?: string) {
  render(<CloneDialog source={source} data={data} mode="clone" onClose={() => undefined} />);
  if (folder) fireEvent.change(screen.getByLabelText('Folder'), { target: { value: folder } });
  return () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clone' })));
}
const created = () => vi.mocked(A.createVm).mock.calls[0];

describe('a copy of a VM whose cloud-init user data is in a Secret', () => {
  beforeEach(() => {
    perms.getSecrets = true;
    vi.mocked(A.createVm).mockClear();
    vi.mocked(readCloudInitSecrets).mockReset().mockResolvedValue({ texts: new Map([['cloudinitdisk', '#cloud-config\nhostname: web-03\n']]), unreadable: [] });
  });

  it('with the right to read it: no note, the user data goes to createVm for a Secret of the copy’s own', async () => {
    const click = await cloneTo();
    expect(screen.queryByRole('status')).toBeNull();
    await click();
    expect(readCloudInitSecrets).toHaveBeenCalledWith(source);
    expect([...created()[2]!]).toEqual([['cloudinitdisk', '#cloud-config\nhostname: web-03\n']]);
  });

  it('without it, in the same folder: says the copy shares the Secret, and never asks for it', async () => {
    perms.getSecrets = false;
    const click = await cloneTo();
    expect(screen.getByRole('status').textContent).toBe(
      "web-03 keeps its cloud-init user data in a Secret, which your role may not read. The copy uses the same Secret: it keeps web-03's hostname, and loses its user data if web-03 is deleted."
    );
    await click();
    expect(readCloudInitSecrets).not.toHaveBeenCalled();
    const vm = created()[0];
    expect(vm.spec.template.spec.volumes).toEqual([{ name: 'cloudinitdisk', cloudInitNoCloud: { secretRef: { name: 'web-03-cloudinit-abcde' } } }]);
  });

  it('without it, in another folder: says the copy gets no user data, and drops the volume it could not start with', async () => {
    perms.getSecrets = false;
    const click = await cloneTo('test');
    expect(screen.getByRole('status').textContent).toBe(
      'web-03 keeps its cloud-init user data in a Secret, which your role may not read, and that Secret is not in test: the copy gets no cloud-init user data.'
    );
    await click();
    const vm = created()[0];
    expect(vm.metadata.namespace).toBe('test');
    expect(vm.spec.template.spec.volumes).toEqual([]);
    expect(vm.spec.template.spec.domain.devices.disks).toEqual([]);
  });
});
