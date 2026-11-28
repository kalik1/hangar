/*
 * A VM's video card as KubeVirt gives it, and whether the guest's desktop
 * can follow the size of the console window with it (hangar#4).
 *
 * The console asks for a size over VNC (ExtendedDesktopSize); QEMU passes
 * the request to the display device, and only virtio-gpu takes it. VGA,
 * Bochs, Cirrus and ramfb keep the mode the guest sets.
 */

import { Obj } from './types';

export type VideoCard = 'virtio' | 'vga' | 'bochs' | 'cirrus' | 'ramfb';

export const VIDEO_LABEL: Record<string, string> = {
  virtio: 'VirtIO',
  vga: 'VGA',
  bochs: 'Bochs',
  cirrus: 'Cirrus',
  ramfb: 'ramfb',
};

export interface VideoFacts {
  /** The card's type, lower case. */
  type: string;
  label: string;
  /** The spec names it; false: KubeVirt's default for the architecture and firmware. */
  chosen: boolean;
}

/** The domain spec of a VMI (`spec`) or of a VM (`spec.template.spec`). */
type DomainSpec = { architecture?: string; domain?: any } | undefined;

/**
 * KubeVirt's card when the spec names none: VGA on amd64 with BIOS, Bochs
 * with UEFI; VirtIO on arm64 and s390x, where QEMU offers nothing else.
 */
export function defaultVideo(spec: DomainSpec): VideoCard {
  const arch = spec?.architecture || 'amd64';
  if (arch === 'arm64' || arch === 's390x') return 'virtio';
  return spec?.domain?.firmware?.bootloader?.efi ? 'bochs' : 'vga';
}

export function videoOf(spec: DomainSpec): VideoFacts {
  const named = String(spec?.domain?.devices?.video?.type ?? '').toLowerCase();
  const type = named || defaultVideo(spec);
  return { type, label: VIDEO_LABEL[type] ?? type, chosen: !!named };
}

/** Only virtio-gpu takes a size from the console. */
export const followsWindow = (type: string) => type === 'virtio';

export interface VideoCards {
  /** The card the guest has: the running instance's, else what the VM asks for. */
  now: VideoFacts;
  /** The card the next power-on gives (a change waits for a restart). */
  next: VideoFacts;
}

/** null until the VM or its instance is known. */
export function videoCards(vm: Obj | null | undefined, vmi: Obj | null | undefined): VideoCards | null {
  if (!vm && !vmi) return null;
  const tpl = vm?.spec?.template?.spec;
  // The template seldom names the architecture: the instance has the cluster's.
  const next = videoOf(tpl && { ...tpl, architecture: tpl.architecture ?? vmi?.spec?.architecture });
  return { now: vmi ? videoOf(vmi.spec) : next, next };
}
