// Primitive gate glyphs: ANSI/IEEE 91-1984
// distinctive shapes. Body proportions are literal to the standard's H-derived
// formulas -- only each pin's wire-attach tip is snapped onto the schematic
// grid (symbol.ts's snap()), since a few of those H-derived points don't land
// on a whole grid unit for every input count and the tip is what the editor's
// hit-test/wire-snap actually needs on-grid, not the decorative body curve.

import type { Rect, Vec2 } from '../scene';
import { paintBody } from './relief';
import type { SignalState, Theme } from '../theme';
import {
  drawBubble,
  drawStub,
  drawUprightText,
  namePlacement,
  registerGlyphGeometry,
  snap,
  withPlacement,
  type GeometryInput,
  type Placement,
  type SymbolGeometry,
} from './symbol';

export type GateKind = 'and' | 'or' | 'nand' | 'nor' | 'xor' | 'xnor' | 'not' | 'buf';
export const GATE_KINDS: readonly GateKind[] = [
  'and',
  'or',
  'nand',
  'nor',
  'xor',
  'xnor',
  'not',
  'buf',
];

const BUBBLE_KINDS: ReadonlySet<GateKind> = new Set(['not', 'nand', 'nor', 'xnor']);
const OR_FAMILY: ReadonlySet<GateKind> = new Set(['or', 'nor', 'xor', 'xnor']);
const AND_FAMILY: ReadonlySet<GateKind> = new Set(['and', 'nand']);

// Body silhouette frozen at the 4-input size; past that only the back edge
// extends to reach the outer pins, Logisim-style.
const BODY_MAX_N = 4;

export interface GateLayout {
  kind: GateKind;
  g: number;
  H: number; // pin span (bounds height)
  Hbody: number; // body silhouette height, <= H (frozen at BODY_MAX_N pitch)
  bodyY0: number; // local y where the body band starts ((H - Hbody) / 2)
  bodyX0: number; // local x where the base shape begins (2G in, for the input stub)
  bodyRightRaw: number; // raw (unsnapped) x of the base shape's tip/cap edge
  /** AND family only: the frozen cap radius and the local x where the flat
   *  top/bottom edges end and the cap begins -- 0 for every other kind. */
  andCapRadius: number;
  andRectRight: number;
  inputYs: { name: string; y: number; stubEndX: number; width: number }[];
  outputName: string;
  outputWidth: number;
  outputY: number; // snapped -- the shape's own convergence point
  outputTipX: number; // snapped -- the wire actually attaches here
  /** Every output pin's own row (width>1 pinView-expanded lanes fan out from
   *  the single convergence point above); length 1 and identical to
   *  outputName/outputY in the common unexpanded case. */
  outputYs: { name: string; y: number; width: number }[];
  bubble: boolean;
  bubbleDiameter: number;
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** x of the OR-family concave back arc at height y: the quadratic from
 *  (x0, 0) to (x0, H) with control (x0 + 0.3H, H/2) has linear y(t) = H*t,
 *  so x(y) = x0 + 0.6H*(1-t)t. Bows rightward by 0.15H at its deepest. */
export function orBackX(x0: number, H: number, y: number): number {
  const t = y / H;
  return x0 + 0.6 * H * (1 - t) * t;
}

/** Back-arc x over the full pin span: the body arc tiles every Hbody above
 *  and below the body band (the wavy Logisim-style extension), so folding y
 *  into the band gives wings and body from one formula. */
export function orBackXSpan(x0: number, Hbody: number, bodyY0: number, y: number): number {
  const folded = (((y - bodyY0) % Hbody) + Hbody) % Hbody;
  return orBackX(x0, Hbody, folded);
}

/** Local (unrotated/unmirrored) layout, the single source for both geometry
 *  registration and drawing so the two never drift apart. */
export function gateLayout(kind: GateKind, input: GeometryInput, theme: Theme): GateLayout {
  const g = theme.gridSchematic;
  const ins = input.pins.filter((p) => p.dir === 'in').sort((a, b) => a.order - b.order);
  const outs = input.pins.filter((p) => p.dir === 'out').sort((a, b) => a.order - b.order);
  const out = outs[0];
  if (!out) throw new Error(`gate '${kind}' has no output pin`);
  const nIn = Math.max(1, ins.length);
  const nOut = Math.max(1, outs.length);
  const n = Math.max(nIn, nOut);
  const H = 2 * Math.max(2, n) * g;
  const Hbody = 2 * Math.min(Math.max(2, n), BODY_MAX_N) * g;
  const bodyY0 = (H - Hbody) / 2;
  const bodyX0 = 2 * g; // one pin pitch (2G) reserved on the left for the input stubs

  const andCapRadius = AND_FAMILY.has(kind) ? Hbody / 2 : 0;
  const andRectRight = AND_FAMILY.has(kind) ? bodyX0 + 0.75 * Hbody : 0;

  const bodyRightRaw = AND_FAMILY.has(kind)
    ? andRectRight + andCapRadius
    : OR_FAMILY.has(kind)
      ? bodyX0 + 1.3 * Hbody
      : bodyX0 + 0.9 * Hbody; // not/buf triangle apex

  // params.outputBubble (bubble-push base form) widens the glyph exactly like
  // the composed kind, so entering/exiting bubble mode never shifts pins.
  const bubble = BUBBLE_KINDS.has(kind) || input.params['outputBubble'] === true;
  const bubbleDiameter = g; // fixed 1G, never scaled by input count
  const afterBubbleRaw = bubble ? bodyRightRaw + bubbleDiameter : bodyRightRaw;
  const outputTipX = snap(afterBubbleRaw + 2 * g, g);
  const outputY = snap(H / 2, g);

  // Rows at 2G pitch symmetric about the centerline: y = G(2i+1) when
  // H = 2G*n, recentred for n < 2 (NOT/BUF input lands on the output axis).
  const isXorFamily = kind === 'xor' || kind === 'xnor';
  const inputYs = ins.map((p, i) => {
    const y = H / 2 + (2 * i + 1 - nIn) * g;
    // Stubs end on the actual back silhouette: flat back (or its straight
    // wing extension) for the AND family and triangles, the tiled back arc
    // for OR (outer arc for XOR, never crossing between its two arcs).
    const stubEndX = OR_FAMILY.has(kind)
      ? orBackXSpan(isXorFamily ? bodyX0 - 0.15 * Hbody : bodyX0, Hbody, bodyY0, y)
      : bodyX0;
    return { name: p.name, y, stubEndX, width: p.width };
  });
  // A width>1 output pin expanded into several 1-bit lanes (M6.6 pinView)
  // needs its own row per lane, same as an input's arity does -- the shape
  // itself only ever converges to one tip point, so extra lanes fan out from
  // a vertical riser at that tip (drawGate), mirroring the AND family's own
  // wing-extension line on the input side.
  const outputYs = outs.map((p, i) => {
    const y = snap(H / 2 + (2 * i + 1 - nOut) * g, g);
    return { name: p.name, y, width: p.width };
  });
  const bounds: Rect = { x: 0, y: 0, w: outputTipX, h: H };

  const pins = new Map<string, Vec2>();
  for (const { name, y } of inputYs) pins.set(name, { x: 0, y });
  for (const { name, y } of outputYs) pins.set(name, { x: outputTipX, y });

  return {
    kind,
    g,
    H,
    Hbody,
    bodyY0,
    bodyX0,
    bodyRightRaw,
    andCapRadius,
    andRectRight,
    inputYs,
    outputName: out.name,
    outputWidth: out.width,
    outputYs,
    outputY,
    outputTipX,
    bubble,
    bubbleDiameter,
    bounds,
    pins,
  };
}

function toGeometry(layout: GateLayout): SymbolGeometry {
  return { bounds: layout.bounds, pins: layout.pins };
}

/** True for a buf stored as a bare inline bubble marker (params.bubbleOnly):
 *  same electrical component, drawn as just the 1G bubble on the wire instead
 *  of the full triangle body. */
export function isBareBubble(input: Pick<GeometryInput, 'kind' | 'params'>): boolean {
  return input.kind === 'buf' && input.params['bubbleOnly'] === true;
}

/** Bare-bubble local geometry: a 2G-square symbol, pins a/y on the horizontal
 *  midline at the left/right edges (both on grid), bubble centered between. */
export function bareBubbleGeometry(theme: Theme): SymbolGeometry {
  const g = theme.gridSchematic;
  return {
    bounds: { x: 0, y: 0, w: 2 * g, h: 2 * g },
    pins: new Map([
      ['a', { x: 0, y: g }],
      ['y', { x: 2 * g, y: g }],
    ]),
  };
}

for (const kind of GATE_KINDS) {
  registerGlyphGeometry(kind, (input, theme) =>
    isBareBubble(input) ? bareBubbleGeometry(theme) : toGeometry(gateLayout(kind, input, theme)),
  );
}

/** Stroke the tiled back-arc extension over [y0, y1] as a sampled polyline. */
function strokeOrWing(
  ctx: CanvasRenderingContext2D,
  x0: number,
  layout: GateLayout,
  y0: number,
  y1: number,
): void {
  const { Hbody, bodyY0 } = layout;
  const steps = Math.max(4, Math.ceil(((y1 - y0) / Hbody) * CURVE_SAMPLES));
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    const x = orBackXSpan(x0, Hbody, bodyY0, y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawGateBody(ctx: CanvasRenderingContext2D, theme: Theme, layout: GateLayout): void {
  const { kind, bodyX0, H, Hbody, bodyY0, bodyRightRaw: tipX } = layout;
  const yB = bodyY0 + Hbody; // body band bottom
  // Silhouette is teaching content: the dials only add fill, pattern and
  // relief on top of the exact path gateContainsLocalPoint mirrors.
  const silhouette = () => {
    if (kind === 'not' || kind === 'buf') {
      ctx.moveTo(bodyX0, bodyY0);
      ctx.lineTo(bodyX0, yB);
      ctx.lineTo(tipX, H / 2);
      ctx.closePath();
    } else if (AND_FAMILY.has(kind)) {
      // Flat back + semicircle cap; radius Hbody/2, so the cap always spans the
      // whole body band.
      const { andRectRight: rectRight, andCapRadius: capRadius } = layout;
      ctx.moveTo(bodyX0, bodyY0);
      ctx.lineTo(rectRight, bodyY0);
      ctx.arc(rectRight, H / 2, capRadius, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(bodyX0, yB);
      ctx.closePath();
    } else {
      // or/nor/xor/xnor: concave back, convex top/bottom converging to a point.
      ctx.moveTo(bodyX0, bodyY0);
      ctx.quadraticCurveTo(bodyX0 + 0.3 * Hbody, H / 2, bodyX0, yB);
      ctx.quadraticCurveTo(bodyX0 + Hbody, yB, tipX, H / 2);
      ctx.quadraticCurveTo(bodyX0 + Hbody, bodyY0, bodyX0, bodyY0);
      ctx.closePath();
    }
  };
  paintBody(ctx, theme, silhouette);

  // Back-edge wings past the frozen body carry the outer pins (arity >= 5):
  // straight for AND, tiled arcs for the OR family.
  if (bodyY0 > 0) {
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    if (OR_FAMILY.has(kind)) {
      strokeOrWing(ctx, bodyX0, layout, 0, bodyY0);
      strokeOrWing(ctx, bodyX0, layout, yB, H);
    } else {
      ctx.beginPath();
      ctx.moveTo(bodyX0, 0);
      ctx.lineTo(bodyX0, bodyY0);
      ctx.moveTo(bodyX0, yB);
      ctx.lineTo(bodyX0, H);
      ctx.stroke();
    }
  }

  if (kind === 'xor' || kind === 'xnor') {
    // The extra input-side curve XOR always carries: a second concave arc
    // parallel to and offset 0.15Hbody behind the first, per the doc.
    const extraX0 = bodyX0 - 0.15 * Hbody;
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    if (bodyY0 > 0) {
      strokeOrWing(ctx, extraX0, layout, 0, H);
    } else {
      ctx.beginPath();
      ctx.moveTo(extraX0, bodyY0);
      ctx.quadraticCurveTo(extraX0 + 0.3 * Hbody, H / 2, extraX0, yB);
      ctx.stroke();
    }
  }
}

/** Overrides the kind-derived bubble presence (bubble-push mode -- a gate
 *  there is always stored in base form with bubble state in params, so what's
 *  drawn can't be read off `kind` alone; see core/gates). Circuit workbench
 *  callers omit this and get today's kind-derived behavior. */
export interface GateBubbleOverrides {
  output?: boolean;
  /** Pin names (e.g. 'a','b') to draw an input-side bubble on. */
  inputs?: ReadonlySet<string>;
}

/** Where a bubble sits (or would sit) on each terminal, in LOCAL glyph
 *  coords: the output entry first, then every input in declaration order.
 *  drawGate consumes this same accessor, so draw and hit-test can never
 *  drift apart (A3). Anchors exist for every terminal regardless of whether
 *  a bubble is currently drawn there -- callers filter by bubble state. */
export interface BubbleAnchor {
  pin: string;
  center: Vec2;
  r: number;
}

export function bubbleAnchors(layout: GateLayout): BubbleAnchor[] {
  const d = layout.bubbleDiameter;
  const anchors: BubbleAnchor[] = [
    {
      pin: layout.outputName,
      center: { x: layout.bodyRightRaw + d / 2, y: layout.outputY },
      r: d / 2,
    },
  ];
  for (const { name, y, stubEndX } of layout.inputYs)
    anchors.push({ pin: name, center: { x: stubEndX - d / 2, y }, r: d / 2 });
  return anchors;
}

function quadPoint(p0: Vec2, cp: Vec2, p1: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p1.y,
  };
}

/** Even-odd ray-cast point-in-polygon (standard algorithm). */
function pointInPolygon(pt: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const crosses = a.y > pt.y !== b.y > pt.y;
    if (crosses && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const CURVE_SAMPLES = 16;

/** Shape-accurate hit-test: true when `pt` (local glyph coords) falls
 *  inside the gate's actual silhouette, not just its bbox --
 *  the AND/OR/NOT curves leave real corner gaps a bbox test wrongly claims.
 *  Mirrors drawGateBody's exact formulas (same constants); the bezier-bounded
 *  OR-family body is sampled into a polygon since there's no DOM Path2D
 *  available outside a browser (this stays Node-testable on purpose).
 *  Includes the output bubble circle when present, same as a real click
 *  landing on the bubble should count. */
export function gateContainsLocalPoint(
  layout: GateLayout,
  pt: Vec2,
  hasOutputBubble: boolean,
): boolean {
  const { kind, bodyX0, H, Hbody, bodyY0, bodyRightRaw: tipX } = layout;
  const yB = bodyY0 + Hbody;
  let inBody: boolean;
  if (kind === 'not' || kind === 'buf') {
    inBody = pointInPolygon(pt, [
      { x: bodyX0, y: bodyY0 },
      { x: bodyX0, y: yB },
      { x: tipX, y: H / 2 },
    ]);
  } else if (AND_FAMILY.has(kind)) {
    // Stadium cap: same shape drawGateBody strokes -- flat rect, then the
    // frozen-radius cap, with the corner nearest `pt` on the vertical run
    // (top/bottom corners test against the two quarter-circle centers).
    const { andRectRight: rectRight, andCapRadius: capRadius } = layout;
    if (pt.x <= rectRight) {
      inBody = pt.x >= bodyX0 && pt.y >= bodyY0 && pt.y <= yB;
    } else {
      const cy =
        pt.y < bodyY0 + capRadius
          ? bodyY0 + capRadius
          : pt.y > yB - capRadius
            ? yB - capRadius
            : pt.y;
      inBody = Math.hypot(pt.x - rectRight, pt.y - cy) <= capRadius;
    }
  } else {
    // or/nor/xor/xnor: same 3 quadratic curves drawGateBody strokes, sampled.
    const poly: Vec2[] = [];
    const back = [
      { x: bodyX0, y: bodyY0 },
      { x: bodyX0 + 0.3 * Hbody, y: H / 2 },
      { x: bodyX0, y: yB },
    ] as const;
    const bottom = [
      { x: bodyX0, y: yB },
      { x: bodyX0 + Hbody, y: yB },
      { x: tipX, y: H / 2 },
    ] as const;
    const top = [
      { x: tipX, y: H / 2 },
      { x: bodyX0 + Hbody, y: bodyY0 },
      { x: bodyX0, y: bodyY0 },
    ] as const;
    for (const [p0, cp, p1] of [back, bottom, top])
      for (let i = 0; i <= CURVE_SAMPLES; i++) poly.push(quadPoint(p0, cp, p1, i / CURVE_SAMPLES));
    inBody = pointInPolygon(pt, poly);
  }
  if (inBody) return true;
  if (hasOutputBubble) {
    const outAnchor = bubbleAnchors(layout)[0]!;
    if (Math.hypot(pt.x - outAnchor.center.x, pt.y - outAnchor.center.y) <= outAnchor.r)
      return true;
  }
  return false;
}

/** Draw the bare-bubble form (buf + params.bubbleOnly): just the 1G bubble
 *  inline on the wire, short stubs to the a/y pins. */
export function drawBareBubble(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
): void {
  const g = theme.gridSchematic;
  const geo = bareBubbleGeometry(theme);
  withPlacement(ctx, geo.bounds, placement, () => {
    drawStub(ctx, theme, { x: 0, y: g }, { x: g - g / 2, y: g });
    drawBubble(ctx, theme, { x: g, y: g }, g);
    drawStub(ctx, theme, { x: g + g / 2, y: g }, { x: 2 * g, y: g });
  });
}

/** Draw one of the 8 primitive gates at a placement. No caption -- per §2,
 *  the shape is the label. */
export function drawGate(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  kind: GateKind,
  input: GeometryInput,
  placement: Placement,
  bubbles?: GateBubbleOverrides,
  label?: string,
  state?: (pin: string) => SignalState | undefined,
): void {
  if (isBareBubble(input)) {
    drawBareBubble(ctx, theme, placement);
    return;
  }
  const layout = gateLayout(kind, input, theme);
  const anchors = bubbleAnchors(layout);
  const outAnchor = anchors[0]!;
  const hasOutputBubble = bubbles?.output ?? layout.bubble;
  withPlacement(ctx, layout.bounds, placement, () => {
    drawGateBody(ctx, theme, layout);
    if (label) {
      // A gate's pins are always left/right (gateLayout never puts any on
      // top/bottom), so it's never "boxed in" on all four sides -- the name
      // always sits above-center, per the shared rule.
      const { anchor, inward } = namePlacement(
        layout.bounds,
        { top: false, bottom: false, left: true, right: true },
        theme.gridSchematic,
        label,
        theme.glyphText,
        input.nameOffset,
      );
      ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
      ctx.fillStyle = theme.colors.ink;
      drawUprightText(ctx, placement, label, anchor, inward);
    }
    const afterBubbleX = hasOutputBubble ? outAnchor.center.x + outAnchor.r : layout.bodyRightRaw;
    if (hasOutputBubble) {
      drawBubble(ctx, theme, outAnchor.center, outAnchor.r * 2);
    }
    // A width>1 output pin expanded into several lanes fans out from the
    // shape's single tip via a vertical riser, same idea as the AND family's
    // own wing-extension line on the input side; the common single-output
    // case collapses to today's one horizontal stub (riser height 0, drawn).
    if (layout.outputYs.length > 1) {
      const ys = layout.outputYs.map((o) => o.y);
      ctx.strokeStyle = theme.colors.ink;
      ctx.lineWidth = theme.strokes.wire;
      ctx.beginPath();
      ctx.moveTo(afterBubbleX, Math.min(...ys));
      ctx.lineTo(afterBubbleX, Math.max(...ys));
      ctx.stroke();
    }
    for (const { name, y } of layout.outputYs) {
      const outFrom = { x: afterBubbleX, y };
      const outTo = { x: layout.outputTipX, y };
      drawStub(ctx, theme, outFrom, outTo, state?.(name));
    }
    for (const { name, y, stubEndX } of layout.inputYs) {
      if (bubbles?.inputs?.has(name)) {
        const anchor = anchors.find((a) => a.pin === name)!;
        drawStub(ctx, theme, { x: 0, y }, { x: anchor.center.x - anchor.r, y }, state?.(name));
        drawBubble(ctx, theme, anchor.center, anchor.r * 2);
      } else {
        drawStub(ctx, theme, { x: 0, y }, { x: stubEndX, y }, state?.(name));
      }
    }
  });
}
