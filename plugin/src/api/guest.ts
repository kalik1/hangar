/*
 * What the guest agent reports (like VM tools), asked every 30 s while a
 * page shows it, from two sources (model/guestinfo.ts):
 * - KubeVirt's subresources guestosinfo, userlist and filesystemlist;
 * - Hangar's guest bridge, the subresource guestinfo, when the cluster has
 *   it and the user's role allows it on this VM.
 */

import React from 'react';
import {
  BRIDGE_GROUP,
  BRIDGE_VERSION,
  bridgeErrorState,
  BridgeState,
  Discovery,
  GUESTINFO,
  GuestInfo,
  GUESTINFO_ROLE,
  GuestSection,
  KubevirtGuest,
  RETRY_AFTER_503_MS,
} from '../model/guestinfo';
import { currentCluster, kreq } from './client';
import { can } from './permissions';
import { PATHS } from './resources';

export const POLL_MS = 30000;

/** An API error's message without Headlamp's status text ("Service Unavailable - …"). */
const detail = (e: any) => {
  const m = String(e?.message ?? e);
  return m.includes(' - ') ? m.split(' - ').slice(1).join(' - ') : m;
};

/** KubeVirt's three subresources, while the AgentConnected condition is True. */
export function useKubevirtGuest(namespace: string, name: string, agentConnected: boolean): KubevirtGuest | null {
  const [info, setInfo] = React.useState<KubevirtGuest | null>(null);
  React.useEffect(() => {
    if (!agentConnected) {
      setInfo(null);
      return;
    }
    let alive = true;
    const load = async () => {
      const get = (sub: string) => kreq(PATHS.vmiSub(namespace, name, sub)).catch(e => ({ __error: e }));
      const [os, users, fs] = await Promise.all([get('guestosinfo'), get('userlist'), get('filesystemlist')]);
      if (!alive) return;
      const failed = [os, users, fs].find(x => x?.__error);
      setInfo({
        info: os?.__error ? undefined : os,
        users: users?.__error ? undefined : users?.items ?? [],
        filesystems: fs?.__error ? undefined : fs?.items ?? [],
        error: failed ? detail(failed.__error) : undefined,
        readAt: Date.now(),
      });
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [namespace, name, agentConnected]);
  return info;
}

/* ------------------------------------------------------- the guest bridge */

const GROUP_PATH = `/apis/${BRIDGE_GROUP}/${BRIDGE_VERSION}`;

export const guestInfoPath = (namespace: string, name: string) =>
  `${GROUP_PATH}/namespaces/${encodeURIComponent(namespace)}/virtualmachineinstances/${encodeURIComponent(name)}/${GUESTINFO}`;

const discoveries = new Map<string, { at: number; p: Promise<Discovery>; v?: Discovery }>();
/** A cluster without the bridge is asked again after 5 minutes; one with it, after a minute. */
const DISCOVERY_TTL = { absent: 5 * 60 * 1000, other: 60 * 1000 };

/**
 * Whether the cluster serves the bridge's group: 404 is no APIService, 503
 * an APIService whose pods do not answer. Cached per cluster; `fresh` asks
 * again (after a call failed).
 */
export function bridgeDiscovery(fresh = false): Promise<Discovery> {
  const k = currentCluster();
  const hit = discoveries.get(k);
  const ttl = hit?.v === 'absent' ? DISCOVERY_TTL.absent : DISCOVERY_TTL.other;
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.p;
  const entry: { at: number; p: Promise<Discovery>; v?: Discovery } = { at: Date.now(), p: Promise.resolve('unknown' as Discovery) };
  entry.p = kreq(GROUP_PATH)
    .then(r => ((r?.resources ?? []).some((x: any) => x?.name === `virtualmachineinstances/${GUESTINFO}`) ? 'present' : 'absent') as Discovery)
    .catch((e): Discovery => (e?.status === 404 ? 'absent' : e?.status === 503 ? 'unavailable' : 'unknown'))
    .then(v => (entry.v = v));
  discoveries.set(k, entry);
  return entry.p;
}

export interface BridgeOptions {
  namespace: string;
  name: string;
  /** The VMI runs on a node: there is an agent to ask. */
  running: boolean;
  /** The sections to read; all when left out. */
  sections?: GuestSection[];
  /** Users whose SSH keys to read too (the VM's cloud-init users). */
  sshUsers?: string[];
}

export interface BridgeResult {
  state: BridgeState;
  /** Asks now, without waiting for the next poll. */
  refresh: () => void;
}

/** One guestinfo call, gated: the group's discovery, then the user's role on this VM (SelfSubjectAccessReview). */
export async function readGuestInfo(o: BridgeOptions): Promise<BridgeState> {
  const discovery = await bridgeDiscovery();
  if (discovery === 'absent') return { kind: 'absent' };
  if (discovery === 'unavailable') return bridgeErrorState(503, 'The guest bridge’s API is installed, but its pods do not answer.', discovery);
  const allowed = await can({ verb: 'get', group: BRIDGE_GROUP, resource: 'virtualmachineinstances', subresource: GUESTINFO, namespace: o.namespace, name: o.name });
  if (!allowed) return { kind: 'forbidden', role: GUESTINFO_ROLE };
  const query: Record<string, string> = {};
  if (o.sections?.length) query.sections = o.sections.join(',');
  if (o.sshUsers?.length) query.sshUsers = o.sshUsers.join(',');
  try {
    const info = await kreq<GuestInfo>(guestInfoPath(o.namespace, o.name), { query });
    return { kind: 'ok', info };
  } catch (e: any) {
    const status: number | undefined = e?.status;
    const again = status === 404 || status === 503 ? await bridgeDiscovery(true) : discovery;
    return bridgeErrorState(status, detail(e), again);
  }
}

/**
 * The bridge's report on a VM, asked at once, then every 30 s. A 503 (the
 * bridge cannot reach the VM's libvirt yet, or the VMI just moved) is
 * asked again after RETRY_AFTER_503_MS, twice at most, before the next
 * poll; the last good answer stays shown meanwhile.
 */
export function useGuestBridge(o: BridgeOptions): BridgeResult {
  const [state, setState] = React.useState<BridgeState>({ kind: 'loading' });
  const [tick, setTick] = React.useState(0);
  const sig = JSON.stringify([o.namespace, o.name, o.running, o.sections ?? [], o.sshUsers ?? []]);
  const lastSig = React.useRef(sig);
  React.useEffect(() => {
    if (!o.running) {
      setState({ kind: 'not-running' });
      return;
    }
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      setState({ kind: 'loading' });
    }
    let alive = true;
    let retry: number | undefined;
    let retries = 0;
    const load = async () => {
      const next = await readGuestInfo(o);
      if (!alive) return;
      if (next.kind === 'unavailable' && !next.apiService && retries < 2) {
        retries++;
        retry = window.setTimeout(load, RETRY_AFTER_503_MS);
        setState(cur => (cur.kind === 'ok' ? cur : next));
        return;
      }
      retries = 0;
      setState(next);
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
      if (retry) window.clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, tick]);
  const refresh = React.useCallback(() => setTick(t => t + 1), []);
  return { state, refresh };
}
