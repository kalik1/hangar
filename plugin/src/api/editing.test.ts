import { EditStore } from './editing';
import { FakeGuest } from './guestfiles.fixture';

const enc = (s: string) => new TextEncoder().encode(s);

/** A local file the user edits with another application. */
class FakeHandle {
  data = new Uint8Array(0);
  lastModified = 1000;
  constructor(readonly name: string) {}
  async getFile() {
    return new File([this.data] as BlobPart[], this.name, { lastModified: this.lastModified });
  }
  async createWritable() {
    const parts: Uint8Array[] = [];
    return {
      write: async (b: Uint8Array) => void parts.push(b),
      close: async () => {
        this.data = new Uint8Array(parts.reduce((n, p) => [...n, ...p], [] as number[]));
        this.lastModified += 1000;
      },
      abort: async () => undefined,
    };
  }
  /** The user saves in their application. */
  save(text: string) {
    this.data = enc(text);
    this.lastModified += 1000;
  }
}

const text = (h: FakeHandle) => new TextDecoder().decode(h.data);
const vm = { namespace: 'vms', name: 'vm' };

async function session(content = 'v1') {
  const g = new FakeGuest().file('/home/k4all/notes.docx', content, 'k4all');
  const h = new FakeHandle('notes.docx');
  const store = new EditStore({ pollMs: 1e9, observe: false });
  const s = await store.start(g, vm, '/home/k4all/notes.docx', h as any, 'Documents');
  return { g, h, store, id: s.id, state: () => store.getSnapshot()[0] };
}

describe('Edit on this PC', () => {
  it('saves the VM file locally, then sees a save on this PC and writes it back on a click', async () => {
    const { g, h, store, id, state } = await session();
    expect(text(h)).toBe('v1');
    expect(state()).toMatchObject({ state: 'watching', localName: 'notes.docx', folder: 'Documents' });
    await store.check(id);
    expect(state().state).toBe('watching');
    h.save('v2 from Word');
    await store.check(id);
    expect(state().state).toBe('changed');
    expect(store.unsaved()).toBe(true);
    g.calls = [];
    await store.writeBack(id);
    expect(g.text('/home/k4all/notes.docx')).toBe('v2 from Word');
    // The check is a stat (unchanged size and mtime: no hash), then the write in place, then a stat for the new version.
    expect(g.log()).toEqual(['stat /home/k4all/notes.docx', 'write /home/k4all/notes.docx@0!', 'stat /home/k4all/notes.docx']);
    expect(state().state).toBe('watching');
    // In place: the owner stays.
    expect(g.nodes.get('/home/k4all/notes.docx')!.user).toBe('k4all');
  });

  it('"write each save" writes without a click', async () => {
    const { g, h, store, id } = await session();
    store.setAuto(id, true);
    h.save('auto');
    await store.check(id);
    expect(g.text('/home/k4all/notes.docx')).toBe('auto');
  });

  it('a VM copy that changed too is a conflict: keep the VM’s, overwrite, or save both', async () => {
    const { g, h, store, id, state } = await session();
    g.touch('/home/k4all/notes.docx', 'changed in the VM');
    h.save('changed here');
    await store.check(id);
    await store.writeBack(id);
    expect(state()).toMatchObject({ state: 'conflict' });
    expect(g.text('/home/k4all/notes.docx')).toBe('changed in the VM');

    await store.writeBack(id, 'saveBoth');
    expect(g.text('/home/k4all/notes.docx')).toBe('changed in the VM');
    expect(g.text('/home/k4all/notes (1).docx')).toBe('changed here');
    expect(state()).toMatchObject({ state: 'watching', vmPath: '/home/k4all/notes (1).docx' });

    // The next save goes to the copy, which nobody changed: no question.
    h.save('again');
    await store.check(id);
    await store.writeBack(id);
    expect(g.text('/home/k4all/notes (1).docx')).toBe('again');
  });

  it('overwrite and keep the VM’s', async () => {
    const { g, h, store, id, state } = await session();
    g.touch('/home/k4all/notes.docx', 'vm edit');
    h.save('pc edit');
    await store.check(id);
    await store.writeBack(id);
    await store.writeBack(id, 'keepVm');
    expect(state()).toMatchObject({ state: 'watching' });
    expect(g.text('/home/k4all/notes.docx')).toBe('vm edit');
    h.save('pc edit 2');
    await store.check(id);
    await store.writeBack(id, 'overwrite');
    expect(g.text('/home/k4all/notes.docx')).toBe('pc edit 2');
  });

  it('a touch in the VM (same bytes) is no conflict: the hash decides', async () => {
    const { g, h, store, id } = await session('same');
    g.touch('/home/k4all/notes.docx');
    h.save('mine');
    await store.check(id);
    await store.writeBack(id);
    expect(g.text('/home/k4all/notes.docx')).toBe('mine');
    expect(g.log('hash')).toHaveLength(1);
  });

  it('a write the guest refuses is an error on the row; stop ends the watch', async () => {
    const { g, h, store, id, state } = await session();
    g.confined = true;
    h.save('x');
    await store.check(id);
    await store.writeBack(id);
    expect(state()).toMatchObject({ state: 'error', message: expect.stringContaining('Permission denied') });
    store.stop(id);
    expect(store.getSnapshot()).toEqual([]);
  });
});
