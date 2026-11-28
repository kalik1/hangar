/*
 * A web address on the Published ports panel: https://<host>/ with the
 * address the name must point at, the TLS state (from the Ingress and the
 * Certificate, never a Secret), whether the VM is behind it (the ClusterIP
 * Service's EndpointSlices), and the one-time URL test.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { errorText } from '../../api/client';
import { NOT_ALLOWED } from '../../api/permissions';
import { runUrlTest, unpublishWeb, urlTestBlocked, WebWorld } from '../../api/web';
import { BEHIND_TEXT, behindState } from '../../model/ports';
import { VM } from '../../model/types';
import { DEFAULT_CERT_WARNING, ingressAddress, issuerOf, TlsState, tlsState, URL_TEST_TEXT, UrlTest, WebRow } from '../../model/web';
import { useK8s } from '../../shell/settings';
import { confirm } from '../../ui/dialogs';
import { IconAction, K8sName, Tag } from '../../ui/kit';
import { RowStatus, useRowChange } from '../../ui/rowState';
import { LedTone, tabular } from '../../ui/tokens';
import { useTokens } from '../../ui/useTokens';
import { CopyButton, LiveLabel, VmPorts } from './portParts';

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '');

/** The TLS state in words, with its LED. */
export function tlsWords(s: TlsState, issuer?: string | null): { tone: LedTone; text: string } {
  switch (s.kind) {
    case 'default':
      return { tone: 'standby', text: "The ingress's default certificate: browsers warn" };
    case 'requesting':
      return { tone: 'busy', text: `Requesting a certificate${issuer ? ` from ${issuer}` : ''}${s.message ? `: ${s.message}` : ''}` };
    case 'valid':
      return { tone: 'on', text: `Certificate valid until ${day(s.notAfter) || 'its end date'}${s.renewing ? ', renewing' : s.renewalTime ? `, renews on ${day(s.renewalTime)}` : ''}` };
    case 'failed':
      return { tone: 'fault', text: `Certificate failed: ${s.message}` };
    default:
      return { tone: 'off', text: s.why === 'denied' ? 'Certificate unknown: your role cannot read Certificates' : 'A certificate from a Secret made elsewhere (Hangar reads no Secret)' };
  }
}

export function WebLine({ row, vm, ports, web, canDelete }: { row: WebRow; vm: VM; ports: VmPorts; web: WebWorld; canDelete: boolean }) {
  const t = useTokens();
  const k8s = useK8s();
  const change = useRowChange<'remove'>();
  const [test, setTest] = React.useState<UrlTest | 'running' | null>(null);
  const url = `https://${row.host}${row.path === '/' ? '/' : row.path}`;
  const address = ingressAddress(row.ingress);
  const tls = tlsState(row.ingress, row.host, web.certificates);
  const tw = tlsWords(tls, issuerOf(row.ingress)?.name);
  const behind = row.service ? behindState(row.service, ports.world.slices, ports.vmOn) : null;
  const b = behind ? BEHIND_TEXT[behind] : { tone: 'standby' as LedTone, text: `Its Service ${row.serviceName} is not this VM's` };
  const remove = async () => {
    const ok = await confirm({
      title: `Remove the web address ${row.host}?`,
      body: (
        <>
          <p>{url} no longer reaches the VM. The port stays published inside the cluster.</p>
          {issuerOf(row.ingress) && <p>cert-manager's Certificate goes with it; the certificate's Secret stays in the folder.</p>}
        </>
      ),
      confirm: 'Remove',
      danger: true,
    });
    if (ok) await change.run('remove', () => unpublishWeb(row, vm).finally(web.refresh));
  };
  const runTest = async () => {
    setTest('running');
    setTest(await runUrlTest(url));
  };
  return (
    <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', fontSize: 14 }}>
        <Icon icon="mdi:web" width={18} style={{ color: t.muted, flex: 'none' }} />
        <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
          <Box component="a" href={url} target="_blank" rel="noopener noreferrer" sx={{ color: 'inherit', fontWeight: 600, overflowWrap: 'anywhere' }}>
            {url}
          </Box>{' '}
          <Box component="span" sx={{ color: t.muted, ...tabular }}>
            → {row.guest ?? row.servicePort}/TCP
          </Box>
        </Box>
        <Box sx={{ fontSize: 13 }}>
          <LiveLabel tone={b.tone}>{b.text}</LiveLabel>
        </Box>
        {!row.managed && <Tag tone="muted">Made outside Hangar</Tag>}
        <CopyButton text={url} label={`Copy ${url}`} />
        {row.managed && <IconAction icon="mdi:delete-outline" label={canDelete ? `Remove ${row.host}` : NOT_ALLOWED} disabled={!canDelete || change.state.phase === 'pending'} onClick={remove} />}
      </Box>
      <Box sx={{ ml: 3.75, mt: 0.25, display: 'grid', gap: 0.25, fontSize: 12.5, color: t.muted, ...tabular }}>
        <Box>
          {address ? (
            <>
              Point {row.host} at <b style={{ color: t.text }}>{address}</b>
              {/\.(nip|sslip)\.io$/.test(row.host) ? ' (this nip.io name already does)' : ''}
            </>
          ) : (
            'Waiting for the ingress to publish its address'
          )}
        </Box>
        <Box>
          <LiveLabel tone={tw.tone}>{tw.text}</LiveLabel>
        </Box>
        {tls.kind === 'default' && <Box>{DEFAULT_CERT_WARNING}</Box>}
        {!row.managed && <Box>Ingress {row.ingress.metadata.name} routes to this VM: change it where it was made.</Box>}
        {k8s && (
          <Box>
            <K8sName>
              ingress/{row.ingress.metadata.name} class {row.ingress.spec?.ingressClassName ?? 'default'} → service/{row.serviceName}:{row.servicePort}
            </K8sName>
          </Box>
        )}
        {(!urlTestBlocked() || test) && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
            {!urlTestBlocked() && (
              <Button size="small" sx={{ textTransform: 'none', p: 0, minWidth: 0, fontSize: 12.5 }} disabled={test === 'running'} onClick={runTest}>
                {test === 'running' ? 'Testing…' : 'Test the address'}
              </Button>
            )}
            {test && test !== 'running' && (
              <Box component="span" role="status" sx={{ color: test === 'answered' ? undefined : '#B7791F' }}>
                {URL_TEST_TEXT[test]}{' '}
                {test !== 'answered' && (
                  <Box component="a" href={url} target="_blank" rel="noopener noreferrer" sx={{ color: t.accent }}>
                    Open {row.host}
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
      <RowStatus state={change.state} sx={{ ml: 3.75, mt: 0.25 }} pending="Removing the web address…" done="Removed." failed={`Not removed: ${errorText(change.state.error)}`} />
    </Box>
  );
}
