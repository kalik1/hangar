/*
 * Configure → Devices: the virtual devices Proxmox lists under Hardware
 * besides CPU, memory, disks and NICs: display (graphics card, video type),
 * audio, random number generator, watchdog, crash-report (panic) device,
 * VSOCK, downward metrics. Each control saves on its own; gated ones are
 * disabled with the reason while their KubeVirt feature is off (and can
 * always be turned off).
 */

import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import React from 'react';
import { useHangar } from '../../api/data';
import { useGate } from '../../api/gates';
import { Obj } from '../../model/types';
import { key, powerState } from '../../model/vm';
import * as O from '../../model/vmoptions';
import { useK8s } from '../../shell/settings';
import { confirm } from '../../ui/dialogs';
import { K8sName, Panel } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';
import { GateHint } from '../settings/GateHint';
import { Help, Later, NotInKubevirt, quiet, Row, saveVm } from './configParts';

const VIDEO: { value: O.VideoType; label: string }[] = [
  { value: '', label: 'Default (VGA for BIOS, Bochs for UEFI)' },
  { value: 'virtio', label: 'VirtIO GPU' },
  { value: 'vga', label: 'Standard VGA' },
  { value: 'bochs', label: 'Bochs' },
  { value: 'ramfb', label: 'ramfb (boot framebuffer)' },
];

const PANIC: { value: O.PanicModel; label: string }[] = [
  { value: '', label: 'None' },
  { value: 'isa', label: 'pvpanic (ISA)' },
  { value: 'pvpanic', label: 'pvpanic (PCI)' },
  { value: 'hyperv', label: 'Hyper-V crash reporting (Windows)' },
];

function GatedSelect<T extends string>({
  value,
  options,
  onChange,
  gate,
  label,
  width = 260,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  gate?: { on: boolean | null };
  label: string;
  width?: number;
}) {
  const off = gate?.on === false;
  return (
    <TextField select size="small" value={value} onChange={e => onChange(e.target.value as T)} sx={{ width: { xs: '100%', sm: width } }} SelectProps={{ displayEmpty: true }} inputProps={{ 'aria-label': label }}>
      {options.map(o => (
        // While the feature is off only "none" (or the current value) can be chosen.
        <MenuItem key={o.value} value={o.value} disabled={off && !!o.value && o.value !== value}>
          {o.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function DevicesPanel({ vm }: { vm: Obj }) {
  const d = useHangar();
  const t = useTokens();
  const k8s = useK8s();
  const vmi = d.idx.vmi.get(key(vm));
  const running = powerState(vm, vmi).kind !== 'off';
  const o = O.deviceOptions(vm);
  const video = useGate('VideoConfig');
  const panic = useGate('PanicDevices');
  const vsock = useGate('VSOCK');
  const metrics = useGate('DownwardMetrics');
  const set = (title: string, p: Partial<O.DeviceOptions>) => quiet(saveVm(vm, title, O.setDevices(vm, p)));
  const setGraphics = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({
        title: 'Run headless?',
        body: (
          <>
            <p>The VM gets no graphics card: the graphical console stays black and the faceplate shows no screen. The serial console keeps working if the guest uses it.</p>
            <p>Applies at the next power-on.</p>
          </>
        ),
        confirm: 'Remove the graphics card',
        danger: true,
      });
      if (!ok) return;
    }
    set(on ? 'Add a graphics card' : 'Run headless', { graphics: on });
  };
  const flagSwitch = (label: string, checked: boolean, gate: { on: boolean | null }, onChange: (v: boolean) => void) => (
    <Switch checked={checked} disabled={gate.on === false && !checked} onChange={e => onChange(e.target.checked)} inputProps={{ 'aria-label': label }} />
  );
  return (
    <Panel title="Devices" icon="mdi:memory" actions={<Later running={running} />}>
      <Row label="Display" align="flex-start" action={<Switch checked={o.graphics} onChange={e => setGraphics(e.target.checked)} inputProps={{ 'aria-label': 'Graphics card' }} />}>
        {o.graphics ? 'Graphics card and console' : 'Headless: no graphics card'}
        {!o.graphics && <Help tone="warn">The graphical console needs a graphics card: use the serial console.</Help>}
        {o.graphics && (
          <Box sx={{ mt: 1 }}>
            <GatedSelect label="Video card" value={o.video} options={VIDEO} gate={video} onChange={v => set('Change video card', { video: v })} />
            {video.on === false && !o.video && <GateHint gate="VideoConfig" sx={{ mt: 0.5 }} />}
          </Box>
        )}
        <NotInKubevirt>SPICE is not in KubeVirt: consoles are VNC and serial.</NotInKubevirt>
      </Row>
      <Row label="Audio">
        <GatedSelect
          label="Audio device"
          value={o.sound}
          options={[
            { value: '' as O.SoundModel, label: 'None' },
            { value: 'ich9', label: 'Intel HD Audio (ich9)' },
            { value: 'ac97', label: 'AC97 (old guests)' },
          ]}
          onChange={v => set(v ? 'Add an audio device' : 'Remove the audio device', { sound: v })}
        />
        <Help>The guest gets a sound card; the console carries no sound.</Help>
      </Row>
      <Row label="Random numbers" align="flex-start" action={<Switch checked={o.rng} onChange={e => set(e.target.checked ? 'Add a VirtIO RNG' : 'Remove the VirtIO RNG', { rng: e.target.checked })} inputProps={{ 'aria-label': 'VirtIO random number generator' }} />}>
        {o.rng ? 'VirtIO RNG: entropy from the host' : 'Off'}
        <Help>Speeds up boots and key generation in guests that wait for entropy.</Help>
      </Row>
      <Row label="Watchdog">
        <GatedSelect
          label="Watchdog"
          value={o.watchdog}
          options={[
            { value: '' as O.WatchdogAction, label: 'None' },
            { value: 'reset', label: 'i6300esb: reset the VM' },
            { value: 'poweroff', label: 'i6300esb: power off the VM' },
            { value: 'shutdown', label: 'i6300esb: shut the guest down' },
          ]}
          onChange={v => set(v ? 'Set the watchdog' : 'Remove the watchdog', { watchdog: v })}
        />
        <Help>When the guest stops feeding it (a hung kernel), the VM is reset or stopped. The guest needs a watchdog daemon.</Help>
      </Row>
      <Row label="Crash reports">
        <GatedSelect label="Panic device" value={o.panic} options={PANIC} gate={panic} onChange={v => set(v ? 'Add a crash-report device' : 'Remove the crash-report device', { panic: v })} />
        {panic.on === false && !o.panic ? <GateHint gate="PanicDevices" sx={{ mt: 0.5 }} /> : <Help>A guest kernel panic shows as a VM event instead of a silent hang.</Help>}
      </Row>
      <Row label="VSOCK" align="flex-start" action={flagSwitch('VSOCK', o.vsock, vsock, v => set(v ? 'Add VSOCK' : 'Remove VSOCK', { vsock: v }))}>
        {o.vsock ? 'On: host–guest sockets without a network' : 'Off'}
        {vsock.on === false && !o.vsock ? <GateHint gate="VSOCK" sx={{ mt: 0.5 }} /> : <Help>For agents that talk to the host over AF_VSOCK; KubeVirt gives the VM a context ID (CID).</Help>}
      </Row>
      <Row label="Host metrics" align="flex-start" action={flagSwitch('Downward metrics', o.downwardMetrics, metrics, v => set(v ? 'Add host metrics' : 'Remove host metrics', { downwardMetrics: v }))}>
        {o.downwardMetrics ? 'On: the guest reads host metrics' : 'Off'}
        {metrics.on === false && !o.downwardMetrics ? (
          <GateHint gate="DownwardMetrics" sx={{ mt: 0.5 }} />
        ) : (
          <Help>A virtio-serial port with host and VM usage (vm-dump-metrics --virtio in the guest, from the vhostmd tools).</Help>
        )}
      </Row>
      {k8s && (
        <Box sx={{ mt: 1, display: 'flex', gap: 0.75, flexWrap: 'wrap', pt: 1, borderTop: `1px solid ${t.rule}` }}>
          <K8sName>autoattachGraphicsDevice</K8sName>
          <K8sName>video.type</K8sName>
          <K8sName>sound</K8sName>
          <K8sName>rng</K8sName>
          <K8sName>watchdog.i6300esb</K8sName>
          <K8sName>panicDevices</K8sName>
          <K8sName>autoattachVSOCK</K8sName>
          <K8sName>downwardMetrics</K8sName>
        </Box>
      )}
    </Panel>
  );
}
