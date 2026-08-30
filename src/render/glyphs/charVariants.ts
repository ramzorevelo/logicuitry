// Per-character panel-device glyphs: output indicator, switch, button, clock.
// Each replaces the canonical IEC/box drawing with an object from that
// character's own visual language, which the overhaul spec allows precisely
// because geometry still comes from the canonical layout functions -- the
// bounding box and every pin anchor are identical, so wiring, routing,
// hit-testing and rotation never notice the difference.
//
// Two rules every variant keeps:
//   - lit/unlit and on/off separate in GRAYSCALE, by fill, not by hue;
//   - the wire and the pin stub keep the signal colour language exactly, so
//     logic 1 reads the same everywhere. Only what is INSIDE a lit device --
//     its fill, halo and emission ticks -- uses the character's glow (accent3),
//     which is decoration, not state.

import { bitState, drawStub, withPlacement, type GeometryInput, type Placement } from './symbol';
import {
  buttonCapCircle,
  buttonLayout,
  clockLayout,
  dipBankLayout,
  drawDeviceLabel,
  ledBankLayout,
  ledLayout,
  switchLayout,
} from './io';
import { paintEmphasis } from './relief';
import type { Theme } from '../theme';
import { registerGlyphVariant, type VariantState } from './variants';

/** Draws an indicator body centred on (cx, cy) with radius r. */
type Shape = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => void;

/** Interior facet lines, drawn over a filled body. Without them a solid
 *  silhouette reads as a flat sticker at TV distance; these are what make the
 *  crystal, the star and the wings read as objects. */
type Facets = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => void;

interface Motif {
  body: Shape;
  facets?: Facets;
  emission?: Emission;
  /** Replaces the flat fill. Called with the body already clipped, so it can
   *  paint freely and stay inside the silhouette. */
  fill?: (
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    cx: number,
    cy: number,
    r: number,
    on: boolean,
  ) => void;
  /** Outline colour; ink unless a character's mark is defined by its own. */
  outline?: 'ink' | 'accent';
}

/** Cyrene: a cut crystal shard -- the faceted lozenge of her wings and her
 *  memory cards. Many edges, tapering to a point at both ends; the facets run
 *  lengthwise like a real gem's, never across it. */
const shard: Motif = {
  body: (ctx, cx, cy, r) => {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.34, cy - r * 0.62);
    ctx.lineTo(cx + r * 0.52, cy - r * 0.1);
    ctx.lineTo(cx + r * 0.4, cy + r * 0.52);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r * 0.4, cy + r * 0.52);
    ctx.lineTo(cx - r * 0.52, cy - r * 0.1);
    ctx.lineTo(cx - r * 0.34, cy - r * 0.62);
    ctx.closePath();
  },
  facets: (ctx, cx, cy, r) => {
    // Lengthwise only: a crossing line would read as a seam, not a facet.
    ctx.moveTo(cx - r * 0.34, cy - r * 0.62);
    ctx.lineTo(cx - r * 0.18, cy + r * 0.62);
    ctx.moveTo(cx + r * 0.34, cy - r * 0.62);
    ctx.lineTo(cx + r * 0.18, cy + r * 0.62);
  },
};

/** Himeko: the four-point star of the Nova insignia. */
const star: Motif = {
  body: (ctx, cx, cy, r) => {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.36;
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  },
  facets: (ctx, cx, cy, r) => {
    // Ridge lines from the centre to each point, like the mech's panel edging.
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 - Math.PI / 2;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
    }
  },
};

/** Kinich: a voxel cluster -- his damage numbers, his scanner and his burst
 *  field are all literal blocks. Traced as ONE cross outline rather than five
 *  rects, so the border is a single thin line instead of a grid of boxes, and
 *  it is drawn in his own jade rather than ink. */
const voxel: Motif = {
  outline: 'accent',
  body: (ctx, cx, cy, r) => {
    const h = r * 0.3; // half a cell
    const pts: readonly [number, number][] = [
      [-1, -3],
      [1, -3],
      [1, -1],
      [3, -1],
      [3, 1],
      [1, 1],
      [1, 3],
      [-1, 3],
      [-1, 1],
      [-3, 1],
      [-3, -1],
      [-1, -1],
    ];
    pts.forEach(([px, py], i) => {
      const x = cx + px * h;
      const y = cy + py * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  },
  fill: (ctx, theme, cx, cy, r, on) => {
    const u = r * 0.3;
    const span = 4; // cells from centre, comfortably past the arms
    for (let gy = -span; gy <= span; gy++)
      for (let gx = -span; gx <= span; gx++) {
        const x = cx + gx * u - u / 2;
        const y = cy + gy * u - u / 2;
        if (on) {
          // Pixelated gradient: brightest at the centre, falling off to the
          // edges, so the block reads as lit from within rather than flat.
          const d = Math.min(1, Math.hypot(gx, gy) / span);
          ctx.globalAlpha = Math.max(0.15, 1 - d * 1.15);
          ctx.fillStyle = theme.colors.accent3;
        } else {
          if ((gx + gy) % 2 !== 0) continue; // checker
          ctx.globalAlpha = 1;
          // The same colour an unasserted wire carries, so an unlit block
          // reads as logic 0 rather than as its own decoration.
          ctx.fillStyle = theme.colors.muted;
        }
        ctx.fillRect(x, y, u, u);
      }
    ctx.globalAlpha = 1;
  },
};

/** Silver Wolf: a circle actually rasterised onto a pixel grid -- built from
 *  per-row runs, so every edge is a 90-degree step and never a diagonal. This
 *  is what keeps her apart from Kinich's cross-shaped voxel cluster. */
const PIXEL_CIRCLE_CELLS = 7; // odd, so the disc has a true centre row

/** Half-width in cells of each raster row of the disc. */
function pixelDiscRows(): number[] {
  const half = PIXEL_CIRCLE_CELLS / 2;
  return Array.from({ length: PIXEL_CIRCLE_CELLS }, (_, row) => {
    const dy = row + 0.5 - half;
    return Math.max(1, Math.round(Math.sqrt(Math.max(0, half * half - dy * dy))));
  });
}

const pixelCircle: Motif = {
  emission: 'pixels',
  body: (ctx, cx, cy, r) => {
    // Traced as ONE staircase outline rather than a rect per row: rects would
    // stroke each row's own box, ruling horizontal lines across the disc.
    const rows = pixelDiscRows();
    const u = (2 * r) / PIXEL_CIRCLE_CELLS;
    const top = cy - r;
    const x = (cells: number) => cx + cells * u;
    ctx.moveTo(x(-rows[0]!), top);
    for (let i = 0; i < rows.length; i++) {
      ctx.lineTo(x(rows[i]!), top + i * u);
      ctx.lineTo(x(rows[i]!), top + (i + 1) * u);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      ctx.lineTo(x(-rows[i]!), top + (i + 1) * u);
      ctx.lineTo(x(-rows[i]!), top + i * u);
    }
    ctx.closePath();
  },
  facets: (ctx, cx, cy, r) => {
    // Interior detail is cells knocked out of the disc, not ruled lines --
    // everything of hers resolves into pixels, including its own inside.
    const u = (2 * r) / PIXEL_CIRCLE_CELLS;
    for (const [dx, dy] of [
      [-0.5, -1.5],
      [0.5, -0.5],
      [-1.5, 0.5],
      [0.5, 1.5],
      [1.5, -0.5],
    ] as const)
      ctx.rect(cx + dx * u, cy + dy * u, u, u);
  },
};

/** Geometry of one blade: the hub end, the tip, and the two control points
 *  that bow its edges out to their widest around 55% of its length. Both the
 *  silhouette and its inset edge are built from this, so an inner edge follows
 *  the outline it sits in rather than approximating it. */
function bladePoints(
  cx: number,
  cy: number,
  angle: number,
  len: number,
  halfW: number,
  hub: number,
) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const px = -uy;
  const py = ux;
  const at = (along: number, across: number) => ({
    x: cx + ux * along + px * across,
    y: cy + uy * along + py * across,
  });
  return {
    base: at(hub, 0),
    tip: at(len, 0),
    ctrlOut: at(len * 0.55, -halfW),
    ctrlBack: at(len * 0.55, halfW),
  };
}

/** Firefly: the Ultimate's mark -- four leaf blades radiating from a common
 *  centre, upper pair longer. Traced as ONE closed path: each blade runs out
 *  to its tip and back to a hub circle, and consecutive blades are joined by a
 *  fillet arc along that circle. Drawing them as four separate subpaths left
 *  the mark looking like four disconnected leaves, each with its own outline
 *  meeting at a seam in the middle. */
const LEAVES: readonly { angle: number; len: number; inner: boolean }[] = [
  { angle: (-133 * Math.PI) / 180, len: 1.35, inner: false }, // upper left
  { angle: (-47 * Math.PI) / 180, len: 1.35, inner: false }, // upper right
  { angle: (47 * Math.PI) / 180, len: 1.05, inner: true }, // lower right
  { angle: (133 * Math.PI) / 180, len: 1.05, inner: true }, // lower left
];

function angleGap(from: number, to: number): number {
  let d = to - from - 2 * HUB_HALF_ANGLE;
  while (d < 0) d += 2 * Math.PI;
  return d;
}

/** Half the angular width of a blade where it meets the hub; the rest of the
 *  turn between two blades is the fillet. */
const HUB_HALF_ANGLE = (22 * Math.PI) / 180;

const butterfly: Motif = {
  body: (ctx, cx, cy, r) => {
    const hub = r * 0.26;
    const on = (angle: number) => ({
      x: cx + Math.cos(angle) * hub,
      y: cy + Math.sin(angle) * hub,
    });
    const first = on(LEAVES[0]!.angle - HUB_HALF_ANGLE);
    ctx.moveTo(first.x, first.y);
    LEAVES.forEach(({ angle, len }, i) => {
      const p = bladePoints(cx, cy, angle, r * len, r * 0.36 * len, hub);
      const back = on(angle + HUB_HALF_ANGLE);
      ctx.quadraticCurveTo(p.ctrlOut.x, p.ctrlOut.y, p.tip.x, p.tip.y);
      ctx.quadraticCurveTo(p.ctrlBack.x, p.ctrlBack.y, back.x, back.y);
      // Fillet across to the next blade. Following the hub circle would bulge
      // outward and fill the gap between blades; the join has to be a valley,
      // so the control point sits INSIDE the hub radius.
      const next = LEAVES[(i + 1) % LEAVES.length]!;
      const nextStart = on(next.angle - HUB_HALF_ANGLE);
      const mid = angle + HUB_HALF_ANGLE + angleGap(angle, next.angle) / 2;
      ctx.quadraticCurveTo(
        cx + Math.cos(mid) * hub * 0.34,
        cy + Math.sin(mid) * hub * 0.34,
        nextStart.x,
        nextStart.y,
      );
    });
    ctx.closePath();
  },
  facets: (ctx, cx, cy, r) => {
    // The lower blades keep an inset edge that follows their own outline (a
    // scaled copy of the same blade, not a generic leaf); the upper pair takes
    // a curved rib. Nothing crosses the hub, so the mark stays one body.
    for (const { angle, len, inner } of LEAVES) {
      const l = r * len;
      const halfW = r * 0.36 * len;
      if (inner) {
        const p = bladePoints(cx, cy, angle, l * 0.74, halfW * 0.74, l * 0.26);
        ctx.moveTo(p.base.x, p.base.y);
        ctx.quadraticCurveTo(p.ctrlOut.x, p.ctrlOut.y, p.tip.x, p.tip.y);
        ctx.quadraticCurveTo(p.ctrlBack.x, p.ctrlBack.y, p.base.x, p.base.y);
        ctx.closePath();
      } else {
        const p = bladePoints(cx, cy, angle, l * 0.86, halfW * 0.42, l * 0.3);
        // Both ribs follow the mark's UPPER curve. A blade's perpendicular
        // flips with its own angle, so which control point that is differs
        // between mirrored blades -- pick the higher one rather than hand-
        // assigning a sign per blade and getting it backwards.
        const ctrl = p.ctrlOut.y <= p.ctrlBack.y ? p.ctrlOut : p.ctrlBack;
        ctx.moveTo(p.base.x, p.base.y);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, p.tip.x, p.tip.y);
      }
    }
  },
};

/** How a lit device throws light. Ticks are the default; Silver Wolf scatters
 *  pixels instead, because everything of hers dissolves into them. */
type Emission = 'ticks' | 'pixels';

/** Radiating ticks in place of the IEC arrows: flat, cheap and unmistakably
 *  "this emits". */
function emissionTicks(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  cx: number,
  cy: number,
  r: number,
): void {
  ctx.beginPath();
  const count = 8;
  for (let i = 0; i < count; i++) {
    const a = (i * 2 * Math.PI) / count + Math.PI / count;
    ctx.moveTo(cx + Math.cos(a) * r * 1.2, cy + Math.sin(a) * r * 1.2);
    ctx.lineTo(cx + Math.cos(a) * r * 1.65, cy + Math.sin(a) * r * 1.65);
  }
  ctx.strokeStyle = theme.colors.accent3;
  ctx.lineWidth = theme.strokes.min;
  ctx.stroke();
}

// Fixed scatter: angle turns, radius steps and cell sizes, so the spray looks
// irregular while staying byte-identical frame to frame. Nothing in a paused
// simulation may shimmer, and the glyph cache keys on state, not on time.
const SPRAY: readonly [number, number, number][] = [
  [0.17, 1.25, 0.5],
  [0.68, 1.75, 0.3],
  [1.22, 1.35, 0.4],
  [1.9, 1.95, 0.25],
  [2.45, 1.3, 0.45],
  [3.05, 1.7, 0.3],
  [3.6, 1.4, 0.35],
  [4.2, 2.05, 0.25],
  [4.75, 1.3, 0.4],
  [5.35, 1.8, 0.3],
  [5.85, 1.5, 0.35],
];

/** Silver Wolf: tiny pixels in several of her hues, scattered at varying
 *  distances -- her glitch spray, quantised like everything else she touches. */
function emissionPixels(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  cx: number,
  cy: number,
  r: number,
): void {
  const hues = [theme.colors.accent3, theme.colors.accent, theme.colors.accent2];
  const cell = Math.max(1.5, r * 0.3);
  SPRAY.forEach(([angle, dist, size], i) => {
    // Snap to the pixel lattice the motif itself sits on.
    const x = Math.round((cx + Math.cos(angle) * r * dist) / cell) * cell;
    const y = Math.round((cy + Math.sin(angle) * r * dist) / cell) * cell;
    ctx.fillStyle = hues[i % hues.length] as string;
    ctx.globalAlpha = 0.55 + (i % 3) * 0.15;
    ctx.fillRect(x, y, cell * size * 2, cell * size * 2);
  });
  ctx.globalAlpha = 1;
}

/** Body + facets + emission for one indicator cell. The stub is the caller's
 *  job. A lit body fills with the character's GLOW colour, not the signal
 *  colour: the wire feeding it already carries logic 1, and the thing inside a
 *  lit indicator should look like light. Grayscale separation still comes from
 *  filled-vs-open, so this stays legible without hue. */
function paintIndicator(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  motif: Motif,
  cx: number,
  cy: number,
  r: number,
  on: boolean,
  emission: Emission = 'ticks',
): void {
  const body = () => motif.body(ctx, cx, cy, r);
  // Glow goes BEHIND the body. Bloom fills the silhouette, so painting it
  // after the body erased the outline and the interior facets -- which is why
  // a lit device lost its detail.
  if (on) {
    ctx.save();
    ctx.lineWidth = theme.strokes.min;
    paintEmphasis(ctx, theme, theme.colors.accent3, body);
    ctx.restore();
  }

  ctx.beginPath();
  body();
  if (motif.fill) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = on ? theme.colors.accent : theme.colors.surface;
    ctx.fill();
    motif.fill(ctx, theme, cx, cy, r, on);
    ctx.restore();
    ctx.beginPath();
    body();
  } else {
    ctx.fillStyle = on ? theme.colors.accent3 : theme.colors.surface;
    ctx.fill();
  }
  // Hairline, not wire weight: a heavy dark outline on a small glowing mark
  // reads as a sticker rather than a light.
  ctx.strokeStyle = motif.outline === 'accent' ? theme.colors.accent : theme.colors.ink;
  ctx.lineWidth = theme.strokes.min;
  ctx.stroke();

  if (motif.facets) {
    ctx.beginPath();
    motif.facets(ctx, cx, cy, r);
    ctx.strokeStyle = theme.colors.ink;
    ctx.lineWidth = theme.strokes.min;
    ctx.globalAlpha = on ? 0.75 : 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (!on) return;
  if (emission === 'pixels') emissionPixels(ctx, theme, cx, cy, r);
  else emissionTicks(ctx, theme, cx, cy, r);
}

function strokeHousing(ctx: CanvasRenderingContext2D, theme: Theme, r: DOMRectLike): void {
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = theme.colors.surface;
  ctx.fill();
  ctx.strokeStyle = theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.stroke();
}

interface DOMRectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

const sortedPins = (input: GeometryInput, dir: 'in' | 'out') =>
  input.pins.filter((p) => p.dir === dir).sort((a, b) => a.order - b.order);

function ledVariant(motif: Motif) {
  return (
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    input: GeometryInput,
    placement: Placement,
    state: VariantState,
  ): boolean => {
    const ins = sortedPins(input, 'in');
    const first = ins[0];
    if (!first) return false;
    const width = ins.length > 1 ? ins.length : first.width;
    if (width > 1) return ledBankVariant(ctx, theme, placement, state, motif, ins, width);

    const on = bitState(state.raw(first.name)) === '1';
    const l = ledLayout(theme.gridSchematic, first.name);
    const r = l.H / 2;
    const cx = 2 * l.g + r;
    withPlacement(ctx, l.bounds, placement, () => {
      // Stub first, and from the body CENTRE: a themed silhouette need not
      // reach the left edge of its bounding circle, and a stub stopping short
      // of the shape reads as a disconnected wire. The body covers the overlap.
      drawStub(
        ctx,
        theme,
        { x: cx, y: l.pinY },
        { x: l.anodeTipX, y: l.pinY },
        state.state(first.name),
      );
      paintIndicator(ctx, theme, motif, cx, l.topPad + r, r, on, motif.emission);
      drawDeviceLabel(
        ctx,
        theme,
        placement,
        state.label,
        { x: cx, y: l.topPad + l.H + 0.5 * l.g },
        { x: 0, y: 1 },
      );
    });
    return true;
  };
}

/** Multi-bit banks get the same character cell per bit, on the canonical bank
 *  geometry -- an array of IEC diodes beside a themed single LED was the most
 *  obvious seam left by the first pass. */
function ledBankVariant(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
  state: VariantState,
  motif: Motif,
  ins: ReturnType<typeof sortedPins>,
  width: number,
): boolean {
  const expanded = ins.length > 1;
  const names = expanded ? ins.map((p) => p.name) : [ins[0]!.name];
  const l = ledBankLayout(theme.gridSchematic, width, names);
  const r = Math.min(l.cellH, l.housing.w) * 0.32;
  withPlacement(ctx, l.bounds, placement, () => {
    strokeHousing(ctx, theme, l.housing);
    for (let row = 0; row < l.width; row++) {
      const cellY = row * l.cellH + l.cellH / 2;
      const pinName = expanded ? names[row]! : names[0]!;
      const raw = state.raw(pinName);
      const bits = expanded ? raw : { v: raw.v >>> row, x: raw.x >>> row, z: raw.z >>> row };
      // A collapsed bank has a single pin at the array's own vertical centre,
      // not at row 0 -- take the y from the canonical geometry rather than
      // assuming it lines up with a cell.
      const pinTip = l.pins.get(pinName);
      if (pinTip && (expanded || row === 0))
        drawStub(
          ctx,
          theme,
          { x: l.housing.x + l.housing.w / 2, y: pinTip.y },
          { x: pinTip.x, y: pinTip.y },
          state.state(pinName),
        );
      paintIndicator(
        ctx,
        theme,
        motif,
        l.housing.x + l.housing.w / 2,
        cellY,
        r,
        bitState(bits) === '1',
        motif.emission,
      );
    }
    drawDeviceLabel(
      ctx,
      theme,
      placement,
      state.label,
      { x: l.housing.x + l.housing.w + 0.5 * l.g, y: l.housing.h / 2 },
      { x: 1, y: 0 },
    );
  });
  return true;
}

/** The switch keeps its housing and its visible throw -- both are what make it
 *  read as an input control -- and takes the character shape as the lever cap. */
function switchVariant(motif: Motif) {
  return (
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    input: GeometryInput,
    placement: Placement,
    state: VariantState,
  ): boolean => {
    const outs = sortedPins(input, 'out');
    const out = outs[0];
    if (!out) return false;
    const width = outs.length > 1 ? outs.length : out.width;
    if (width > 1) return switchBankVariant(ctx, theme, placement, state, motif, outs, width);
    const s = bitState(state.raw(out.name));
    const on = s === '1';
    const l = switchLayout(theme.gridSchematic, out.name);
    withPlacement(ctx, l.bounds, placement, () => {
      strokeHousing(ctx, theme, l.housing);
      const leverY = on ? l.housing.y + 0.5 * l.g : l.lever.y;
      paintIndicator(
        ctx,
        theme,
        motif,
        l.lever.x + l.lever.w / 2,
        leverY + l.lever.h / 2,
        Math.min(l.lever.w, l.lever.h) / 2,
        on,
        motif.emission,
      );
      drawStub(ctx, theme, { x: l.housing.w, y: l.pinY }, { x: l.tipX, y: l.pinY }, s);
      drawDeviceLabel(
        ctx,
        theme,
        placement,
        state.label,
        { x: -0.5 * l.g, y: l.pinY },
        { x: -1, y: 0 },
      );
    });
    return true;
  };
}

/** A multi-bit switch is a DIP bank: one character motif per cell, acting as
 *  that bit's lever. Without this an array of plain square levers sat beside a
 *  themed single switch -- the same seam the LED bank had. */
function switchBankVariant(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  placement: Placement,
  state: VariantState,
  motif: Motif,
  outs: ReturnType<typeof sortedPins>,
  width: number,
): boolean {
  const expanded = outs.length > 1;
  const names = expanded ? outs.map((p) => p.name) : [outs[0]!.name];
  const l = dipBankLayout(theme.gridSchematic, width, names);
  const r = Math.min(l.cellH, l.housing.w) * 0.32;
  withPlacement(ctx, l.bounds, placement, () => {
    strokeHousing(ctx, theme, l.housing);
    for (let row = 0; row < l.width; row++) {
      const cellY = row * l.cellH + l.cellH / 2;
      const pinName = expanded ? names[row]! : names[0]!;
      const raw = state.raw(pinName);
      const bits = expanded ? raw : { v: raw.v >>> row, x: raw.x >>> row, z: raw.z >>> row };
      const on = bitState(bits) === '1';
      // The throw still has to be visible: the motif slides toward the pin
      // side when the bit is set, exactly like the canonical square lever.
      const cx = l.housing.x + (on ? l.housing.w * 0.66 : l.housing.w * 0.34);
      const tip = l.pins.get(pinName);
      if (tip && (expanded || row === 0))
        drawStub(
          ctx,
          theme,
          { x: l.housing.x + l.housing.w, y: tip.y },
          { x: tip.x, y: tip.y },
          state.state(pinName),
        );
      paintIndicator(ctx, theme, motif, cx, cellY, r, on, motif.emission);
    }
    drawDeviceLabel(
      ctx,
      theme,
      placement,
      state.label,
      { x: l.housing.x - 0.5 * l.g, y: l.housing.h / 2 },
      { x: -1, y: 0 },
    );
  });
  return true;
}

/** Momentary button: pressed still reads as pressed, because the cap both
 *  fills and shrinks into the housing. */
function buttonVariant(motif: Motif) {
  return (
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    input: GeometryInput,
    placement: Placement,
    state: VariantState,
  ): boolean => {
    const out = input.pins.find((p) => p.dir === 'out');
    if (!out) return false;
    const held = state.state(out.name) === '1';
    const l = buttonLayout(theme.gridSchematic, out.name);
    const { cx, cy, r } = buttonCapCircle(l);
    withPlacement(ctx, l.bounds, placement, () => {
      strokeHousing(ctx, theme, l.housing);
      paintIndicator(ctx, theme, motif, cx, cy, held ? r * 0.78 : r, held, motif.emission);
      drawStub(
        ctx,
        theme,
        { x: l.housing.w, y: l.pinY },
        { x: l.tipX, y: l.pinY },
        held ? '1' : '0',
      );
      drawDeviceLabel(
        ctx,
        theme,
        placement,
        state.label,
        { x: -0.5 * l.g, y: l.pinY },
        { x: -1, y: 0 },
      );
    });
    return true;
  };
}

/** Clock: the square-wave silkscreen stays, since that is what makes it read
 *  as a periodic source; the character mark becomes its corner tick motif. */
function clockVariant(motif: Motif) {
  return (
    ctx: CanvasRenderingContext2D,
    theme: Theme,
    input: GeometryInput,
    placement: Placement,
    state: VariantState,
  ): boolean => {
    const out = input.pins.find((p) => p.dir === 'out');
    if (!out) return false;
    const l = clockLayout(theme.gridSchematic, out.name);
    const g = l.g;
    withPlacement(ctx, l.bounds, placement, () => {
      strokeHousing(ctx, theme, { x: 0, y: 0, w: l.boxW, h: l.boxH });

      const cy = l.boxH / 2;
      ctx.beginPath();
      let x = l.boxW / 2 - 2 * g;
      ctx.moveTo(x, cy + g);
      for (let i = 0; i < 4; i++) {
        const up = i % 2 === 0;
        ctx.lineTo(x, up ? cy - g : cy + g);
        x += g;
        ctx.lineTo(x, up ? cy - g : cy + g);
      }
      ctx.strokeStyle = theme.colors.ink;
      ctx.lineWidth = theme.strokes.wire;
      ctx.stroke();

      ctx.beginPath();
      motif.body(ctx, l.boxW - 0.75 * g, 0.75 * g, 0.4 * g);
      ctx.fillStyle = theme.colors.accent2;
      ctx.fill();

      drawStub(
        ctx,
        theme,
        { x: l.boxW, y: l.pinY },
        { x: l.tipX, y: l.pinY },
        state.state(out.name),
      );
      drawDeviceLabel(
        ctx,
        theme,
        placement,
        state.label,
        { x: -0.5 * g, y: l.pinY },
        { x: -1, y: 0 },
      );
    });
    return true;
  };
}

const MOTIFS = {
  cyrene: shard,
  himeko: star,
  kinich: voxel,
  silverwolf: pixelCircle,
  firefly: butterfly,
} as const;

for (const [theme, motif] of Object.entries(MOTIFS)) {
  registerGlyphVariant(theme, 'led', ledVariant(motif));
  registerGlyphVariant(theme, 'toggle', switchVariant(motif));
  registerGlyphVariant(theme, 'button', buttonVariant(motif));
  registerGlyphVariant(theme, 'clock', clockVariant(motif));
}
