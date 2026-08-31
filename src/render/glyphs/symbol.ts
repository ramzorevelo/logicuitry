// Shared foundation for the schematic glyph modules (gates.ts, chip.ts, io.ts).
// Pure geometry lives here so bounds/pin positions are unit-testable without a
// DOM; the only canvas-touching exports are the small stub/bubble draw helpers
// and withPlacement, which every glyph module reuses instead of hand-rolling
// its own rotate/mirror matrix math.

import type { ChipDef, Component, ParamValue, PinDir, PinRole } from '../../core/model/types';
import { isChipInstance } from '../../core/model/types';
import { getPrimitive } from '../../core/sim/primitives/registry';
import type { Params } from '../../core/sim/primitives/types';
import type { Rect, Vec2 } from '../scene';
import { signalStyle, type SignalState, type Theme } from '../theme';

export type Rot = 0 | 90 | 180 | 270;

/** World placement of a symbol: pos is the world position of the symbol's
 *  final (post-rotation) bounding-box top-left corner. */
export interface Placement {
  pos: Vec2;
  rot?: Rot | undefined;
  mirror?: boolean | undefined;
}

export interface ResolvedPin {
  name: string;
  dir: PinDir;
  width: number;
  role: PinRole;
  order: number;
  /** Display text for the glyph label, when it differs from `name` (see
   *  PrimitivePin). Falls back to `name` when unset. */
  label?: string;
}

/** Pin list for a primitive kind, straight from its PrimitiveSpec. */
export function primitivePins(kind: string, params: Params = {}): ResolvedPin[] {
  return getPrimitive(kind).pins(params);
}

/** Pin list for a ChipDef, in boundary-pin order. */
export function chipPins(def: ChipDef): ResolvedPin[] {
  return def.pins.map((p) => ({
    name: p.name,
    dir: p.dir,
    width: p.width,
    role: p.role,
    order: p.order,
  }));
}

/** Resolve a placed component's pins: primitives delegate to their spec,
 *  chip instances to the def's boundary pins. A chip instance whose def isn't
 *  resolvable (missing/not-yet-loaded, e.g. a ghost racing the chip library)
 *  degrades to zero pins instead of throwing through the render loop (P0.6,
 *  M4.2) -- callers that care distinguish this case via `isChipInstance(c) &&
 *  !chipDef` and render a placeholder box. */
export function resolveComponentPins(c: Component, chipDef?: ChipDef): ResolvedPin[] {
  if (isChipInstance(c)) return chipDef ? chipPins(chipDef) : [];
  return primitivePins(c.kind, (c.params as Params) ?? {});
}

/** Local, unrotated/unmirrored geometry: bounds start at (0,0) per §2/§3 of
 *  the glyph-language doc, pin positions are the wire-attach tips. */
export interface SymbolGeometry {
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** Snap a coordinate to the nearest schematic grid line. Gate body proportions
 *  (§2's H-derived constants) don't always land on whole grid units for every
 *  input count -- only the pin's wire-attach tip must, per the doc's hit-test
 *  requirement, so callers snap the tip while leaving the body silhouette
 *  literal to the spec's formula. */
export function snap(v: number, g: number): number {
  return Math.round(v / g) * g;
}

function rotatePoint(dx: number, dy: number, rot: Rot): Vec2 {
  switch (rot) {
    case 0:
      return { x: dx, y: dy };
    case 90:
      return { x: -dy, y: dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: dy, y: -dx };
  }
}

/** Mirror (about the bounds' vertical center line) then rotate (about the
 *  bounds' center) a point, expressed relative to that center. Shared by
 *  transformGeometry (pure math) and withPlacement (canvas transform), so
 *  both agree on exactly the same corner/pin mapping. */
function centeredTransform(p: Vec2, bounds: Rect, rot: Rot, mirror: boolean): Vec2 {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const mx = mirror ? 2 * cx - p.x : p.x;
  return rotatePoint(mx - cx, p.y - cy, rot);
}

function invRotatePoint(dx: number, dy: number, rot: Rot): Vec2 {
  switch (rot) {
    case 0:
      return { x: dx, y: dy };
    case 90:
      return { x: dy, y: -dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: -dy, y: dx };
  }
}

/** Inverse of centeredTransform: local-space point (relative to `bounds`)
 *  that centeredTransform would carry to `t`. */
function invCenteredTransform(t: Vec2, bounds: Rect, rot: Rot, mirror: boolean): Vec2 {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const d = invRotatePoint(t.x, t.y, rot);
  const mx = d.x + cx;
  const x = mirror ? 2 * cx - mx : mx;
  return { x, y: d.y + cy };
}

function boundsCorners(bounds: Rect): Vec2[] {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.h },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
  ];
}

/** World-space bounds + pin positions for a local symbol under a placement.
 *  This is the single source the editor's hit-test/wire-snap consumes. */
export function transformGeometry(
  geo: SymbolGeometry,
  placement: Placement,
): { bounds: Rect; pins: Map<string, Vec2> } {
  const rot = placement.rot ?? 0;
  const mirror = placement.mirror ?? false;
  const corners = boundsCorners(geo.bounds).map((p) =>
    centeredTransform(p, geo.bounds, rot, mirror),
  );
  const minX = Math.min(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxX = Math.max(...corners.map((c) => c.x));
  const maxY = Math.max(...corners.map((c) => c.y));

  const bounds: Rect = { x: placement.pos.x, y: placement.pos.y, w: maxX - minX, h: maxY - minY };
  const pins = new Map<string, Vec2>();
  for (const [name, p] of geo.pins) {
    const t = centeredTransform(p, geo.bounds, rot, mirror);
    pins.set(name, { x: t.x - minX + placement.pos.x, y: t.y - minY + placement.pos.y });
  }
  return { bounds, pins };
}

/** Inverse of transformGeometry's point mapping: a world-space point back
 *  into the symbol's local (unrotated/unmirrored) space. Used where a click
 *  needs to resolve against local geometry (e.g. the DIP-bank's per-bit
 *  cells) rather than just a pin/bounds hit-test. */
export function worldToLocal(worldPt: Vec2, localBounds: Rect, placement: Placement): Vec2 {
  const rot = placement.rot ?? 0;
  const mirror = placement.mirror ?? false;
  const corners = boundsCorners(localBounds).map((p) =>
    centeredTransform(p, localBounds, rot, mirror),
  );
  const minX = Math.min(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const t: Vec2 = {
    x: worldPt.x - placement.pos.x + minX,
    y: worldPt.y - placement.pos.y + minY,
  };
  return invCenteredTransform(t, localBounds, rot, mirror);
}

/** Set up a canvas transform equivalent to transformGeometry, then draw the
 *  symbol body using its LOCAL (unrotated/unmirrored) coordinates -- callers
 *  never hand-transform arc/bezier control points for rotation. */
export function withPlacement(
  ctx: CanvasRenderingContext2D,
  bounds: Rect,
  placement: Placement,
  draw: () => void,
): void {
  const rot = placement.rot ?? 0;
  const mirror = placement.mirror ?? false;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const corners = boundsCorners(bounds).map((p) => centeredTransform(p, bounds, rot, mirror));
  const minX = Math.min(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));

  ctx.save();
  ctx.translate(placement.pos.x - minX, placement.pos.y - minY);
  ctx.rotate((rot * Math.PI) / 180);
  if (mirror) ctx.scale(-1, 1);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}

/** Registry of geometry builders keyed by component kind, filled by gates.ts/
 *  chip.ts/io.ts at module load (same idiom as sim/primitives/registry.ts).
 *  symbol.ts stays the single dependency-free base so those modules can import
 *  it without a cycle. */
export interface GeometryInput {
  kind: string;
  params: Params;
  pins: ResolvedPin[];
  name?: string | undefined;
  id?: string | undefined;
  /** Component.nameOffset, carried through for the drawn instance-name seam
   *  (namePlacement); geometry itself (symbolBounds) never reads it -- the
   *  name rect is display-only, not a hit-test/routing obstacle (Task 2b). */
  nameOffset?: Vec2 | undefined;
  /** ChipDef.appearance.package for a chip instance standing for a real part.
   *  Carried here so hit-testing and drawing measure the same silhouette: a
   *  DIP is a different shape from the generic box, not a paint-time skin. */
  package?: string | undefined;
}
export type GeometryBuilder = (input: GeometryInput, theme: Theme) => SymbolGeometry;

const builders = new Map<string, GeometryBuilder>();

export function registerGlyphGeometry(kind: string, fn: GeometryBuilder): void {
  builders.set(kind, fn);
}

export function buildLocalGeometry(input: GeometryInput, theme: Theme): SymbolGeometry {
  const fn = builders.get(input.kind);
  if (!fn) throw new Error(`no glyph geometry registered for kind '${input.kind}'`);
  return fn(input, theme);
}

/** World-space bounds + pin positions for a placed Component. The single
 *  source the editor's loose-pin hit-test and wire snapping read from. */
export function symbolBounds(
  component: Component,
  theme: Theme,
  chipDef?: ChipDef,
): { bounds: Rect; pins: Map<string, Vec2> } {
  const pins = resolveComponentPins(component, chipDef);
  const local = buildLocalGeometry(
    {
      kind: component.kind,
      params: (component.params as Params) ?? {},
      pins,
      name: glyphBodyName(component.kind, component.label, chipDef?.name),
      id: component.id,
      package: chipDef?.appearance?.package,
    },
    theme,
  );
  return transformGeometry(local, {
    pos: component.pos,
    rot: component.rot,
    mirror: component.mirror,
  });
}

// Box kinds whose body text is a fixed
// identity, never the user's label -- a chip instance shows its def name,
// every other one shows its own kind string, so a shapeless rectangle still
// reads as "mux" etc. at a glance. Every other kind (gates, io tags) keeps
// showing the user's label as its body text, unchanged.
const FIXED_BODY_NAME_KINDS = new Set([
  'chip',
  'dff',
  'dlatch',
  'register',
  'mux',
  'demux',
  'decoder',
  'encoder',
]);

/** The name drawn INSIDE a glyph's body -- distinct from the user's label,
 *  which (for box kinds) draws OUTSIDE via namePlacement/instanceName. The
 *  single rule both symbolBounds and editorScene's geometryInput call, so
 *  glyph geometry (hit-test, wire snapping) and the draw path never drift
 *  apart on what text they measured. */
export function glyphBodyName(
  kind: string,
  label: string | undefined,
  defName: string | undefined,
): string | undefined {
  if (!FIXED_BODY_NAME_KINDS.has(kind)) return label ?? defName;
  return kind === 'chip' ? defName : kind;
}

// --- Draw helpers: pin stubs and bubbles, first-class per the glyph doc's
// "gate = base shape + optional bubble" decomposition. ---

/** Straight stub segment from a body edge point to a pin's wire-attach tip.
 *  Colour comes from signalStyle when a live state is known; otherwise ink,
 *  matching the doc's "body outline never recolors, wires/stubs do" rule. */
export function drawStub(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  from: Vec2,
  to: Vec2,
  state?: SignalState,
): void {
  const style = state ? signalStyle(theme, state) : undefined;
  ctx.strokeStyle = style?.color ?? theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.lineCap = theme.glyph.pinCap;
  ctx.setLineDash(style?.dashed ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  if (style?.alt) strokeMixedPass(ctx, style.alt);
  ctx.setLineDash([]);
}

/** Second pass of the mixed-bus cue: same path, alternate colour, dash offset
 *  by one run so the two interleave. The caller leaves the path in place. */
export function strokeMixedPass(ctx: CanvasRenderingContext2D, alt: string): void {
  const prev = ctx.strokeStyle;
  ctx.strokeStyle = alt;
  ctx.setLineDash(MIXED_DASH);
  ctx.lineDashOffset = MIXED_DASH[0];
  ctx.stroke();
  ctx.lineDashOffset = 0;
  ctx.strokeStyle = prev;
}

/** Equal on/off runs, so the second pass lands exactly in the first's gaps. */
const MIXED_DASH: [number, number] = [6, 6];

/** Diagonal slash + bit-count badge on a collapsed multi-bit pin's stub:
 *  same visual convention as a wide wire's own collapsed-bus glyph (chip.ts's
 *  busSlashGeometry), at stub scale, so a pin still drawn as one stub reads
 *  as a bus at a glance. No-op for a 1-bit pin. */
export function drawStubBusBadge(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
  from: Vec2,
  to: Vec2,
  width: number,
): void {
  if (width <= 1) return;
  const g = theme.gridSchematic;
  const mid: Vec2 = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const half = 0.4 * g;
  ctx.strokeStyle = theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.beginPath();
  ctx.moveTo(mid.x - ux * half + px * half, mid.y - uy * half + py * half);
  ctx.lineTo(mid.x + ux * half - px * half, mid.y + uy * half - py * half);
  ctx.stroke();
  ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.ink;
  const badgeAnchor: Vec2 = { x: mid.x + px * g * 0.8, y: mid.y + py * g * 0.8 };
  drawUprightText(ctx, placement, String(width), badgeAnchor, { x: 0, y: 0 });
}

/** One bubble size everywhere: filled surface, stroked ink, diameter given by
 *  the caller (0.25*H per §2/§3), centered on the point passed in. */
export function drawBubble(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  center: Vec2,
  diameter: number,
): void {
  ctx.beginPath();
  ctx.arc(center.x, center.y, diameter / 2, 0, Math.PI * 2);
  ctx.fillStyle = theme.colors.surface;
  ctx.fill();
  ctx.strokeStyle = theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.stroke();
}

/** Canvas text drawn inside a withPlacement callback stays upright: the
 *  anchor point rides the placement transform, but rotation/mirror are undone
 *  around it before the glyphs rasterize. `inward` is the local direction the
 *  text extends into (e.g. (1,0) for a left-edge pin label); alignment flips
 *  to whichever side the anchor faces after rotation/mirror. Pass (0,0) for
 *  centered text. */
export function drawUprightText(
  ctx: CanvasRenderingContext2D,
  placement: Placement,
  text: string,
  anchor: Vec2,
  inward: Vec2,
): void {
  const rot = placement.rot ?? 0;
  const mirror = placement.mirror ?? false;
  // Only a half-turn is worth undoing. At a quarter-turn the pin rows run
  // across the screen while each label still ran along it, so neighbouring
  // labels overlapped each other; letting the text turn with the body puts it
  // perpendicular to the row again, which is the only way they fit.
  const upright = rot === 0 || rot === 180;
  const mirrored = mirror ? -inward.x : inward.x;
  const d = upright ? rotatePoint(mirrored, inward.y, rot) : { x: mirrored, y: inward.y };
  ctx.save();
  ctx.translate(anchor.x, anchor.y);
  // Undo the placement's rotate-then-mirror around the anchor (S then R(-t)
  // composes with the outer R*S to identity).
  if (mirror) ctx.scale(-1, 1);
  if (upright) ctx.rotate((-rot * Math.PI) / 180);
  ctx.textAlign = d.x > 0.5 ? 'left' : d.x < -0.5 ? 'right' : 'center';
  ctx.textBaseline = d.y > 0.5 ? 'top' : d.y < -0.5 ? 'bottom' : 'middle';
  // A caption may carry newlines (an LED naming the expression it displays).
  // Rows stack away from the anchor in the direction the baseline already
  // implies, so a one-line caption draws exactly where it always did.
  const lines = text.split('\n');
  const lineH = textLineHeight(ctx);
  const first =
    ctx.textBaseline === 'top'
      ? 0
      : ctx.textBaseline === 'bottom'
        ? -(lines.length - 1) * lineH
        : -((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => ctx.fillText(line, 0, first + i * lineH));
  ctx.restore();
}

/** A placed component's bounds INCLUDING the caption drawn outside them.
 *
 *  Zoom-to-fit has to frame what the eye sees, not the silhouettes: a label
 *  sits outside the symbol box, so fitting the boxes clips the outermost
 *  labels off the edge of the view.
 *
 *  Each component is grown by its own caption's measured size rather than by
 *  a fixed pad, and the caller unions the results. Because the union takes
 *  the extreme on each side, the board's bounds end up asymmetric in exactly
 *  the way the drawing is: a short label on the leftmost part contributes a
 *  short margin on the left, a long one on the rightmost part a long margin
 *  on the right.
 *
 *  The caption's side is not known here (each glyph kind decides its own),
 *  so growth is symmetric per component. That can only ever be too generous,
 *  never too tight, and only on an inner side that the union discards.
 */
export function captionAwareBounds(bounds: Rect, label: string | undefined, theme: Theme): Rect {
  if (!label) return bounds;
  const block = measureMonoBlock(label, theme.glyphText);
  const padX = block.w;
  const padY = block.lines * theme.glyphText;
  return {
    x: bounds.x - padX,
    y: bounds.y - padY,
    w: bounds.w + 2 * padX,
    h: bounds.h + 2 * padY,
  };
}

/** Slack a cached glyph tile needs around its bounds so a caption drawn
 *  outside them is rasterised rather than cut off. Paint that falls past the
 *  tile is lost, not merely uncached, so this is sized from the caption
 *  itself: the widest line, plus a row per line, plus a grid step of margin.
 *  Zero for an unlabelled glyph, which then keeps the cheap default. */
export function captionPad(label: string, fontPx: number, g: number): number {
  if (!label) return 0;
  const block = measureMonoBlock(label, fontPx);
  return Math.ceil(block.w + block.lines * fontPx + 2 * g);
}

/** A caption on one line, for the places that lay text out in a single row --
 *  the waveform's label gutter, the STA card, the conflict dialog. A caption
 *  may hold newlines; those layouts cannot, and a raw newline draws as a box.
 *  The canvas glyphs use the label as authored and stack it instead. */
export function oneLine(text: string): string {
  return text.replace(/\n/g, ' ');
}

/** Row pitch for stacked caption text, from the font the context carries.
 *  Falls back to a typical 1.25em when the size cannot be parsed. */
export function textLineHeight(ctx: CanvasRenderingContext2D): number {
  const px = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
  return px ? Number(px[1]) * 1.25 : 16;
}

/** Width of the widest line, and the number of lines, for a caption that may
 *  be multi-line. Bounds and hit boxes size from this rather than from the raw
 *  string, whose embedded newlines would otherwise read as width. */
export function measureMonoBlock(text: string, fontPx: number): { w: number; lines: number } {
  const lines = text.split('\n');
  return {
    w: Math.max(...lines.map((l) => measureMonoText(l, fontPx))),
    lines: lines.length,
  };
}

/** Task 1c: instance-name placement rule, shared by gates, boxes and future
 *  kinds -- draw above the body, per the owner's live-QA correction: (1) the
 *  common case (no pins on ALL four sides at once) is above-CENTER, clear
 *  of the top edge; (2) only when every side already carries a pin (no room
 *  anywhere adjacent -- a future kind, not any of today's) does it fall back
 *  to above-left, pushed clearly outside the body's own highlight box rather
 *  than snug against it. `inward` must point AWAY from the body (upward) --
 *  drawUprightText treats it as the direction the text extends from the
 *  anchor, so pointing it back toward the body (the first version of this
 *  function did) draws the text growing DOWN into the box instead of
 *  clearing it. The highlight/hover outline pads `bounds` by 0.5G
 *  (editorScene.ts's `outline`), so the anchor sits exactly on that pad's
 *  edge and the text, growing away from it, lands fully outside the box. */
/** The rect a name of the given size occupies, growing from `anchor` in the
 *  `inward` direction (KiCad-movable-name seam, Task 2b): `offset` (the
 *  component's own local-space `nameOffset`) shifts the anchor before the
 *  rect is built, so a future drag just has to write that offset back. */
function nameRect(
  anchor: Vec2,
  inward: Vec2,
  w: number,
  h: number,
  offset?: Vec2,
): {
  anchor: Vec2;
  rect: Rect;
} {
  const ax = anchor.x + (offset?.x ?? 0);
  const ay = anchor.y + (offset?.y ?? 0);
  const x = inward.x === 0 ? ax - w / 2 : inward.x < 0 ? ax - w : ax;
  const y = inward.y <= 0 ? ay - h : ay;
  return { anchor: { x: ax, y: ay }, rect: { x, y, w, h } };
}

export function namePlacement(
  bounds: Rect,
  edgesWithPins: { top: boolean; bottom: boolean; left: boolean; right: boolean },
  g: number,
  text = '',
  fontPx = 0,
  offset?: Vec2,
): { anchor: Vec2; inward: Vec2; rect: Rect } {
  const boxedIn =
    edgesWithPins.top && edgesWithPins.bottom && edgesWithPins.left && edgesWithPins.right;
  const block = measureMonoBlock(text, fontPx);
  const w = block.w;
  const h = fontPx * (1 + 1.25 * (block.lines - 1));
  if (boxedIn) {
    const inward: Vec2 = { x: -1, y: -1 };
    const { anchor, rect } = nameRect({ x: bounds.x - g, y: -g }, inward, w, h, offset);
    return { anchor, inward, rect };
  }
  // Prefer the top edge (above-centre); a part that routes pins to the top
  // (e.g. a mux with selSide: 'top') displaces the name to the bottom edge
  // instead, clear of those pins' labels.
  if (!edgesWithPins.top) {
    const inward: Vec2 = { x: 0, y: -1 };
    const { anchor, rect } = nameRect(
      { x: bounds.x + bounds.w / 2, y: -0.5 * g },
      inward,
      w,
      h,
      offset,
    );
    return { anchor, inward, rect };
  }
  const inward: Vec2 = { x: 0, y: 1 };
  const { anchor, rect } = nameRect(
    { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h + 0.5 * g },
    inward,
    w,
    fontPx,
    offset,
  );
  return { anchor, inward, rect };
}

/** Single-bit BusValue -> SignalState, for I/O glyphs that show live signal fill. */
export function bitState(v: { v: number; x: number; z: number }): SignalState {
  if (v.z & 1) return 'Z';
  if (v.x & 1) return 'X';
  return v.v & 1 ? '1' : '0';
}

/**
 * Row pitch for a glyph whose rows carry text: ports, probes, bus displays,
 * and a box's pin rows. Presentation scales `--glyph-text-scale` while the
 * grid stays put, so a fixed 2G row is too short for its own text there;
 * rounding the text height up to whole grid rows keeps every pin on the grid
 * and leaves the default size (13px text in a 2G row) exactly as it was.
 */
export function textRowH(g: number, fontPx: number): number {
  return Math.max(2 * g, Math.ceil(fontPx / g) * g);
}

/**
 * Top edge of a stack of text rows whose FIRST row centre sits at `g`. Scaling
 * the text grows a row band, and growing it from y=0 would push the pin down
 * and pile the extra height above it; anchoring the first row's centre instead
 * keeps every pin exactly where it was and grows the body evenly around it.
 * Negative once a row is taller than 2G, which is why a layout's bounds start
 * here rather than at 0.
 */
export function textRowTop(g: number, rowH: number): number {
  return g - rowH / 2;
}

/** Centre of row `i` in a band laid out by `textRowTop`. On grid whenever
 *  `rowH` is (it always is -- `textRowH` rounds to whole grid rows). */
export function textRowCenter(g: number, rowH: number, row: number): number {
  return g + row * rowH;
}

/** Mono-font text width without a canvas context, for pure geometry (box
 *  sizing) that must run in Node. Approximates JetBrains Mono's ~0.6em
 *  average advance; draw call sites may pass ctx.measureText instead when a
 *  real context is available for pixel-accurate layout. */
export function measureMonoText(text: string, fontPx: number): number {
  return text.length * fontPx * 0.6;
}

export type { ParamValue };
