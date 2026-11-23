/*
 * Configure → Clipboard sharing: copy and paste between this computer and
 * the VM's graphical console (see model/clipboard.ts for how it works).
 */

import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import React from 'react';
import { setVmClipboard } from '../../api/clipboard';
import { useHangar } from '../../api/data';
import { NOT_ALLOWED, useCan, useVmPerms } from '../../api/permissions';
import { clipboardMode, clipboardOnVm, HOOK_ANNOTATION, sidecarGateOn, sidecarImage } from '../../model/clipboard';
import { Obj } from '../../model/types';
import { key } from '../../model/vm';
import { useK8s } from '../../shell/settings';
import { confirm } from '../../ui/dialogs';
import { K8sName, Panel } from '../../ui/kit';
import { Led } from '../../ui/Led';
import { useTokens } from '../../ui/useTokens';

/** Asks before turning on KubeVirt's Sidecar feature gate; false when cancelled. */
export async function confirmSidecarGate(): Promise<boolean> {
  const ok = await confirm({
    title: 'Turn on hook sidecars in KubeVirt?',
    body: (
      <>
        <p>
          Clipboard sharing needs KubeVirt&apos;s <b>Sidecar</b> feature: a VM can run a helper container next to it. Hangar
          uses KubeVirt&apos;s own sidecar-shim image with a small script that adds the clipboard port to the VM.
        </p>
        <p>The switch is cluster-wide: from then on, anyone who may edit VMs can add hook sidecars to them.</p>
      </>
    ),
    confirm: 'Turn on and continue',
  });
  return !!ok;
}

export function ClipboardPanel({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const ns = vm.metadata.namespace as string;
  const vmi = d.idx.vmi.get(key(vm)) ?? null;
  const perms = useVmPerms(ns);
  const kv = d.kubevirt;
  const gateOn = sidecarGateOn(kv);
  const canGate = useCan(kv ? { verb: 'update', group: 'kubevirt.io', resource: 'kubevirts', namespace: kv.metadata.namespace as string } : null);
  const canHook = useCan({ verb: 'create', group: '', resource: 'configmaps', namespace: ns });
  const wanted = clipboardOnVm(vm);
  const mode = clipboardMode(vm, vmi);
  const [busy, setBusy] = React.useState(false);

  const why = !perms.edit
    ? NOT_ALLOWED
    : !kv
    ? 'KubeVirt is not readable'
    : !wanted && !gateOn && !canGate
    ? "Needs an administrator: KubeVirt's Sidecar feature is off"
    : !wanted && !canHook
    ? `${NOT_ALLOWED} (it keeps a small script in the folder)`
    : undefined;

  const toggle = async (on: boolean) => {
    if (on && !gateOn && !(await confirmSidecarGate())) return;
    setBusy(true);
    try {
      await setVmClipboard(vm, on, kv);
    } catch {
      /* shown in Recent tasks */
    } finally {
      setBusy(false);
    }
  };

  const status =
    mode === 'shared' && vmi
      ? { tone: 'on' as const, text: 'Shared with the console' }
      : mode === 'shared'
      ? { tone: 'on' as const, text: 'On' }
      : mode === 'pending'
      ? { tone: 'standby' as const, text: 'On from the next power-on' }
      : mode === 'off-pending'
      ? { tone: 'standby' as const, text: 'Off from the next power-on' }
      : { tone: 'off' as const, text: 'Off' };

  return (
    <Panel title="Clipboard sharing" icon="mdi:clipboard-multiple-outline">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Switch checked={wanted} disabled={!!why || busy} onChange={e => toggle(e.target.checked)} inputProps={{ 'aria-label': 'Clipboard sharing' }} />}
          label={<Box sx={{ fontSize: 14 }}>Copy and paste with the console</Box>}
          title={why}
        />
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 13.5 }}>
          <Led tone={status.tone} />
          {status.text}
        </Box>
      </Box>
      <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 1 }}>
        Press Ctrl+V in the VM&apos;s console to paste what you copied on this computer; what you copy in the VM shows up in the
        console&apos;s Clipboard panel. The guest needs the SPICE agent (spice-vdagent, already in Fedora and Ubuntu desktops;
        Windows: spice-guest-tools) and a logged-in desktop. A change applies at the next power-on.
        {why && wanted === false ? ` ${why}.` : ''}
      </Typography>
      {k8s && (
        <Box sx={{ mt: 1, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          <K8sName>{HOOK_ANNOTATION}</K8sName>
          <K8sName>{sidecarImage(kv)}</K8sName>
          <K8sName>configmap/hangar-clipboard-hook</K8sName>
          <K8sName>featureGates: Sidecar {gateOn ? 'on' : 'off'}</K8sName>
        </Box>
      )}
    </Panel>
  );
}
