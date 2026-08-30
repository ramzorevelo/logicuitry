// Board -> canvas: glyph dispatch, orthogonal wire drawing with live signal
// color, junctions, selection, and wiring/ghost overlays. Pure draw over a
// viewport transform; all state comes in through RenderParams.

import type { ChipLibrary, Circuit, Component, Wire, WireEnd } from '../../core/model/types';
import {
  drawStubBusBadge,
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
import { netPins, type PinRef } from '../../core/gates/netGraph';
import { drawBox, drawConstant } from '../../render/glyphs/chip';
import {
  drawBusDisplay,
  drawButton,
  drawClock,
  drawLed,
  drawNetLabel,
  drawPort,
  drawProbe,
  drawSevenSeg,
  drawSevenSegHex,
  drawSwitch,
} from '../../render/glyphs/io';
import type { GeometryInput, Placement } from '../../render/glyphs/symbol';
import {
  busLabelGeometry,
  pinKeysOfWires,
  shouldShowPinBusBadge,
  wireBusWidth,
  type BusBadgeContext,
} from './busBadge';
import { occupancyKey, wiredPinKeys } from './pinTargets';
import { pinFacing } from './smartConnect';
import { getPrefs } from '../prefs';
import type { Rect, Vec2, Viewport } from '../../render/scene';
import { chipTintColor, signalStyle, type SignalState, type Theme } from '../../render/theme';
import { computeWireRoutes, pointAlongPolyline, routeAvoiding, routeOrthogonal } from './wireGeom';
import { GHOST_ALPHA } from '../../render/ghostPreview';
import { drawCachedGlyph } from '../../render/glyphCache';
import { lodFor } from '../../render/lod';
import { paintEmphasis } from '../../render/glyphs/relief';
import { glyphVariant } from '../../render/glyphs/variants';
import '../../render/glyphs/charVariants'; // side-effect: registers per-theme device glyphs

const GATE_SET = new Set<string>(GATE_KINDS);
const BOX_SET = new Set([
  'chip',
  'dff',
  'dlatch',
  'register',
  'mux',
  'demux',
  'decoder',
  'encoder',
]);
const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

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
}

/** Cache identity for one component's glyph: everything the drawing depends on
 *  except its position. Chip instances are excluded by the caller, since a def
 *  edit changes their drawing without changing anything visible here. */
function glyphKey(comp: Component, theme: Theme, p: GlyphContext): string {
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
  ];
  for (const pin of resolveComponentPins(comp, undefined)) {
    const raw = p.pinRawValue?.(comp.id, pin.name);
    parts.push(`${pin.name}${p.pinSignal(comp.id, pin.name) ?? '?'}`);
    if (raw) parts.push(`${raw.v}/${raw.x}/${raw.z}`);
  }
  return parts.join('|');
}

export interface RenderParams extends GlyphContext {
  /** The active tab's circuit body: the board, or an open ChipDef being edited. */
  board: Circuit;
  viewport: Viewport;
  selection: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  /** Chip instances with a re-bind badge (a def edit stranded one of their wires). */
  stale?: ReadonlySet<string>;
  hoverPin?: Vec2 | undefined;
  // Full polyline (start pin/free-point, every committed bend, live cursor
  // point) -- not just a single from/to elbow, per P1.6's multi-bend drawing.
  wiringPreview?: Vec2[] | undefined;
  grid: number;
  /** Backing-store scale: canvas.width = cssWidth * dpr. */
  dpr?: number;
  /** Pending-placement ghost, drawn last at reduced alpha. */
  ghost?: Component | undefined;
  /** In-progress lasso-select rectangle, world space. */
  lasso?: Rect | undefined;
  /** Wires the in-progress cut slash currently crosses, highlighted before delete. */
  cutFlags?: ReadonlySet<string> | undefined;
  /** In-progress wire-cut freehand slash. */
  cutSlash?: { from: Vec2; to: Vec2 } | undefined;
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
  /** Net labels sharing the hovered/selected label's name. A name join has no
   *  wire to look at, so an accidental one is invisible until the peers say
   *  so -- this is the only thing that shows the join. */
  peerLabels?: ReadonlySet<string> | undefined;
  /** STA overlay: per-wire path role + per-component hop delay labels. */
  staOverlay?:
    | {
        criticalWires: ReadonlySet<string>;
        shortWires: ReadonlySet<string>;
        labels: ReadonlyMap<string, string>;
        shortLabels: ReadonlyMap<string, string>;
      }
    | undefined;
}

interface Geo {
  bounds: Rect;
  pins: Map<string, Vec2>;
}

export function renderBoard(ctx: CanvasRenderingContext2D, theme: Theme, p: RenderParams): void {
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
  drawGrid(ctx, theme, p, cssW, cssH);

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
  theme = { ...theme, lod: lodFor(vp.zoom, p.board.components.length) };

  const geo = new Map<string, Geo>();
  for (const comp of p.board.components) {
    const def = comp.defId ? p.chipLib.get(comp.defId) : undefined;
    geo.set(comp.id, symbolBounds(comp, theme, def));
  }

  // Group borders go down first, so every wire and body draws over them: the
  // border says "these belong together", it is not part of the circuit.
  drawGroups(ctx, theme, p.board, geo);

  const resolveEnd = (end: WireEnd): Vec2 | undefined => {
    if (end.kind === 'pin') return geo.get(end.component)?.pins.get(end.pin);
    if (end.kind === 'junction') return p.board.junctions.find((j) => j.id === end.junction)?.pos;
    return end.pos; // 'free' and 'tap' both carry their own click point
  };

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
  const boundsById = new Map([...geo.entries()].map(([id, g]) => [id, g.bounds]));
  const routes = computeWireRoutes(p.board.wires, resolveEnd, boundsById, p.grid);

  for (const wire of p.board.wires) {
    const a = resolveEnd(wire.a);
    const b = resolveEnd(wire.b);
    if (!a || !b) continue;
    const pts = routes.get(wire.id)!;
    const info =
      endpointInfo(p, geo, wire.a) ?? endpointInfo(p, geo, wire.b) ?? netEndpointInfo(p, wire);
    if (p.highlightWires?.has(wire.id)) {
      // Waveform-track hover halo, drawn under the wire's own signal color.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = theme.colors.accent;
      ctx.lineWidth = theme.strokes.wire * 4;
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
      ctx.lineWidth = theme.strokes.wire * 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
      ctx.restore();
    }
    // Width comes from the shared resolver, not from `info`, so the badge's
    // own hit-test agrees with what is drawn about which wires have a label.
    const busWidth = wireBusWidth(p.board, p.chipLib, wire);
    drawWire(ctx, theme, pts, info?.state, busWidth, false, attachedEnds(wire));
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
    if (p.selection.has(wire.id) || p.cutFlags?.has(wire.id)) {
      ctx.strokeStyle = p.cutFlags?.has(wire.id) ? theme.colors.warn : theme.colors.accent;
      ctx.lineWidth = theme.strokes.wire + 4;
      ctx.globalAlpha = 0.35;
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

  for (const j of p.board.junctions) drawJunction(ctx, theme, j.pos);

  // A wired pin's width is already stated by the wire's own bus glyph; drawing
  // it twice is noise on a board full of buses.
  const badgeRule: BusBadgeContext = {
    wired: wiredPinKeys(p.board.wires),
    mismatched: pinKeysOfWires(p.board.wires, p.mismatchWires),
    alwaysShow: getPrefs().alwaysShowPinBusWidth,
  };

  for (const comp of p.board.components) {
    paintComponent(ctx, theme, comp, p, geo.get(comp.id)?.bounds, dpr * vp.zoom);
    const g = geo.get(comp.id);
    if (!g) continue;
    drawPinBusBadges(ctx, theme, comp, g, p.chipLib, badgeRule);
    if (p.selection.has(comp.id)) outline(ctx, theme, g.bounds, theme.colors.accent);
    else if (p.changed.has(comp.label || comp.id)) outline(ctx, theme, g.bounds, theme.colors.warn);
    else if (p.stale?.has(comp.id)) outline(ctx, theme, g.bounds, theme.colors.warn);
    if (p.paramHighlight?.has(comp.id)) outline(ctx, theme, g.bounds, theme.colors.ok, 1.8);
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
    const oGeo = new Map<string, Geo>();
    for (const comp of ob.components) {
      const def = comp.defId ? p.chipLib.get(comp.defId) : undefined;
      oGeo.set(comp.id, symbolBounds(comp, theme, def));
    }
    const oResolve = (end: WireEnd): Vec2 | undefined => {
      if (end.kind === 'pin') return oGeo.get(end.component)?.pins.get(end.pin);
      if (end.kind === 'junction') return ob.junctions.find((j) => j.id === end.junction)?.pos;
      if (end.kind === 'free' || end.kind === 'tap') return end.pos;
      return undefined;
    };
    const oBounds = new Map([...oGeo.entries()].map(([id, g]) => [id, g.bounds]));
    const oRoutes = computeWireRoutes(ob.wires, oResolve, oBounds, p.grid);
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
    const bodyObstacles = [...boundsById.values()];
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
  if (p.cutSlash) {
    ctx.strokeStyle = theme.colors.warn;
    ctx.lineWidth = theme.strokes.wire;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(p.cutSlash.from.x, p.cutSlash.from.y);
    ctx.lineTo(p.cutSlash.to.x, p.cutSlash.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (p.lasso) {
    ctx.strokeStyle = theme.colors.accent;
    ctx.fillStyle = theme.colors.accent;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(p.lasso.x, p.lasso.y, p.lasso.w, p.lasso.h);
    ctx.globalAlpha = 1;
    ctx.lineWidth = theme.strokes.min;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(p.lasso.x, p.lasso.y, p.lasso.w, p.lasso.h);
    ctx.setLineDash([]);
  }
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
  const center = { x: g.bounds.x + g.bounds.w / 2, y: g.bounds.y + g.bounds.h / 2 };
  const stub = theme.gridSchematic;
  for (const pin of pins) {
    const tip = g.pins.get(pin.name);
    if (!tip) continue;
    if (!shouldShowPinBusBadge(pin.width, occupancyKey(comp.id, pin.name), rule)) continue;
    // The stub runs inward from the tip; its far end is only needed for the
    // badge's own axis, so one grid unit along the facing is enough.
    const facing = pinFacing(tip, center);
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

/** Rects for every group, a nested one enclosing its descendants as well as
 *  its own members -- otherwise a child could poke out of its parent, which
 *  reads as it not being inside at all. */
export function groupRects(
  board: Circuit,
  boundsOf: (id: string) => Rect | undefined,
  g: number,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  if (!board.groups?.length) return out;
  const ownBounds = new Map<string, Rect[]>();
  for (const c of board.components) {
    if (!c.group) continue;
    const b = boundsOf(c.id);
    if (b) ownBounds.set(c.group, [...(ownBounds.get(c.group) ?? []), b]);
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
      if (r) parts.push(r);
    }
    solving.delete(id);
    const rect = groupRect(parts, g);
    if (rect) out.set(id, rect);
    return rect;
  };
  for (const group of board.groups) solve(group.id);
  return out;
}

function drawGroups(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  board: Circuit,
  geo: ReadonlyMap<string, Geo>,
): void {
  if (!board.groups?.length) return;
  const g = theme.gridSchematic;
  const rects = groupRects(board, (id) => geo.get(id)?.bounds, g);
  for (const group of board.groups) {
    const rect = rects.get(group.id);
    if (!rect) continue;
    ctx.save();
    ctx.strokeStyle = theme.colors.line;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([]);
    ctx.fillStyle = theme.colors.muted;
    ctx.font = `${theme.glyphText}px ${theme.fonts.mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(oneLine(group.name), rect.x, rect.y - 2);
    ctx.restore();
  }
}

function paintComponent(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  comp: Component,
  p: GlyphContext,
  bounds: Rect | undefined,
  scale: number,
): void {
  // A chip's drawing follows its def, which can change under a stable key.
  if (!bounds || comp.kind === 'chip') {
    drawComponent(ctx, theme, comp, p);
    return;
  }
  // A caption draws OUTSIDE the component's bounds, and anything past the
  // tile's slack is rasterised away rather than merely uncached -- which cut
  // "AB + A'C + BC" short on the consensus board.
  const pad = captionPad(comp.label ?? '', theme.glyphText, theme.gridSchematic);
  drawCachedGlyph(
    ctx,
    glyphKey(comp, theme, p),
    scale,
    bounds,
    (c) => drawComponent(c, theme, comp, p),
    pad || undefined,
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
    drawButton(ctx, theme, input, placement, on('y'), comp.label, live);
  } else if (comp.kind === 'led') {
    drawLed(ctx, theme, input, placement, raw, comp.label, live);
  } else if (comp.kind === 'clock') {
    drawClock(ctx, theme, input, placement, comp.label);
  } else if (comp.kind === 'sevenseg') {
    const lit = new Set(SEGMENTS.filter((s) => p.pinSignal(comp.id, s) === '1'));
    drawSevenSeg(ctx, theme, input, placement, lit);
  } else if (comp.kind === 'sevenseghex') {
    drawSevenSegHex(ctx, theme, input, placement, 0);
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
  } else if (comp.kind === 'constant') {
    drawConstant(ctx, theme, input, placement, (pin) => p.pinSignal(comp.id, pin));
  } else if (BOX_SET.has(comp.kind)) {
    const missingDef = comp.kind === 'chip' && !!comp.defId && !p.chipLib.get(comp.defId);
    const appearance = comp.defId ? p.chipLib.get(comp.defId)?.appearance : undefined;
    drawBox(
      ctx,
      theme,
      input,
      placement,
      (pin) => p.pinSignal(comp.id, pin),
      missingDef,
      comp.label,
      {
        body: chipTintColor(theme, appearance?.color),
        border: chipTintColor(theme, appearance?.borderColor),
      },
    );
  }
}

/** Width deliberately absent: it comes from wireBusWidth, so nothing here can
 *  report a second, disagreeing answer. */
interface EndInfo {
  state?: SignalState;
}

function pinEndInfo(p: RenderParams, ref: PinRef): EndInfo | undefined {
  const comp = p.board.components.find((c) => c.id === ref.component);
  if (!comp) return undefined;
  const def = comp.defId ? p.chipLib.get(comp.defId) : undefined;
  if (!resolveComponentPins(comp, def).some((s) => s.name === ref.pin)) return undefined;
  const state = p.pinSignal(ref.component, ref.pin);
  return state ? { state } : {};
}

function endpointInfo(p: RenderParams, geo: Map<string, Geo>, end: WireEnd): EndInfo | undefined {
  if (end.kind !== 'pin') return undefined;
  return pinEndInfo(p, { component: end.component, pin: end.pin });
}

/** A wire with no direct pin end (e.g. junction-to-free-end, split off the
 *  middle of a bus and dropped in empty space) still carries the tapped
 *  net's real width/state -- walk the net from each end to the nearest
 *  reachable pin instead of defaulting to a thin 1-bit wire with no bus
 *  badge. Direct pin ends are always tried first (`endpointInfo`); this is
 *  strictly a fallback, so it only pays the graph-walk cost when needed. */
function netEndpointInfo(p: RenderParams, wire: { a: WireEnd; b: WireEnd }): EndInfo | undefined {
  for (const end of [wire.a, wire.b]) {
    if (end.kind === 'pin') continue;
    for (const ref of netPins(p.board, end)) {
      const info = pinEndInfo(p, ref);
      if (info) return info;
    }
  }
  return undefined;
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
): void {
  const style = state ? signalStyle(theme, state) : undefined;
  ctx.lineWidth = width > 1 ? theme.strokes.bus : theme.strokes.wire;
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

function outline(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  b: Rect,
  color: string,
  padScale = 1,
): void {
  const pad = theme.gridSchematic * 0.5 * padScale;
  ctx.strokeStyle = color;
  ctx.lineWidth = theme.strokes.min;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  ctx.setLineDash([]);
}
