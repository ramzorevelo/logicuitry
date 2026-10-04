// A Boolean expression drawn on canvas with stacked overbars: each complement
// sits one bar above the highest bar inside it, so (A'B)' shows two heights.

import { productNeedsDot, type Expr } from '../core/boolean/expr';
import type { Theme } from './theme';

const PRECEDENCE: Record<Expr['kind'], number> = {
  const: 4,
  var: 4,
  not: 3,
  and: 2,
  xor: 1,
  or: 0,
};

interface Run {
  text: string;
  x: number;
}

interface Bar {
  x0: number;
  x1: number;
  level: number;
}

export interface ExprLayout {
  width: number;
  /** Stacked bar count above the text. */
  bars: number;
  runs: Run[];
  barSpans: Bar[];
}

/** Lays `e` out from x = 0 in the context's current font. */
export function layoutExprText(ctx: CanvasRenderingContext2D, e: Expr): ExprLayout {
  const runs: Run[] = [];
  const barSpans: Bar[] = [];
  const text = (s: string, x: number): number => {
    runs.push({ text: s, x });
    return ctx.measureText(s).width;
  };

  // Returns [width, bar depth] of the node laid out at x.
  const walk = (n: Expr, minimum: number, x: number): [number, number] => {
    const parens = PRECEDENCE[n.kind] < minimum;
    let cx = x;
    if (parens) cx += text('(', cx);
    let depth = 0;
    const children = (args: Expr[], sep: (i: number) => string, childMin: number) => {
      args.forEach((a, i) => {
        const s = sep(i);
        if (s) cx += text(s, cx);
        const [w, d] = walk(a, a.kind === n.kind ? 3 : childMin, cx);
        cx += w;
        depth = Math.max(depth, d);
      });
    };
    switch (n.kind) {
      case 'const':
        cx += text(String(n.value), cx);
        break;
      case 'var':
        cx += text(n.name, cx);
        break;
      case 'not': {
        const [w, d] = walk(n.a, 0, cx);
        barSpans.push({ x0: cx, x1: cx + w, level: d + 1 });
        cx += w;
        depth = d + 1;
        break;
      }
      case 'and':
        children(
          n.args,
          (i) => (i > 0 && productNeedsDot(n.args[i - 1]!, n.args[i]!) ? '·' : ''),
          PRECEDENCE.and,
        );
        break;
      case 'xor':
        children(n.args, (i) => (i > 0 ? ' ⊕ ' : ''), PRECEDENCE.xor);
        break;
      case 'or':
        children(n.args, (i) => (i > 0 ? ' + ' : ''), 0);
        break;
    }
    if (parens) cx += text(')', cx);
    return [cx - x, depth];
  };

  const [width, bars] = walk(e, 0, 0);
  return { width, bars, runs, barSpans };
}

/** Height a laid-out expression occupies: the text plus its stacked bars. */
export function exprTextHeight(layout: ExprLayout, fontPx: number): number {
  return fontPx * (1 + layout.bars * 0.22);
}

/** Paints a layout with its text's vertical middle at y, starting at x, in
 *  the font it was laid out in. */
export function paintExprText(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: ExprLayout,
  x: number,
  y: number,
  fontPx: number,
  color: string,
): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  for (const r of layout.runs) ctx.fillText(r.text, x + r.x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, theme.strokes.min);
  ctx.beginPath();
  for (const b of layout.barSpans) {
    // The first bar sits where the K-map puts a literal's; each level above
    // clears the one below it.
    const by = y - fontPx * (0.62 + (b.level - 1) * 0.22);
    ctx.moveTo(x + b.x0 + 0.5, by);
    ctx.lineTo(x + b.x1 - 0.5, by);
  }
  ctx.stroke();
}

export function exprFont(theme: Theme, fontPx: number): string {
  return `${fontPx}px ${theme.fonts.mono}`;
}
