/*
 * The publish dialog's web address: the hostname (with a nip.io name that
 * resolves by itself), the ingress class, and where the certificate comes
 * from (a cert-manager issuer, or the ingress's default certificate, said
 * plainly). It reports the choice and what is wrong with it.
 */

import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import React from 'react';
import { webContext,WebWorld } from '../../api/web';
import { Obj, VM } from '../../model/types';
import {
  acmeProblem,
  DEFAULT_CERT_WARNING,
  hostProblem,
  ingressIpv4,
  issuerList,
  IssuerRef,
  isTraefikClass,
  pickClass,
  suggestHost,
} from '../../model/web';
import { useK8s } from '../../shell/settings';
import { K8sName } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { Note } from '../storage/parts';
import { Help } from './configParts';

export interface WebChoice {
  host: string;
  className: string;
  traefik: boolean;
  issuer?: IssuerRef;
}

export function WebFields({ vm, web, onChange }: { vm: VM; web: WebWorld; onChange: (choice: WebChoice | null, problem: string | null) => void }) {
  const t = useTokens();
  const k8s = useK8s();
  const vmNs = vm.metadata.namespace as string;
  const [ctx, setCtx] = React.useState<{ ingresses: Obj[]; services: Obj[] } | null>(null);
  React.useEffect(() => {
    let alive = true;
    webContext(vmNs).then(c => alive && setCtx(c));
    return () => {
      alive = false;
    };
  }, [vmNs]);
  const classes = web.classes;
  const [className, setClassName] = React.useState<string>(() => (classes ? pickClass(classes) ?? '' : 'traefik'));
  React.useEffect(() => {
    if (!className && classes) setClassName(pickClass(classes) ?? '');
  }, [classes, className]);
  const [host, setHost] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const ip = ctx ? ingressIpv4(ctx.ingresses, className || null, ctx.services) : null;
  const suggestion = suggestHost(vm.metadata.name, vmNs, ip);
  React.useEffect(() => {
    if (!touched && suggestion) setHost(suggestion);
  }, [suggestion, touched]);
  const issuers = issuerList(web.clusterIssuers, web.issuers);
  const [cert, setCert] = React.useState('default');
  const chosen = issuers.rows.find(r => `${r.kind}/${r.name}` === cert);
  const traefik = !!className && isTraefikClass(className, classes);

  const problem = !className ? 'Pick the ingress class' : hostProblem(host, ctx?.ingresses ?? (Array.isArray(web.ingresses) ? web.ingresses : [])) ?? acmeProblem(chosen, host.trim());
  React.useEffect(() => {
    onChange(problem ? null : { host: host.trim(), className, traefik, issuer: chosen ? { kind: chosen.kind, name: chosen.name } : undefined }, problem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem, host, className, traefik, cert]);

  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      <TextField
        size="small"
        label="Web address (hostname)"
        value={host}
        onChange={e => {
          setHost(e.target.value);
          setTouched(true);
        }}
        error={touched && !!hostProblem(host, ctx?.ingresses ?? [])}
        helperText={
          touched && hostProblem(host, ctx?.ingresses ?? [])
            ? hostProblem(host, ctx?.ingresses ?? [])
            : suggestion
            ? `${suggestion === host.trim() ? 'Suggested: ' : `Or ${suggestion}: `}a nip.io name resolves to the ingress's address by itself`
            : 'A name your DNS points at the ingress'
        }
        sx={{ maxWidth: 480 }}
      />
      {classes === null ? (
        <TextField
          size="small"
          label="Ingress class"
          value={className}
          onChange={e => setClassName(e.target.value.trim())}
          helperText="Your role cannot list the ingress classes (they are cluster-wide): Hangar takes the class by name, traefik on k4all"
          sx={{ maxWidth: 480 }}
        />
      ) : classes.length > 1 || !pickClass(classes) ? (
        <TextField select size="small" label="Ingress class" value={className} onChange={e => setClassName(e.target.value)} sx={{ maxWidth: 480 }}>
          {classes.map(c => (
            <MenuItem key={c.name} value={c.name}>
              {c.name}
              <Box component="span" sx={{ ml: 1, color: t.muted, fontSize: 12.5 }}>
                {c.controller}
                {c.isDefault ? ', the default' : ''}
              </Box>
            </MenuItem>
          ))}
        </TextField>
      ) : (
        <Help>
          Through the ingress class {className} {k8s && <K8sName>{classes[0]?.controller}</K8sName>}
        </Help>
      )}
      {classes !== null && classes.length === 0 && <Note tone="warn">No ingress class on this cluster: an ingress controller (such as Traefik) must run first.</Note>}

      <TextField select size="small" label="Certificate" value={cert} onChange={e => setCert(e.target.value)} sx={{ maxWidth: 480 }}>
        <MenuItem value="default">The ingress's default certificate</MenuItem>
        {issuers.rows.map(r => {
          const acme = acmeProblem(r, host.trim());
          return (
            <MenuItem key={`${r.kind}/${r.name}`} value={`${r.kind}/${r.name}`} disabled={r.ready === false || !!acme}>
              <Box>
                <Box>
                  {r.name}{' '}
                  <Box component="span" sx={{ color: t.muted, fontSize: 12.5 }}>
                    {r.kind === 'ClusterIssuer' ? 'cert-manager, every folder' : 'cert-manager, this folder'}
                    {r.acme ? ', ACME' : ''}
                  </Box>
                </Box>
                {(r.ready === false || acme) && <Box sx={{ fontSize: 12.5, color: t.muted, whiteSpace: 'normal' }}>{acme ?? `Not ready: ${r.why ?? 'see the issuer'}`}</Box>}
              </Box>
            </MenuItem>
          );
        })}
      </TextField>
      {cert === 'default' ? (
        <Note tone="warn">
          {issuers.noCertManager ? 'cert-manager is not installed here, so the ingress uses its default certificate. ' : !issuers.rows.length ? 'No cert-manager issuer on this cluster yet. ' : ''}
          {DEFAULT_CERT_WARNING}
        </Note>
      ) : (
        <Help>cert-manager requests a certificate for {host.trim() || 'the name'} from {chosen?.name}; the row says when it is valid.</Help>
      )}
      {issuers.clusterDenied && <Help>Your role cannot list ClusterIssuers (they are cluster-wide): only this folder's Issuers are offered.</Help>}
      <Help>
        The guest serves plain HTTP on this port; TLS ends at the ingress.{' '}
        {traefik
          ? 'Through Traefik the address answers on HTTPS (443) only: the VM is never reachable over plain HTTP through the ingress.'
          : "This controller's own HTTP and HTTPS behaviour applies (Hangar writes Traefik's settings only for Traefik)."}
      </Help>
    </Box>
  );
}
