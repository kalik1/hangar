/*
 * What the guest agent reports (like VM tools): OS, users logged in,
 * filesystems with their usage. Asked every 30 s while a page shows it.
 */

import React from 'react';
import { kreq } from './client';
import { PATHS } from './resources';

export interface GuestInfo {
  os?: any;
  users: { userName: string; domain?: string; loginTime?: number }[];
  filesystems: { diskName: string; mountPoint: string; fileSystemType: string; usedBytes: number; totalBytes: number }[];
  error?: string;
}

export function useGuestInfo(namespace: string, name: string, agentConnected: boolean): GuestInfo | null {
  const [info, setInfo] = React.useState<GuestInfo | null>(null);
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
      setInfo({
        os: os?.__error ? undefined : os,
        users: users?.items ?? [],
        filesystems: (fs?.items ?? []).filter((f: any) => f.totalBytes > 0),
        error: os?.__error ? String(os.__error.message ?? os.__error) : undefined,
      });
    };
    load();
    const id = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [namespace, name, agentConnected]);
  return info;
}
