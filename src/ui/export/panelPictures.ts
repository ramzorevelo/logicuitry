import type { Expr } from '../../core/boolean/expr';
import { exprFont, exprTextHeight, layoutExprText, paintExprText } from '../../render/exprText';
import { drawKmap, type KmapDrawOpts, type KmapLayout } from '../../render/kmap';
import type { Theme } from '../../render/theme';
import { drawTruthTable, layoutTruthTable, type TableModel } from '../../render/truthTable';
import { drawWaveform, type WaveformDrawOpts, type WaveformLayout } from '../../render/waveform';
import type { ExportPicture } from './exportPicture';

const PAD = 16;

/** Measuring needs a context before the export canvas exists. */
function measureContext(): CanvasRenderingContext2D | null {
  return document.createElement('canvas').getContext('2d');
}

export interface ExprCaption {
  /** Drawn before the expression, e.g. `Y = `. */
  lead: string;
  expr: Expr;
}

export function kmapPicture(
  theme: Theme,
  layout: KmapLayout,
  opts: KmapDrawOpts,
  captions: readonly ExprCaption[],
): ExportPicture {
  const fontPx = Math.max(theme.canvasTextMin, 14);
  const measure = measureContext();
  if (measure) measure.font = exprFont(theme, fontPx);
  const lines = captions.map((c) => {
    const lay = measure ? layoutExprText(measure, c.expr) : null;
    const leadW = measure ? measure.measureText(c.lead).width : c.lead.length * fontPx * 0.6;
    return {
      ...c,
      lay,
      leadW,
      width: leadW + (lay?.width ?? 0),
      height: lay ? exprTextHeight(lay, fontPx) : fontPx,
    };
  });
  const lineGap = Math.round(fontPx * 0.6);
  const textH = lines.reduce((h, l) => h + l.height + lineGap, 0);
  const width = Math.ceil(Math.max(layout.width, ...lines.map((l) => l.width)) + 2 * PAD);
  const height = Math.ceil(layout.height + textH + 2 * PAD);
  return {
    width,
    height,
    draw: (ctx) => {
      ctx.fillStyle = theme.colors.surface;
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.translate(PAD, PAD);
      drawKmap(ctx, theme, layout, opts);
      ctx.restore();
      let y = PAD + layout.height + lineGap;
      ctx.font = exprFont(theme, fontPx);
      for (const l of lines) {
        const mid = y + l.height - fontPx / 2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = theme.colors.ink;
        ctx.fillText(l.lead, PAD, mid);
        if (l.lay) paintExprText(ctx, theme, l.lay, PAD + l.leadW, mid, fontPx, theme.colors.ink);
        y += l.height + lineGap;
      }
    },
  };
}

export function tablePicture(theme: Theme, model: TableModel): ExportPicture {
  const layout = layoutTruthTable(model, theme);
  return {
    width: layout.width,
    height: layout.height,
    draw: (ctx) => drawTruthTable(ctx, theme, layout, model),
  };
}

export function wavePicture(
  theme: Theme,
  layout: WaveformLayout,
  opts: WaveformDrawOpts,
): ExportPicture {
  return {
    width: layout.width,
    height: layout.height,
    draw: (ctx) => drawWaveform(ctx, theme, layout, opts),
  };
}
