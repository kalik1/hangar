/*
 * Performance charts of a VM: CPU and memory over the last 30 minutes, as
 * measured on its host.
 */

import Box from '@mui/material/Box';
import React from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useHangar } from '../../api/data';
import { Sample, useMetrics } from '../../api/metrics';
import { Obj } from '../../model/types';
import { formatBytes, formatCores } from '../../model/units';
import { hardware, key } from '../../model/vm';
import { Empty, Panel } from '../../ui/kit';
import { useTokens } from '../../ui/useTokens';

export function UsageChart({
  samples,
  pick,
  max,
  format,
  label,
}: {
  samples: Sample[];
  pick: (s: Sample) => number;
  max: number;
  format: (n: number) => string;
  label: string;
}) {
  const t = useTokens();
  const data = samples.map(s => ({ t: s.t, v: pick(s) }));
  return (
    <Box sx={{ height: 220 }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={t.rule} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            stroke={t.muted}
            fontSize={12}
          />
          <YAxis domain={[0, max]} tickFormatter={format} stroke={t.muted} fontSize={12} width={72} />
          <Tooltip
            labelFormatter={v => new Date(v as number).toLocaleTimeString()}
            formatter={(v: any) => [format(v as number), label]}
            contentStyle={{ background: t.surface, border: `1px solid ${t.rule}`, fontSize: 13 }}
          />
          <Area type="monotone" dataKey="v" stroke={t.meterUsed} fill={t.meterAlloc} strokeWidth={1.5} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
}

export function MonitorTab({ vm }: { vm: Obj }) {
  const d = useHangar();
  const m = useMetrics();
  const vmi = d.idx.vmi.get(key(vm));
  const hw = hardware(vm, vmi, d.instancetypes);
  const samples = m.vms.get(key(vm)) ?? [];
  if (!vmi) return <Empty icon="mdi:chart-line" title="The VM is powered off">Charts appear while it runs.</Empty>;
  if (m.available === false)
    return (
      <Empty icon="mdi:chart-line" title="No measurements">
        The cluster has no metrics-server, so Hangar cannot read CPU and memory usage.
      </Empty>
    );
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' } }}>
      <Panel title="CPU" icon="mdi:cpu-64-bit">
        {samples.length < 2 ? (
          <Box sx={{ color: 'text.secondary', fontSize: 14 }}>Collecting: a point every 15 seconds while Hangar is open.</Box>
        ) : (
          <UsageChart samples={samples} pick={s => s.cpu} max={hw.vcpus} format={n => `${formatCores(n)} vCPU`} label="CPU used" />
        )}
      </Panel>
      <Panel title="Memory" icon="mdi:memory">
        {samples.length < 2 ? (
          <Box sx={{ color: 'text.secondary', fontSize: 14 }}>Collecting: a point every 15 seconds while Hangar is open.</Box>
        ) : (
          <UsageChart samples={samples} pick={s => s.mem} max={Math.max(hw.memoryBytes * 1.25, ...samples.map(s => s.mem))} format={n => formatBytes(n, 0)} label="Memory used" />
        )}
      </Panel>
    </Box>
  );
}
