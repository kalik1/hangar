/*
 * What the wizard offers: guest OS families (with the KubeVirt preference
 * that tunes devices for them), size profile series, defaults.
 */

import { Obj } from '../model/types';
import { parseQuantity } from '../model/units';

export interface OsChoice {
  id: string;
  label: string;
  icon: string;
  /** Cluster preferences to try, first that exists wins. */
  preferences: string[];
  firmware: 'bios' | 'uefi' | 'uefi-secure';
  tpm?: boolean;
  /** Smallest sensible memory. */
  minMemGiB: number;
  cloudInit: boolean;
}

export const OS_CHOICES: OsChoice[] = [
  { id: 'fedora', label: 'Fedora', icon: 'mdi:fedora', preferences: ['fedora'], firmware: 'bios', minMemGiB: 2, cloudInit: true },
  { id: 'ubuntu', label: 'Ubuntu', icon: 'mdi:ubuntu', preferences: ['ubuntu'], firmware: 'bios', minMemGiB: 2, cloudInit: true },
  { id: 'debian', label: 'Debian', icon: 'mdi:debian', preferences: ['debian'], firmware: 'bios', minMemGiB: 1, cloudInit: true },
  {
    id: 'centos',
    label: 'CentOS Stream',
    icon: 'mdi:centos',
    preferences: ['centos.stream10', 'centos.stream9'],
    firmware: 'bios',
    minMemGiB: 2,
    cloudInit: true,
  },
  {
    id: 'rhel',
    label: 'Red Hat Enterprise Linux',
    icon: 'mdi:redhat',
    preferences: ['rhel.10', 'rhel.9'],
    firmware: 'bios',
    minMemGiB: 2,
    cloudInit: true,
  },
  { id: 'alpine', label: 'Alpine Linux', icon: 'mdi:linux', preferences: ['alpine'], firmware: 'bios', minMemGiB: 1, cloudInit: true },
  {
    id: 'windows',
    label: 'Windows',
    icon: 'mdi:microsoft-windows',
    preferences: ['windows.11', 'windows.2k25', 'windows.2k22', 'windows.10'],
    firmware: 'uefi-secure',
    tpm: true,
    minMemGiB: 4,
    cloudInit: false,
  },
  { id: 'cirros', label: 'CirrOS (test)', icon: 'mdi:linux', preferences: ['cirros'], firmware: 'bios', minMemGiB: 0.25, cloudInit: true },
  { id: 'linux', label: 'Other Linux', icon: 'mdi:linux', preferences: ['linux'], firmware: 'bios', minMemGiB: 1, cloudInit: true },
  { id: 'other', label: 'Other', icon: 'mdi:help-circle-outline', preferences: [], firmware: 'bios', minMemGiB: 1, cloudInit: false },
];

export function osChoice(id?: string): OsChoice {
  return OS_CHOICES.find(o => o.id === id) ?? OS_CHOICES[OS_CHOICES.length - 1];
}

/** The first preference of the OS that the cluster has. */
export function preferenceFor(os: OsChoice, preferences: Obj[]): string | undefined {
  const names = new Set(preferences.map(p => p.metadata.name));
  return os.preferences.find(p => names.has(p));
}

export const SERIES: Record<string, { label: string; help: string }> = {
  u1: { label: 'General purpose', help: 'Balanced, for most workloads.' },
  o1: { label: 'Overcommitted', help: 'Memory overcommitted, for many light VMs.' },
  cx1: { label: 'Compute', help: 'Dedicated CPUs, for CPU-heavy work.' },
  m1: { label: 'Memory', help: 'More memory per CPU, huge pages.' },
  n1: { label: 'Network', help: 'For DPDK network functions.' },
  rt1: { label: 'Real time', help: 'For real-time workloads.' },
};

export interface SizeProfile {
  name: string;
  series: string;
  vcpus: number;
  memBytes: number;
}

export function sizeProfiles(instancetypes: Obj[]): SizeProfile[] {
  return instancetypes
    .map(it => ({
      name: it.metadata.name,
      series: it.metadata.name.split('.')[0],
      vcpus: Number(it.spec?.cpu?.guest ?? 0),
      memBytes: parseQuantity(it.spec?.memory?.guest),
    }))
    .filter(p => p.vcpus > 0 && isFinite(p.memBytes))
    .sort((a, b) => a.series.localeCompare(b.series) || a.vcpus - b.vcpus || a.memBytes - b.memBytes);
}

/** A library image as the wizard lists it. */
export interface LibraryImage {
  namespace: string;
  name: string;
  displayName: string;
  os?: string;
  media: 'disk' | 'iso';
  sizeBytes: number;
  ready: boolean;
  progress?: string;
}

export function libraryImages(dvs: Obj[], pvcs: Obj[], libraryNs: string): LibraryImage[] {
  const out: LibraryImage[] = [];
  const seen = new Set<string>();
  const add = (o: Obj, ready: boolean, progress?: string) => {
    const k = `${o.metadata.namespace}/${o.metadata.name}`;
    if (seen.has(k)) return;
    seen.add(k);
    const pvc = pvcs.find(p => p.metadata.namespace === o.metadata.namespace && p.metadata.name === o.metadata.name);
    const a = o.metadata.annotations ?? {};
    out.push({
      namespace: o.metadata.namespace as string,
      name: o.metadata.name,
      displayName: a['hangar.magesgate.com/display-name'] || o.metadata.name,
      os: a['hangar.magesgate.com/os'],
      media: a['hangar.magesgate.com/media'] === 'iso' || /iso/i.test(o.metadata.name) ? 'iso' : 'disk',
      sizeBytes: parseQuantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage ?? o.spec?.storage?.resources?.requests?.storage),
      ready,
      progress,
    });
  };
  for (const dv of dvs) {
    const isImage = dv.metadata.labels?.['hangar.magesgate.com/image'] === 'true';
    if (!isImage && dv.metadata.namespace !== libraryNs) continue;
    if (!isImage) continue;
    add(dv, dv.status?.phase === 'Succeeded', dv.status?.progress);
  }
  for (const pvc of pvcs) {
    if (pvc.metadata.labels?.['hangar.magesgate.com/image'] !== 'true') continue;
    add(pvc, pvc.status?.phase === 'Bound');
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
