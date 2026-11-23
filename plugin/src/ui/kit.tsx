/*
 * Hangar's small UI kit: panels, key/value rows, meters, power labels,
 * toolbars, empty states, sparklines. Quiet by design; the faceplate
 * (src/views/vm/Faceplate.tsx) is the one loud element.
 */

import { Icon } from '@iconify/react';
import Box, { BoxProps } from '@mui/material/Box';
import Button, { ButtonProps } from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PowerState } from '../model/vm';
import { Led } from './Led';
import { tabular } from './tokens';
import { useTokens } from './useTokens';

/* ---------------------------------------------------------------- panel */

export function Panel({
  title,
  icon,
  actions,
  children,
  dense,
  sx,
  footer,
}: {
  title?: React.ReactNode;
  icon?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  dense?: boolean;
  sx?: BoxProps['sx'];
  footer?: React.ReactNode;
}) {
  const t = useTokens();
  return (
    <Box
      component="section"
      sx={{
        border: `1px solid ${t.rule}`,
        borderRadius: `${t.radius.panel}px`,
        background: t.surface,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        ...sx,
      }}
    >
      {(title || actions) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            minHeight: 44,
            borderBottom: `1px solid ${t.rule}`,
          }}
        >
          {icon && <Icon icon={icon} width={18} style={{ color: t.muted, flex: 'none' }} />}
          <Typography component="h3" sx={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
            {title}
          </Typography>
          {actions}
        </Box>
      )}
      <Box sx={{ p: dense ? 0 : 2, flex: 1, minWidth: 0 }}>{children}</Box>
      {footer && <Box sx={{ px: 2, py: 1, borderTop: `1px solid ${t.rule}` }}>{footer}</Box>}
    </Box>
  );
}

/* ------------------------------------------------------- key/value rows */

export function KV({ rows, labelWidth = 150 }: { rows: [React.ReactNode, React.ReactNode][]; labelWidth?: number }) {
  const t = useTokens();
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: `minmax(110px, ${labelWidth}px) 1fr`,
        columnGap: 2,
        rowGap: 0.75,
        fontSize: 13.5,
      }}
    >
      {rows
        .filter(r => r !== null)
        .map(([k, v], i) => (
          <React.Fragment key={i}>
            <Box component="dt" sx={{ color: t.muted, m: 0 }}>
              {k}
            </Box>
            <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere', ...tabular }}>
              {v ?? '—'}
            </Box>
          </React.Fragment>
        ))}
    </Box>
  );
}

/* ---------------------------------------------------------------- meter */

/**
 * Capacity meter: `used` solid, `allocated` (reserved but not used) hatched
 * lighter, on the track of `total`. Text above: label left, numbers right.
 */
export function Meter({
  label,
  used,
  allocated,
  total,
  format,
  warnAt = 85,
  caption,
}: {
  label: React.ReactNode;
  used?: number;
  allocated?: number;
  total: number;
  format: (n: number) => string;
  warnAt?: number;
  caption?: React.ReactNode;
}) {
  const t = useTokens();
  const p = (n?: number) => (total > 0 && n !== undefined && isFinite(n) ? Math.min(100, (n / total) * 100) : 0);
  const usedPct = p(used);
  const allocPct = p(allocated);
  // Warn on what is used; allocation above capacity is overcommit, said in the caption.
  const hot = (used !== undefined ? usedPct : allocPct) >= warnAt;
  const main = used !== undefined ? used : allocated;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600, flex: 1 }} noWrap>
          {label}
        </Typography>
        <Typography sx={{ fontSize: 13, color: t.muted, ...tabular }} noWrap>
          {main !== undefined ? format(main) : '—'} of {format(total)}
        </Typography>
      </Box>
      <Box
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.max(usedPct, allocPct))}
        aria-label={typeof label === 'string' ? label : undefined}
        sx={{ position: 'relative', height: 8, borderRadius: 1, background: t.meterTrack, overflow: 'hidden' }}
      >
        {allocated !== undefined && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              width: `${allocPct}%`,
              background: `repeating-linear-gradient(135deg, ${t.meterAlloc} 0 4px, transparent 4px 7px)`,
              borderRight: allocPct > 0 ? `1px solid ${t.meterUsed}` : 'none',
            }}
          />
        )}
        {used !== undefined && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              width: `${usedPct}%`,
              background: hot ? '#E8A33D' : t.meterUsed,
            }}
          />
        )}
      </Box>
      {caption && <Typography sx={{ fontSize: 12.5, color: t.muted, mt: 0.5, ...tabular }}>{caption}</Typography>}
    </Box>
  );
}

/* ---------------------------------------------------------- power label */

export function PowerLabel({ p, size = 'md' }: { p: PowerState; size?: 'sm' | 'md' }) {
  const t = useTokens();
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.9, minWidth: 0 }}
      title={p.detail ? `${p.label}: ${p.detail}` : p.label}
    >
      <Led tone={p.tone} size={size === 'sm' ? 8 : 9} />
      <Box
        component="span"
        sx={{
          fontSize: size === 'sm' ? 13 : 13.5,
          color: p.tone === 'fault' ? '#E5484D' : t.text,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {p.label}
      </Box>
    </Box>
  );
}

/* -------------------------------------------------------------- toolbar */

export function ToolButton({
  icon,
  children,
  tooltip,
  ...rest
}: ButtonProps & { icon?: string; tooltip?: string }) {
  const btn = (
    <Button
      size="small"
      variant="text"
      color="inherit"
      startIcon={icon ? <Icon icon={icon} width={18} /> : undefined}
      sx={{ textTransform: 'none', fontWeight: 500, fontSize: 13.5, px: 1.25, whiteSpace: 'nowrap', ...rest.sx }}
      {...rest}
    >
      {children}
    </Button>
  );
  return tooltip ? (
    <Tooltip title={tooltip}>
      <span>{btn}</span>
    </Tooltip>
  ) : (
    btn
  );
}

export function IconAction({
  icon,
  label,
  onClick,
  disabled,
  size = 18,
  color,
}: {
  icon: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  size?: number;
  color?: string;
}) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton size="small" aria-label={label} onClick={onClick} disabled={disabled} sx={{ color }}>
          <Icon icon={icon} width={size} />
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function Toolbar({ children, sx }: { children: React.ReactNode; sx?: BoxProps['sx'] }) {
  const t = useTokens();
  return (
    <Box
      role="toolbar"
      sx={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 0.25,
        px: 1,
        minHeight: 44,
        borderBottom: `1px solid ${t.rule}`,
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

export function Divider() {
  const t = useTokens();
  return <Box aria-hidden sx={{ width: '1px', alignSelf: 'stretch', my: 1, mx: 0.75, background: t.rule }} />;
}

/* ---------------------------------------------------------- empty state */

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: string;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const t = useTokens();
  return (
    <Box sx={{ py: 6, px: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 1 }}>
      <Icon icon={icon} width={36} style={{ color: t.muted, opacity: 0.8 }} />
      <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{title}</Typography>
      {children && <Typography sx={{ color: t.muted, fontSize: 14, maxWidth: 520 }}>{children}</Typography>}
      {action && <Box sx={{ mt: 1 }}>{action}</Box>}
    </Box>
  );
}

/* ------------------------------------------------------------ sparkline */

export function Sparkline({
  values,
  max,
  width = 120,
  height = 28,
  color,
  label,
}: {
  values: number[];
  max?: number;
  width?: number;
  height?: number;
  color?: string;
  label?: string;
}) {
  const t = useTokens();
  const stroke = color ?? t.meterUsed;
  if (values.length < 2)
    return (
      <Box
        component="span"
        aria-label={label}
        sx={{ display: 'inline-block', width, height, borderBottom: `1px dashed ${t.rule}` }}
      />
    );
  const m = max ?? Math.max(...values, 1e-9);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / m) * (height - 4)).toFixed(1)}`);
  return (
    <svg width={width} height={height} role="img" aria-label={label} style={{ display: 'block' }}>
      <polyline points={`0,${height} ${pts.join(' ')} ${width},${height}`} fill={`${stroke}22`} stroke="none" />
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/* --------------------------------------------------------------- chips */

export function Tag({ children, tone }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warn' }) {
  const t = useTokens();
  const color = tone === 'warn' ? '#B7791F' : tone === 'accent' ? t.meterUsed : t.muted;
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        px: 0.75,
        height: 22,
        borderRadius: `${t.radius.small}px`,
        border: `1px solid ${t.rule}`,
        fontSize: 12.5,
        color,
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </Box>
  );
}

/** A Kubernetes name shown next to the virtualizer name, in Kubernetes mode. */
export function K8sName({ children }: { children: React.ReactNode }) {
  const t = useTokens();
  return (
    <Box
      component="code"
      sx={{
        fontFamily: t.font.mono,
        fontSize: 12,
        color: t.muted,
        background: t.hover,
        px: 0.5,
        borderRadius: `${t.radius.small}px`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  );
}

export function SectionTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
      <Typography component="h2" sx={{ fontSize: 18, fontWeight: 600, flex: 1 }}>
        {children}
      </Typography>
      {actions}
    </Box>
  );
}
