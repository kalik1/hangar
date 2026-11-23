/*
 * The pure part of browser uploads to CDI (see src/api/upload.ts): where the
 * upload proxy is, the token request, what a failed upload means.
 */

import { Obj } from './types';

export interface ProxyTarget {
  /** e.g. https://cdi-uploadproxy.example.com */
  base?: string;
  problem?: string;
}

/** The upload proxy's base URL, from the CDIConfig status. */
export function proxyTarget(cdiConfig: Obj | null | undefined, pageProtocol: string): ProxyTarget {
  const raw: string | undefined = cdiConfig?.spec?.uploadProxyURLOverride || cdiConfig?.status?.uploadProxyURL;
  if (!raw) {
    return {
      problem:
        'CDI does not say where its upload proxy is: expose the cdi-uploadproxy service (Ingress or Route) and set uploadProxyURLOverride in the CDIConfig.',
    };
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const base = withScheme.replace(/\/+$/, '');
  if (pageProtocol === 'https:' && base.startsWith('http:')) {
    return {
      base,
      problem: `The upload proxy is plain HTTP (${base}) and this page is HTTPS: the browser blocks it. Expose the proxy over HTTPS.`,
    };
  }
  return { base };
}

export const UPLOAD_PATH = '/v1beta1/upload-async';

export function uploadTokenRequest(namespace: string, name: string): Obj {
  return {
    apiVersion: 'upload.cdi.kubevirt.io/v1beta1',
    kind: 'UploadTokenRequest',
    metadata: { name, namespace },
    spec: { pvcName: name },
  };
}

/** What a failed upload means, and what to do. */
export function uploadError(status: number, body: string, base: string): string {
  const text = (body || '').trim().slice(0, 300);
  if (status === 0)
    return `The browser could not reach the upload proxy at ${base}. If it uses a certificate this browser does not trust, open ${base}/healthz in a new tab, accept the certificate, then upload again.`;
  if (status === 401 || status === 403) return `The upload proxy refused the upload token (HTTP ${status}). Upload again; if it keeps failing, check the CDI upload proxy's logs.`;
  if (status === 413)
    return 'The upload proxy, or an ingress in front of it, refused a file this large: raise its body size limit (nginx: proxy-body-size "0").';
  if (status === 502 || status === 503 || status === 504)
    return `The upload proxy could not pass the file to the disk's upload server (HTTP ${status})${text ? `: ${text}` : ''}. Upload again in a minute.`;
  return `The upload failed (HTTP ${status})${text ? `: ${text}` : ''}.`;
}
