// The bit-row instrument shared by the Numbers workbench tabs. Pure layout +
// draw over a canvas context: MSB-left cells, a nibble gap every 4 bits, index
// labels beneath. Values are known logic bits, coloured via signalStyle; the
// caller supplies per-cell highlight intensity (eased elsewhere) for emphasis.

import { toString, type BusValue } from '../core/value/busValue';
import type { Rect } from './scene';
import { signalStyle, type Theme } from './theme';
import { bodyRectPath } from './glyphs/relief';

export interface BitCell {
  bit: number; // logical index, 0 = LSB
  rect: Rect; // screen space
}

export interface BitRowLayout {
  cells: BitCell[];
  width: number; // pixel width of the row
  height: number; // pixel height incl. index labels
  groupBits: number; // where the wider gap falls; also which columns get labelled
}

export interface BitGridMetrics {
  cellW: number; // cell width in px
  cellH: number; // cell height in px
  gap: number; // gap between adjacent cells
  nibbleGap: number; // extra gap at every 4-bit boundary
  labelH: number; // height reserved for index labels
}

// Upright rather than square: a cell holds one digit, so width past what the
// digit needs only pushes a 32-bit row wider without making it more readable.
export const defaultMetrics: BitGridMetrics = {
  cellW: 22,
  cellH: 34,
  gap: 4,
  nibbleGap: 10,
  labelH: 16,
};

/**
 * Column weights above the cells. `power` is the whole word's place values;
 * `nibble`/`triplet` restart at each group so a group reads as one hex/octal
 * digit (H&H: the low four bits carry 8, 4, 2, 1, the next four 16 times that).
 */
export type WeightMode = 'power' | 'nibble' | 'triplet';

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** `2^17` written the way the book writes it. */
export function superscript(n: number): string {
  return String(n).replace(/\d/g, (d) => SUPERSCRIPT_DIGITS[Number(d)]!);
}

/**
 * `exponent` picks the power form over the decimal place value. The caller
 * decides, per row, by measuring: 128 belongs over an 8-bit row, but 32768
 * is five glyphs over a cell that holds one.
 */
export function weightLabel(bit: number, mode: WeightMode, exponent = false): string {
  if (mode === 'nibble') return String(2 ** (bit % 4));
  if (mode === 'triplet') return String(2 ** (bit % 3));
  return exponent ? `2${superscript(bit)}` : String(2 ** bit);
}

/**
 * Chapter 1 Example 1.12's borrow notation, as MSB-left strings the width of the
 * row; a space means nothing is written over that column.
 * - `lent`     the column's value after lending downward, drawn just above it
 * - `received` `10`, the value a column takes on after borrowing from its left
 * - `struck`   `1` marks an original digit to draw struck through
 */
export interface BorrowMarks {
  lent: string;
  received: string;
  struck: string;
}

/** Uniformly scales cell metrics; used for presentation-mode enlargement. */
export function scaleMetrics(scale: number, m: BitGridMetrics = defaultMetrics): BitGridMetrics {
  return {
    cellW: m.cellW * scale,
    cellH: m.cellH * scale,
    gap: m.gap * scale,
    nibbleGap: m.nibbleGap * scale,
    labelH: m.labelH * scale,
  };
}

/**
 * Lay out `width` cells MSB-left starting at (x0, y0). `groupBits` sets where the
 * wider gap falls: 4 for hex nibbles, 3 for octal triplets, so a group's weight
 * labels always sit against the group the eye actually sees.
 */
export function layoutBitRow(
  width: number,
  x0: number,
  y0: number,
  m: BitGridMetrics = defaultMetrics,
  groupBits = 4,
): BitRowLayout {
  const cells: BitCell[] = [];
  let x = x0;
  for (let col = 0; col < width; col++) {
    const bit = width - 1 - col; // leftmost column is the MSB
    cells.push({ bit, rect: { x, y: y0, w: m.cellW, h: m.cellH } });
    x += m.cellW + m.gap;
    if (bit % groupBits === 0 && col !== width - 1) x += m.nibbleGap;
  }
  return { cells, width: x - x0 - m.gap, height: m.cellH + m.labelH, groupBits };
}

export interface BitRowDraw {
  value: BusValue;
  highlight?: ReadonlySet<number>;
  /** Per-bit emphasis 0..1 (eased by the caller); overrides highlight alpha. */
  intensity?: (bit: number) => number;
  showIndices?: boolean;
  /** Column weights above each cell; absent draws no weight row. */
  weights?: WeightMode;
  /** Carry-in digit per lane, MSB-left (carryStr); drawn above each cell. */
  carries?: string;
  /** Example 1.12 borrow notation over the minuend row. */
  borrows?: BorrowMarks;
  /** Selected columns [start, end) as MSB-left indices; drawn as a fill on the
   *  cells themselves, so a selection reads per bit rather than as one band. */
  selection?: { start: number; end: number };
  /** Caret column as an MSB-left index; drawn on the cell's leading edge. */
  caret?: number;
}

/** Extra top band height when weights or carries are drawn. */
export const topBandH = 16;

/** Borrow notation stacks two annotation rows over the digits. */
export const borrowBandH = topBandH * 2;

/**
 * Whether decimal place values still clear the column pitch. Decided once for
 * the row, never per cell: half a row reading 1024 and the other half 2^15
 * looks like a bug rather than a choice. The widest label is always the MSB's.
 */
function decimalWeightsFit(
  ctx: CanvasRenderingContext2D,
  layout: BitRowLayout,
  font: string,
): boolean {
  const cells = layout.cells;
  const msb = cells[0];
  if (!msb || cells.length < 2) return true;
  let pitch = Infinity;
  for (let i = 1; i < cells.length; i++) {
    pitch = Math.min(pitch, cells[i]!.rect.x - cells[i - 1]!.rect.x);
  }
  const prev = ctx.font;
  ctx.font = font;
  const w = ctx.measureText(String(2 ** msb.bit)).width;
  ctx.font = prev;
  return w <= pitch - 2; // 1px of air either side, or the labels touch
}

const SUPERSCRIPT_RUN = /[⁰¹²³⁴-⁹]+$/;

/**
 * A weight, centred on `cx`. The exponent is typeset rather than trusted to the
 * font: a monospace superscript takes a full advance width, so 2^31 overhangs a
 * cell it should sit inside and 2^10 reads as three separate digits.
 */
function drawWeight(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  text: string,
  cx: number,
  baseline: number,
  labelPx: number,
): void {
  const run = SUPERSCRIPT_RUN.exec(text);
  if (!run) {
    ctx.fillText(text, cx, baseline);
    return;
  }
  const base = text.slice(0, run.index);
  const exp = [...run[0]].map((ch) => SUPERSCRIPT_DIGITS.indexOf(ch)).join('');
  const baseFont = `${labelPx}px ${theme.fonts.mono}`;
  const expFont = `${Math.max(8, Math.round(labelPx * 0.72))}px ${theme.fonts.mono}`;
  ctx.font = baseFont;
  const baseW = ctx.measureText(base).width;
  ctx.font = expFont;
  const expW = ctx.measureText(exp).width;
  const x = cx - (baseW + expW) / 2;
  ctx.textAlign = 'left';
  ctx.font = baseFont;
  ctx.fillText(base, x, baseline);
  ctx.font = expFont;
  ctx.fillText(exp, x + baseW, baseline - labelPx * 0.34);
  ctx.textAlign = 'center';
  ctx.font = baseFont;
}

/**
 * On a row too wide to label every column, only each group's own first and last
 * bit is named, so a nibble still reads as a self-contained 8 4 2 1 unit and the
 * eye can count inwards from either end of it.
 */
function isGroupEdge(bit: number, groupBits: number): boolean {
  const place = bit % groupBits;
  return place === 0 || place === groupBits - 1;
}

export function drawBitRow(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: BitRowLayout,
  opts: BitRowDraw,
): void {
  if (opts.selection) drawSelection(ctx, theme, layout, opts.selection);
  const bits = toString(opts.value, 32); // MSB-left over 32; index by position
  const cellH = layout.cells[0]?.rect.h ?? defaultMetrics.cellH;
  const fontPx = Math.max(theme.canvasTextMin, Math.round(cellH * 0.5));
  // Annotations track the cell rather than sitting at a fixed 13px, so
  // presentation mode enlarges the weights along with the digits they label.
  const labelPx = Math.max(theme.canvasTextMin, Math.round(cellH * 0.32));
  const width = layout.cells.length;
  const labelFont = `${labelPx}px ${theme.fonts.mono}`;
  // One decision for the whole row, from one measurement: place values as the
  // course reads them while they fit, the power form and group edges past that.
  // Nibble/triplet weights are single digits that always fit, so a row showing
  // them keeps every label and both annotation rows stay in step.
  const grouped = opts.weights === 'nibble' || opts.weights === 'triplet';
  const dense = grouped || decimalWeightsFit(ctx, layout, labelFont);
  const exponent = opts.weights === 'power' && !dense;
  for (const { bit, rect } of layout.cells) {
    const ch = bits[31 - bit];
    const state = ch === '1' ? '1' : ch === '0' ? '0' : 'X';
    const style = signalStyle(theme, state === 'X' ? 'X' : state);
    const emphasis = opts.intensity ? opts.intensity(bit) : opts.highlight?.has(bit) ? 1 : 0;

    ctx.fillStyle = state === '1' ? theme.colors.accentFill : theme.colors.surface;
    ctx.strokeStyle = emphasis > 0 ? theme.colors.accent : theme.colors.line;
    ctx.lineWidth = theme.strokes.min * (1 + emphasis);
    ctx.beginPath();
    // Same corner treatment as a themed box glyph, so a bit cell and a chip
    // body are cut the same way.
    bodyRectPath(ctx, theme, rect);
    ctx.fill();
    ctx.stroke();

    // Undiscovered/unknown bits render as a muted dot, not a fake 0.
    ctx.fillStyle = state === 'X' ? theme.colors.muted : style.color;
    ctx.font = `${fontPx}px ${theme.fonts.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state === 'X' ? '·' : state, rect.x + rect.w / 2, rect.y + rect.h / 2);

    const col = width - 1 - bit; // index into the MSB-left annotation strings

    // A digit that lent to the column below is struck through, then rewritten above.
    if (opts.borrows?.struck[col] === '1') {
      ctx.strokeStyle = theme.colors.muted;
      ctx.lineWidth = theme.strokes.min;
      ctx.beginPath();
      ctx.moveTo(rect.x + rect.w * 0.2, rect.y + rect.h / 2);
      ctx.lineTo(rect.x + rect.w * 0.8, rect.y + rect.h / 2);
      ctx.stroke();
    }

    ctx.font = labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    if (opts.borrows) {
      // Bottom-up in the order the column changes: it lends first, then borrows.
      const stack = [opts.borrows.lent[col], opts.borrows.received[col] === '1' ? '10' : ' '];
      ctx.fillStyle = theme.colors.accent;
      let y = rect.y - 2;
      for (const mark of stack) {
        if (mark === undefined || mark.trim() === '') continue;
        ctx.fillText(mark, rect.x + rect.w / 2, y);
        y -= topBandH;
      }
    } else if (opts.carries !== undefined) {
      // Book-style: only the 1s are written, above the column they carry into.
      if (opts.carries[col] === '1') {
        ctx.fillStyle = theme.colors.accent;
        ctx.fillText('1', rect.x + rect.w / 2, rect.y - 2);
      }
    } else if (opts.weights !== undefined && (dense || isGroupEdge(bit, layout.groupBits))) {
      ctx.fillStyle = theme.colors.muted;
      drawWeight(
        ctx,
        theme,
        weightLabel(bit, opts.weights, exponent),
        rect.x + rect.w / 2,
        rect.y - 2,
        labelPx,
      );
    }
    ctx.textBaseline = 'middle';

    if (opts.showIndices !== false && (dense || isGroupEdge(bit, layout.groupBits))) {
      ctx.fillStyle = theme.colors.muted;
      ctx.font = labelFont;
      ctx.textBaseline = 'top';
      ctx.fillText(String(bit), rect.x + rect.w / 2, rect.y + rect.h + 2);
    }
  }
}

/** Which bit, if any, a screen point falls on. */
export function bitAtPoint(layout: BitRowLayout, x: number, y: number): number | undefined {
  for (const { bit, rect } of layout.cells) {
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return bit;
  }
  return undefined;
}

/**
 * Nearest bit to a point, tolerant of the gaps between cells: a click in the
 * inter-cell gap or a nibble gap belongs to the cell it sits against rather
 * than to nothing. Undefined above/below the row or past either end.
 */
export function nearestBitAtPoint(layout: BitRowLayout, x: number, y: number): number | undefined {
  const first = layout.cells[0];
  const last = layout.cells[layout.cells.length - 1];
  if (!first || !last) return undefined;
  if (y < first.rect.y || y > first.rect.y + first.rect.h) return undefined;
  if (x < first.rect.x || x > last.rect.x + last.rect.w) return undefined;
  let best = first;
  let bestD = Infinity;
  for (const cell of layout.cells) {
    const d = Math.max(cell.rect.x - x, 0, x - (cell.rect.x + cell.rect.w));
    if (d < bestD) {
      bestD = d;
      best = cell;
    }
  }
  return best.bit;
}

/**
 * Cursor column for a screen x: the cell the pointer is on or nearest to.
 * Editing overwrites a cell rather than inserting between two, so a click
 * anywhere inside a box addresses that box; there is no position past the
 * last cell. Always resolves, ignoring y, so it can back a drag that has
 * wandered off the row.
 */
export function columnAtPoint(layout: BitRowLayout, x: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let col = 0; col < layout.cells.length; col++) {
    const { rect } = layout.cells[col]!;
    const d = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
    if (d < bestD) {
      bestD = d;
      best = col;
    }
  }
  return best;
}

/** Selected cells, filled behind the digits so each bit reads as its own box. */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: BitRowLayout,
  sel: { start: number; end: number },
): void {
  ctx.save();
  // Accent at low alpha, not accentFill: a logic-1 cell is already filled with
  // accentFill, and a selection has to read on top of one.
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = theme.colors.accent;
  for (let col = sel.start; col < sel.end; col++) {
    const cell = layout.cells[col];
    if (!cell) continue;
    ctx.beginPath();
    bodyRectPath(ctx, theme, cell.rect);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Cursor on the cell a typed digit will land on, drawn as a bar INSIDE that
 * cell's bottom edge: a line on the cell's leading edge sits in the gap and
 * reads as belonging to either neighbour.
 */
export function drawCaret(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: BitRowLayout,
  col: number,
): void {
  const cell = layout.cells[col];
  if (!cell) return;
  const { x, y, w, h } = cell.rect;
  const inset = w * 0.15;
  const thickness = Math.max(2, theme.strokes.min * 2);
  ctx.save();
  ctx.fillStyle = theme.colors.accent;
  ctx.fillRect(x + inset, y + h - inset - thickness, w - inset * 2, thickness);
  ctx.restore();
}
