import { defaultVideo, followsWindow, videoCards, videoOf } from './display';

const spec = (o: { video?: string; efi?: boolean; arch?: string } = {}) => ({
  ...(o.arch ? { architecture: o.arch } : {}),
  domain: {
    devices: o.video ? { video: { type: o.video } } : {},
    ...(o.efi ? { firmware: { bootloader: { efi: { secureBoot: true } } } } : {}),
  },
});

describe('the video card', () => {
  it("is KubeVirt's default when the spec names none", () => {
    expect(defaultVideo(spec())).toBe('vga');
    expect(defaultVideo(spec({ efi: true }))).toBe('bochs');
    expect(defaultVideo(spec({ arch: 'arm64' }))).toBe('virtio');
    expect(defaultVideo(spec({ arch: 's390x', efi: true }))).toBe('virtio');
    expect(defaultVideo(undefined)).toBe('vga');
    expect(videoOf(spec())).toEqual({ type: 'vga', label: 'VGA', chosen: false });
  });

  it('is the one the spec names', () => {
    expect(videoOf(spec({ video: 'virtio' }))).toEqual({ type: 'virtio', label: 'VirtIO', chosen: true });
    expect(videoOf(spec({ video: 'ramfb', efi: true }))).toEqual({ type: 'ramfb', label: 'ramfb', chosen: true });
  });

  it('follows the window only with VirtIO', () => {
    expect(['virtio', 'vga', 'bochs', 'cirrus', 'ramfb'].filter(followsWindow)).toEqual(['virtio']);
  });

  it("of a running VM is its instance's; a change waits for the next power-on", () => {
    const vm = { metadata: { name: 'a' }, spec: { template: { spec: spec({ video: 'virtio' }) } } };
    const vmi = { metadata: { name: 'a' }, spec: spec({ arch: 'amd64' }) };
    expect(videoCards(vm, vmi)).toEqual({
      now: { type: 'vga', label: 'VGA', chosen: false },
      next: { type: 'virtio', label: 'VirtIO', chosen: true },
    });
    expect(videoCards(vm, null)?.now.type).toBe('virtio');
    expect(videoCards(null, null)).toBeNull();
  });

  it("reads the next card with the instance's architecture when the template names none", () => {
    const vm = { metadata: { name: 'a' }, spec: { template: { spec: spec() } } };
    const vmi = { metadata: { name: 'a' }, spec: spec({ arch: 'arm64' }) };
    expect(videoCards(vm, vmi)?.next.type).toBe('virtio');
  });
});
