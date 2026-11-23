import { describe, expect, it } from 'vitest';
import {
  clonesInProgress,
  editPatch,
  guessFromName,
  imageDataVolume,
  libraryItems,
  libraryManifests,
  registryUrl,
  slugName,
  sniffImage,
  sourceRows,
  suggestedSize,
  urlProblem,
} from './library';
import { Obj } from './types';

const GiB = 2 ** 30;

describe('library items', () => {
  const dv = (ns: string, name: string, ann: Record<string, string> = {}, labels: Record<string, string> = {}, status: any = { phase: 'Succeeded' }): Obj => ({
    metadata: { namespace: ns, name, annotations: ann, labels, creationTimestamp: '2026-11-22T10:00:00Z' },
    spec: { source: { http: { url: 'https://x/y.img' } }, storage: { resources: { requests: { storage: '1Gi' } } } },
    status,
  });
  it('lists labelled images and everything in the library namespace', () => {
    const items = libraryItems(
      [
        dv('hangar-library', 'cirros-0.6.3', { 'hangar.magesgate.com/display-name': 'CirrOS 0.6.3', 'hangar.magesgate.com/os': 'cirros', 'hangar.magesgate.com/media': 'disk' }, { 'hangar.magesgate.com/image': 'true' }),
        dv('hangar-library', 'alpine-virt-iso', {}, {}, { phase: 'ImportInProgress', progress: '12.0%' }),
        dv('prod', 'web-root'),
        dv('prod', 'golden', {}, { 'hangar.magesgate.com/image': 'true' }),
      ],
      [{ metadata: { namespace: 'hangar-library', name: 'prime-00000000-0000-4000-8000-000000000001' }, spec: {} }],
      'hangar-library'
    );
    expect(items.map(i => i.name)).toEqual(['alpine-virt-iso', 'cirros-0.6.3', 'golden']);
    const [alpine, cirros] = items;
    expect(cirros).toMatchObject({ displayName: 'CirrOS 0.6.3', os: 'cirros', media: 'disk', sizeBytes: GiB, source: { kind: 'http' } });
    expect(alpine).toMatchObject({ media: 'iso', os: 'alpine' });
    expect(alpine.state.label).toBe('Importing 12%');
  });
});

describe('names and references', () => {
  it('makes Kubernetes names from display names', () => {
    expect(slugName('Ubuntu 24.04 LTS')).toBe('ubuntu-24-04-lts');
    expect(slugName('Débian 12 — netinst')).toBe('debian-12-netinst');
    expect(slugName('2024 build')).toBe('image-2024-build');
    expect(slugName('cirros', new Set(['cirros']))).toBe('cirros-2');
    expect(slugName('x'.repeat(80)).length).toBeLessThanOrEqual(50);
  });
  it('normalises registry references', () => {
    expect(registryUrl('quay.io/containerdisks/fedora:41')).toBe('docker://quay.io/containerdisks/fedora:41');
    expect(registryUrl('docker://quay.io/a/b')).toBe('docker://quay.io/a/b');
    expect(urlProblem('registry', 'quay.io/containerdisks/fedora:latest')).toBeNull();
    expect(urlProblem('registry', 'fedora')).toMatch(/reference like/);
    expect(urlProblem('http', 'ftp://x')).toMatch(/http/);
    expect(urlProblem('http', 'https://dl-cdn.alpinelinux.org/a.iso')).toBeNull();
  });
  it('guesses name, OS and media from a file name', () => {
    expect(guessFromName('alpine-virt-3.24.4-x86_64.iso')).toEqual({ displayName: 'alpine-virt-3.24.4-x86_64', os: 'alpine', media: 'iso' });
    expect(guessFromName('https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img?x=1')).toMatchObject({ media: 'disk' });
    expect(guessFromName('Fedora-Cloud-Base-Generic-45-1.4.x86_64.qcow2')).toMatchObject({ os: 'fedora', displayName: 'Fedora-Cloud-Base-Generic-45-1.4.x86_64' });
    expect(guessFromName('Win11_24H2_English_x64.iso').os).toBe('windows');
  });
});

describe('manifests', () => {
  it('builds an import DataVolume with the library labels', () => {
    const dv = imageDataVolume({ namespace: 'lib', name: 'cirros', displayName: 'CirrOS', os: 'cirros', media: 'disk', sizeBytes: GiB, source: { http: ' https://x/c.img ' } });
    expect(dv.metadata.labels).toEqual({ 'hangar.magesgate.com/image': 'true' });
    expect(dv.metadata.annotations).toMatchObject({
      'hangar.magesgate.com/display-name': 'CirrOS',
      'hangar.magesgate.com/os': 'cirros',
      'hangar.magesgate.com/media': 'disk',
      'cdi.kubevirt.io/storage.bind.immediate.requested': 'true',
    });
    expect(dv.spec.source).toEqual({ http: { url: 'https://x/c.img' } });
    expect(dv.spec.storage.resources.requests.storage).toBe('1Gi');
  });
  it('builds registry and upload DataVolumes', () => {
    const reg = imageDataVolume({ namespace: 'lib', name: 'f', displayName: 'F', media: 'disk', sizeBytes: 10 * GiB, source: { registry: 'quay.io/containerdisks/fedora:41' }, storageClass: 'fast' });
    expect(reg.spec.source).toEqual({ registry: { url: 'docker://quay.io/containerdisks/fedora:41' } });
    expect(reg.spec.storage.storageClassName).toBe('fast');
    const up = imageDataVolume({ namespace: 'lib', name: 'u', displayName: 'U', media: 'iso', sizeBytes: 70 * 2 ** 20, source: { upload: true } });
    expect(up.spec.source).toEqual({ upload: {} });
    expect(up.spec.storage.resources.requests.storage).toBe('70Mi');
  });
  it('edits or removes annotations', () => {
    expect(editPatch({ displayName: ' New ', os: '' })).toEqual({
      metadata: { annotations: { 'hangar.magesgate.com/display-name': 'New', 'hangar.magesgate.com/os': null } },
    });
  });
  it('shares the library with every folder', () => {
    const m = libraryManifests('hangar-library');
    expect(m.namespace.metadata.labels).toEqual({ 'hangar.magesgate.com/library': 'true' });
    expect(m.role.rules[0]).toEqual({ apiGroups: ['cdi.kubevirt.io'], resources: ['datavolumes/source'], verbs: ['create'] });
    expect(m.binding.subjects.map((s: any) => s.name)).toEqual(['system:serviceaccounts', 'system:authenticated']);
    expect(m.binding.roleRef.name).toBe(m.role.metadata.name);
  });
  it('finds disks still being copied from an image', () => {
    const copying = { metadata: { namespace: 'p', name: 'a' }, spec: { source: { pvc: { namespace: 'lib', name: 'img' } } }, status: { phase: 'CloneInProgress' } };
    const done = { metadata: { namespace: 'p', name: 'b' }, spec: { source: { pvc: { namespace: 'lib', name: 'img' } } }, status: { phase: 'Succeeded' } };
    expect(clonesInProgress({ namespace: 'lib', name: 'img' }, [copying, done])).toEqual([copying]);
  });
});

describe('data sources', () => {
  it('pairs DataSources with their DataImportCron', () => {
    const rows = sourceRows(
      [
        {
          metadata: { namespace: 'os-images', name: 'fedora', labels: { 'cdi.kubevirt.io/dataImportCron': 'fedora-cron' } },
          spec: { source: { pvc: { namespace: 'os-images', name: 'fedora-abc' } } },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
      [
        {
          metadata: { namespace: 'os-images', name: 'fedora-cron' },
          spec: { schedule: '0 */12 * * *', managedDataSource: 'fedora', template: { spec: { source: { registry: { url: 'docker://quay.io/containerdisks/fedora:latest' } } } } },
          status: { lastImportTimestamp: '2026-11-21T00:00:00Z', conditions: [{ type: 'UpToDate', status: 'True' }] },
        },
      ]
    );
    expect(rows[0]).toMatchObject({ ready: true, target: 'os-images/fedora-abc', cron: { schedule: '0 */12 * * *', upToDate: true } });
  });
});

describe('file sniffing', () => {
  const bytes = (n: number, put: (b: Uint8Array) => void) => {
    const b = new Uint8Array(n);
    put(b);
    return b;
  };
  it('reads the virtual size of a qcow2', () => {
    const head = bytes(64, b => {
      b.set([0x51, 0x46, 0x49, 0xfb, 0, 0, 0, 3], 0);
      // 5 GiB at offset 24, big endian.
      b.set([0, 0, 0, 1, 0x40, 0, 0, 0], 24);
    });
    expect(sniffImage(head, 600 * 2 ** 20)).toEqual({ format: 'qcow2', virtualSize: 5 * GiB });
  });
  it('recognises ISO, compressed and raw files', () => {
    const iso = bytes(34 * 1024, b => b.set([0x43, 0x44, 0x30, 0x30, 0x31], 32769));
    expect(sniffImage(iso, 1234).format).toBe('iso');
    expect(sniffImage(bytes(16, b => b.set([0x1f, 0x8b])), 10).format).toBe('gzip');
    expect(sniffImage(bytes(16, b => b.set([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])), 10).format).toBe('xz');
    expect(sniffImage(bytes(16, () => undefined), 10)).toEqual({ format: 'raw', virtualSize: 10 });
  });
  it('suggests a disk size that fits the image', () => {
    expect(suggestedSize({ format: 'qcow2', virtualSize: 5 * GiB }, 600 * 2 ** 20)).toBe(5 * GiB);
    expect(suggestedSize({ format: 'iso', virtualSize: 60 * 2 ** 20 }, 60 * 2 ** 20)).toBe(GiB);
    expect(suggestedSize({ format: 'xz' }, 2 * GiB)).toBe(6 * GiB);
  });
});
