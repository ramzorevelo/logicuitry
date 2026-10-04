// DIP package glyph: the body a student holds, drawn the way its datasheet
// draws it -- pin 1 at the top left, numbers running down the left side and
// back up the right, notch at the top. Used for chip instances whose def
// carries `appearance.package`; every other chip keeps the generic box.

import type { Rect, Vec2 } from '../scene';
import { type SignalState, type Theme } from '../theme';
import {
  drawStub,
  drawUprightText,
  measureMonoText,
  withPlacement,
  type GeometryInput,
  type Placement,
  type ResolvedPin,
  type SymbolGeometry,
} from './symbol';
import { bodyRectPath, paintBody } from './relief';

/** Stub length: long enough for a two-digit pin number to sit over it. */
const STUB = 2; // * G
const ROW_PITCH = 2; // * G
const NOTCH_R = 0.75; // * G
/** Clear lane down the middle for the part number, as a fraction of its font
 *  size: a rotated line costs its cap height in width, not its length. */
const NAME_LANE = 0.8;
/** Every package is one body width, as every real 300-mil DIP is: a part's
 *  pin names are fitted to the body, never the body to its longest name. */
const BODY_W = 9; // * G
/** Pin name inset from the body edge. */
const NAME_INSET = 0.6; // * G

export interface DipLayout {
  g: number;
  width: number;
  height: number;
  boxLeft: number;
  boxRight: number;
  nameFontPx: number;
  /** Centre of the body, where the part number runs along the long axis. */
  bodyCenter: Vec2;
  /** Pin rows top to bottom, paired left/right, in package pin order. */
  left: DipRow[];
  right: DipRow[];
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export interface DipRow {
  pin: ResolvedPin;
  number: number;
  y: number;
  /** The name as printed: an active-low `/X` reads as X under a bar. */
  text: string;
  bar: boolean;
  /** At or below the glyph text size, whatever fits the name's column. */
  fontPx: number;
}

/** `/BI_RBO` is the datasheet's BI/RBO under one bar; the slash prefix is
 *  only how a pin name can say "active low" in plain text. */
export function dipPinText(name: string): { text: string; bar: boolean } {
  return name.startsWith('/')
    ? { text: name.slice(1).replace(/_/g, '/'), bar: true }
    : { text: name, bar: false };
}

/** Pin count a package name declares, e.g. 'DIP14' -> 14. */
export function dipPinCount(pkg: string): number {
  return Number.parseInt(pkg.replace(/\D/g, ''), 10);
}

export function isDipPackage(pkg: string | undefined): boolean {
  return pkg !== undefined && /^DIP\d+$/.test(pkg) && dipPinCount(pkg) % 2 === 0;
}

/**
 * A DIP's pin order is physical, not electrical: the def lists its boundary
 * pins in package order, so index 0..n/2-1 run down the left and the rest come
 * back up the right. That is the whole point of the symbol, so the in-left /
 * out-right split the generic box uses is deliberately ignored here.
 */
export function dipLayout(input: GeometryInput, theme: Theme): DipLayout {
  const g = theme.gridSchematic;
  const fontPx = theme.glyphText;
  const nameFontPx = theme.glyphText;
  const ordered = [...input.pins].sort((a, b) => a.order - b.order);
  const perSide = Math.ceil(ordered.length / 2);

  // A full row of body above pin 1 and below the last pin, so the package sits
  // symmetrically on its own pin rows rather than hanging off the top one.
  const END_PAD = ROW_PITCH * g;
  const rowY = (i: number) => END_PAD + i * ROW_PITCH * g;
  // Each name gets the half body left beside the part number's lane.
  const column = (BODY_W * g - NAME_LANE * nameFontPx) / 2 - NAME_INSET * g;
  const row = (pin: ResolvedPin, number: number, y: number): DipRow => {
    const { text, bar } = dipPinText(pin.label ?? pin.name);
    const fit = column / measureMonoText(text, 1);
    return { pin, number, y, text, bar, fontPx: Math.min(fontPx, fit) };
  };
  const left = ordered.slice(0, perSide).map((pin, i) => row(pin, i + 1, rowY(i)));
  const right = ordered
    .slice(perSide)
    .reverse()
    .map((pin, i) => row(pin, ordered.length - i, rowY(i)));

  const boxLeft = STUB * g;
  const boxRight = boxLeft + BODY_W * g;
  const width = boxRight + STUB * g;
  const height = perSide * ROW_PITCH * g + END_PAD;

  const pins = new Map<string, Vec2>();
  for (const r of left) pins.set(r.pin.name, { x: 0, y: r.y });
  for (const r of right) pins.set(r.pin.name, { x: width, y: r.y });

  return {
    g,
    width,
    height,
    boxLeft,
    boxRight,
    nameFontPx,
    bodyCenter: { x: (boxLeft + boxRight) / 2, y: height / 2 },
    left,
    right,
    bounds: { x: 0, y: 0, w: width, h: height },
    pins,
  };
}

export function dipGeometry(input: GeometryInput, theme: Theme): SymbolGeometry {
  const l = dipLayout(input, theme);
  return { bounds: l.bounds, pins: l.pins };
}

export function drawDip(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  pinState?: (pinName: string) => SignalState | undefined,
  tint?: { body?: string | undefined; border?: string | undefined },
): void {
  const l = dipLayout(input, theme);
  const g = l.g;
  withPlacement(ctx, l.bounds, placement, () => {
    const box = { x: l.boxLeft, y: 0, w: l.boxRight - l.boxLeft, h: l.height };
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, box), {
      rect: box,
      tint: tint?.body,
      outline: tint?.border,
    });

    // Pin-1 notch, top centre: the one mark that tells you which way round the
    // package goes, and the mistake it prevents is the classic one.
    ctx.beginPath();
    ctx.arc(l.bodyCenter.x, 0, NOTCH_R * g, 0, Math.PI);
    ctx.fillStyle = theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.min;
    ctx.stroke();

    for (const [side, rows] of [
      ['left', l.left],
      ['right', l.right],
    ] as const) {
      const isLeft = side === 'left';
      for (const row of rows) {
        const tipX = isLeft ? 0 : l.width;
        const edgeX = isLeft ? l.boxLeft : l.boxRight;
        drawStub(
          ctx,
          theme,
          { x: edgeX, y: row.y },
          { x: tipX, y: row.y },
          pinState?.(row.pin.name),
        );

        ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
        ctx.fillStyle = theme.colors.ink;
        // Number outside over the stub, signal name inside the body: the
        // datasheet connection diagram's own arrangement.
        drawUprightText(
          ctx,
          placement,
          String(row.number),
          { x: (tipX + edgeX) / 2, y: row.y - g * 0.6 },
          { x: 0, y: 0 },
        );
        const inset = g * NAME_INSET;
        const textW = measureMonoText(row.text, row.fontPx);
        ctx.font = `${row.fontPx}px ${theme.fonts.mono}`;
        drawUprightText(
          ctx,
          placement,
          row.text,
          {
            x: isLeft ? edgeX + inset + textW / 2 : edgeX - inset - textW / 2,
            y: row.y + row.fontPx * 0.1,
          },
          { x: 0, y: 0 },
          row.bar ? { overbarPx: row.fontPx } : undefined,
        );
      }
    }

    // Part number down the body's long axis, clear of the notch, reading top
    // to bottom. The whole label turns with the package the way real printing
    // does, so it is not routed through drawUprightText, whose job is the
    // opposite: keeping text screen-upright.
    ctx.font = `${l.nameFontPx}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    ctx.save();
    ctx.translate(l.bodyCenter.x, l.bodyCenter.y);
    if (placement.mirror) ctx.scale(-1, 1);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.name ?? '', 0, 0);
    ctx.restore();
  });
}
