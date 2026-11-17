// Board -> canvas: glyph dispatch, orthogonal wire drawing with live signal
// color, junctions, selection, and wiring/ghost overlays. Pure draw over a
// viewport transform; all state comes in through RenderParams.

import type {
  ChipDef,
  ChipLibrary,
  Circuit,
  Component,
  Group,
  Point,
  Wire,
  WireEnd,
} from '../../core/model/types';
import {
  drawStubBusBadge,
  captionAwareBounds,
  captionPad,
  glyphBodyName,
  oneLine,
  resolveComponentPins,
  strokeMixedPass,
  symbolBounds,
} from '../../render/glyphs/symbol';
import { GATE_KINDS, drawGate, type GateKind } from '../../render/glyphs/gates';
import {
  getInputBubbles,
  getOutputBubble,
  normalizeGateComponent,
} from '../../core/gates/bubbleModel';
import { drawBox, drawConstant } from '../../render/glyphs/chip';
import { drawPull, drawRail } from '../../render/glyphs/power';
import {
  COMMON_PINS,
  matrixDotLit,
  segmentLit,
  sevenSegCommon,
} from '../../core/sim/primitives/display';
import { drawDip, isDipPackage } from '../../render/glyphs/dip';
import {
  drawBusDisplay,
  drawButton,
  drawSpdt,
  drawClock,
  drawPattern,
  drawLed,
  drawLedMatrix,
  drawNetLabel,
  drawPort,
  drawProbe,
  drawSevenSeg,
  drawSwitch,
} from '../../render/glyphs/io';
import type { GeometryInput, Placement } from '../../render/glyphs/symbol';
import type { Params } from '../../core/sim/primitives/types';
import { contactToGround, spdtPosition, type Throw } from '../../core/sim/primitives/stimulus';
import {
  busLabelGeometry,
  pinKeysOfWires,
  shouldShowPinBusBadge,
  type BusBadgeContext,
} from './busBadge';
import { occupancyKey, wiredPinKeys } from './pinTargets';
import { pinFacing } from './smartConnect';
import { getPrefs } from '../prefs';
import {
  inflateRect,
  polylineBounds,
  rectsIntersect,
  visibleWorldRect,
  type Rect,
  type Vec2,
  type Viewport,
} from '../../render/scene';
import {
  chipTintColor,
  paletteColor,
  signalStyle,
  type SignalState,
  type Theme,
} from '../../render/theme';
import { pinExitSide, pointAlongPolyline, routeAvoiding, routeOrthogonal } from './wireGeom';
import type { Expr } from '../../core/boolean/expr';
import { exprFont, exprTextHeight, layoutExprText, paintExprText } from '../../render/exprText';
import { GHOST_ALPHA } from '../../render/ghostPreview';
import {
  SCRATCH_PAD,
  drawCachedGlyph,
  drawWithGlyphBudget,
  fitGlyphCacheTo,
} from '../../render/glyphCache';
import { circuitRoutes, componentGeometry, endResolver, previewRoutes } from './routeCache';
import { wireDisplayInfo } from './wireDisplay';
import { lodFor } from '../../render/lod';
import { paintEmphasis } from '../../render/glyphs/relief';
import { glyphVariant } from '../../render/glyphs/variants';
import { drawTimer } from '../../render/glyphs/timer';
import '../../render/glyphs/charVariants'; // side-effect: registers per-theme device glyphs

const GATE_SET = new Set<string>(GATE_KINDS);
const BOX_SET = new Set([
  'chip',
  'dff',
  'dlatch',
  'register',
  'srlatch',
  'counter',
  'shiftreg',
  'ram',
  'mux',
  'demux',
  'decoder',
  'encoder',
  'adder',
  'comparator',
  'parity',
  'transceiver',
]);
const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

/** Everything one component's glyph needs, so a single glyph can be drawn
 *  outside the board scene (palette thumbnails) through the same code path. */
export interface GlyphContext {
  chipLib: ChipLibrary;
  pinSignal: (componentId: string, pinName: string) => SignalState | undefined;
  /** Raw per-bit value for glyphs needing more than an aggregate state
   *  (e.g. the DIP-bank switch). */
  pinRawValue?: (
    componentId: string,
    pinName: string,
  ) => { v: number; x: number; z: number } | undefined;
  /** Where a powered SPDT's lever sits; its outputs cannot say while it bounces. */
  throwOf?: (componentId: string) => Throw | undefined;
  /** Whether a powered button is held: a contact to GND's net cannot say. */
  heldOf?: (componentId: string) => boolean | undefined;
}

const defSerials = new WeakMap<ChipDef, number>();
let nextDefSerial = 0;

/** A def edit replaces the def object rather than mutating it, so object
 *  identity stands in for a revision a chip instance's tile can key on. */
function defSerial(def: ChipDef | undefined): string {
  if (!def) return '-';
  let n = defSerials.get(def);
  if (n === undefined) {
    n = nextDefSerial++;
    defSerials.set(def, n);
  }
  return String(n);
}

/** Cache identity for one component's glyph: everything the drawing depends on
 *  except its position. */
export function glyphKey(comp: Component, theme: Theme, p: GlyphContext): string {
  const def = comp.defId ? p.chipLib.get(comp.defId) : undefined;
  const parts = [
    theme.name,
    theme.presentation ? 'P' : '-',
    theme.lod,
    comp.kind,
    comp.label ?? comp.id,
    comp.rot ?? 0,
    comp.mirror ? 'M' : '-',
    JSON.stringify(comp.params ?? {}),
    comp.nameOffset ? `${comp.nameOffset.x},${comp.nameOffset.y}` : '-',
    comp.defId ?? '-',
    defSerial(def),
    comp.kind === 'spdt' ? (p.throwOf?.(comp.id) ?? '-') : '-',
    comp.kind === 'button' ? heldKey(p.heldOf?.(comp.id)) : '-',
  ];
  for (const pin of resolveComponentPins(comp, def)) {
    const raw = p.pinRawValue?.(comp.id, pin.name);
    parts.push(`${pin.name}${p.pinSignal(comp.id, pin.name) ?? '?'}`);
    if (raw) parts.push(`${raw.v}/${raw.x}/${raw.z}`);
  }
  return parts.join('|');
}

export interface RenderParams extends GlyphContext {
  /** The active tab's circuit body: the board, or an open ChipDef being edited. */
  board: Circuit;
  /** The committed circuit when `board` is a preview built from it: only the
   *  wires the preview touches reroute. */
  routeBase?: Circuit | undefined;
  viewport: Viewport;
  selection: ReadonlySet<string>;
  /** A touch hold has picked the selection up: drawn heavier so the lift shows
   *  on a phone whose touch vibration is off. */
  lifted?: boolean;
  /** Gate step: wires on the nets the last press changed, ringed. */
  gateRing?: ReadonlySet<string> | undefined;
  /** Gate step: parts with a drive or wake still pending, outlined. */
  gatePending?: ReadonlySet<string> | undefined;
  /** Chip instances with a re-bind badge (a def edit stranded one of their wires). */
  stale?: ReadonlySet<string>;
  hoverPin?: Vec2 | undefined;
  // Full polyline (start pin/free-point, every committed bend, live cursor
  // point) -- not just a single from/to elbow, per P1.6's multi-bend drawing.
  wiringPreview?: Vec2[] | undefined;
  grid: number;
  /** Dot grid off; `grid` still routes and snaps, so it cannot stand in. */
  hideGrid?: boolean;
  /** Backing-store scale: canvas.width = cssWidth * dpr. */
  dpr?: number;
  /** Pending-placement ghost, drawn last at reduced alpha. */
  ghost?: Component | undefined;
  /** In-progress lasso-select rectangle, world space. */
  lasso?: Rect | undefined;
  /** In-progress freehand lasso path, world space, drawn closed. */
  lassoPath?: readonly Vec2[] | undefined;
  /** Wires the in-progress cut stroke currently crosses, highlighted before delete. */
  cutFlags?: ReadonlySet<string> | undefined;
  /** In-progress wire-cut stroke, world space, drawn open. */
  cutStroke?: readonly Vec2[] | undefined;
  /** Smart-connect ghost preview: one proposed wire per pair, with a pin-name label. */
  smartConnectPreview?: { from: Vec2; to: Vec2; label: string }[] | undefined;
  /** Duplicate/paste ghost group, already offset to its proposed position. */
  ghostGroup?: Pick<Circuit, 'components' | 'wires' | 'junctions'> | undefined;
  /** Bubble-mode pending-push overlay: the post-transform board as a ghost,
   *  ok-tinted wires when legal, warn-tinted when illegal. Routed through the
   *  same computeWireRoutes pipeline as the live board so an unchanged wire
   *  ghosts exactly over itself (the old Gates workbench drew ghost wires on
   *  a different route than the live ones, reading as a stray offset wire). */
  bubbleOverlay?: { board: Circuit; legal: boolean } | undefined;
  /** Bubble-mode focus ring: a terminal anchor point, a whole wire, or a
   *  whole-body focus (standalone-inverter drag handle) drawn as a bounds
   *  outline -- a point ring at the body center reads as a phantom bubble. */
  bubbleFocus?:
    | { kind: 'point'; pos: Vec2 }
    | { kind: 'wire'; wireId: string }
    | { kind: 'rect'; rect: Rect }
    | undefined;
  /** The grabbed bubble following the cursor during a drag, ghost alpha. */
  dragBubble?: { center: Vec2; d: number } | undefined;
  /** Wires on a hovered waveform track's net, drawn with an accent halo. */
  highlightWires?: ReadonlySet<string> | undefined;
  /** Wires touching a width-mismatched component, drawn with a warn halo. */
  mismatchWires?: ReadonlySet<string> | undefined;
  /** Task 6 batch param edit: components sharing the double-click overlay's
   *  currently-focused field, drawn with an extra dashed --ok outline (wider
   *  pad than the accent selection / warn stale outlines, so it reads as a
   *  distinct ring rather than a thicker selection box). */
  paramHighlight?: ReadonlySet<string> | undefined;
  /** Components whose gesture the current mode just refused, with the pulse's
   *  current opacity: the visible half of the blocked-gesture feedback. */
  blockedFlash?: { ids: ReadonlySet<string>; alpha: number } | undefined;
  /** Net labels sharing the hovered/selected label's name. A name join has no
   *  wire to look at, so an accidental one is invisible until the peers say
   *  so -- this is the only thing that shows the join. */
  peerLabels?: ReadonlySet<string> | undefined;
  /** Parts the open lesson step points at: a heavier, wider dashed ring than
   *  any editing outline, so the class sees it from the back row. */
  lessonHighlight?: ReadonlySet<string> | undefined;
  /** STA overlay: per-wire path role + per-component hop delay labels. */
  staOverlay?:
    | {
        criticalWires: ReadonlySet<string>;
        shortWires: ReadonlySet<string>;
        labels: ReadonlyMap<string, string>;
        shortLabels: ReadonlyMap<string, string>;
      }
    | undefined;
  /** View > Sub-expressions: `<componentId>.<pin>` -> the expression that
   *  output computes, drawn beside the pin. */
  subExpressions?: ReadonlyMap<string, Expr> | undefined;
  /** Checks tab open: rings on open pins, a badge on an unpowered DIP, a
   *  dashed overlay on a net that can float. */
  checkMarkers?:
    | {
        pins: readonly { component: string; pin: string }[];
        badges: ReadonlySet<string>;
        dashedWires: ReadonlySet<string>;
      }
    | undefined;
}

interface Geo {
  bounds: Rect;
  pins: Map<string, Vec2>;
}

/** Returns true when some glyphs drew from a stand-in tile, so the caller
 *  draws another frame. */
export function renderBoard(ctx: CanvasRenderingContext2D, theme: Theme, p: RenderParams): boolean {
  fitGlyphCacheTo(p.board.components.length);
  return drawWithGlyphBudget(() => drawBoard(ctx, theme, p));
}

/** Slack around a wire's route for what draws beside it: the bus slash and
 *  width, a tap's range label, a free-end marker. In grid units, on top of
 *  the widest halo. */
const WIRE_CULL_GRIDS = 8;

/** Per wires array, so a pan does not rescan every wire each frame. */
const wiredKeysCache = new WeakMap<readonly Wire[], ReadonlySet<string>>();
function wiredPinKeysOf(wires: readonly Wire[]): ReadonlySet<string> {
  let keys = wiredKeysCache.get(wires);
  if (!keys) {
    keys = wiredPinKeys(wires);
    wiredKeysCache.set(wires, keys);
  }
  return keys;
}

function drawBoard(ctx: CanvasRenderingContext2D, theme: Theme, p: RenderParams): void {
  const { viewport: vp } = p;
  const dpr = p.dpr ?? 1;
  const canvas = ctx.canvas;
  // All drawing happens in CSS pixels on top of the dpr scale, so strokes stay
  // crisp on HiDPI backing stores.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  ctx.fillStyle = theme.colors.paper;
  ctx.fillRect(0, 0, cssW, cssH);
  if (!p.hideGrid) drawGrid(ctx, theme, p, cssW, cssH);

  ctx.setTransform(
    dpr * vp.zoom,
    0,
    0,
    dpr * vp.zoom,
    -vp.panX * vp.zoom * dpr,
    -vp.panY * vp.zoom * dpr,
  );

  // One decoration budget for the whole frame, carried on the theme so every
  // glyph function sees it without a parallel parameter.
  // Geometry never reads lod, and the frame's spread copy would defeat the
  // geometry and route caches, which key on the theme object.
  const baseTheme = theme;
  theme = { ...theme, lod: lodFor(vp.zoom, p.board.components.length) };

  const geo = componentGeometry(p.board.components, p.chipLib, baseTheme);
  const routes = p.routeBase
    ? previewRoutes(p.board, p.routeBase, p.chipLib, baseTheme, p.grid)
    : circuitRoutes(p.board, p.chipLib, baseTheme, p.grid);

  // Group borders go down first, so every wire and body draws over them: the
  // border says "these belong together", it is not part of the circuit.
  drawGroups(ctx, theme, p.board, geo, routes);

  const resolveEnd = endResolver(p.board, p.chipLib, baseTheme);

  // P2.1/M4.5: bounding boxes of every component, including a wire's own
  // endpoint components (the M4.5 own-pin exclusion was removed -- a pin sits
  // exactly on its component's bounds edge, so a normally-attached wire is
  // tangent, not crossing, and a body dragged past its own pin is correctly
  // routed around), for routing wires beside bodies instead of through them,
  // and beside each other instead of overlapping. Single source of truth for
  // every wire's route -- hit-testing in
  // CircuitWorkbench.tsx must compute from the exact same inputs, or a click
  // lands on a path that isn't the one drawn (M4.2 follow-up route-
  // consistency bug).
  const showWireColors = getPrefs().showWireColors;
  const display = wireDisplayInfo(p.board, p.chipLib);
  // Only what is drawn is culled; hit-tests and routing still see every item.
  const view = visibleWorldRect(vp, cssW, cssH);
  const inView = (r: Rect, pad: number) => rectsIntersect(inflateRect(r, pad), view);
  const wirePad = WIRE_CULL_GRIDS * theme.gridSchematic + theme.strokes.wire * 8;

  for (const wire of p.board.wires) {
    const a = resolveEnd(wire.a);
    const b = resolveEnd(wire.b);
    if (!a || !b) continue;
    const pts = routes.get(wire.id)!;
    if (!inView(polylineBounds(pts), wirePad)) continue;
    const shown = display.get(wire.id);
    const state = shown?.readPin && p.pinSignal(shown.readPin.component, shown.readPin.pin);
    // Width comes from the shared resolver, so the badge's own hit-test agrees
    // with what is drawn about which wires have a label.
    const busWidth = shown?.width ?? 1;
    const sheath = showWireColors ? paletteColor(theme, wire.color) : undefined;
    // Every halo and highlight clears the sheath, or a coloured wire would
    // hide the very cue that points at it.
    const outer = sheath ? sheathWidth(theme, busWidth) : coreWidth(theme, busWidth);
    const haloWidth = Math.max(theme.strokes.wire * 4, outer + theme.strokes.wire * 2);
    if (p.gateRing?.has(wire.id)) gateRingWire(ctx, theme, pts, haloWidth);
    if (p.highlightWires?.has(wire.id)) {
      // Waveform-track hover halo, drawn under the wire's own signal color.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = theme.colors.accent;
      ctx.lineWidth = haloWidth;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
      ctx.restore();
    }
    if (p.mismatchWires?.has(wire.id)) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = theme.colors.warn;
      ctx.lineWidth = haloWidth;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
      ctx.restore();
    }
    drawWire(ctx, theme, pts, state, busWidth, false, attachedEnds(wire), sheath);
    if (busWidth > 1 && pts.length >= 2) {
      // Bus-width slash + bit-count badge, oriented along the wire's local direction at its
      // arc-length midpoint so a bent bus wire still reads correctly.
      const at = pointAlongPolyline(pts, wire.busLabelT ?? 0.5);
      const { slashA, slashB, badgePos } = busLabelGeometry(at, theme.gridSchematic);
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
      ctx.fillText(String(busWidth), badgePos.x, badgePos.y);
    }
    // Hollow warning marker on dangling ends (same mark as unconnected inputs).
    for (const [end, pt] of [
      [wire.a, a],
      [wire.b, b],
    ] as const) {
      if (end.kind !== 'free') continue;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, theme.gridSchematic * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = theme.colors.surface;
      ctx.fill();
      ctx.strokeStyle = theme.colors.warn;
      ctx.lineWidth = theme.strokes.min;
      ctx.stroke();
    }
    // Bus-tap marker: a hollow dot (distinct from a junction's filled one --
    // a tap doesn't electrically merge the bus, it slices a sub-range off it)
    // plus its [hi:lo] range, so a tapped bus wire never looks like a plain
    // same-width junction.
    for (const [end, pt] of [
      [wire.a, a],
      [wire.b, b],
    ] as const) {
      if (end.kind !== 'tap') continue;
      drawTapPoint(ctx, theme, pt, end.range);
    }
    const blocked = p.blockedFlash?.ids.has(wire.id) ? p.blockedFlash.alpha : 0;
    if (p.selection.has(wire.id) || p.cutFlags?.has(wire.id) || blocked > 0) {
      ctx.strokeStyle =
        p.cutFlags?.has(wire.id) || blocked > 0 ? theme.colors.warn : theme.colors.accent;
      ctx.lineWidth = Math.max(theme.strokes.wire + 4, outer + 4);
      // A refused gesture pulses rather than sitting at the steady highlight
      // weight, so it reads as feedback and not as a new selection.
      ctx.globalAlpha = blocked > 0 ? 0.35 + 0.5 * blocked : p.lifted ? 0.7 : 0.35;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // STA overlay: short path muted under critical accent (Fig 2.68), per-hop
  // delay labels beside each component on the critical path.
  if (p.staOverlay) {
    for (const [ids, color, w] of [
      [p.staOverlay.shortWires, theme.colors.muted, 3],
      [p.staOverlay.criticalWires, theme.colors.accent, 4],
    ] as const) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = color;
      ctx.lineWidth = theme.strokes.wire * w;
      ctx.lineJoin = 'round';
      for (const id of ids) {
        const pts = routes.get(id);
        if (!pts) continue;
        ctx.beginPath();
        pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  if (p.checkMarkers?.dashedWires.size) {
    ctx.save();
    ctx.strokeStyle = theme.colors.warn;
    ctx.lineWidth = theme.strokes.wire * 2;
    ctx.lineJoin = 'round';
    ctx.setLineDash([theme.gridSchematic * 0.6, theme.gridSchematic * 0.4]);
    for (const id of p.checkMarkers.dashedWires) {
      const pts = routes.get(id);
      if (!pts || !inView(polylineBounds(pts), wirePad)) continue;
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const j of p.board.junctions)
    if (inView({ ...j.pos, w: 0, h: 0 }, theme.gridSchematic)) drawJunction(ctx, theme, j.pos);

  // A wired pin's width is already stated by the wire's own bus glyph; drawing
  // it twice is noise on a board full of buses.
  const badgeRule: BusBadgeContext = {
    wired: wiredPinKeysOf(p.board.wires),
    mismatched: pinKeysOfWires(p.board.wires, p.mismatchWires),
    alwaysShow: getPrefs().alwaysShowPinBusWidth,
  };

  for (const comp of p.board.components) {
    const g = geo.get(comp.id);
    if (g && !inView(g.bounds, glyphPad(comp, theme))) continue;
    paintComponent(ctx, theme, comp, p, g?.bounds, dpr * vp.zoom);
    if (!g) continue;
    drawPinBusBadges(ctx, theme, comp, g, p.chipLib, badgeRule);
    if (p.selection.has(comp.id))
      outline(ctx, theme, g.bounds, theme.colors.accent, 1, p.lifted ?? false);
    else if (p.stale?.has(comp.id)) outline(ctx, theme, g.bounds, theme.colors.warn);
    if (p.paramHighlight?.has(comp.id)) outline(ctx, theme, g.bounds, theme.colors.ok, 1.8);
    if (p.blockedFlash?.ids.has(comp.id)) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * p.blockedFlash.alpha;
      outline(ctx, theme, g.bounds, theme.colors.warn, 2.2);
      ctx.globalAlpha = prev;
    }
    if (p.peerLabels?.has(comp.id)) outline(ctx, theme, g.bounds, theme.colors.accent, 1.8);
    const staLabel = p.staOverlay?.labels.get(comp.id);
    if (staLabel) {
      ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
      ctx.fillStyle = theme.colors.accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(staLabel, g.bounds.x + g.bounds.w / 2, g.bounds.y - 4);
    }
    // Short-path t_cd hops label below the glyph so both figures on a shared
    // gate (critical tpd above, short tcd below) stay legible.
    const staShort = p.staOverlay?.shortLabels.get(comp.id);
    if (staShort) {
      ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
      ctx.fillStyle = theme.colors.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(staShort, g.bounds.x + g.bounds.w / 2, g.bounds.y + g.bounds.h + 4);
    }
  }

  if (p.gatePending?.size)
    for (const comp of p.board.components) {
      const g = p.gatePending.has(comp.id) ? geo.get(comp.id) : undefined;
      if (g && inView(g.bounds, theme.gridSchematic * 3)) gatePendingOutline(ctx, theme, g.bounds);
    }

  if (p.lessonHighlight?.size) {
    const parts = p.board.components.flatMap((comp) => {
      const g = p.lessonHighlight!.has(comp.id) ? geo.get(comp.id) : undefined;
      return g ? [captionAwareBounds(g.bounds, comp.label, theme)] : [];
    });
    for (const box of lessonHighlightBoxes(parts, theme)) lessonOutline(ctx, theme, box);
  }

  if (p.subExpressions && theme.lod !== 'flat')
    drawSubExpressions(ctx, theme, p.subExpressions, geo);

  if (p.checkMarkers) drawCheckMarkers(ctx, theme, p.checkMarkers, geo, inView);

  if (p.ghost) {
    ctx.globalAlpha = GHOST_ALPHA;
    drawComponent(ctx, theme, p.ghost, p);
    drawGhostBadges(ctx, theme, p.ghost, p.chipLib);
    ctx.globalAlpha = 1;
  }

  if (p.ghostGroup) {
    const geo2 = new Map<string, Geo>();
    for (const comp of p.ghostGroup.components) {
      const def = comp.defId ? p.chipLib.get(comp.defId) : undefined;
      geo2.set(comp.id, symbolBounds(comp, theme, def));
    }
    const resolveGhostEnd = (end: WireEnd): Vec2 | undefined => {
      if (end.kind === 'pin') return geo2.get(end.component)?.pins.get(end.pin);
      if (end.kind === 'junction')
        return p.ghostGroup!.junctions.find((j) => j.id === end.junction)?.pos;
      if (end.kind === 'free' || end.kind === 'tap') return end.pos;
      return undefined;
    };
    ctx.globalAlpha = GHOST_ALPHA;
    for (const wire of p.ghostGroup.wires) {
      const a = resolveGhostEnd(wire.a);
      const b = resolveGhostEnd(wire.b);
      if (!a || !b) continue;
      const pts = wire.points.length ? [a, ...wire.points, b] : routeOrthogonal(a, b);
      drawWire(ctx, theme, pts, undefined, 1, false, attachedEnds(wire));
    }
    for (const comp of p.ghostGroup.components) {
      drawComponent(ctx, theme, comp, p);
      drawGhostBadges(ctx, theme, comp, p.chipLib);
    }
    for (const j of p.ghostGroup.junctions) drawJunction(ctx, theme, j.pos);
    ctx.globalAlpha = 1;
  }

  if (p.bubbleOverlay) {
    const ob = p.bubbleOverlay.board;
    const oRoutes = circuitRoutes(ob, p.chipLib, baseTheme, p.grid);
    const tint = p.bubbleOverlay.legal ? theme.colors.ok : theme.colors.warn;
    ctx.globalAlpha = GHOST_ALPHA;
    ctx.strokeStyle = tint;
    ctx.lineWidth = theme.strokes.wire;
    for (const w of ob.wires) {
      const pts = oRoutes.get(w.id);
      if (!pts) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    }
    for (const comp of ob.components) {
      drawComponent(ctx, theme, comp, p);
      drawGhostBadges(ctx, theme, comp, p.chipLib);
    }
    ctx.globalAlpha = 1;
  }

  if (p.bubbleFocus) {
    ctx.strokeStyle = theme.colors.accent;
    if (p.bubbleFocus.kind === 'rect') {
      const g = theme.gridSchematic;
      const r = p.bubbleFocus.rect;
      ctx.lineWidth = theme.strokes.wire + 1.5;
      ctx.strokeRect(r.x - g / 2, r.y - g / 2, r.w + g, r.h + g);
    } else if (p.bubbleFocus.kind === 'point') {
      ctx.beginPath();
      ctx.arc(p.bubbleFocus.pos.x, p.bubbleFocus.pos.y, theme.gridSchematic * 0.6, 0, Math.PI * 2);
      ctx.lineWidth = theme.strokes.wire + 1.5;
      ctx.stroke();
    } else {
      const pts = routes.get(p.bubbleFocus.wireId);
      if (pts) {
        ctx.lineWidth = theme.strokes.wire + 3;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  if (p.dragBubble) {
    ctx.globalAlpha = GHOST_ALPHA;
    ctx.beginPath();
    ctx.arc(p.dragBubble.center.x, p.dragBubble.center.y, p.dragBubble.d / 2, 0, Math.PI * 2);
    ctx.fillStyle = theme.colors.surface;
    ctx.fill();
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.wire;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (p.wiringPreview && p.wiringPreview.length > 1) {
    drawWire(ctx, theme, p.wiringPreview, undefined, 1, true);
  }
  if (p.smartConnectPreview) {
    ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
    ctx.fillStyle = theme.colors.accent;
    // Route each preview wire the same way a committed one would (M4.5) --
    // avoiding component bodies and every wire already on the board, plus
    // every preview wire drawn so far this pass, so the fan of suggested
    // wires doesn't visually stack on itself or the real board.
    const previewObstacles: Vec2[][] = [...routes.values()];
    const bodyObstacles = [...geo.values()].map((g) => g.bounds);
    for (const pair of p.smartConnectPreview) {
      const pts = routeAvoiding(pair.from, pair.to, bodyObstacles, previewObstacles, p.grid);
      drawWire(ctx, theme, pts, undefined, 1, true);
      previewObstacles.push(pts);
      const mid = pts[Math.floor((pts.length - 1) / 2)]!;
      ctx.fillText(pair.label, mid.x + 4, mid.y - 4);
    }
  }
  if (p.hoverPin) {
    ctx.beginPath();
    ctx.arc(p.hoverPin.x, p.hoverPin.y, theme.gridSchematic * 0.6, 0, Math.PI * 2);
    ctx.strokeStyle = theme.colors.accent;
    ctx.lineWidth = theme.strokes.min;
    ctx.stroke();
  }
  if (p.cutStroke && p.cutStroke.length > 1) {
    ctx.strokeStyle = theme.colors.warn;
    ctx.lineWidth = theme.strokes.wire;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(p.cutStroke[0]!.x, p.cutStroke[0]!.y);
    for (const pt of p.cutStroke.slice(1)) ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (p.lasso || (p.lassoPath && p.lassoPath.length > 1)) {
    ctx.strokeStyle = theme.colors.accent;
    ctx.fillStyle = theme.colors.accent;
    ctx.beginPath();
    if (p.lassoPath && p.lassoPath.length > 1) {
      ctx.moveTo(p.lassoPath[0]!.x, p.lassoPath[0]!.y);
      for (const pt of p.lassoPath.slice(1)) ctx.lineTo(pt.x, pt.y);
      ctx.closePath();
    } else if (p.lasso) {
      ctx.rect(p.lasso.x, p.lasso.y, p.lasso.w, p.lasso.h);
    }
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = theme.strokes.min;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Each gate output's expression beside its pin, on the side the wire leaves
 *  by and clear of it, over a paper plate so a wire behind stays readable. */
function drawSubExpressions(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  exprs: ReadonlyMap<string, Expr>,
  geo: ReadonlyMap<string, Geo>,
): void {
  const fontPx = theme.glyphText;
  const g = theme.gridSchematic;
  const pad = 2;
  ctx.font = exprFont(theme, fontPx);
  for (const [key, expr] of exprs) {
    const dot = key.lastIndexOf('.');
    const at = geo.get(key.slice(0, dot));
    const pin = at?.pins.get(key.slice(dot + 1));
    if (!at || !pin) continue;
    const layout = layoutExprText(ctx, expr);
    const h = exprTextHeight(layout, fontPx);
    const side = pinExitSide(pin, at.bounds) ?? 'right';
    // Text middle sits above a horizontal wire, beside a vertical one.
    const x = side === 'left' ? pin.x - g / 2 - layout.width : pin.x + g / 2;
    const y =
      side === 'up'
        ? pin.y - g / 2 - fontPx / 2
        : side === 'down'
          ? pin.y + g / 2 + h - fontPx / 2
          : pin.y - pad * 2 - fontPx / 2;
    ctx.fillStyle = theme.colors.paper;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x - pad, y + fontPx / 2 - h - pad, layout.width + pad * 2, h + pad * 2);
    ctx.globalAlpha = 1;
    paintExprText(ctx, theme, layout, x, y, fontPx, theme.colors.accent);
  }
}

function drawCheckMarkers(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  markers: NonNullable<RenderParams['checkMarkers']>,
  geo: ReadonlyMap<string, Geo>,
  inView: (r: Rect, pad: number) => boolean,
): void {
  const g = theme.gridSchematic;
  ctx.save();
  ctx.strokeStyle = theme.colors.warn;
  ctx.lineWidth = theme.strokes.wire * 1.5;
  for (const { component, pin } of markers.pins) {
    const at = geo.get(component)?.pins.get(pin);
    if (!at || !inView({ ...at, w: 0, h: 0 }, g)) continue;
    ctx.beginPath();
    ctx.arc(at.x, at.y, g * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The warning triangle the Checks tab shows for the row, on the chip's corner.
  const s = g * 1.4;
  for (const id of markers.badges) {
    const b = geo.get(id)?.bounds;
    if (!b || !inView(b, s)) continue;
    const cx = b.x + b.w;
    const top = b.y - s * 0.9;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx + s * 0.55, top + s * 0.9);
    ctx.lineTo(cx - s * 0.55, top + s * 0.9);
    ctx.closePath();
    ctx.fillStyle = theme.colors.surface;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.colors.warn;
    ctx.fillRect(cx - s * 0.05, top + s * 0.32, s * 0.1, s * 0.3);
    ctx.fillRect(cx - s * 0.05, top + s * 0.68, s * 0.1, s * 0.1);
  }
  ctx.restore();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  p: RenderParams,
  cssW: number,
  cssH: number,
): void {
  const g = p.grid * p.viewport.zoom;
  if (g < 5) return;
  ctx.fillStyle = theme.colors.line;
  const ox = ((-p.viewport.panX * p.viewport.zoom) % g) - g;
  const oy = ((-p.viewport.panY * p.viewport.zoom) % g) - g;
  for (let x = ox; x < cssW; x += g) for (let y = oy; y < cssH; y += g) ctx.fillRect(x, y, 1, 1);
}

function geometryInput(comp: Component, chipLib: ChipLibrary): GeometryInput {
  const def = comp.defId ? chipLib.get(comp.defId) : undefined;
  return {
    kind: comp.kind,
    params: (comp.params as GeometryInput['params']) ?? {},
    pins: resolveComponentPins(comp, def),
    name: glyphBodyName(comp.kind, comp.label, def?.name),
    nameOffset: comp.nameOffset,
    package: def?.appearance?.package,
  };
}

/** The badge is drawn here rather than inside each glyph for two reasons: one
 *  code path covers gates, boxes, I/O devices and chip instances alike (the
 *  glyph files have ~20 separate stub sites between them), and it stays OUTSIDE
 *  the cached tile, so wiring a pin never invalidates `glyphKey`. */
function drawPinBusBadges(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  comp: Component,
  g: Geo,
  chipLib: ChipLibrary,
  rule: BusBadgeContext,
): void {
  const def = comp.defId ? chipLib.get(comp.defId) : undefined;
  const pins = resolveComponentPins(comp, def);
  if (!pins.some((pin) => pin.width > 1)) return;
  const stub = theme.gridSchematic;
  for (const pin of pins) {
    const tip = g.pins.get(pin.name);
    if (!tip) continue;
    if (!shouldShowPinBusBadge(pin.width, occupancyKey(comp.id, pin.name), rule)) continue;
    // The stub runs inward from the tip; its far end is only needed for the
    // badge's own axis, so one grid unit along the facing is enough.
    const facing = pinFacing(tip, g.bounds);
    const from = { x: tip.x - facing.x * stub, y: tip.y - facing.y * stub };
    drawStubBusBadge(ctx, theme, UPRIGHT, from, tip, pin.width);
  }
}

/** No placement transform is in effect out here, so the badge number is
 *  already upright and needs no counter-rotation. */
const UPRIGHT: Placement = { pos: { x: 0, y: 0 }, rot: 0, mirror: false };

/** Nothing on a ghost is wired yet, so every wide pin states its own width.
 *  Geometry is rebuilt here because a ghost has no entry in the board's `geo`. */
function drawGhostBadges(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  comp: Component,
  chipLib: ChipLibrary,
): void {
  const def = comp.defId ? chipLib.get(comp.defId) : undefined;
  drawPinBusBadges(ctx, theme, comp, symbolBounds(comp, theme, def), chipLib, GHOST_BADGES);
}

const GHOST_BADGES: BusBadgeContext = {
  wired: new Set<string>(),
  mismatched: new Set<string>(),
  alwaysShow: false,
};

/** Live and scrubbed caps draw differently at the same stub, so all three
 *  states key apart. */
function heldKey(held: boolean | undefined): string {
  return held === undefined ? '-' : held ? 'H' : 'h';
}

/** A scrub has no lever history: the throw carrying the common's level while
 *  the other does not is the one touched. Undefined when the nets cannot tell. */
function throwFromPins(signal: (pin: string) => SignalState | undefined): Throw | undefined {
  const c = signal('c');
  if (c === undefined) return undefined;
  const onA = signal('a') === c;
  const onB = signal('b') === c;
  return onA === onB ? undefined : onA ? 'a' : 'b';
}

/** Cached path for the board loop: identical output to drawComponent, blitted
 *  from an offscreen tile when the glyph's identity and state are unchanged. */
/** Rect enclosing a group's members, padded so the border clears their bodies
 *  and leaves room for the name above. Derived, never stored: a border that
 *  could disagree with the membership would be worse than no border. */
export function groupRect(bounds: readonly Rect[], g: number): Rect | undefined {
  if (bounds.length === 0) return undefined;
  const pad = 1.5 * g;
  const x = Math.min(...bounds.map((b) => b.x)) - pad;
  const y = Math.min(...bounds.map((b) => b.y)) - pad;
  return {
    x,
    y,
    w: Math.max(...bounds.map((b) => b.x + b.w)) + pad - x,
    h: Math.max(...bounds.map((b) => b.y + b.h)) + pad - y,
  };
}

/** Last result per route map: drawGroups runs every frame and the hit-tests on
 *  every pointer move, and a route map is itself memoised per board state. */
const wirePointsCache = new WeakMap<
  ReadonlyMap<string, Vec2[]>,
  { groups: Circuit['groups']; value: Map<string, Point[]> }
>();

/** Points of the wires each group keeps to itself, so its border encloses them
 *  as well as the parts. A wire tree (wires joined at junctions and taps)
 *  belongs to the innermost group holding every pin it reaches; one reaching an
 *  ungrouped part or two unrelated groups has to cross a border. `routes` are
 *  the drawn paths: most wires store no bends and are routed when drawn. */
export function groupWirePoints(
  board: Circuit,
  routes?: ReadonlyMap<string, Vec2[]>,
): Map<string, Point[]> {
  const cached = routes && wirePointsCache.get(routes);
  // Nesting groups changes no route, only which group a tree falls to.
  if (cached && cached.groups === board.groups) return cached.value;
  const out = new Map<string, Point[]>();
  if (routes) wirePointsCache.set(routes, { groups: board.groups, value: out });
  const groups = board.groups ?? [];
  if (!groups.length || !board.wires.length) return out;
  const parentOf = new Map(groups.map((g) => [g.id, g.parent]));
  const ancestry = (id: string): string[] => {
    const chain = [id];
    // Bounded by the group count: a hand-edited parent cycle must not hang.
    for (
      let p = parentOf.get(id);
      p !== undefined && chain.length <= groups.length;
      p = parentOf.get(p)
    )
      chain.push(p);
    return chain;
  };
  const common = (a: string, b: string): string | undefined => {
    const above = new Set(ancestry(b));
    return ancestry(a).find((id) => above.has(id));
  };

  const link = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (link.has(r)) r = link.get(r)!;
    if (r !== k) link.set(k, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) link.set(ra, rb);
  };
  for (const w of board.wires)
    for (const e of [w.a, w.b]) {
      if (e.kind === 'junction') join(`w:${w.id}`, `j:${e.junction}`);
      else if (e.kind === 'tap') join(`w:${w.id}`, `w:${e.wire}`);
    }

  const groupOf = new Map(board.components.map((c) => [c.id, c.group]));
  const junctionAt = new Map(board.junctions.map((j) => [j.id, j.pos]));
  // undefined: no pin seen yet; null: the tree has to cross a border.
  const trees = new Map<string, { group: string | null | undefined; points: Point[] }>();
  for (const w of board.wires) {
    const key = find(`w:${w.id}`);
    const tree = trees.get(key) ?? { group: undefined, points: [] };
    trees.set(key, tree);
    tree.points.push(...(routes?.get(w.id) ?? w.points));
    for (const e of [w.a, w.b]) {
      if (e.kind === 'pin') {
        const g = groupOf.get(e.component);
        if (tree.group === null) continue;
        tree.group =
          g === undefined ? null : tree.group === undefined ? g : (common(tree.group, g) ?? null);
      } else if (e.kind === 'junction') {
        const pos = junctionAt.get(e.junction);
        if (pos) tree.points.push(pos);
      } else tree.points.push(e.pos);
    }
  }
  for (const { group, points } of trees.values()) {
    if (!group) continue;
    const into = out.get(group);
    if (into) for (const p of points) into.push(p);
    else out.set(group, points);
  }
  return out;
}

/** Height of a group's name above its border, in grid units. */
const GROUP_NAME_ROOM = 2;

/** Rects for every group, a nested one enclosing its descendants as well as
 *  its own members -- otherwise a child could poke out of its parent, which
 *  reads as it not being inside at all. */
export function groupRects(
  board: Circuit,
  boundsOf: (id: string) => Rect | undefined,
  g: number,
  routes?: ReadonlyMap<string, Vec2[]>,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  if (!board.groups?.length) return out;
  const ownBounds = new Map<string, Rect[]>();
  for (const c of board.components) {
    if (!c.group) continue;
    const b = boundsOf(c.id);
    if (b) ownBounds.set(c.group, [...(ownBounds.get(c.group) ?? []), b]);
  }
  for (const [id, points] of groupWirePoints(board, routes)) {
    const own = ownBounds.get(id) ?? [];
    for (const p of points) own.push({ x: p.x, y: p.y, w: 0, h: 0 });
    ownBounds.set(id, own);
  }
  const childrenOf = new Map<string, string[]>();
  for (const group of board.groups)
    if (group.parent)
      childrenOf.set(group.parent, [...(childrenOf.get(group.parent) ?? []), group.id]);

  // Depth-first with a guard: a parent cycle is not reachable through the
  // editor, but a hand-edited file could carry one and must not hang a frame.
  const solving = new Set<string>();
  const solve = (id: string): Rect | undefined => {
    const cached = out.get(id);
    if (cached) return cached;
    if (solving.has(id)) return undefined;
    solving.add(id);
    const parts = [...(ownBounds.get(id) ?? [])];
    for (const child of childrenOf.get(id) ?? []) {
      const r = solve(child);
      // The child's name sits above its border; without the room the
      // parent's border would run through it.
      if (r) parts.push({ ...r, y: r.y - GROUP_NAME_ROOM * g, h: r.h + GROUP_NAME_ROOM * g });
    }
    solving.delete(id);
    const rect = groupRect(parts, g);
    if (rect) out.set(id, rect);
    return rect;
  };
  for (const group of board.groups) solve(group.id);
  return out;
}

/** Text inset inside a group's title tab, in world px. */
const GROUP_TAB_PAD = 4;
/** The name's baseline sits this far above the border. */
const GROUP_NAME_LIFT = 2;

/** Where a group's name sits above its border: the bare name, or the tab
 *  drawn behind it. The scene and the name's hit-test both read this, so the
 *  whole visible tab is grabbable. */
export function groupNameBox(group: Group, rect: Rect, textWidth: number, theme: Theme): Rect {
  const tab = !!group.tab && paletteColor(theme, group.color) !== undefined;
  const pad = tab ? GROUP_TAB_PAD : 0;
  const h = theme.glyphText + (tab ? GROUP_NAME_LIFT + 1 : 0);
  return { x: rect.x, y: rect.y - h, w: textWidth + 2 * pad, h };
}

/** Parents before children, so a nested fill stacks on its parent's rather
 *  than being painted over by it. Board order breaks ties. */
function groupsByDepth(groups: readonly Group[]): Group[] {
  const parentOf = new Map(groups.map((g) => [g.id, g.parent]));
  const depth = (id: string): number => {
    let d = 0;
    // Bounded by the group count: a hand-edited parent cycle must not hang.
    for (let p = parentOf.get(id); p !== undefined && d < groups.length; p = parentOf.get(p)) d++;
    return d;
  };
  return groups
    .map((g, i) => ({ g, i, d: depth(g.id) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ g }) => g);
}

function drawGroups(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  board: Circuit,
  geo: ReadonlyMap<string, Geo>,
  routes: ReadonlyMap<string, Vec2[]>,
): void {
  if (!board.groups?.length) return;
  const g = theme.gridSchematic;
  const rects = groupRects(board, (id) => geo.get(id)?.bounds, g, routes);
  ctx.save();
  ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const group of groupsByDepth(board.groups)) {
    const rect = rects.get(group.id);
    if (!rect) continue;
    const color = paletteColor(theme, group.color);
    if (color) {
      ctx.globalAlpha = theme.groupFillAlpha;
      ctx.fillStyle = color;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color ?? theme.colors.line;
    ctx.lineWidth = color ? theme.strokes.min : 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([]);
    const name = oneLine(group.name);
    const box = groupNameBox(group, rect, ctx.measureText(name).width, theme);
    if (group.tab && color) {
      ctx.fillStyle = color;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      // The palette is tuned against the surface, so surface on a slot reads
      // as well as the slot on the surface.
      ctx.fillStyle = theme.colors.surface;
      ctx.fillText(name, box.x + GROUP_TAB_PAD, rect.y - GROUP_NAME_LIFT);
    } else {
      ctx.fillStyle = color ?? theme.colors.muted;
      ctx.fillText(name, rect.x, rect.y - GROUP_NAME_LIFT);
    }
  }
  ctx.restore();
}

/** How far a glyph may paint outside its bounds, in world units. A caption
 *  draws outside them, and anything past the tile's slack is rasterised away
 *  rather than merely uncached -- which cut "AB + A'C + BC" short on the
 *  consensus board. */
function glyphPad(comp: Component, theme: Theme): number {
  return captionPad(comp.label ?? '', theme.glyphText, theme.gridSchematic) || SCRATCH_PAD;
}

function paintComponent(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  comp: Component,
  p: GlyphContext,
  bounds: Rect | undefined,
  scale: number,
): void {
  if (!bounds) {
    drawComponent(ctx, theme, comp, p);
    return;
  }
  drawCachedGlyph(
    ctx,
    glyphKey(comp, theme, p),
    scale,
    bounds,
    (c) => drawComponent(c, theme, comp, p),
    glyphPad(comp, theme),
  );
}

export function drawComponent(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  comp: Component,
  p: GlyphContext,
): void {
  const input = geometryInput(comp, p.chipLib);
  const placement: Placement = { pos: comp.pos, rot: comp.rot, mirror: comp.mirror };
  const on = (pin: string) => p.pinSignal(comp.id, pin) === '1';
  const raw = (pin: string) => p.pinRawValue?.(comp.id, pin) ?? { v: 0, x: 0xffffffff, z: 0 };
  // No sim running: `raw` above is an all-X placeholder, which must not colour
  // a stub amber while every other unpowered glyph draws in ink.
  const live = input.pins.some((pin) => p.pinSignal(comp.id, pin.name) !== undefined);

  // A theme may redraw an I/O device outright; geometry still comes from the
  // canonical builder, so pins and bounds are unaffected.
  const variant = glyphVariant(theme, comp.kind);
  if (
    variant &&
    variant(ctx, theme, input, placement, {
      state: (pin) => p.pinSignal(comp.id, pin),
      raw,
      label: comp.label,
    })
  )
    return;

  if (GATE_SET.has(comp.kind)) {
    // Bubble params (base-kind + outputBubble/inputBubbles, see core/gates)
    // override the kind-derived bubbles only when actually present --
    // components without them keep today's 4-arg path bit-for-bit. The
    // bubbleOnly bare-marker form is dispatched inside drawGate itself.
    // Normalize first: a composed kind (nand) carrying leftover inputBubbles
    // params would otherwise read output=false from params alone and lose its
    // kind-derived output bubble outside bubble mode.
    const norm = normalizeGateComponent(comp);
    const hasBubbleParams =
      norm.params !== undefined && ('outputBubble' in norm.params || 'inputBubbles' in norm.params);
    drawGate(
      ctx,
      theme,
      comp.kind as GateKind,
      input,
      placement,
      hasBubbleParams
        ? { output: getOutputBubble(norm), inputs: getInputBubbles(norm) }
        : undefined,
      comp.label,
      (pin) => p.pinSignal(comp.id, pin),
    );
  } else if (comp.kind === 'toggle') {
    drawSwitch(ctx, theme, input, placement, raw, comp.label, live);
  } else if (comp.kind === 'button') {
    if (contactToGround(input.params)) {
      const stub = p.pinSignal(comp.id, 'y');
      // A scrub has no press history, so it reads the pulled-down net instead.
      const held = p.heldOf?.(comp.id) ?? stub === '0';
      drawButton(ctx, theme, input, placement, held, comp.label, live, { stub });
    } else drawButton(ctx, theme, input, placement, on('y'), comp.label, live);
  } else if (comp.kind === 'spdt') {
    const position =
      p.throwOf?.(comp.id) ??
      throwFromPins((pin) => p.pinSignal(comp.id, pin)) ??
      spdtPosition((comp.params ?? {}) as Params);
    drawSpdt(ctx, theme, placement, position, (pin) => p.pinSignal(comp.id, pin), comp.label);
  } else if (comp.kind === 'led') {
    drawLed(ctx, theme, input, placement, raw, comp.label, live);
  } else if (comp.kind === 'clock') {
    drawClock(ctx, theme, input, placement, comp.label);
  } else if (comp.kind === 'pattern') {
    drawPattern(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin), comp.label);
  } else if (comp.kind === 'timer555') {
    drawTimer(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin), comp.label);
  } else if (comp.kind === 'sevenseg') {
    // A common-anode display lights on a driven 0 and stays dark on Z, which
    // is exactly what an open-collector 74LS47 gives it. The common terminal
    // has to be at the matching rail too: unwired means dark, as on the bench.
    // The two commons are one net after compile, so either lead carries the
    // rail; reading the one that is actually wired is what the bench does.
    const common = sevenSegCommon(comp.params ?? {});
    const commonState = COMMON_PINS.map((c) => p.pinSignal(comp.id, c)).find(
      (v) => v !== undefined,
    );
    const lit = new Set(
      SEGMENTS.filter((s) => segmentLit(p.pinSignal(comp.id, s), common, commonState)),
    );
    drawSevenSeg(ctx, theme, input, placement, lit, (pin) => p.pinSignal(comp.id, pin), comp.label);
  } else if (comp.kind === 'ledmatrix') {
    drawLedMatrix(
      ctx,
      theme,
      input,
      placement,
      (row, col) => matrixDotLit(p.pinSignal(comp.id, row), p.pinSignal(comp.id, col)),
      (pin) => p.pinSignal(comp.id, pin),
      comp.label,
    );
  } else if (comp.kind === 'probe') {
    // A literal '?' reads as a stuck/broken probe; the component's own id is
    // always present and unique, so it's a sensible default name for a
    // probe nobody bothered to label.
    drawProbe(
      ctx,
      theme,
      input,
      placement,
      comp.label ?? comp.id,
      // Undefined, not 'X': an unpowered probe draws in ink like every other
      // glyph at rest rather than flagging a placeholder value as unknown.
      (pin) => p.pinSignal(comp.id, pin),
    );
  } else if (comp.kind === 'busdisplay') {
    // Same label fallback as the probe above, and the same one the registered
    // geometry sizes the tag rect from -- a fixed placeholder here drew every
    // bus display as '--' in a box measured for its real name.
    drawBusDisplay(ctx, theme, input, placement, comp.label ?? comp.id, (pin) =>
      p.pinSignal(comp.id, pin),
    );
  } else if (comp.kind === 'inport' || comp.kind === 'outport') {
    drawPort(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin));
  } else if (comp.kind === 'netlabel') {
    drawNetLabel(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin));
  } else if (comp.kind === 'vcc' || comp.kind === 'gnd') {
    drawRail(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin));
  } else if (comp.kind === 'pullup' || comp.kind === 'pulldown') {
    drawPull(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin));
  } else if (comp.kind === 'constant') {
    drawConstant(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin));
  } else if (BOX_SET.has(comp.kind)) {
    const missingDef = comp.kind === 'chip' && !!comp.defId && !p.chipLib.get(comp.defId);
    const appearance = comp.defId ? p.chipLib.get(comp.defId)?.appearance : undefined;
    const tint = {
      body: chipTintColor(theme, appearance?.color),
      border: chipTintColor(theme, appearance?.borderColor),
    };
    if (!missingDef && isDipPackage(appearance?.package)) {
      drawDip(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin), tint);
      return;
    }
    drawBox(
      ctx,
      theme,
      input,
      placement,
      (pin) => p.pinSignal(comp.id, pin),
      missingDef,
      comp.label,
      tint,
    );
  }
}

/**
 * Which of a wire's own ends land on something a glyph already draws (a pin
 * stub, a junction dot, a tap mark) rather than hanging free. Those ends need
 * their joint closed; a free end is deliberately a bare tip.
 */
function attachedEnds(wire: Wire): [boolean, boolean] {
  return [wire.a.kind !== 'free', wire.b.kind !== 'free'];
}

function drawWire(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  pts: Vec2[],
  state: SignalState | undefined,
  width: number,
  ghost = false,
  // Ends to close against whatever they attach to. A wire and a pin stub are
  // separate butt-capped strokes, so where they meet at a right angle each cap
  // stops at the shared point and the outer corner -- half a stroke width --
  // is left unpainted: the two read as touching, not joined. Every corner
  // WITHIN a wire is a rounded lineJoin, which is why only the pin end shows
  // it, and only when the wire arrives perpendicular.
  attached: readonly [boolean, boolean] = [false, false],
  sheath?: string,
): void {
  const style = state ? signalStyle(theme, state) : undefined;
  ctx.globalAlpha = ghost ? 0.45 : 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = theme.glyph.pinCap;
  const r = theme.strokes.cornerRadius;
  const path = () => {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length - 1; i++)
      ctx.arcTo(pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y, r);
    ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
  };
  if (sheath) {
    // Insulation, then a paper gap, so the signal core stays readable even
    // where the sheath shares its hue.
    ctx.beginPath();
    path();
    ctx.setLineDash([]);
    ctx.lineWidth = sheathWidth(theme, width);
    ctx.strokeStyle = sheath;
    ctx.stroke();
    ctx.lineWidth = coreWidth(theme, width) + theme.strokes.wire;
    ctx.strokeStyle = theme.colors.paper;
    ctx.stroke();
  }
  ctx.lineWidth = coreWidth(theme, width);
  // Emphasis rides an asserted wire only; a settled 0 must stay quiet.
  if (state === '1' && !ghost) {
    ctx.beginPath();
    path();
    paintEmphasis(ctx, theme, signalStyle(theme, '1').color, path, false);
  }
  ctx.beginPath();
  path();
  ctx.strokeStyle = style?.color ?? theme.colors.muted;
  ctx.setLineDash(style?.dashed || ghost ? [5, 4] : []);
  ctx.stroke();
  // Mixed bus: the alternating second pass reads as "some bits high, some
  // low" without relying on hue alone.
  if (style?.alt) strokeMixedPass(ctx, style.alt);
  ctx.setLineDash([]);
  ctx.fillStyle = style?.color ?? theme.colors.muted;
  if (attached[0]) fillJoint(ctx, theme, pts[0]!, pts[1], ctx.lineWidth);
  if (attached[1]) fillJoint(ctx, theme, pts[pts.length - 1]!, pts[pts.length - 2], ctx.lineWidth);
  ctx.globalAlpha = 1;
}

function coreWidth(theme: Theme, busWidth: number): number {
  return busWidth > 1 ? theme.strokes.bus : theme.strokes.wire;
}

/** A sheath shows a band one wire stroke wide each side of the paper gap. */
function sheathWidth(theme: Theme, busWidth: number): number {
  return coreWidth(theme, busWidth) + theme.strokes.wire * 3;
}

/**
 * Paints the corner two butt caps leave open where a wire meets a pin stub:
 * this wire's own width across its last segment, the stub's width along it.
 * Sized to the two strokes it joins rather than squared off, so a 4px bus
 * never bulges past the 2px stub band it lands on. Already-painted at a
 * collinear arrival or under a junction dot, so it costs nothing there.
 */
function fillJoint(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  end: Vec2,
  toward: Vec2 | undefined,
  wireW: number,
): void {
  if (!toward) return;
  const stubW = theme.strokes.wire;
  const horizontal = end.y === toward.y;
  const w = horizontal ? stubW : wireW;
  const h = horizontal ? wireW : stubW;
  ctx.fillRect(end.x - w / 2, end.y - h / 2, w, h);
}

function drawJunction(ctx: CanvasRenderingContext2D, theme: Theme, pos: Vec2): void {
  const r = theme.strokes.wire * 1.4;
  ctx.beginPath();
  junctionPath(ctx, theme, pos, r);
  ctx.fillStyle = theme.colors.ink;
  ctx.fill();
}

/** A junction is always explicit; only its mark's shape is a theme's to pick. */
function junctionPath(ctx: CanvasRenderingContext2D, theme: Theme, pos: Vec2, r: number): void {
  const { x, y } = pos;
  switch (theme.glyph.junctionDot) {
    case 'square':
      ctx.rect(x - r, y - r, r * 2, r * 2);
      return;
    case 'diamond':
      ctx.moveTo(x, y - r * 1.3);
      ctx.lineTo(x + r * 1.3, y);
      ctx.lineTo(x, y + r * 1.3);
      ctx.lineTo(x - r * 1.3, y);
      ctx.closePath();
      return;
    case 'star':
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        const rad = i % 2 === 0 ? r * 1.8 : r * 0.7;
        const px = x + Math.cos(a) * rad;
        const py = y + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      return;
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function drawTapPoint(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  pos: Vec2,
  range: { hi: number; lo: number },
): void {
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, theme.strokes.wire * 1.4, 0, Math.PI * 2);
  ctx.fillStyle = theme.colors.surface;
  ctx.fill();
  ctx.strokeStyle = theme.colors.ink;
  ctx.lineWidth = theme.strokes.min;
  ctx.stroke();
  const label = range.hi === range.lo ? `[${range.hi}]` : `[${range.hi}:${range.lo}]`;
  ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, pos.x + theme.gridSchematic * 0.3, pos.y - theme.gridSchematic * 0.2);
}

const within = (a: Rect, b: Rect, gap: number) =>
  a.x <= b.x + b.w + gap &&
  b.x <= a.x + a.w + gap &&
  a.y <= b.y + b.h + gap &&
  b.y <= a.y + a.h + gap;

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** One padded box per highlighted part; boxes less than a grid square apart
 *  merge, so close parts (a column of flag LEDs) read as one group rather than
 *  a stack of crossed or doubled rings. */
export function lessonHighlightBoxes(parts: readonly Rect[], theme: Theme): Rect[] {
  const grid = theme.gridSchematic;
  const boxes = parts.map((r) => inflateRect(r, grid * 1.2));
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++)
      for (let j = i + 1; j < boxes.length; j++)
        if (within(boxes[i]!, boxes[j]!, grid)) {
          boxes[i] = union(boxes[i]!, boxes[j]!);
          boxes.splice(j, 1);
          merged = true;
          break;
        }
  }
  return boxes;
}

/** A changed net's ring: a halo along the wire, under its own signal colour. */
export function gateRingWire(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  pts: readonly Vec2[],
  haloWidth: number,
): void {
  // Opaque: the token's contrast is the ring's, and a class reads it from the back row.
  ctx.save();
  ctx.strokeStyle = theme.colors.gateRipple;
  ctx.lineWidth = haloWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
  ctx.stroke();
  ctx.restore();
}

/** A part still due to move: a fine dashed box with a "pending" tag over its corner. */
export function gatePendingOutline(ctx: CanvasRenderingContext2D, theme: Theme, b: Rect): void {
  const grid = theme.gridSchematic;
  const pad = grid * 0.375;
  ctx.save();
  ctx.strokeStyle = theme.colors.gatePending;
  ctx.lineWidth = theme.strokes.min;
  ctx.setLineDash([grid * 0.375, grid * 0.375]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  ctx.setLineDash([]);
  ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
  ctx.fillStyle = theme.colors.gatePending;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('pending', b.x - pad, b.y - pad * 1.5);
  ctx.restore();
}

export function lessonOutline(ctx: CanvasRenderingContext2D, theme: Theme, box: Rect): void {
  const grid = theme.gridSchematic;
  ctx.strokeStyle = theme.colors.lessonHighlight;
  ctx.lineWidth = theme.strokes.min * 2;
  ctx.setLineDash([grid * 0.75, grid * 0.5]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
}

function outline(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  b: Rect,
  color: string,
  padScale = 1,
  solid = false,
): void {
  const pad = theme.gridSchematic * 0.5 * padScale;
  ctx.strokeStyle = color;
  ctx.lineWidth = solid ? theme.strokes.min * 2.5 : theme.strokes.min;
  ctx.setLineDash(solid ? [] : [4, 3]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  ctx.setLineDash([]);
}
