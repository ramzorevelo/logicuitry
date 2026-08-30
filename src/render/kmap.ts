// K-map instrument: Gray-ordered grid, axis labels with
// overbars drawn as a line over the glyph, group outlines as rounded rects
// that split open toward a wrapped edge, cell/outline hit-testing. Pure
// canvas over core/boolean/kmap's grid model; React supplies chrome only.

import type { KmapGrid, ImplicantLiteral } from '../core/boolean/kmap';
import type { Rect } from './scene';
import type { Theme } from './theme';

export interface KmapMetrics {
  cell: number;
  /** Space reserved left of the grid for row labels / axis caption. */
  labelW: number;
  /** Space reserved above the grid for column labels / axis caption. */
  labelH: number;
}

export const defaultKmapMetrics: KmapMetrics = { cell: 48, labelW: 64, labelH: 44 };

export interface KmapLayout {
  grid: KmapGrid;
  metrics: KmapMetrics;
  /** cellRects[row][col], screen space. */
  cellRects: Rect[][];
  width: number;
  height: number;
  x0: number;
  y0: number;
}

export function layoutKmap(
  grid: KmapGrid,
  x0: number,
  y0: number,
  metrics: KmapMetrics = defaultKmapMetrics,
): KmapLayout {
  const gx = x0 + metrics.labelW;
  const gy = y0 + metrics.labelH;
  const cellRects = grid.rowCodes.map((_, r) =>
    grid.colCodes.map((_, c) => ({
      x: gx + c * metrics.cell,
      y: gy + r * metrics.cell,
      w: metrics.cell,
      h: metrics.cell,
    })),
  );
  return {
    grid,
    metrics,
    cellRects,
    width: metrics.labelW + grid.colCodes.length * metrics.cell,
    height: metrics.labelH + grid.rowCodes.length * metrics.cell,
    x0,
    y0,
  };
}

/** A committed circle: its cells plus how to draw it (instructor's own vs
 *  the revealed minimal cover, which renders dashed in the ok tint). */
export interface KmapGroupDraw {
  minterms: readonly number[];
  style: 'user' | 'reveal';
  /** Palette slot (theme.colors.kmapGroups[color % 8]); stable per circle. */
  color: number;
  /** Stable index used to inset nested outlines so they stay distinguishable. */
  inset?: number;
}

export interface KmapDrawOpts {
  /** Display name per input path (component label, else id). */
  names: ReadonlyMap<string, string>;
  /** Output display name for the diagonal-split corner cell. */
  outName?: string;
  groups?: readonly KmapGroupDraw[];
  /** Live drag selection preview. */
  candidate?: ReadonlySet<number> | null;
  /** Render the candidate in the warn color (illegal flash). */
  candidateIllegal?: boolean;
  /** Keyboard cell cursor as a minterm index. */
  cursor?: number | null;
  /** Indices into `groups` drawn emphasized (hovered/selected). */
  emphasis?: ReadonlySet<number>;
}

function codeLabel(code: number, bits: number): string {
  return code.toString(2).padStart(bits, '0');
}

/** Text with an overline over negated variables; returns painted width. */
export function drawTermText(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  term: readonly ImplicantLiteral[],
  names: ReadonlyMap<string, string>,
  x: number,
  y: number,
  fontPx: number,
  color: string,
): number {
  ctx.font = `${fontPx}px ${theme.fonts.mono}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, theme.strokes.min);
  let cx = x;
  if (term.length === 0) {
    ctx.fillText('1', cx, y);
    return ctx.measureText('1').width;
  }
  for (const lit of term) {
    const label = names.get(lit.var) ?? lit.var;
    const w = ctx.measureText(label).width;
    ctx.fillText(label, cx, y);
    if (lit.negated) {
      ctx.beginPath();
      ctx.moveTo(cx, y - fontPx * 0.62);
      ctx.lineTo(cx + w, y - fontPx * 0.62);
      ctx.stroke();
    }
    cx += w + fontPx * 0.15;
  }
  return cx - x;
}

interface Run {
  start: number;
  len: number;
  /** Continues across the wrap on the low side (index 0). */
  openLow: boolean;
  openHigh: boolean;
}

/** Contiguous index runs, allowing one wraparound split (Gray axes are
 *  cyclic). A full axis is a single closed run. */
function axisRuns(indices: ReadonlySet<number>, size: number): Run[] {
  if (indices.size === size) return [{ start: 0, len: size, openLow: false, openHigh: false }];
  const runs: Run[] = [];
  let i = 0;
  while (i < size) {
    if (!indices.has(i)) {
      i++;
      continue;
    }
    const start = i;
    while (i < size && indices.has(i)) i++;
    runs.push({ start, len: i - start, openLow: false, openHigh: false });
  }
  // Wrap: a run ending at the last index joins one starting at 0.
  if (runs.length >= 2) {
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    if (first.start === 0 && last.start + last.len === size) {
      first.openLow = true;
      last.openHigh = true;
    }
  }
  return runs;
}

function strokeBlock(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  radius: number,
  open: { left: boolean; right: boolean; top: boolean; bottom: boolean },
): void {
  const { x, y, w, h } = r;
  const rr = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  // Each side is skipped when open toward a wrapped edge (the book's split
  // rounded-rect visual); corners round only where both sides are closed.
  const tl = !open.top && !open.left ? rr : 0;
  const tr = !open.top && !open.right ? rr : 0;
  const br = !open.bottom && !open.right ? rr : 0;
  const bl = !open.bottom && !open.left ? rr : 0;
  if (!open.top) {
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  }
  if (!open.right) {
    ctx.moveTo(x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  }
  if (!open.bottom) {
    ctx.moveTo(x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  }
  if (!open.left) {
    ctx.moveTo(x, y + h - bl);
    ctx.lineTo(x, y + tl);
    if (tl) ctx.arcTo(x, y, x + tl, y, tl);
  }
  ctx.stroke();
}

/** Screen-space outline blocks for a group (1, 2, or 4 blocks when the
 *  subcube wraps an edge / the corners). Exported for outline hit-testing. */
export function groupBlocks(
  layout: KmapLayout,
  minterms: readonly number[],
  insetPx = 0,
): { rect: Rect; open: { left: boolean; right: boolean; top: boolean; bottom: boolean } }[] {
  const g = layout.grid;
  const set = new Set(minterms);
  const rows = new Set<number>();
  const cols = new Set<number>();
  for (let r = 0; r < g.rowCodes.length; r++)
    for (let c = 0; c < g.colCodes.length; c++)
      if (set.has(g.cells[r]![c]!.minterm)) {
        rows.add(r);
        cols.add(c);
      }
  const out: ReturnType<typeof groupBlocks> = [];
  for (const rr of axisRuns(rows, g.rowCodes.length)) {
    for (const cr of axisRuns(cols, g.colCodes.length)) {
      const first = layout.cellRects[rr.start]![cr.start]!;
      out.push({
        rect: {
          x: first.x + insetPx,
          y: first.y + insetPx,
          w: cr.len * layout.metrics.cell - 2 * insetPx,
          h: rr.len * layout.metrics.cell - 2 * insetPx,
        },
        open: {
          left: cr.openLow,
          right: cr.openHigh,
          top: rr.openLow,
          bottom: rr.openHigh,
        },
      });
    }
  }
  return out;
}

export function drawKmap(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: KmapLayout,
  opts: KmapDrawOpts,
): void {
  const g = layout.grid;
  const m = layout.metrics;
  const fontPx = Math.max(theme.canvasTextMin, Math.round(m.cell * 0.4));
  const labelPx = Math.max(theme.canvasTextMin, Math.round(m.cell * 0.3));
  const name = (p: string) => opts.names.get(p) ?? p;

  const gx = layout.x0 + m.labelW;
  const gy = layout.y0 + m.labelH;

  // Corner cell per Fig 2.49: a diagonal splits it -- output name upper-left
  // above the split, column vars upper-right beside the code row, row vars
  // lower-left beside the code column.
  ctx.strokeStyle = theme.colors.muted;
  ctx.lineWidth = theme.strokes.min;
  ctx.beginPath();
  ctx.moveTo(layout.x0, layout.y0 + m.labelH * 0.35);
  ctx.lineTo(gx, gy);
  ctx.stroke();
  ctx.font = `${labelPx}px ${theme.fonts.mono}`;
  ctx.textBaseline = 'middle';
  if (opts.outName) {
    ctx.fillStyle = theme.colors.ink;
    ctx.textAlign = 'left';
    ctx.fillText(opts.outName, layout.x0 + 2, layout.y0 + m.labelH * 0.15);
  }
  ctx.fillStyle = theme.colors.muted;
  ctx.textAlign = 'right';
  ctx.fillText(g.colVars.map(name).join(''), gx - 4, layout.y0 + m.labelH * 0.35);
  ctx.textAlign = 'left';
  ctx.fillText(g.rowVars.map(name).join(''), layout.x0 + 2, layout.y0 + m.labelH * 0.82);

  // Header dividers: the code row/column read as a header band, separated
  // from the grid body like the book's figures. Ruled in the theme's
  // structural colour, matching the waveform's own frame.
  ctx.strokeStyle = theme.colors.accent2;
  ctx.lineWidth = theme.strokes.min;
  ctx.beginPath();
  ctx.moveTo(layout.x0, gy);
  ctx.lineTo(gx + g.colCodes.length * m.cell, gy);
  ctx.moveTo(gx, layout.y0);
  ctx.lineTo(gx, gy + g.rowCodes.length * m.cell);
  ctx.stroke();

  // Gray-code labels.
  ctx.fillStyle = theme.colors.muted;
  ctx.textAlign = 'center';
  g.colCodes.forEach((code, c) => {
    ctx.fillText(
      codeLabel(code, g.colVars.length),
      gx + (c + 0.5) * m.cell,
      layout.y0 + m.labelH * 0.75,
    );
  });
  ctx.textAlign = 'right';
  g.rowCodes.forEach((code, r) => {
    ctx.fillText(codeLabel(code, g.rowVars.length), gx - 6, gy + (r + 0.5) * m.cell);
  });

  // Cells.
  for (let r = 0; r < g.rowCodes.length; r++) {
    for (let c = 0; c < g.colCodes.length; c++) {
      const cell = g.cells[r]![c]!;
      const rect = layout.cellRects[r]![c]!;
      const inCandidate = opts.candidate?.has(cell.minterm) ?? false;
      ctx.fillStyle = inCandidate
        ? opts.candidateIllegal
          ? theme.colors.warn
          : theme.colors.accentFill
        : theme.colors.surface;
      if (inCandidate && opts.candidateIllegal) {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      ctx.strokeStyle = theme.colors.line;
      ctx.lineWidth = theme.strokes.min;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = cell.value === 1 ? theme.colors.ink : theme.colors.muted;
      ctx.font = `${fontPx}px ${theme.fonts.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const glyph = cell.value === 'x' ? 'X' : cell.value === null ? '–' : String(cell.value);
      ctx.fillText(glyph, rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
  }

  // Keyboard cursor.
  if (opts.cursor !== null && opts.cursor !== undefined) {
    for (let r = 0; r < g.rowCodes.length; r++)
      for (let c = 0; c < g.colCodes.length; c++)
        if (g.cells[r]![c]!.minterm === opts.cursor) {
          const rect = layout.cellRects[r]![c]!;
          ctx.strokeStyle = theme.colors.accent;
          ctx.lineWidth = theme.strokes.min * 2;
          ctx.strokeRect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
        }
  }

  // Group outlines: per-group categorical color; user circles solid, the
  // revealed cover dashed to stay distinguishable (decision 7). Hovered or
  // selected groups get a heavier stroke plus a fill tint.
  (opts.groups ?? []).forEach((grp, i) => {
    const inset = 4 + ((grp.inset ?? i) % 3) * 3;
    const color = theme.colors.kmapGroups[grp.color % 8] ?? theme.colors.accent;
    const emphasized = opts.emphasis?.has(i) ?? false;
    const blocks = groupBlocks(layout, grp.minterms, inset);
    if (emphasized) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      for (const block of blocks)
        ctx.fillRect(block.rect.x, block.rect.y, block.rect.w, block.rect.h);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = emphasized ? theme.strokes.wire * 1.75 : theme.strokes.wire;
    ctx.setLineDash(grp.style === 'reveal' ? [6, 4] : []);
    for (const block of blocks)
      strokeBlock(ctx, block.rect, theme.strokes.cornerRadius * 2, block.open);
    ctx.setLineDash([]);
  });
}

/** Minterm under a screen point, if any. */
export function kmapCellAt(layout: KmapLayout, x: number, y: number): number | undefined {
  for (let r = 0; r < layout.cellRects.length; r++) {
    for (let c = 0; c < layout.cellRects[r]!.length; c++) {
      const rect = layout.cellRects[r]![c]!;
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h)
        return layout.grid.cells[r]![c]!.minterm;
    }
  }
  return undefined;
}

/** Index of the group whose outline band contains (x, y): on the stroke
 *  (`outerTol` outward) or up to `innerTol` inside it; the deep interior and
 *  anything further outside miss. */
export function kmapGroupAt(
  layout: KmapLayout,
  groups: readonly KmapGroupDraw[],
  x: number,
  y: number,
  innerTol = 8,
  outerTol = 2,
): number | undefined {
  for (let i = groups.length - 1; i >= 0; i--) {
    const inset = 4 + ((groups[i]!.inset ?? i) % 3) * 3;
    for (const { rect } of groupBlocks(layout, groups[i]!.minterms, inset)) {
      const inExpanded =
        x >= rect.x - outerTol &&
        x <= rect.x + rect.w + outerTol &&
        y >= rect.y - outerTol &&
        y <= rect.y + rect.h + outerTol;
      const inDeepInterior =
        x > rect.x + innerTol &&
        x < rect.x + rect.w - innerTol &&
        y > rect.y + innerTol &&
        y < rect.y + rect.h - innerTol;
      if (inExpanded && !inDeepInterior) return i;
    }
  }
  return undefined;
}
