// Rectangular box glyphs: ChipDef instances,
// dff, dlatch, register, mux -- everything sequential/packaged. Also the
// collapsed-bus wire glyph, which isn't a component at all, just
// a drawing convention over a bus-width wire.
//
// Pin rows run at 2G pitch below a reserved header band rounded up to whole
// grid rows (>= the name height plus clearance), so every pin lands on a grid
// intersection and the name never collides with a pin label.

import type { Rect, Vec2 } from '../scene';
import { signalStyle, type SignalState, type Theme } from '../theme';
import {
  drawBubble,
  drawStub,
  drawUprightText,
  measureMonoText,
  namePlacement,
  registerGlyphGeometry,
  snap,
  strokeMixedPass,
  textRowH,
  withPlacement,
  type GeometryInput,
  type Placement,
  type ResolvedPin,
  type SymbolGeometry,
} from './symbol';
import { bodyRectPath, paintBody } from './relief';

const BOX_KINDS = [
  'chip',
  'dff',
  'dlatch',
  'register',
  'mux',
  'demux',
  'decoder',
  'encoder',
] as const;

// Fixed 1G bubble diameter for box async pins: one bubble size, everywhere,
// always -- same as the gate output bubble.
const BOX_BUBBLE_SCALE = 1; // * G

// mux/demux/decoder/encoder share one minimum body width so none of them
// visibly resizes as pinView expand/collapse toggles change label content
// (content that genuinely needs more room -- many expanded lines with
// bracket labels, a wide select span -- still grows past this floor).
const CODER_KINDS: ReadonlySet<string> = new Set(['mux', 'demux', 'decoder', 'encoder']);
const CODER_MIN_BODY_W = 8; // * G

/** A lane-expanded bit's display text (`d0[3]`) when set, else the plain
 *  wiring name -- `pins.set()`/wire hit-testing always use `.name`, never
 *  this, so a label is display-only. */
function pinLabelText(p: ResolvedPin): string {
  return p.label ?? p.name;
}

export interface BoxPinLayout extends ResolvedPin {
  y: number; // local y of the pin's box-edge point (pre-stub); for top/bottom
  // edge pins this is the fixed edge y (0 or height) -- see `x` below.
  x?: number; // local x of the pin's box-edge point; only set for top/bottom
  // pins (left/right pins sit at the fixed boxLeft/boxRight edge instead).
}

export interface BoxLayout {
  name: string;
  g: number;
  width: number;
  height: number;
  headerH: number; // reserved top band the name sits in, clear of the first pin row
  footerH: number; // reserved bottom band, clear of the last data pin row --
  // sized like headerH whenever select pins occupy either edge (their
  // rotated labels need the same clearance a header name does).
  nameAtBottom: boolean; // true when selSide:'top' displaces the name out of
  // the header band (now occupied by select-pin labels) into the footer.
  nameFontPx: number;
  boxLeft: number; // local x of the box's left edge (1G in, for the stub)
  boxRight: number; // local x of the box's right edge
  left: BoxPinLayout[]; // input pins, top to bottom
  right: BoxPinLayout[]; // output pins, top to bottom
  top: BoxPinLayout[]; // select-role pins routed to the top edge (selSide)
  bottom: BoxPinLayout[]; // select-role pins routed to the bottom edge (default)
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** Select-role pins (mux/demux) route to the bottom edge by default, or the
 *  top edge when `selSide: 'top'` -- everything else (data, clock, enable,
 *  async set/clear) keeps the left/right in/out split. */
export function boxLayout(input: GeometryInput, theme: Theme): BoxLayout {
  const g = theme.gridSchematic;
  const name = input.name ?? input.kind;
  const selSide = input.params['selSide'] === 'top' ? 'top' : 'bottom';
  // Select lines read as a binary number left-to-right, so the MSB sits
  // leftmost: s(k-1) .. s0. Electrical order is untouched (s0 is still the
  // LSB); only the edge placement is reversed.
  const selectPins = input.pins
    .filter((p) => p.role === 'select')
    .sort((a, b) => b.order - a.order);
  const left = input.pins
    .filter((p) => p.dir === 'in' && p.role !== 'select')
    .sort((a, b) => a.order - b.order);
  const right = input.pins.filter((p) => p.dir === 'out').sort((a, b) => a.order - b.order);
  const rows = Math.max(left.length, right.length, 1);

  // Row pitch tracks the pin-label size, not a literal 2G: at presentation
  // scale a fixed 2G row is shorter than the text in it and adjacent pin
  // labels collide. Identical to 2G at the default 13px text.
  const rowPitch = textRowH(g, theme.glyphText);
  // Select lines run along the bottom/top edge, so their pitch is horizontal,
  // but the same rule applies and the same number keeps the two axes agreeing.
  const selPitch = rowPitch;
  const nameFontPx = theme.glyphText * 1.15; // one step above pin-label size, per §5
  const nameWidth = measureMonoText(name, nameFontPx);
  // Width fits both the header name and the widest facing pin-label pair with
  // a 1G gap between them (labels sit INSIDE the box, 0.5G inset from their
  // edge), rounded up to grid + 1G padding per side.
  const labelW = (list: ResolvedPin[]) =>
    list.reduce((w, p) => Math.max(w, measureMonoText(pinLabelText(p), theme.glyphText)), 0);
  const contentWidth = Math.max(2 * g, nameWidth, labelW(left) + labelW(right) + g);
  // Select pins need their own on-grid pitch along the bottom/top edge; grow
  // the body to fit them (2G pitch, 1G-equivalent margin either side) if the
  // label-driven width isn't already wide enough.
  const selSpan = selectPins.length > 0 ? selPitch * (selectPins.length + 1) : 0;
  const coderFloor = CODER_KINDS.has(input.kind) ? CODER_MIN_BODY_W * g : 0;
  const bodyW = Math.max(Math.ceil(contentWidth / g) * g + 2 * g, selSpan, coderFloor);

  // Header band tall enough to hold a name one step above the 13px text floor
  // with clearance from the top stroke; a literal 1G (8px) band cannot, so the
  // reserved band rounds up to whole grid rows and the first pin row starts one
  // pitch (2G) below it (labels never collide with the name).
  const headerH = Math.max(g, Math.ceil((nameFontPx + 0.5 * g) / g) * g);
  const firstPinY = headerH + rowPitch;
  // Select pins (either edge) need the same clearance from the last data
  // row that the header band already gives the first -- a plain 1G margin
  // puts their rotated label right up against it.
  const footerH = selectPins.length > 0 ? headerH : g;
  const nameAtBottom = selSide === 'top' && selectPins.length > 0;
  const height = firstPinY + Math.max(0, rows - 1) * rowPitch + footerH;

  const boxLeft = 2 * g; // pin stub length is one pitch (2G) everywhere
  const width = boxLeft + bodyW + 2 * g;
  const boxRight = boxLeft + bodyW;

  const withY = (list: ResolvedPin[]): BoxPinLayout[] =>
    list.map((p, i) => ({ ...p, y: firstPinY + i * rowPitch }));
  const leftLaid = withY(left);
  const rightLaid = withY(right);

  // Select pins centered along the body, on-grid pitch (2G); the stub extends
  // one more pitch beyond the box edge (topStub/bottomStub below).
  const selMargin =
    selectPins.length > 0 ? snap((bodyW - (selectPins.length - 1) * selPitch) / 2, g) : 0;
  const selY = selSide === 'top' ? 0 : height;
  const selLaid: BoxPinLayout[] = selectPins.map((p, i) => ({
    ...p,
    x: boxLeft + selMargin + i * selPitch,
    y: selY,
  }));
  const topLaid = selSide === 'top' ? selLaid : [];
  const bottomLaid = selSide === 'bottom' ? selLaid : [];
  const topStub = topLaid.length > 0 ? 2 * g : 0;
  const bottomStub = bottomLaid.length > 0 ? 2 * g : 0;

  const pins = new Map<string, Vec2>();
  for (const p of leftLaid) pins.set(p.name, { x: 0, y: p.y });
  for (const p of rightLaid) pins.set(p.name, { x: width, y: p.y });
  for (const p of topLaid) pins.set(p.name, { x: p.x!, y: -topStub });
  for (const p of bottomLaid) pins.set(p.name, { x: p.x!, y: height + bottomStub });

  return {
    name,
    g,
    width,
    height,
    headerH,
    footerH,
    nameAtBottom,
    nameFontPx,
    boxLeft,
    boxRight,
    left: leftLaid,
    right: rightLaid,
    top: topLaid,
    bottom: bottomLaid,
    bounds: { x: 0, y: -topStub, w: width, h: height + topStub + bottomStub },
    pins,
  };
}

function toGeometry(layout: BoxLayout): SymbolGeometry {
  return { bounds: layout.bounds, pins: layout.pins };
}

for (const kind of BOX_KINDS) {
  registerGlyphGeometry(kind, (input, theme) => toGeometry(boxLayout(input, theme)));
}

/** Constant's "name" is its value rendered 0x2F-style (glyph doc §4). */
export function constantLabel(params: GeometryInput['params']): string {
  const raw = params['value'];
  const value = typeof raw === 'number' ? raw : 0;
  return `0x${value.toString(16).toUpperCase()}`;
}

const withConstantName = (input: GeometryInput): GeometryInput => ({
  ...input,
  name: constantLabel(input.params),
});

registerGlyphGeometry('constant', (input, theme) =>
  toGeometry(boxLayout(withConstantName(input), theme)),
);

export function drawConstant(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  pinState?: (pinName: string) => SignalState | undefined,
): void {
  drawBox(ctx, theme, withConstantName(input), placement, pinState);
}

/** Open (stroked, surface-backed, never filled) clock wedge: base 1G on the
 *  box edge, depth 1G pointing inward. */
function drawClockWedge(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  edgeX: number,
  y: number,
  fromLeft: boolean,
): void {
  const g = theme.gridSchematic;
  const dir = fromLeft ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(edgeX, y - g / 2);
  ctx.lineTo(edgeX + dir * g, y);
  ctx.lineTo(edgeX, y + g / 2);
  ctx.fillStyle = theme.colors.surface;
  ctx.fill();
  ctx.strokeStyle = theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.stroke();
}

function drawPinLabel(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
  text: string,
  x: number,
  y: number,
  inward: Vec2,
): void {
  ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.ink;
  drawUprightText(ctx, placement, text, { x, y }, inward);
}

/** Draw a chip/dff/dlatch/register/mux box at a placement. `pinState` looks
 *  up a live signal for a pin name, for future wire-color-matched debugging;
 *  the box body itself never recolors (§1). */
export function drawBox(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  pinState?: (pinName: string) => SignalState | undefined,
  // P0.6 (M4.2): a chip instance whose ChipDef can't be resolved (missing/not
  // yet loaded def, e.g. a "My chips" ghost racing chipLib) degrades to a
  // dashed '?' placeholder box instead of throwing through the render loop.
  placeholder?: boolean,
  // Task 1c: the INSTANCE's own name, drawn outside the box (a chip
  // instance keeps its def name inside, per layout.name above, and gets
  // this outside too; mux/demux/decoder/encoder only ever have this one).
  instanceName?: string,
  // A packaged chip's stored colours (ChipDef.appearance), each already
  // resolved against this theme -- undefined for every built-in box.
  tint?: { body?: string | undefined; border?: string | undefined },
): void {
  const layout = boxLayout(input, theme);
  withPlacement(ctx, layout.bounds, placement, () => {
    if (placeholder) ctx.setLineDash([4, 3]);
    const box = {
      x: layout.boxLeft,
      y: 0,
      w: layout.boxRight - layout.boxLeft,
      h: layout.height,
    };
    paintBody(ctx, theme, () => bodyRectPath(ctx, theme, box), {
      rect: box,
      tint: tint?.body,
      outline: tint?.border,
    });
    if (placeholder) ctx.setLineDash([]);

    // Name centered in its reserved band -- the header (top) normally, or
    // the footer (bottom) when select pins displaced it there (selSide:
    // 'top' -- the two labels would otherwise overlap).
    ctx.font = `${layout.nameFontPx}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.ink;
    const nameY = layout.nameAtBottom ? layout.height - layout.footerH / 2 : layout.headerH / 2;
    drawUprightText(
      ctx,
      placement,
      placeholder ? '?' : layout.name,
      { x: (layout.boxLeft + layout.boxRight) / 2, y: nameY },
      { x: 0, y: 0 },
    );

    // Pin labels sit INSIDE the box, 0.5G inset from their edge (KiCad
    // convention: the space outside a pin belongs to the wire entering it).
    // A clock pin's label steps past the 1G wedge to keep §5 clearance.
    const g = layout.g;
    for (const p of layout.left) {
      const edge = { x: layout.boxLeft, y: p.y };
      const tip = { x: 0, y: p.y };
      drawStub(ctx, theme, edge, tip, pinState?.(p.name));
      if (p.role === 'clock') drawClockWedge(ctx, theme, layout.boxLeft, p.y, true);
      if (p.role === 'asyncSet' || p.role === 'asyncClear') {
        const d = BOX_BUBBLE_SCALE * g;
        drawBubble(ctx, theme, { x: layout.boxLeft - d / 2, y: p.y }, d);
      }
      const inset = p.role === 'clock' ? 1.5 * g : 0.5 * g;
      drawPinLabel(ctx, theme, placement, pinLabelText(p), layout.boxLeft + inset, p.y, {
        x: 1,
        y: 0,
      });
    }
    for (const p of layout.right) {
      const edge = { x: layout.boxRight, y: p.y };
      const tip = { x: layout.width, y: p.y };
      drawStub(ctx, theme, edge, tip, pinState?.(p.name));
      if (p.role === 'clock') drawClockWedge(ctx, theme, layout.boxRight, p.y, false);
      if (p.role === 'asyncSet' || p.role === 'asyncClear') {
        const d = BOX_BUBBLE_SCALE * g;
        drawBubble(ctx, theme, { x: layout.boxRight + d / 2, y: p.y }, d);
      }
      const inset = p.role === 'clock' ? 1.5 * g : 0.5 * g;
      drawPinLabel(ctx, theme, placement, pinLabelText(p), layout.boxRight - inset, p.y, {
        x: -1,
        y: 0,
      });
    }
    // Select-role pins (mux/demux): bottom edge by default, top when
    // selSide: 'top'. Labels rotate 90 deg to fit the vertical stub's narrow
    // pitch, inset 0.5G into the box from the edge they sit on.
    for (const p of layout.top) {
      const edge = { x: p.x!, y: 0 };
      const tip = { x: p.x!, y: -2 * g };
      drawStub(ctx, theme, edge, tip, pinState?.(p.name));
      drawPinLabel(ctx, theme, placement, pinLabelText(p), p.x!, 0.5 * g, { x: 0, y: 1 });
    }
    for (const p of layout.bottom) {
      const edge = { x: p.x!, y: layout.height };
      const tip = { x: p.x!, y: layout.height + 2 * g };
      drawStub(ctx, theme, edge, tip, pinState?.(p.name));
      drawPinLabel(ctx, theme, placement, pinLabelText(p), p.x!, layout.height - 0.5 * g, {
        x: 0,
        y: -1,
      });
    }
    if (instanceName) {
      const { anchor, inward } = namePlacement(
        layout.bounds,
        {
          top: layout.top.length > 0,
          bottom: layout.bottom.length > 0,
          left: layout.left.length > 0,
          right: layout.right.length > 0,
        },
        g,
        instanceName,
        layout.nameFontPx,
        input.nameOffset,
      );
      ctx.font = `${layout.nameFontPx}px ${theme.fonts.mono}`;
      ctx.fillStyle = theme.colors.ink;
      drawUprightText(ctx, placement, instanceName, anchor, inward);
    }
  });
}

// --- Collapsed bus glyph: a drawing convention over a bus-width wire, not a
// component -- no placement/rotation, just two endpoints on the schematic. ---

export interface BusSlashGeometry {
  slashA: Vec2;
  slashB: Vec2;
  badgePos: Vec2;
}

/** Pure geometry for the diagonal slash + bit-count badge near a bus wire's
 *  midpoint, so the draw call and tests share one derivation. */
export function busSlashGeometry(a: Vec2, b: Vec2, g: number): BusSlashGeometry {
  const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular unit vector, for the slash mark and badge offset.
  const px = -uy;
  const py = ux;
  const slashHalf = 0.4 * g;
  const slashA: Vec2 = {
    x: mid.x - ux * slashHalf + px * slashHalf,
    y: mid.y - uy * slashHalf + py * slashHalf,
  };
  const slashB: Vec2 = {
    x: mid.x + ux * slashHalf - px * slashHalf,
    y: mid.y + uy * slashHalf - py * slashHalf,
  };
  const badgePos: Vec2 = { x: mid.x + px * g, y: mid.y + py * g };
  return { slashA, slashB, badgePos };
}

export function drawCollapsedBus(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  a: Vec2,
  b: Vec2,
  bitWidth: number,
  state?: SignalState,
): void {
  const g = theme.gridSchematic;
  const style = state ? signalStyle(theme, state) : undefined;
  ctx.strokeStyle = style?.color ?? theme.colors.ink;
  ctx.lineWidth = theme.strokes.bus;
  ctx.setLineDash(style?.dashed ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  if (style?.alt) strokeMixedPass(ctx, style.alt);
  ctx.setLineDash([]);

  const { slashA, slashB, badgePos } = busSlashGeometry(a, b, g);
  ctx.strokeStyle = theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.beginPath();
  ctx.moveTo(slashA.x, slashA.y);
  ctx.lineTo(slashB.x, slashB.y);
  ctx.stroke();

  ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(bitWidth), badgePos.x, badgePos.y);
}
