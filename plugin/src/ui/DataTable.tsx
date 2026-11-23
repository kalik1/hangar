/*
 * The inventory table: dense rows, sortable columns, checkbox selection for
 * bulk actions, Enter/double-click to open, right-click for the row menu.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import React from 'react';
import { tabular } from './tokens';
import { useTokens } from './useTokens';

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Sort key; columns without one are not sortable. */
  sort?: (row: T) => string | number;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  /** Hidden below this container width (px). */
  minWidth?: number;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  onOpen,
  onContextMenu,
  initialSort,
  empty,
  activeKey,
  label,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  onOpen?: (row: T) => void;
  onContextMenu?: (row: T, e: React.MouseEvent) => void;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
  empty?: React.ReactNode;
  activeKey?: string;
  label: string;
}) {
  const t = useTokens();
  const [sort, setSort] = React.useState(initialSort ?? { id: columns.find(c => c.sort)?.id ?? '', dir: 'asc' as const });
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(2000);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(e => setWidth(e[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = columns.filter(c => !c.minWidth || width >= c.minWidth);
  const sorted = React.useMemo(() => {
    const col = columns.find(c => c.id === sort.id);
    if (!col?.sort) return rows;
    const f = col.sort;
    const out = [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === 'asc' ? r : -r;
    });
    return out;
  }, [rows, columns, sort]);
  const sel = selected ?? new Set<string>();
  const allKeys = sorted.map(rowKey);
  const allOn = allKeys.length > 0 && allKeys.every(k => sel.has(k));
  const someOn = allKeys.some(k => sel.has(k));
  const toggle = (k: string) => {
    const next = new Set(sel);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onSelectedChange?.(next);
  };
  const cellSx = (c: Column<T>) => ({
    px: 1.25,
    py: 0.75,
    textAlign: c.align ?? 'left',
    width: c.width,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: c.width ?? 320,
  });
  return (
    <Box ref={ref} sx={{ width: '100%', overflowX: 'auto' }}>
      <Box
        component="table"
        aria-label={label}
        sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, ...tabular, tableLayout: 'auto' }}
      >
        <Box component="thead">
          <Box component="tr" sx={{ borderBottom: `1px solid ${t.rule}` }}>
            {selectable && (
              <Box component="th" sx={{ width: 36, pl: 0.5 }}>
                <Checkbox
                  size="small"
                  checked={allOn}
                  indeterminate={!allOn && someOn}
                  onChange={() => onSelectedChange?.(allOn ? new Set() : new Set(allKeys))}
                  inputProps={{ 'aria-label': 'Select all' }}
                />
              </Box>
            )}
            {cols.map(c => {
              const active = sort.id === c.id;
              return (
                <Box
                  component="th"
                  key={c.id}
                  scope="col"
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  sx={{
                    ...cellSx(c),
                    fontWeight: 600,
                    fontSize: 12.5,
                    color: t.muted,
                    position: 'sticky',
                    top: 0,
                    background: t.surface,
                    zIndex: 1,
                  }}
                >
                  {c.sort ? (
                    <Box
                      component="button"
                      onClick={() => setSort(s => ({ id: c.id, dir: s.id === c.id && s.dir === 'asc' ? 'desc' : 'asc' }))}
                      sx={{
                        all: 'unset',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.25,
                        '&:focus-visible': { outline: `2px solid ${t.meterUsed}`, outlineOffset: 2 },
                      }}
                    >
                      {c.header}
                      <Icon
                        icon={active && sort.dir === 'desc' ? 'mdi:chevron-down' : 'mdi:chevron-up'}
                        width={14}
                        style={{ opacity: active ? 1 : 0 }}
                      />
                    </Box>
                  ) : (
                    c.header
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
        <Box component="tbody">
          {sorted.map(r => {
            const k = rowKey(r);
            const isSel = sel.has(k);
            return (
              <Box
                component="tr"
                key={k}
                tabIndex={onOpen ? 0 : undefined}
                aria-selected={selectable ? isSel : undefined}
                onDoubleClick={() => onOpen?.(r)}
                onClick={e => {
                  if ((e.target as HTMLElement).closest('input,button,a,[role=menuitem]')) return;
                  onOpen?.(r);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') onOpen?.(r);
                  if (e.key === ' ' && selectable) {
                    e.preventDefault();
                    toggle(k);
                  }
                }}
                onContextMenu={
                  onContextMenu
                    ? e => {
                        e.preventDefault();
                        onContextMenu(r, e);
                      }
                    : undefined
                }
                sx={{
                  borderBottom: `1px solid ${t.rule}`,
                  cursor: onOpen ? 'pointer' : 'default',
                  background: isSel || activeKey === k ? t.selected : 'transparent',
                  '&:hover': { background: isSel ? t.selected : t.hover },
                  '&:focus-visible': { outline: `2px solid ${t.meterUsed}`, outlineOffset: -2 },
                }}
              >
                {selectable && (
                  <Box component="td" sx={{ width: 36, pl: 0.5 }}>
                    <Checkbox
                      size="small"
                      checked={isSel}
                      onChange={() => toggle(k)}
                      inputProps={{ 'aria-label': `Select ${k}` }}
                    />
                  </Box>
                )}
                {cols.map(c => (
                  <Box component="td" key={c.id} sx={cellSx(c)}>
                    {c.cell(r)}
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
      </Box>
      {sorted.length === 0 && empty}
    </Box>
  );
}
