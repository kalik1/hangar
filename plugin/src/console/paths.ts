/*
 * API paths of the KubeVirt console subresources, and small names built
 * from a VM (window ids, screenshot file names).
 */

export type VmiSubresource = 'vnc' | 'console' | 'vnc/screenshot' | 'pause' | 'unpause' | 'reset';

const enc = encodeURIComponent;

/** The VirtualMachineInstance, e.g. /apis/kubevirt.io/v1/namespaces/demo/virtualmachineinstances/vm1. */
export function vmiPath(namespace: string, name: string): string {
  return `/apis/kubevirt.io/v1/namespaces/${enc(namespace)}/virtualmachineinstances/${enc(name)}`;
}

/** A VMI subresource, with an optional query string. */
export function vmiSubresourcePath(
  namespace: string,
  name: string,
  sub: VmiSubresource,
  query?: Record<string, string | boolean | number | undefined>
): string {
  const base = `/apis/subresources.kubevirt.io/v1/namespaces/${enc(
    namespace
  )}/virtualmachineinstances/${enc(name)}/${sub}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * The VNC stream. With `preserveSession` KubeVirt refuses the connection
 * while another client holds the console, instead of disconnecting it.
 */
export function vncPath(namespace: string, name: string, preserveSession = false): string {
  return vmiSubresourcePath(
    namespace,
    name,
    'vnc',
    preserveSession ? { preserveSession: true } : undefined
  );
}

export function serialPath(namespace: string, name: string): string {
  return vmiSubresourcePath(namespace, name, 'console');
}

export function screenshotPath(namespace: string, name: string): string {
  return vmiSubresourcePath(namespace, name, 'vnc/screenshot');
}

export type ConsoleKind = 'vnc' | 'serial';

/** One console window per cluster, VM and kind. */
export function consoleWindowId(
  cluster: string,
  namespace: string,
  name: string,
  kind: ConsoleKind
): string {
  return `hangar-console/${cluster}/${namespace}/${name}/${kind}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "<vm>-<yyyymmdd>-<hhmmss>.png", local time: sorts by time, safe on every file system. */
export function screenshotFileName(vm: string, at: Date): string {
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const safe = vm.replace(/[^A-Za-z0-9._-]+/g, '-') || 'console';
  return `${safe}-${date}-${time}.png`;
}
