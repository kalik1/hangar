import { addCollection } from '@iconify/react';
import { ICONS } from './icons.generated';

/** Registers the mdi icons Hangar uses with Headlamp's Iconify, for offline use. */
export function registerIcons(): void {
  addCollection({ prefix: 'mdi', icons: ICONS });
}
