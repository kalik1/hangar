/*
 * VM summary, on k4all: whether the VM gets k4all's metadata service
 * (169.254.169.254), what it serves the guest, and why not
 * (model/metadata.ts metadataVerdict). Reads k4all's ClusterConfig, the
 * VM's folder (its PodSecurity labels), its ServiceAccounts and the Events
 * k4all writes on the VM.
 */

import Box from '@mui/material/Box';
import React from 'react';
import { kreq } from '../../api/client';
import { useHangar } from '../../api/data';
import { useK4allMetadata, useServiceAccounts } from '../../api/k4all';
import { L_METADATA, L_SERVICE_ACCOUNT, MetadataState, metadataVerdict } from '../../model/metadata';
import { Obj } from '../../model/types';
import { key } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { K8sName, Panel } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { LedTone } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { K4allLink } from '../settings/K4allManaged';

/** The Events of one VM, every 30 s; [] until read or when they cannot be listed. */
function useVmEvents(namespace: string | undefined, name: string, on: boolean): Obj[] {
  const [events, setEvents] = React.useState<Obj[]>([]);
  React.useEffect(() => {
    if (!on || !namespace) return;
    let alive = true;
    const load = () =>
      kreq<{ items?: Obj[] }>(`/api/v1/namespaces/${encodeURIComponent(namespace)}/events`, {
        query: { fieldSelector: `involvedObject.kind=VirtualMachine,involvedObject.name=${name}` },
      }).then(
        r => alive && setEvents(r.items ?? []),
        () => undefined
      );
    load();
    const id = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [namespace, name, on]);
  return events;
}

const TONES: Record<MetadataState, { tone: LedTone; text: string }> = {
  on: { tone: 'on', text: 'Served' },
  off: { tone: 'off', text: 'Off' },
  'not-asked': { tone: 'off', text: 'Not asked for' },
  skipped: { tone: 'standby', text: 'Not served' },
  unknown: { tone: 'off', text: 'Unknown' },
};

export function MetadataPanel({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const k4 = useK4allMetadata();
  const ns = vm.metadata.namespace;
  const events = useVmEvents(ns, vm.metadata.name, k4.on);
  const serviceAccounts = useServiceAccounts(k4.on ? ns : undefined);
  if (!k4.on || k4.metadata === undefined) return null;
  const v = metadataVerdict({ vm, namespace: d.namespaces.find(n => n.metadata.name === ns), service: k4.metadata, events, serviceAccounts, vmi: d.idx.vmi.get(key(vm)) });
  const head = TONES[v.state];
  return (
    <Panel title="Metadata service" icon="mdi:cloud-key-outline">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14, fontWeight: 600 }}>
        <Led tone={head.tone} />
        {head.text}
      </Box>
      <Box sx={{ fontSize: 13.5, color: t.muted, mt: 0.5, lineHeight: 1.5 }}>{v.why}</Box>
      {v.serves.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.25, fontSize: 13.5, lineHeight: 1.6 }}>
          {v.serves.map(x => (
            <li key={x}>{x}</li>
          ))}
        </Box>
      )}
      {v.notes.map(n => (
        <Box key={n} sx={{ fontSize: 12.5, color: '#B7791F', mt: 0.75 }}>
          {n}
        </Box>
      ))}
      <Box sx={{ mt: 1, fontSize: 12.5, color: t.muted, display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
        {k8s && (
          <>
            <K8sName>
              {L_METADATA}: {vm.spec?.template?.metadata?.labels?.[L_METADATA] ?? '(not set)'}
            </K8sName>
            {v.asked && v.serviceAccount !== 'default' && (
              <K8sName>
                {L_SERVICE_ACCOUNT}: {v.serviceAccount}
              </K8sName>
            )}
          </>
        )}
        <K4allLink page="virtualization" anchor="metadata">
          k4all&apos;s metadata settings
        </K4allLink>
      </Box>
    </Panel>
  );
}
