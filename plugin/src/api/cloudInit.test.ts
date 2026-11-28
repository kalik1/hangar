import { Obj, VM } from '../model/types';
import { buildVm, WizardInput } from '../model/vmspec';
import { createWithCloudInit, readCloudInitSecrets } from './cloudInit';

/** The API: what was called, in order; `fail` makes a call reject (its signature, `?dry` for a dry run → error). */
const api: { calls: { method: string; path: string; body?: any; query?: any }[]; fail: Map<string, unknown>; secrets: Map<string, Obj> } = {
  calls: [],
  fail: new Map(),
  secrets: new Map(),
};
const sig = (c: { method: string; path: string; query?: any }) => `${c.method} ${c.path}${c.query?.dryRun ? '?dry' : ''}`;

vi.mock('./client', async orig => ({
  ...((await orig()) as object),
  kpost: async (path: string, body: any, query?: any) => {
    const c = { method: 'POST', path, body, query };
    api.calls.push(c);
    if (api.fail.has(sig(c))) throw api.fail.get(sig(c));
    return body;
  },
  kdelete: async (path: string, body?: any) => {
    const c = { method: 'DELETE', path, body };
    api.calls.push(c);
    if (api.fail.has(sig(c))) throw api.fail.get(sig(c));
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
  runStrategy: 'Always',
};
const sized = (n: number) => '#cloud-config\n#' + 'x'.repeat(n - 16) + '\n';
const vmWith = (userData: string) => buildVm({ ...base, cloudInit: { custom: userData } });
const ciOf = (vm: any) => vm.spec.template.spec.volumes.find((v: any) => v.name === 'cloudinitdisk').cloudInitNoCloud;
const SECRETS = '/api/v1/namespaces/prod/secrets';
const VM_PATH = '/apis/kubevirt.io/v1/namespaces/prod/virtualmachines/web-03';
const NAME = /^web-03-cloudinit-[a-z0-9]{5}$/;

/** A create that records the VM it gets and answers with a uid. */
function creator() {
  const got: VM[] = [];
  const create = async (vm: VM) => {
    got.push(vm);
    const c = { method: 'POST', path: 'vm' };
    api.calls.push(c);
    if (api.fail.has(sig(c))) throw api.fail.get(sig(c));
    return { ...vm, metadata: { ...vm.metadata, uid: 'vm-uid' } } as Obj;
  };
  return { got, create };
}
const forbidden = (m: string) => Object.assign(new Error(`Forbidden - ${m}`), { status: 403 });

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
    expect(api.calls.map(sig)).toEqual(['POST vm']);
  });

  it('2049 bytes: a dry run of the Secret, the VM (it refers to the Secret), then the Secret owned by the VM; no patch', async () => {
    const { got, create } = creator();
    await createWithCloudInit(vmWith(sized(2049)), create);
    expect(api.calls.map(sig)).toEqual([`POST ${SECRETS}?dry`, 'POST vm', `POST ${SECRETS}`]);
    const [dry, , secret] = api.calls;
    expect(dry.query).toEqual({ dryRun: 'All' });
    expect(dry.body.metadata.ownerReferences).toBeUndefined();
    expect(secret.body.metadata.name).toMatch(NAME);
    expect(secret.body.metadata.name).toBe(dry.body.metadata.name);
    expect(secret.body.stringData).toEqual({ userdata: sized(2049) });
    expect(secret.body.metadata.ownerReferences).toEqual([{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', name: 'web-03', uid: 'vm-uid' }]);
    expect(ciOf(got[0])).toEqual({ secretRef: { name: secret.body.metadata.name } });
  });

  it('refuses with the reason when the Secret may not be made, and creates nothing', async () => {
    api.fail.set(`POST ${SECRETS}?dry`, forbidden('secrets is forbidden: User "u" cannot create resource "secrets"'));
    const { got, create } = creator();
    await expect(createWithCloudInit(vmWith(sized(2400)), create)).rejects.toThrow(
      'The cloud-init user data is 2,400 bytes, more than the 2,048 KubeVirt takes inline, and Hangar could not keep it in a Secret: Not allowed: secrets is forbidden: User "u" cannot create resource "secrets"'
    );
    expect(got).toEqual([]);
    expect(api.calls.map(sig)).toEqual([`POST ${SECRETS}?dry`]);
  });

  it('when the real Secret still fails, deletes the VM it just created and says why', async () => {
    api.fail.set(`POST ${SECRETS}`, forbidden('exceeded quota: secrets'));
    const { create } = creator();
    const e = await createWithCloudInit(vmWith(sized(2049)), create).catch(x => x);
    expect(e.message).toBe('The cloud-init user data is 2,049 bytes, more than the 2,048 KubeVirt takes inline, and Hangar could not keep it in a Secret: Not allowed: exceeded quota: secrets');
    expect(api.calls.map(sig)).toEqual([`POST ${SECRETS}?dry`, 'POST vm', `POST ${SECRETS}`, `DELETE ${VM_PATH}`]);
    expect(api.calls[3].body).toEqual({ kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Background' });
  });

  it('names a VM it could not delete again', async () => {
    api.fail.set(`POST ${SECRETS}`, forbidden('exceeded quota: secrets'));
    api.fail.set(`DELETE ${VM_PATH}`, forbidden('protected'));
    const { create } = creator();
    await expect(createWithCloudInit(vmWith(sized(2049)), create)).rejects.toThrow(/secrets The VM web-03 was created and Hangar could not delete it again: delete it\.$/);
  });

  it('a failed VM create leaves nothing: the Secret is made only after it', async () => {
    const bad = Object.assign(new Error('Unprocessable Entity - bad spec'), { status: 422 });
    api.fail.set('POST vm', bad);
    const { create } = creator();
    await expect(createWithCloudInit(vmWith(sized(2049)), create)).rejects.toBe(bad);
    expect(api.calls.map(sig)).toEqual([`POST ${SECRETS}?dry`, 'POST vm']);
  });

  it('a copy gets the source’s Secret-held user data in a Secret of its own, with its hostname, in the same order', async () => {
    const copy = vmWith('#cloud-config\n');
    ciOf(copy).secretRef = { name: 'tpl-cloudinit-aaaaa' };
    delete ciOf(copy).userData;
    const { got, create } = creator();
    await createWithCloudInit(copy, create, new Map([['cloudinitdisk', '#cloud-config\nhostname: tpl\n']]));
    expect(api.calls.map(sig)).toEqual([`POST ${SECRETS}?dry`, 'POST vm', `POST ${SECRETS}`]);
    expect(api.calls[2].body.stringData).toEqual({ userdata: '#cloud-config\nhostname: web-03\n' });
    expect(api.calls[2].body.metadata.ownerReferences[0].uid).toBe('vm-uid');
    expect(ciOf(got[0])).toEqual({ secretRef: { name: api.calls[2].body.metadata.name } });
  });
});

describe('readCloudInitSecrets', () => {
  beforeEach(() => {
    api.calls = [];
    api.secrets = new Map();
  });

  it('reads the user data of Secret-held cloud-init volumes, and lists what it may not read', async () => {
    const vm = vmWith('#cloud-config\n');
    ciOf(vm).secretRef = { name: 'web-03-cloudinit-aaaaa' };
    delete ciOf(vm).userData;
    vm.spec.template.spec.volumes.push({ name: 'other', cloudInitConfigDrive: { secretRef: { name: 'theirs' } } });
    api.secrets.set(`${SECRETS}/web-03-cloudinit-aaaaa`, { metadata: { name: 'web-03-cloudinit-aaaaa' }, data: { userdata: btoa('#cloud-config\nhostname: Ã©\n') } });
    const out = await readCloudInitSecrets(vm);
    expect([...out.texts]).toEqual([['cloudinitdisk', '#cloud-config\nhostname: é\n']]);
    expect(out.unreadable).toEqual(['other']);
  });
});
