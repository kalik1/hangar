import { buildVm, WizardInput } from '../model/vmspec';
import { isDesktopImage, libraryImages, osChoice, virtioVideoDefault, WINDOWS_VIRTIO_VIDEO_DEFAULT } from './catalog';

describe('desktop guests (VirtIO video, hangar#4)', () => {
  it('Windows keeps KubeVirt\'s card until its lab test (kalik1/hangar#19), whatever the image', () => {
    expect(WINDOWS_VIRTIO_VIDEO_DEFAULT).toBe(false);
    expect(virtioVideoDefault(osChoice('windows'))).toBe(false);
    expect(virtioVideoDefault(osChoice('windows'), { desktop: true })).toBe(false);
  });

  it('a Linux desktop image gets the VirtIO card; a server or cloud image does not', () => {
    expect(virtioVideoDefault(osChoice('fedora'), { desktop: true })).toBe(true);
    expect(virtioVideoDefault(osChoice('fedora'), { desktop: false })).toBe(false);
    expect(virtioVideoDefault(osChoice('ubuntu'))).toBe(false);
    expect(virtioVideoDefault(osChoice('other'), { desktop: true })).toBe(true);
  });

  it('reads a desktop from the name of the image or installer', () => {
    for (const n of ['Fedora-Workstation-Live-x86_64-43.iso', 'ubuntu-24.04.1-desktop-amd64.iso', 'Fedora-KDE-Live', 'debian-12-xfce', 'Linux Mint Cinnamon']) {
      expect(isDesktopImage(n)).toBe(true);
    }
    for (const n of ['ubuntu-24.04-live-server-amd64.iso', 'Fedora-Cloud-Base-Generic-43.qcow2', 'rocky-10-genericcloud', 'mateo-disk', undefined]) {
      expect(isDesktopImage(n)).toBe(false);
    }
    expect(isDesktopImage('fedora-43', 'Fedora 43 Workstation')).toBe(true);
  });

  it('marks library images by their display name or name', () => {
    const dv = (name: string, display?: string) => ({
      metadata: {
        name,
        namespace: 'hangar-library',
        labels: { 'hangar.magesgate.com/image': 'true' },
        annotations: display ? { 'hangar.magesgate.com/display-name': display } : {},
      },
      status: { phase: 'Succeeded' },
    });
    const imgs = libraryImages([dv('f43', 'Fedora 43 Workstation'), dv('ubuntu-24-04-desktop'), dv('fedora-cloud')], [], 'hangar-library');
    expect(Object.fromEntries(imgs.map(i => [i.name, i.desktop]))).toEqual({ f43: true, 'ubuntu-24-04-desktop': true, 'fedora-cloud': false });
  });

  it('the wizard puts the card in the VM, never on a headless one', () => {
    const w: WizardInput = {
      name: 'desk',
      namespace: 'demo',
      sockets: 1,
      cores: 2,
      threads: 1,
      memoryBytes: 4 * 2 ** 30,
      firmware: 'uefi-secure',
      tpm: true,
      source: { kind: 'blank' },
      rootDisk: { name: 'rootdisk', sizeBytes: 64 * 2 ** 30, bus: 'virtio' },
      extraDisks: [],
      nics: [],
      runStrategy: 'Always',
    };
    const devices = (x: WizardInput) => buildVm(x).spec.template.spec.domain.devices;
    expect(devices({ ...w, video: 'virtio' }).video).toEqual({ type: 'virtio' });
    expect(devices(w).video).toBeUndefined();
    expect(devices({ ...w, video: 'virtio', headless: true }).video).toBeUndefined();
  });
});
