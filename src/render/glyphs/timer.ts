// 555 timer: a schematic box with the NE555 pin number on each stub and the
// part's R, C and resulting timing printed on the body.

import type { Rect, Vec2 } from '../scene';
import type { SignalState, Theme } from '../theme';
import type { Params } from '../../core/sim/primitives/types';
import {
  TIMER_PIN_NUMBERS,
  timerIntervals,
  timerMode,
  timerValues,
} from '../../core/sim/primitives/timer555';
import { formatEngineering } from '../../core/value/engineering';
import { formatTimePs } from '../waveform';
import { bodyRectPath, paintBody } from './relief';
import {
  drawBubble,
  drawStub,
  drawUprightText,
  measureMonoText,
  namePlacement,
  registerGlyphGeometry,
  textRowH,
  withPlacement,
  type GeometryInput,
  type Placement,
  type ResolvedPin,
} from './symbol';

/** The widest value line any mode prints: the body is sized to it so a live
 *  retime never moves a pin and reroutes the board. */
const VALUE_TEMPLATE = 'R1 9.99 kΩ  R2 9.99 kΩ';
const NUMBER_SCALE = 0.8;

/** Mode, then the values and the timing they give, as the body prints them. */
export function timerBodyLines(params: Params): string[] {
  const mode = timerMode(params);
  const { r1, r2, c } = timerValues(params);
  const iv = timerIntervals(params);
  const ohms = (r: number) => formatEngineering(r, 'Ω');
  const farads = formatEngineering(c, 'F');
  if (mode === 'astable') {
    const hz = formatEngineering(1e12 / (iv.highPs + iv.lowPs), 'Hz', 0);
    return [mode, `R1 ${ohms(r1)}  R2 ${ohms(r2)}`, `C ${farads}  f ${hz}`];
  }
  if (mode === 'monostable')
    return [mode, `R ${ohms(r1)}  C ${farads}`, `tw ${formatTimePs(iv.pulsePs)}`];
  return [mode];
}

export interface TimerLayout {
  g: number;
  rowPitch: number;
  nameFontPx: number;
  headerH: number;
  boxLeft: number;
  boxRight: number;
  width: number;
  height: number;
  left: (ResolvedPin & { y: number })[];
  outY: number;
  lines: string[];
  linesTop: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export function timerLayout(input: GeometryInput, theme: Theme): TimerLayout {
  const g = theme.gridSchematic;
  const rowPitch = textRowH(g, theme.glyphText);
  const nameFontPx = theme.glyphText * 1.15;
  const headerH = Math.max(g, Math.ceil((nameFontPx + 0.5 * g) / g) * g);
  const firstPinY = headerH + rowPitch;
  const left = input.pins
    .filter((p) => p.dir === 'in')
    .sort((a, b) => a.order - b.order)
    .map((p, i) => ({ ...p, y: firstPinY + i * rowPitch }));
  const lines = timerBodyLines(input.params);
  const rows = Math.max(left.length, 1);
  const linesTop = firstPinY + rows * rowPitch;
  const height = linesTop + Math.max(0, lines.length - 1) * rowPitch + g;
  const labelW = left.reduce(
    (w, p) => Math.max(w, measureMonoText(p.label ?? p.name, theme.glyphText)),
    0,
  );
  const contentW = Math.max(
    measureMonoText(VALUE_TEMPLATE, theme.glyphText),
    labelW + measureMonoText('OUT', theme.glyphText) + g,
  );
  const bodyW = Math.ceil(contentW / g) * g + 2 * g;
  const boxLeft = 2 * g;
  const boxRight = boxLeft + bodyW;
  const width = boxRight + 2 * g;
  const pins = new Map<string, Vec2>();
  for (const p of left) pins.set(p.name, { x: 0, y: p.y });
  pins.set('out', { x: width, y: firstPinY });
  return {
    g,
    rowPitch,
    nameFontPx,
    headerH,
    boxLeft,
    boxRight,
    width,
    height,
    left,
    outY: firstPinY,
    lines,
    linesTop,
    bounds: { x: 0, y: 0, w: width, h: height },
    pins,
  };
}

registerGlyphGeometry('timer555', (input, theme) => {
  const l = timerLayout(input, theme);
  return { bounds: l.bounds, pins: l.pins };
});

function drawPinNumber(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
  pin: string,
  at: Vec2,
): void {
  const n = TIMER_PIN_NUMBERS[pin];
  if (n === undefined) return;
  ctx.font = `${theme.glyphText * NUMBER_SCALE}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.muted;
  drawUprightText(ctx, placement, String(n), at, { x: 0, y: -1 });
}

export function drawTimer(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  stateOf: (pin: string) => SignalState | undefined,
  instanceName?: string,
): void {
  const l = timerLayout(input, theme);
  const g = l.g;
  withPlacement(ctx, l.bounds, placement, () => {
    const box = { x: l.boxLeft, y: 0, w: l.boxRight - l.boxLeft, h: l.height };
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, box), { rect: box });
    const midX = (l.boxLeft + l.boxRight) / 2;
    ctx.font = `${l.nameFontPx}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    drawUprightText(ctx, placement, '555', { x: midX, y: l.headerH / 2 }, { x: 0, y: 0 });

    for (const p of l.left) {
      drawStub(ctx, theme, { x: l.boxLeft, y: p.y }, { x: 0, y: p.y }, stateOf(p.name));
      if (p.activeLow) drawBubble(ctx, theme, { x: l.boxLeft - g / 2, y: p.y }, g);
      drawPinNumber(ctx, theme, placement, p.name, { x: 0.75 * g, y: p.y - 0.25 * g });
      ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
      ctx.fillStyle = theme.colors.ink;
      drawUprightText(
        ctx,
        placement,
        p.label ?? p.name,
        { x: l.boxLeft + 0.5 * g, y: p.y },
        { x: 1, y: 0 },
        p.activeLow ? { overbarPx: theme.glyphText } : undefined,
      );
    }
    drawStub(ctx, theme, { x: l.boxRight, y: l.outY }, { x: l.width, y: l.outY }, stateOf('out'));
    drawPinNumber(ctx, theme, placement, 'out', { x: l.width - 0.75 * g, y: l.outY - 0.25 * g });
    ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    drawUprightText(ctx, placement, 'OUT', { x: l.boxRight - 0.5 * g, y: l.outY }, { x: -1, y: 0 });

    l.lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? theme.colors.muted : theme.colors.accent2;
      drawUprightText(
        ctx,
        placement,
        line,
        { x: midX, y: l.linesTop + i * l.rowPitch },
        { x: 0, y: 0 },
      );
    });

    if (instanceName) {
      const { anchor, inward } = namePlacement(
        l.bounds,
        { top: false, bottom: false, left: true, right: true },
        g,
        instanceName,
        l.nameFontPx,
        input.nameOffset,
      );
      ctx.font = `${l.nameFontPx}px ${theme.fonts.mono}`;
      ctx.fillStyle = theme.colors.ink;
      drawUprightText(ctx, placement, instanceName, anchor, inward);
    }
  });
}
