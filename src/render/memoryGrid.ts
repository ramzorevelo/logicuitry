// Memory panel grid: one row per address (binary address, bits MSB left,
// hex, and the '189's /O complement), with the current address, the last
// write and the edit cursor marked. Pure canvas; React supplies chrome only.

import * as bv from '../core/value/busValue';
import type { Theme } from './theme';

export interface MemoryGridMetrics {
  rowH: number;
  /** Width of one bit column; also the bit's tap target. */
  bitW: number;
  font: number;
  /** Advance of one monospace character at `font`. */
  charW: number;
  pad: number;
}

/** JetBrains Mono advances 0.6 em per character. */
const MONO_ADVANCE = 0.6;

/**
 * Metrics at `scale` times the default (presentation follows the root font
 * size), with rows and bit columns at least `minTarget` px so a finger can
 * take a single bit.
 */
export function memoryGridMetrics(scale: number, minTarget = 0): MemoryGridMetrics {
  const font = Math.round(14 * scale);
  const rowH = Math.max(Math.round(22 * scale), minTarget);
  const bitW = Math.max(Math.round(18 * scale), minTarget);
  return { rowH, bitW, font, charW: font * MONO_ADVANCE, pad: Math.round(8 * scale) };
}

export interface MemoryGridDims {
  width: number;
  addressBits: number;
  invertedOut: boolean;
}

export interface MemoryGridLayout {
  dims: MemoryGridDims;
  metrics: MemoryGridMetrics;
  rows: number;
  headerH: number;
  addrX: number;
  /** Left edge of bit column `width - 1` (the MSB). */
  bitsX: number;
  hexX: number;
  invX: number | null;
  width: number;
  height: number;
}

export function layoutMemoryGrid(dims: MemoryGridDims, m: MemoryGridMetrics): MemoryGridLayout {
  const digits = Math.ceil(dims.width / 4);
  // The marker triangle sits in the gutter left of the address.
  const addrX = m.pad + m.charW * 1.5;
  const bitsX = addrX + Math.max(dims.addressBits, 4) * m.charW + m.pad;
  const hexX = bitsX + dims.width * m.bitW + m.pad;
  const hexW = Math.max(digits + 1, 3) * m.charW;
  const invX = dims.invertedOut ? hexX + hexW + m.pad : null;
  const right = invX === null ? hexX + hexW : invX + Math.max(dims.width, 2) * m.charW;
  const rows = 1 << dims.addressBits;
  const headerH = m.rowH;
  return {
    dims,
    metrics: m,
    rows,
    headerH,
    addrX,
    bitsX,
    hexX,
    invX,
    width: Math.ceil(right + m.pad),
    height: headerH + rows * m.rowH,
  };
}

export function rowTop(layout: MemoryGridLayout, row: number): number {
  return layout.headerH + row * layout.metrics.rowH;
}

export interface MemoryHit {
  row: number;
  /** Bit index (0 = LSB) when the point is on a bit column. */
  bit?: number;
}

export function memoryCellAt(
  layout: MemoryGridLayout,
  x: number,
  y: number,
): MemoryHit | undefined {
  if (y < layout.headerH || y >= layout.height || x < 0 || x >= layout.width) return undefined;
  const row = Math.floor((y - layout.headerH) / layout.metrics.rowH);
  const col = Math.floor((x - layout.bitsX) / layout.metrics.bitW);
  if (x < layout.bitsX || col >= layout.dims.width) return { row };
  return { row, bit: layout.dims.width - 1 - col };
}

export interface MemoryGridDraw {
  cells: readonly bv.BusValue[];
  /** Edit cursor row (power off only). */
  selected: number | null;
  /** Hex digits typed into the selected row and not yet committed. */
  pending: string;
  /** The address on the RAM's `a` pins while powered; null while unknown. */
  current: number | null;
  /** The row the last write changed. */
  written: number | null;
  focused: boolean;
}

const binary = (n: number, digits: number) => n.toString(2).padStart(digits, '0');

function hexText(cell: bv.BusValue, width: number): string {
  const digits = Math.ceil(width / 4);
  return bv.isFullyKnown(cell, width)
    ? (cell.v >>> 0).toString(16).toUpperCase().padStart(digits, '0')
    : 'X'.repeat(digits);
}

export function drawMemoryGrid(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: MemoryGridLayout,
  d: MemoryGridDraw,
): void {
  const { metrics: m, dims } = layout;
  const c = theme.colors;
  const w = dims.width;
  const midY = (top: number) => top + m.rowH / 2;
  const bitCx = (bit: number) => layout.bitsX + (w - 1 - bit + 0.5) * m.bitW;

  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(m.font * 0.85)}px ${theme.fonts.mono}`;
  ctx.fillStyle = c.muted;
  ctx.textAlign = 'left';
  ctx.fillText('addr', layout.addrX, midY(0));
  ctx.textAlign = 'center';
  for (let bit = w - 1; bit >= 0; bit--) ctx.fillText(String(bit), bitCx(bit), midY(0));
  ctx.textAlign = 'left';
  ctx.fillText('hex', layout.hexX, midY(0));
  if (layout.invX !== null) ctx.fillText('/O', layout.invX, midY(0));

  ctx.font = `${m.font}px ${theme.fonts.mono}`;
  for (let row = 0; row < layout.rows; row++) {
    const top = rowTop(layout, row);
    const y = midY(top);
    const cell = d.cells[row] ?? bv.allX(w);
    if (row === d.current) {
      ctx.fillStyle = c.accentFill;
      ctx.fillRect(0, top, layout.width, m.rowH);
      const s = m.font * 0.35;
      const x = m.pad * 0.5;
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 1.6, y);
      ctx.lineTo(x, y + s);
      ctx.closePath();
      ctx.fill();
    }
    const valueInk = row === d.written ? c.warn : c.ink;
    if (row === d.written) {
      ctx.fillStyle = c.warn;
      ctx.fillRect(0, top + 2, 3, m.rowH - 4);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = c.accent2;
    ctx.fillText(binary(row, dims.addressBits), layout.addrX, y);

    ctx.textAlign = 'center';
    for (let bit = w - 1; bit >= 0; bit--) {
      const mask = (1 << bit) >>> 0;
      const unknown = ((cell.x | cell.z) & mask) !== 0;
      ctx.fillStyle = unknown ? c.muted : valueInk;
      ctx.fillText(unknown ? 'X' : (cell.v & mask) !== 0 ? '1' : '0', bitCx(bit), y);
    }

    ctx.textAlign = 'left';
    const editing = row === d.selected && d.pending !== '';
    const known = bv.isFullyKnown(cell, w);
    ctx.fillStyle = editing ? c.accent : known ? valueInk : c.muted;
    const digits = Math.ceil(w / 4);
    ctx.fillText(editing ? d.pending.padEnd(digits, '_') : hexText(cell, w), layout.hexX, y);

    if (layout.invX !== null) {
      ctx.fillStyle = known ? c.accent2 : c.muted;
      const inv = bv.not(cell, w);
      ctx.fillText(known ? binary(inv.v >>> 0, w) : 'X'.repeat(w), layout.invX, y);
    }

    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + m.rowH - 0.5);
    ctx.lineTo(layout.width, top + m.rowH - 0.5);
    ctx.stroke();
  }

  if (d.selected !== null) {
    const top = rowTop(layout, d.selected);
    ctx.strokeStyle = d.focused ? c.accent : c.muted;
    ctx.lineWidth = d.focused ? 2 : 1;
    ctx.strokeRect(1, top + 1, layout.width - 2, m.rowH - 2);
  }
}
