// Power rail symbols: VCC (bar over a stem, wire enters from below) and GND
// (three tapering bars under a stem, wire enters from above), and the pull-up
// and pull-down resistors to them. All are drawn in ink like any other body;
// only the stub color-codes the live signal.

import { signalStyle, type SignalState, type Theme } from '../theme';
import {
  drawStub,
  drawUprightText,
  measureMonoText,
  registerGlyphGeometry,
  textRowCenter,
  textRowH,
  type GeometryInput,
  type Placement,
  type SymbolGeometry,
  withPlacement,
} from './symbol';

/** Stem length between the pin tip and the first bar. */
const STEM = 2; // * G
/** Widest bar, and the symbol's minimum body width. */
const BAR = 2; // * G

export function railText(input: GeometryInput): string {
  return input.name ?? (input.kind === 'vcc' ? 'VCC' : 'GND');
}

interface RailLayout {
  g: number;
  cx: number;
  textY: number;
  barY: number;
  pinY: number;
  bounds: { x: number; y: number; w: number; h: number };
  pins: Map<string, { x: number; y: number }>;
}

/**
 * Text row, bar band and stem stack away from the pin, so the tip stays on the
 * grid whatever the text scale does. Width is rounded to a whole 2G so the
 * centre line -- which the stem, the bars and the pin all share -- is on grid.
 */
function railLayout(g: number, kind: string, text: string, fontPx: number): RailLayout {
  const rowH = textRowH(g, fontPx);
  const w = Math.max(BAR * 2 * g, Math.ceil(measureMonoText(text, fontPx) / (2 * g)) * 2 * g);
  const cx = w / 2;
  // VCC stacks text, bar, stem, pin from the top down. GND is the other way
  // up -- pin, stem, bars, text -- and reserves a further 1G for the two
  // narrower bars that taper below the first.
  const up = kind === 'vcc';
  const barY = up ? rowH : STEM * g;
  const pinY = up ? rowH + STEM * g : 0;
  const textY = up ? textRowCenter(g, rowH, 0) : (STEM + 1) * g + rowH / 2;
  const h = up ? rowH + STEM * g : (STEM + 1) * g + rowH;
  return {
    g,
    cx,
    textY,
    barY,
    pinY,
    bounds: { x: 0, y: 0, w, h },
    pins: new Map([['p', { x: cx, y: pinY }]]),
  };
}

function geometry(input: GeometryInput, theme: Theme): SymbolGeometry {
  const l = railLayout(theme.gridSchematic, input.kind, railText(input), theme.glyphText);
  return { bounds: l.bounds, pins: l.pins };
}

registerGlyphGeometry('vcc', geometry);
registerGlyphGeometry('gnd', geometry);

export function drawRail(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  const text = railText(input);
  const l = railLayout(theme.gridSchematic, input.kind, text, theme.glyphText);
  const g = l.g;
  const state = stateOf('p');
  withPlacement(ctx, l.bounds, placement, () => {
    drawStub(ctx, theme, { x: l.cx, y: l.barY }, { x: l.cx, y: l.pinY }, state);

    ctx.strokeStyle = state ? signalStyle(theme, state).color : theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    ctx.beginPath();
    if (input.kind === 'vcc') {
      ctx.moveTo(l.cx - BAR * g * 0.5, l.barY);
      ctx.lineTo(l.cx + BAR * g * 0.5, l.barY);
    } else {
      // Three bars tapering away from the stem, the conventional earth symbol.
      const step = g / 3;
      for (const [i, scale] of [1, 0.6, 0.25].entries()) {
        const y = l.barY + i * step;
        ctx.moveTo(l.cx - BAR * g * 0.5 * scale, y);
        ctx.lineTo(l.cx + BAR * g * 0.5 * scale, y);
      }
    }
    ctx.stroke();

    ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    drawUprightText(
      ctx,
      placement,
      text,
      // Same optical-centre nudge every other captioned glyph uses.
      { x: l.cx, y: l.textY + theme.glyphText * 0.1 },
      { x: 0, y: 0 },
    );
  });
}

/** Pin-side stem, long enough for the scene's bus badge beside it. */
const PULL_PIN_STEM = 2; // * G
const PULL_RAIL_STEM = 1; // * G
const RESISTOR = 3; // * G
const ZIGZAG_PEAKS = 6;

interface PullLayout {
  cx: number;
  pinY: number;
  /** Resistor ends, pin side first. */
  resPin: number;
  resRail: number;
  railY: number;
  bounds: { x: number; y: number; w: number; h: number };
  pins: Map<string, { x: number; y: number }>;
}

/** A resistor to a rail mark: pull-up has VCC's bar on top and the pin below,
 *  pull-down the pin on top and GND's bars below. Every length is a whole G so
 *  the pin tip stays on grid. */
function pullLayout(g: number, kind: string): PullLayout {
  const cx = BAR * g;
  const span = (PULL_PIN_STEM + RESISTOR + PULL_RAIL_STEM) * g;
  const up = kind === 'pullup';
  const pinY = up ? span : 0;
  const railY = up ? 0 : span;
  const dir = up ? -1 : 1;
  const resPin = pinY + dir * PULL_PIN_STEM * g;
  const resRail = resPin + dir * RESISTOR * g;
  // GND's two narrower bars taper 1G below the first.
  const h = up ? span : span + g;
  return {
    cx,
    pinY,
    resPin,
    resRail,
    railY,
    bounds: { x: 0, y: 0, w: 2 * cx, h },
    pins: new Map([['p', { x: cx, y: pinY }]]),
  };
}

function pullGeometry(input: GeometryInput, theme: Theme): SymbolGeometry {
  const l = pullLayout(theme.gridSchematic, input.kind);
  return { bounds: l.bounds, pins: l.pins };
}

registerGlyphGeometry('pullup', pullGeometry);
registerGlyphGeometry('pulldown', pullGeometry);

export function drawPull(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  stateOf: (pin: string) => SignalState | undefined,
): void {
  const g = theme.gridSchematic;
  const l = pullLayout(g, input.kind);
  const pinEnd = { x: l.cx, y: l.pinY };
  const resPinEnd = { x: l.cx, y: l.resPin };
  withPlacement(ctx, l.bounds, placement, () => {
    drawStub(ctx, theme, resPinEnd, pinEnd, stateOf('p'));

    // The resistor and rail are passive, so they stay in ink whatever the net carries.
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(l.cx, l.resPin);
    const step = (l.resRail - l.resPin) / ZIGZAG_PEAKS;
    for (let i = 0; i < ZIGZAG_PEAKS; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      ctx.lineTo(l.cx + side * 0.5 * g, l.resPin + (i + 0.5) * step);
    }
    ctx.lineTo(l.cx, l.resRail);
    ctx.lineTo(l.cx, l.railY);
    if (input.kind === 'pullup') {
      ctx.moveTo(l.cx - BAR * g * 0.5, l.railY);
      ctx.lineTo(l.cx + BAR * g * 0.5, l.railY);
    } else {
      for (const [i, scale] of [1, 0.6, 0.25].entries()) {
        const y = l.railY + (i * g) / 2;
        ctx.moveTo(l.cx - BAR * g * 0.5 * scale, y);
        ctx.lineTo(l.cx + BAR * g * 0.5 * scale, y);
      }
    }
    ctx.stroke();
  });
}
