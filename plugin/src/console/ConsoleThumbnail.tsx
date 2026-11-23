/*
 * A live miniature of a VM's screen, from KubeVirt's vnc/screenshot
 * (a PNG from QEMU, no VNC session: it never disturbs an open console).
 * Fetched with Headlamp's own request function, so it carries the same
 * auth as every Headlamp request (backend kubeconfig, kubeconfig header
 * for browser-stored clusters, or the login cookie). It refreshes only
 * while it is on screen and the tab is visible.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import React from 'react';
import { useTokens } from '../ui/useTokens';
import { screenshotPath } from './paths';
import { resolveCluster } from './useConsoleSession';

export interface ConsoleThumbnailProps {
  namespace: string;
  name: string;
  /** Defaults to the cluster of the current route. */
  cluster?: string;
  /** The VM runs: fetch its screen. Otherwise show a dark screen and `label`. */
  running: boolean;
  /** Width in px; the screen is 4:3. Default 240. */
  width?: number;
  /** Refresh period in ms. Default 5000. */
  refreshMs?: number;
  /** Makes the thumbnail a button (e.g. to open the console). */
  onClick?: () => void;
  /** Text on the dark screen when not running. Default "Powered off". */
  label?: string;
}

/** The screen as a PNG blob. */
export async function fetchScreenshot(
  namespace: string,
  name: string,
  cluster: string
): Promise<Blob> {
  const res: Response = await ApiProxy.clusterRequest(screenshotPath(namespace, name), {
    cluster,
    isJSON: false,
    autoLogoutOnAuthError: false,
    timeout: 15000,
    cache: 'no-store',
    // No Accept header: KubeVirt answers 406 to "image/png" (it only lists */*).
  } as any);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') && blob.type !== '')
    throw new Error(`not an image: ${blob.type}`);
  return blob;
}

/** Element on screen (IntersectionObserver) and tab visible. */
function useShown(ref: React.RefObject<HTMLElement>): boolean {
  const [inView, setInView] = React.useState(typeof IntersectionObserver === 'undefined');
  const [pageVisible, setPageVisible] = React.useState(() => document.visibilityState !== 'hidden');
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => setInView(entries.some(e => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  React.useEffect(() => {
    const on = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return inView && pageVisible;
}

export function ConsoleThumbnail({
  namespace,
  name,
  cluster: clusterProp,
  running,
  width = 240,
  refreshMs = 5000,
  onClick,
  label = 'Powered off',
}: ConsoleThumbnailProps) {
  const t = useTokens();
  const cluster = resolveCluster(clusterProp);
  const rootRef = React.useRef<HTMLElement>(null);
  const shown = useShown(rootRef);
  const [src, setSrc] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const urlRef = React.useRef<string | null>(null);
  const lastFetch = React.useRef(0);

  const show = React.useCallback((url: string | null) => {
    const old = urlRef.current;
    urlRef.current = url;
    setSrc(url);
    if (old && old !== url) URL.revokeObjectURL(old);
  }, []);

  // Not running: drop the picture, a fresh one comes when it runs again.
  React.useEffect(() => {
    if (!running) {
      show(null);
      setFailed(false);
      lastFetch.current = 0;
    }
  }, [running, show]);

  React.useEffect(() => () => show(null), [show]);

  React.useEffect(() => {
    if (!running || !shown) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      lastFetch.current = Date.now();
      try {
        const blob = await fetchScreenshot(namespace, name, cluster);
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        // Swap only once decoded: the old picture stays until then.
        const img = new Image();
        img.src = url;
        await img.decode().catch(() => undefined);
        if (stopped) {
          URL.revokeObjectURL(url);
          return;
        }
        show(url);
        setFailed(false);
      } catch {
        if (!stopped) setFailed(true);
      }
      if (!stopped) timer = setTimeout(tick, refreshMs);
    };
    const due = Math.max(0, lastFetch.current + refreshMs - Date.now());
    timer = setTimeout(tick, due);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, shown, namespace, name, cluster, refreshMs, show]);

  const height = Math.round((width * 3) / 4);
  const text = !running ? label : !src && failed ? 'No picture' : null;
  const interactive = !!onClick;

  const screen = (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: t.screen,
        borderRadius: '2px',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {running && src && (
        <Box
          component="img"
          src={src}
          alt={interactive ? '' : `Screen of ${name}`}
          draggable={false}
          sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      )}
      {text && (
        <Box
          component="span"
          sx={{ color: t.chassisMuted, fontSize: Math.max(11, Math.round(width / 20)), px: 1 }}
        >
          {text}
        </Box>
      )}
    </Box>
  );

  const frame = {
    display: 'block',
    flex: 'none',
    width,
    height,
    p: '3px',
    boxSizing: 'border-box' as const,
    background: t.bezel,
    border: 'none',
    borderRadius: `${t.radius.small}px`,
  };

  if (interactive) {
    return (
      <Box
        ref={rootRef as React.RefObject<HTMLButtonElement>}
        component="button"
        type="button"
        onClick={onClick}
        aria-label={`Open the console of ${name}`}
        title={`Open the console of ${name}`}
        sx={{
          ...frame,
          cursor: 'pointer',
          font: 'inherit',
          '&:hover': { background: t.chassisMuted },
          '&:focus-visible': { outline: `2px solid ${t.accent}`, outlineOffset: '2px' },
        }}
      >
        {screen}
      </Box>
    );
  }
  return (
    <Box
      ref={rootRef as React.RefObject<HTMLDivElement>}
      role={running && src ? undefined : 'img'}
      aria-label={running && src ? undefined : `Screen of ${name}: ${text ?? 'loading'}`}
      sx={frame}
    >
      {screen}
    </Box>
  );
}
