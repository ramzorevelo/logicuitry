// Insert-on-wire: whether a placed primitive qualifies to splice into an
// existing wire (exactly one `in` pin and one `out` pin -- NOT, BUF, and
// similar passthroughs). Multi-pin components never auto-splice (ambiguous
// pin mapping); a single-pin observer like probe isn't 1-in/1-out either, so
// it falls through to a normal placement rather than cutting the wire it's
// dropped on.

import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import type { Params } from '../../core/sim/primitives/types';
import type { Rect, Vec2 } from '../../render/scene';
import type { Wire } from '../../core/model/types';
import { projectOntoSegment, segmentIntersectsRect } from './wireGeom';

export interface SplicePins {
  inName: string;
  outName: string;
}

export function splicePins(kind: string, params: Params): SplicePins | undefined {
  if (!hasPrimitive(kind)) return undefined;
  const pins = getPrimitive(kind).pins(params);
  const ins = pins.filter((p) => p.dir === 'in');
  const outs = pins.filter((p) => p.dir === 'out');
  if (ins.length === 1 && outs.length === 1)
    return { inName: ins[0]!.name, outName: outs[0]!.name };
  return undefined;
}

export interface SpliceHit {
  wireId: string;
  seg: number;
  segA: Vec2;
  segB: Vec2;
}

/** Which wire (if any) a pending drop should splice into, when the cursor
 *  itself missed every wire's fat hit radius: body overlap QUALIFIES a wire
 *  (any of its display segments intersects `bodyBounds`), but the returned
 *  segment is the `refPoint`-NEAREST segment across ALL segments of
 *  qualified wires -- not just the overlapping ones. The overlap and the
 *  best drop point can be different legs of one L-wire: the body (pin stubs
 *  included) may only touch the leg that dead-ends at another component's
 *  pin while `refPoint` sits nearest the mid-run leg; splicing must land
 *  mid-run, not on top of that pin. `refPoint` is the ghost body's CENTER
 *  (M4.5) -- NOT the raw cursor position, which is only a detection
 *  affordance the caller may use separately; passing the cursor here would
 *  land the spliced component off the ghost the user actually saw.
 *  `getDisplayPts` supplies each wire's actual on-screen polyline (obstacle-
 *  avoiding route or stored bends) so this stays in sync with what's drawn,
 *  same as every other hit-test in the editor; a pure function taking that
 *  as a callback so the caller's theme/geometry plumbing never has to
 *  appear in this module or its tests. */
export function findSpliceWire(
  refPoint: Vec2,
  bodyBounds: Rect,
  wires: readonly Wire[],
  getDisplayPts: (wire: Wire) => Vec2[] | undefined,
): SpliceHit | undefined {
  let best: (SpliceHit & { d: number }) | undefined;
  for (const wire of wires) {
    const pts = getDisplayPts(wire);
    if (!pts || pts.length < 2) continue;
    let qualifies = false;
    for (let i = 0; i < pts.length - 1 && !qualifies; i++)
      qualifies = segmentIntersectsRect(pts[i]!, pts[i + 1]!, bodyBounds);
    if (!qualifies) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const proj = projectOntoSegment(refPoint, a, b);
      const d = Math.hypot(proj.x - refPoint.x, proj.y - refPoint.y);
      if (!best || d < best.d) best = { wireId: wire.id, seg: i, segA: a, segB: b, d };
    }
  }
  if (!best) return undefined;
  return { wireId: best.wireId, seg: best.seg, segA: best.segA, segB: best.segB };
}

const snapPoint = (p: Vec2, g: number): Vec2 => ({
  x: Math.round(p.x / g) * g,
  y: Math.round(p.y / g) * g,
});

/** Aligns a spliced component's placement `pos` (glyph top-left, per
 *  symbolBounds -- NOT the pin centerline) so its in/out pins land exactly on
 *  the wire's line at the drop point, instead of the naive snap-both-axes
 *  approach that left the pins up to a full grid unit off the line. `pinIn`/
 *  `pinOut` are the candidate's own pin world positions with `pos` at the
 *  origin (caller resolves via symbolBounds on a throwaway placement).
 *  Normal case: the wire segment is axis-aligned and the two pins are
 *  collinear along that axis (a plain in-line splice) -- the perpendicular
 *  coordinate locks exactly onto the wire's own line (no snap: the wire
 *  itself may be off-grid), and only the along-axis coordinate centers on the
 *  drop point and snaps to grid. Falls back to a plain grid-snapped drop when
 *  the component is oriented across the wire (no single wire-line coordinate
 *  to lock onto). */
export function alignSplicePos(
  dropPos: Vec2,
  segA: Vec2,
  segB: Vec2,
  pinIn: Vec2,
  pinOut: Vec2,
  grid: number,
): Vec2 {
  if (segA.y === segB.y && pinIn.y === pinOut.y) {
    const y = segA.y - pinIn.y;
    const x = Math.round((dropPos.x - (pinIn.x + pinOut.x) / 2) / grid) * grid;
    return { x, y };
  }
  if (segA.x === segB.x && pinIn.x === pinOut.x) {
    const x = segA.x - pinIn.x;
    const y = Math.round((dropPos.y - (pinIn.y + pinOut.y) / 2) / grid) * grid;
    return { x, y };
  }
  return snapPoint(dropPos, grid);
}
