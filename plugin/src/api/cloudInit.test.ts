import { Obj, VM } from '../model/types';
import { buildVm, WizardInput } from '../model/vmspec';
import { createWithCloudInit, readCloudInitSecrets } from './cloudInit';

/** The API: what was called, in order; `fail` makes a call reject (method + path prefix → error). */
const api: { calls: { method: string; path: string; body?: any }[]; fail: Map<string, unknown>; secrets: Map<string, Obj> } = {
  calls: [],
  fail: new Map(),
  secrets: new Map(),
};
const failing = (method: string, path: string) => [...api.fail].find(([k]) => `${method} ${path}`.startsWith(k))?.[1];

vi.mock('./client', async orig => ({
  ...((await orig()) as object),
  kpost: async (path: string, body: any) => {
    api.calls.push({ method: 'POST', path, body });
    const e = failing('POST', path);
    if (e) throw e;
    return { ...body, metadata: { ...body.metadata, name: body.metadata.name ?? `${body.metadata.generateName}x7k2p`, uid: 'uid-1' } };
  },
  kmerge: async (path: string, body: any) => {
    api.calls.push({ method: 'PATCH', path, body });
    const e = failing('PATCH', path);
    if (e) throw e;
    return {};
  },
  kdelete: async (path: string) => {
    api.calls.push({ method: 'DELETE', path });
    return {};
  },
  kreq: async (path: string) => {
    api.calls.push({ method: 'GET', path });
    const s = api.secrets.get(path);
    if (!s) throw Object.assign(new Error('Forbidden - secrets "x" is forbidden'), { status: 403 });
    return s;
  },
}));

const base: WizardInput = {
  name: 'web-03',
  namespace: 'prod',
  sockets: 1,
  cores: 1,
  threads: 1,
  memoryBytes: 2 ** 30,
  firmware: 'bios',
  tpm: false,
  source: { kind: 'blank' },
  rootDisk: { name: 'rootdisk', sizeBytes: 2 ** 30, bus: 'virtio' },
  extraDisks: [],
  nics: [],
  runStrategy: 'Halted',
};
const sized = (n: number) => '#cloud-config\n#' + 'x'.repeat(n - 16) + '\n';
const vmWith = (userData: string) => buildVm({ ...base, cloudInit: { custom: userData } });
const ciOf = (vm: any) => vm.spec.template.spec.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud;
const SECRETS = '/api/v1/namespaces/prod/secrets';

/** A create that records the VM it gets and answers with a uid. */
function creator() {
  const got: VM[] = [];
  const create = async (vm: VM) => {
    got.push(vm);
    api.calls.push({ method: 'POST', path: 'vm' });
    if (api.fail.has('vm')) throw api.fail.get('vm');
    return { ...vm, metadata: { ...vm.metadata, uid: 'vm-uid' } } as Obj;
  };
  return { got, create };
}

describe('createWithCloudInit: the 2048-byte guard (hangar#7)', () => {
  beforeEach(() => {
    api.calls = [];
    api.fail = new Map();
    api.secrets = new Map();
  });

  it('2048 bytes: inline, no Secret', async () => {
    const { got, create } = creator();
    await createWithCloudInit(vmWith(sized(2048)), create);
    expect(ciOf(got[0])).toEqual({ userData: sized(2048) });
    expect(api.calls.map(c => c.method + ' ' + c.path)).toEqual(['POST vm']);
  });

  it('2049 bytes: a Secret first, the VM refers to it, then the VM owns it', async () => {
    const { got, create } = creator();
    await createWithCloudInit(vmWith(sized(2049)), create);
    expect(api.calls.map(c => c.method + ' ' + c.path)).toEqual(['POST ' + SECRETS, 'POST vm', `PATCH ${SECRETS}/web-03-cloudinit-x7k2p`]);
    expect(api.calls[0].body.stringData).toEqual({ userdata: sized(2049) });
    expect(ciOf(got[0])).toEqual({ secretRef: { name: 'web-03-cloudinit-x7k2p' } });
    expect(api.calls[2].body).toEqual({
      metadata: { ownerReferences: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'web-03', uid: 'vm-uid' }] },
    });
  });

  it('refuses with the reason when it cannot make the Secret, and creates nothing', async () => {
    api.fail.set('POST ' + SECRETS, Object.assign(new Error('Forbidden - secrets is forbidden: User "u" cannot create resource "secrets"'), { status: 403 }));
    const { got, create } = creator();
    await expect(createWithCloudInit(vmWith(sized(2400)), create)).rejects.toThrow(
      'The cloud-init user data is 2,400 bytes, more than the 2,048 KubeVirt takes inline, and Hangar could not keep it in a Secret: Not allowed: secrets is forbidden: User "u" cannot create resource "secrets"'
    );
    expect(got).toEqual([]);
  });

  it('a failed VM create deletes the Secret it made', async () => {
    const denied = Object.assign(new Error('Unprocessable Entity - bad spec'), { status: 422 });
    api.fail.set('vm', denied);
    const { create } = creator();
    await expect(createWithCloudInit(vmWith(sized(2049)), create)).rejects.toBe(denied);
    expect(api.calls.map(c => c.method + ' ' + c.path)).toEqual(['POST ' + SECRETS, 'POST vm', `DELETE ${SECRETS}/web-03-cloudinit-x7k2p`]);
  });

  it('without patch on Secrets the VM is still created (the Secret stays after it)', async () => {
    api.fail.set('PATCH ' + SECRETS, Object.assign(new Error('Forbidden - no'), { status: 403 }));
    const { got, create } = creator();
    await expect(createWithCloudInit(vmWith(sized(2049)), create)).resolves.toMatchObject({ metadata: { uid: 'vm-uid' } });
    expect(got).toHaveLength(1);
  });

  it('a copy gets the source’s Secret-held user data in a Secret of its own, with its hostname', async () => {
    const copy = vmWith('#cloud-config\n');
    ciOf(copy).secretRef = { name: 'tpl-cloudinit-aaaaa' };
    delete ciOf(copy).userData;
    const { got, create } = creator();
    await createWithCloudInit(copy, create, new Map([['cloudinitdisk', '#cloud-config\nhostname: tpl\n']]));
    expect(api.calls[0].body.stringData).toEqual({ userdata: '#cloud-config\nhostname: web-03\n' });
    expect(ciOf(got[0])).toEqual({ secretRef: { name: 'web-03-cloudinit-x7k2p' } });
  });
});

describe('readCloudInitSecrets', () => {
  beforeEach(() => {
    api.calls = [];
    api.secrets = new Map();
  });

  it('reads the user data of Secret-held cloud-init volumes, and leaves out what it may not read', async () => {
    const vm = vmWith('#cloud-config\n');
    ciOf(vm).secretRef = { name: 'web-03-cloudinit-aaaaa' };
    delete ciOf(vm).userData;
    vm.spec.template.spec.volumes.push({ name: 'other', cloudInitConfigDrive: { secretRef: { name: 'theirs' } } });
    api.secrets.set(`${SECRETS}/web-03-cloudinit-aaaaa`, { metadata: { name: 'web-03-cloudinit-aaaaa' }, data: { userdata: btoa('#cloud-config\nhostname: é\n'.replace('é', 'Ã©')) } });
    const out = await readCloudInitSecrets(vm);
    expect([...out]).toEqual([['cloudinitdisk', '#cloud-config\nhostname: é\n']]);
    expect(api.calls.map(c => c.path).sort()).toEqual([`${SECRETS}/theirs`, `${SECRETS}/web-03-cloudinit-aaaaa`]);
  });
});
