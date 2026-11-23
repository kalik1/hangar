import { describe, expect, it } from 'vitest';
import {
  consoleWindowId,
  screenshotFileName,
  screenshotPath,
  serialPath,
  vmiPath,
  vmiSubresourcePath,
  vncPath,
} from './paths';

describe('subresource paths', () => {
  it('builds the VMI path', () => {
    expect(vmiPath('demo', 'cirros-test')).toBe(
      '/apis/kubevirt.io/v1/namespaces/demo/virtualmachineinstances/cirros-test'
    );
  });

  it('builds the console subresources', () => {
    const base = '/apis/subresources.kubevirt.io/v1/namespaces/demo/virtualmachineinstances/vm1';
    expect(vncPath('demo', 'vm1')).toBe(`${base}/vnc`);
    expect(vncPath('demo', 'vm1', true)).toBe(`${base}/vnc?preserveSession=true`);
    expect(serialPath('demo', 'vm1')).toBe(`${base}/console`);
    expect(screenshotPath('demo', 'vm1')).toBe(`${base}/vnc/screenshot`);
  });

  it('adds only the query parameters that are set', () => {
    expect(
      vmiSubresourcePath('a', 'b', 'vnc/screenshot', { moveCursor: false, x: undefined })
    ).toBe(
      '/apis/subresources.kubevirt.io/v1/namespaces/a/virtualmachineinstances/b/vnc/screenshot?moveCursor=false'
    );
  });

  it('encodes path segments', () => {
    expect(vmiPath('a b', 'c/d')).toBe(
      '/apis/kubevirt.io/v1/namespaces/a%20b/virtualmachineinstances/c%2Fd'
    );
  });
});

describe('names', () => {
  it('keys console windows by cluster, VM and kind', () => {
    expect(consoleWindowId('demo', 'ns', 'vm', 'vnc')).toBe('hangar-console/demo/ns/vm/vnc');
    expect(consoleWindowId('demo', 'ns', 'vm', 'serial')).not.toBe(
      consoleWindowId('demo', 'ns', 'vm', 'vnc')
    );
  });

  it('names screenshots after the VM and the local time', () => {
    const at = new Date(2026, 10, 2, 9, 5, 7);
    expect(screenshotFileName('web-01', at)).toBe('web-01-20261102-090507.png');
  });

  it('keeps screenshot names file-system safe', () => {
    const at = new Date(2026, 0, 1, 0, 0, 0);
    expect(screenshotFileName('a b/c', at)).toBe('a-b-c-20260101-000000.png');
    expect(screenshotFileName('', at)).toBe('console-20260101-000000.png');
  });
});
