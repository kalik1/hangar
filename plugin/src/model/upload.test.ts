import { describe, expect, it } from 'vitest';
import { proxyTarget, uploadError, uploadTokenRequest } from './upload';

describe('proxyTarget', () => {
  const cdi = (url?: string, override?: string) => ({ metadata: { name: 'config' }, spec: override ? { uploadProxyURLOverride: override } : {}, status: url ? { uploadProxyURL: url } : {} });
  it('uses HTTPS for a bare host (the proxy always speaks TLS)', () => {
    expect(proxyTarget(cdi('cdi-uploadproxy.192.0.2.10.nip.io'), 'http:')).toEqual({ base: 'https://cdi-uploadproxy.192.0.2.10.nip.io' });
  });
  it('prefers the override and keeps an explicit scheme', () => {
    expect(proxyTarget(cdi('a.example', 'https://upload.example/'), 'https:')).toEqual({ base: 'https://upload.example' });
  });
  it('flags mixed content', () => {
    const t = proxyTarget(cdi('http://upload.example'), 'https:');
    expect(t.problem).toMatch(/browser blocks it/);
  });
  it('says what to do when CDI has no proxy URL', () => {
    expect(proxyTarget(cdi(), 'https:').problem).toMatch(/uploadProxyURLOverride/);
    expect(proxyTarget(null, 'https:').base).toBeUndefined();
  });
});

describe('upload request and errors', () => {
  it('asks a token for the claim', () => {
    expect(uploadTokenRequest('hangar-library', 'alpine')).toEqual({
      apiVersion: 'upload.cdi.kubevirt.io/v1beta1',
      kind: 'UploadTokenRequest',
      metadata: { name: 'alpine', namespace: 'hangar-library' },
      spec: { pvcName: 'alpine' },
    });
  });
  it('explains failures with the fix', () => {
    expect(uploadError(0, '', 'https://p')).toMatch(/open https:\/\/p\/healthz in a new tab/);
    expect(uploadError(413, '', 'https://p')).toMatch(/proxy-body-size/);
    expect(uploadError(401, '', 'https://p')).toMatch(/refused the upload token/);
    expect(uploadError(500, 'boom', 'https://p')).toBe('The upload failed (HTTP 500): boom.');
  });
});
