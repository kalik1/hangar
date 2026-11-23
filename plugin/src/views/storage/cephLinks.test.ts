import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ Router: { createRouteURL: () => '' } }));
vi.mock('react-redux', () => ({ useSelector: () => undefined }));
vi.mock('../../api/client', () => ({ currentCluster: () => 'main' }));

import { cephUrl, fillPath, findCephRoutes } from './cephLinks';

describe('findCephRoutes', () => {
  it('finds the Ceph plugin routes by path', () => {
    const r = findCephRoutes({
      '/ceph': { path: '/ceph', name: 'ceph-overview' },
      '/ceph/pools/:pool': { path: '/ceph/pools/:pool', name: 'ceph-pool' },
      '/ceph/osds': { path: '/ceph/osds', name: 'ceph-osds' },
      '/ceph/rbd/:pool/:image': { path: '/ceph/rbd/:pool/:image', name: 'ceph-rbd' },
      '/hangar/:view?': { path: '/hangar/:view?', name: 'hangar' },
    });
    expect(r.overview?.name).toBe('ceph-overview');
    expect(r.pool?.params).toEqual(['pool']);
    expect(r.osds?.name).toBe('ceph-osds');
    expect(r.rbd?.params).toEqual(['pool', 'image']);
  });
  it('accepts an overview with optional parameters and array paths', () => {
    const r = findCephRoutes({ x: { path: ['/ceph/:tab?'], name: 'ceph' } });
    expect(r.overview?.params).toEqual([]);
  });
  it('finds nothing without the plugin', () => {
    expect(findCephRoutes({ '/hangar': { path: '/hangar' } })).toEqual({});
    expect(findCephRoutes(undefined)).toEqual({});
  });
});

describe('URLs', () => {
  it('fills parameters in order and drops optional ones', () => {
    expect(fillPath({ path: '/ceph/rbd/:pool/:image', params: ['pool', 'image'], useClusterURL: true }, ['vm-pool', 'csi vol'])).toBe('/ceph/rbd/vm-pool/csi%20vol');
    expect(fillPath({ path: '/ceph/:tab?', params: [], useClusterURL: true }, [])).toBe('/ceph');
  });
  it('falls back to the cluster path, and never links with a missing value', () => {
    const ref = { name: 'ceph-pool', path: '/ceph/pools/:pool', params: ['pool'], useClusterURL: true };
    expect(cephUrl(ref, ['vm-pool'], 'main')).toBe('/c/main/ceph/pools/vm-pool');
    expect(cephUrl(ref, [''], 'main')).toBeNull();
    expect(cephUrl(undefined, ['x'], 'main')).toBeNull();
  });
});

describe('a catch-all Ceph route', () => {
  const r = findCephRoutes({ '/ceph/:view?/:a?/:b?/:c?': { path: '/ceph/:view?/:a?/:b?/:c?', name: 'cairn' } });
  it('serves the pool, OSD and RBD pages', () => {
    expect(r.overview?.name).toBe('cairn');
    expect(r.pool?.via).toEqual({ params: ['view', 'a', 'b', 'c'], fixed: ['pools'] });
    expect(r.rbd?.path).toBe('/ceph/rbd/:pool/:image');
    expect(r.osds?.params).toEqual([]);
  });
  it('builds their URLs', () => {
    expect(cephUrl(r.pool, ['vm-pool'], 'main')).toBe('/c/main/ceph/pools/vm-pool');
    expect(cephUrl(r.rbd, ['vm-pool', 'csi-vol-1'], 'main')).toBe('/c/main/ceph/rbd/vm-pool/csi-vol-1');
    expect(cephUrl(r.osds, [], 'main')).toBe('/c/main/ceph/osds');
  });
  it('does not stretch a catch-all with too few parameters', () => {
    const short = findCephRoutes({ x: { path: '/ceph/:view?/:a?', name: 'c' } });
    expect(short.pool).toBeDefined();
    expect(short.rbd).toBeUndefined();
  });
});
