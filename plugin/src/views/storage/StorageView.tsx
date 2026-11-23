/*
 * Storage: four sections under one tab, each deep-linkable
 * (/hangar/storage/<section>[/<folder>]):
 *   Datastores — the StorageClasses, with honest capacity and what they can do;
 *   Disks      — every VM disk with its VM, size, datastore, host, snapshots;
 *   Images     — the image library (disk images and ISOs);
 *   Templates  — VMs kept as templates, to make new VMs from.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { useHangar } from '../../api/data';
import { libraryItems } from '../../model/library';
import { diskInventory } from '../../model/storage';
import { formatBytes } from '../../model/units';
import { isTemplate } from '../../model/vm';
import { hrefFor } from '../../shell/nav';
import { useSettings } from '../../shell/settings';
import { tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { ImagesTab } from '../library/LibraryView';
import { DatastoresTab } from './DatastoresTab';
import { DisksTab } from './DisksTab';
import { TemplatesTab } from './TemplatesTab';

export const STORAGE_SECTIONS = ['datastores', 'disks', 'images', 'templates'] as const;
export type StorageSection = (typeof STORAGE_SECTIONS)[number];

export function storageSection(a: string | undefined): StorageSection {
  return (STORAGE_SECTIONS as readonly string[]).includes(a ?? '') ? (a as StorageSection) : 'datastores';
}

const LABELS: Record<StorageSection, { label: string; icon: string }> = {
  datastores: { label: 'Datastores', icon: 'mdi:database-outline' },
  disks: { label: 'Disks', icon: 'mdi:harddisk' },
  images: { label: 'Images', icon: 'mdi:disc' },
  templates: { label: 'Templates', icon: 'mdi:file-document-outline' },
};

export function StorageView({ section: raw, folder }: { section?: string; folder?: string }) {
  const d = useHangar();
  const t = useTokens();
  const history = useHistory();
  const [settings] = useSettings();
  const libNs = settings.libraryNamespace;
  const section = storageSection(raw);
  const inv = React.useMemo(() => diskInventory(d.pvcs, d.dvs, d.vms, d.idx.vmi, libNs), [d.pvcs, d.dvs, d.vms, d.idx.vmi, libNs]);
  const images = React.useMemo(() => libraryItems(d.dvs, d.pvcs, libNs), [d.dvs, d.pvcs, libNs]);
  const templates = d.vms.filter(isTemplate).length;
  const vmDisks = inv.rows.filter(r => r.kind === 'vm' || r.kind === 'unattached').length;
  const provisioned = inv.rows.filter(r => r.kind !== 'container').reduce((s, r) => s + r.sizeBytes, 0);
  // StorageClasses, plus classes disks name that do not exist (shown as cards too).
  const datastoreCount = new Set([...d.storageClasses.map(s => s.metadata.name), ...inv.rows.map(r => r.datastore).filter(Boolean)]).size;
  const counts: Record<StorageSection, number> = { datastores: datastoreCount, disks: vmDisks, images: images.length, templates };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600 }}>
          <Icon icon="mdi:database-outline" width={22} style={{ verticalAlign: -3, marginRight: 8, color: t.muted }} />
          Storage
        </Typography>
        <Typography sx={{ color: t.muted, fontSize: 14, ...tabular }}>
          {counts.datastores} datastore{counts.datastores === 1 ? '' : 's'}, {vmDisks} VM disk{vmDisks === 1 ? '' : 's'}, {images.length} image
          {images.length === 1 ? '' : 's'}, {templates} template{templates === 1 ? '' : 's'}; {formatBytes(provisioned)} provisioned
        </Typography>
      </Box>
      <Box sx={{ borderBottom: `1px solid ${t.rule}`, px: 1 }}>
        <Tabs
          value={section}
          onChange={(_, v: StorageSection) => history.push(hrefFor('storage', v))}
          aria-label="Storage sections"
          variant="scrollable"
          scrollButtons={false}
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, textTransform: 'none', fontSize: 14, minWidth: 0, px: 2 } }}
        >
          {STORAGE_SECTIONS.map(s => (
            <Tab
              key={s}
              value={s}
              id={`hangar-storage-tab-${s}`}
              aria-controls={`hangar-storage-panel-${s}`}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <Icon icon={LABELS[s].icon} width={17} />
                  {LABELS[s].label}
                  <Box component="span" sx={{ color: t.muted, fontSize: 12.5, ...tabular }}>
                    {counts[s]}
                  </Box>
                </Box>
              }
            />
          ))}
        </Tabs>
      </Box>
      <Box role="tabpanel" id={`hangar-storage-panel-${section}`} aria-labelledby={`hangar-storage-tab-${section}`} sx={{ p: 2, flex: 1 }}>
        {section === 'datastores' && <DatastoresTab d={d} inv={inv} />}
        {section === 'disks' && <DisksTab d={d} inv={inv} />}
        {section === 'images' && <ImagesTab />}
        {section === 'templates' && <TemplatesTab d={d} folder={folder} />}
      </Box>
    </Box>
  );
}
