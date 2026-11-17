// Truth-table image: the Analyze drawer's full table as a plain grid on its
// own surface, inputs left of a divider, outputs in the accent colour.

import type { Theme } from './theme';

export interface TableModel {
  headings: string[];
  inputCount: number;
  rows: string[][];
}

export interface TruthTableLayout {
  fontPx: number;
  rowH: number;
  /** Left edge of each column; one extra entry closes the last. */
  colX: number[];
  /** Null when there is no output column to divide from. */
  dividerX: number | null;
  width: number;
  height: number;
}

const PAD_X = 12;
const PAD_Y = 10;
const CHAR_W = 0.62;

export function layoutTruthTable(m: TableModel, theme: Theme): TruthTableLayout {
  const fontPx = Math.max(theme.canvasTextMin, 16);
  const rowH = Math.round(fontPx * 1.8);
  const colX = [PAD_X];
  m.headings.forEach((h, c) => {
    // Bold heading glyphs run wider than the regular body digits.
    let chars = h.length * 1.1;
    for (const row of m.rows) chars = Math.max(chars, (row[c] ?? '').length);
    colX.push(colX[c]! + Math.ceil(chars * fontPx * CHAR_W) + PAD_X * 2);
  });
  const hasOutputs = m.inputCount > 0 && m.inputCount < m.headings.length;
  return {
    fontPx,
    rowH,
    colX,
    dividerX: hasOutputs ? colX[m.inputCount]! : null,
    width: colX[colX.length - 1]! + PAD_X,
    height: (m.rows.length + 1) * rowH + PAD_Y * 2,
  };
}

export function drawTruthTable(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: TruthTableLayout,
  m: TableModel,
): void {
  const { colX, rowH, fontPx } = layout;
  ctx.fillStyle = theme.colors.surface;
  ctx.fillRect(0, 0, layout.width, layout.height);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const centre = (c: number) => (colX[c]! + colX[c + 1]!) / 2;
  const top = PAD_Y;

  ctx.font = `bold ${fontPx}px ${theme.fonts.mono}`;
  m.headings.forEach((h, c) => {
    ctx.fillStyle = c < m.inputCount ? theme.colors.ink : theme.colors.accent;
    ctx.fillText(h, centre(c), top + rowH / 2);
  });

  ctx.font = `${fontPx}px ${theme.fonts.mono}`;
  m.rows.forEach((row, r) => {
    const y = top + (r + 1) * rowH + rowH / 2;
    row.forEach((cell, c) => {
      ctx.fillStyle = c < m.inputCount ? theme.colors.ink : theme.colors.accent;
      ctx.fillText(cell, centre(c), y);
    });
  });

  ctx.strokeStyle = theme.colors.line;
  ctx.lineWidth = theme.strokes.min;
  ctx.beginPath();
  ctx.moveTo(PAD_X / 2, top + rowH);
  ctx.lineTo(layout.width - PAD_X / 2, top + rowH);
  ctx.stroke();

  if (layout.dividerX !== null) {
    ctx.strokeStyle = theme.colors.accent2;
    ctx.beginPath();
    ctx.moveTo(layout.dividerX, top);
    ctx.lineTo(layout.dividerX, top + (m.rows.length + 1) * rowH);
    ctx.stroke();
  }
}
