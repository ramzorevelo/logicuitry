// Orthogonal wire geometry: elbow routing for click-to-click wiring, plus the
// segment-intersection primitives the wire-cut gesture and tap picking reuse.
// Pure math over Vec2; no DOM, no canvas.

import type { Rect, Vec2 } from '../../render/scene';
import type { Wire, WireEnd } from '../../core/model/types';

/** Corner of a single-elbow route between a and b. flip picks which axis leads:
 *  false -> horizontal then vertical, true -> vertical then horizontal. */
export function elbowCorner(a: Vec2, b: Vec2, flip: boolean): Vec2 {
  return flip ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
}

/** Single-elbow orthogonal polyline a -> corner -> b (collapses to one segment
 *  when already axis-aligned). */
export function routeOrthogonal(a: Vec2, b: Vec2, flip = false): Vec2[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  return [a, elbowCorner(a, b, flip), b];
}

/** True when the axis-aligned segment p0->p1 passes through rect's interior
 *  (touching an edge doesn't count -- a wire landing exactly on a pin at the
 *  body's boundary is normal, not a body crossing). */
function segmentCrossesRect(p0: Vec2, p1: Vec2, rect: Rect): boolean {
  const x0 = Math.min(p0.x, p1.x);
  const x1 = Math.max(p0.x, p1.x);
  const y0 = Math.min(p0.y, p1.y);
  const y1 = Math.max(p0.y, p1.y);
  return x0 < rect.x + rect.w && x1 > rect.x && y0 < rect.y + rect.h && y1 > rect.y;
}

export function polylineCrossesAny(pts: Vec2[], obstacles: readonly Rect[]): boolean {
  for (let i = 0; i < pts.length - 1; i++)
    for (const r of obstacles) if (segmentCrossesRect(pts[i]!, pts[i + 1]!, r)) return true;
  return false;
}

/** True when two axis-aligned segments overlap COLLINEARLY (same line, over a
 *  span of positive length) -- a perpendicular crossing (a T or a plus)
 *  shares at most a point and must NOT count, that's a normal, unavoidable
 *  wire crossing, not visual overlap. */
function segmentsOverlapCollinear(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean {
  if (a0.y === a1.y && b0.y === b1.y && a0.y === b0.y) {
    const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
    const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
    return hi - lo > 0;
  }
  if (a0.x === a1.x && b0.x === b1.x && a0.x === b0.x) {
    const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
    const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
    return hi - lo > 0;
  }
  return false;
}

/** True when polyline `pts` collinearly overlaps any segment of any polyline
 *  in `wireObstacles` (other wires' already-computed display routes). */
export function routeOverlapsWires(
  pts: readonly Vec2[],
  wireObstacles: readonly Vec2[][],
): boolean {
  for (let i = 0; i < pts.length - 1; i++)
    for (const other of wireObstacles)
      for (let j = 0; j < other.length - 1; j++)
        if (segmentsOverlapCollinear(pts[i]!, pts[i + 1]!, other[j]!, other[j + 1]!)) return true;
  return false;
}

/** Single-elbow route a -> b that tries to avoid crossing through any of
 *  `obstacles` (other components' bounding boxes) and, secondarily,
 *  overlapping any of `wireObstacles` (other wires' already-routed
 *  polylines) -- tries both elbow orientations, a two-elbow (Z) detour, then
 *  a few mid-coordinate-shifted two-elbow variants on BOTH axes (x-shifted
 *  for a horizontal-flow detour, y-shifted for a vertical-flow one; nearest
 *  grid step first, both signs) to dodge a collinear overlap, then just gives up and
 *  returns the naive route (per the spec's "simple two-elbow, instructor
 *  tidies afterward" stance -- not full pathfinding). Body-avoidance for the
 *  common adjacent-gates / one-obstacle-hop cases (P2.1, M4.2); wire-overlap
 *  avoidance for the common several-parallel-wires case (M4.5); neither is
 *  exhaustive. A candidate that clears both wins outright; failing that, the
 *  first that at least clears bodies (today's pre-M4.5 behavior) wins, so
 *  wire-overlap avoidance can never make body-avoidance worse. */
export function routeAvoiding(
  a: Vec2,
  b: Vec2,
  obstacles: readonly Rect[],
  wireObstacles: readonly Vec2[][] = [],
  grid = 16,
): Vec2[] {
  if (obstacles.length === 0 && wireObstacles.length === 0) return routeOrthogonal(a, b);
  const straight = routeOrthogonal(a, b);
  const flipped = routeOrthogonal(a, b, true);
  const detour = routeTwoElbow(a, b);
  const shifted: Vec2[][] = [];
  if (a.x !== b.x && a.y !== b.y) {
    const baseX = Math.round((a.x + b.x) / 2);
    const baseY = Math.round((a.y + b.y) / 2);
    for (const step of [1, 2, 3]) {
      for (const sign of [1, -1]) {
        const midX = baseX + step * sign * grid;
        shifted.push([a, { x: midX, y: a.y }, { x: midX, y: b.y }, b]);
        const midY = baseY + step * sign * grid;
        shifted.push([a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]);
      }
    }
  }
  const candidates = [straight, flipped, detour, ...shifted];
  const clearsBody = (pts: Vec2[]) => !polylineCrossesAny(pts, obstacles);
  for (const c of candidates) if (clearsBody(c) && !routeOverlapsWires(c, wireObstacles)) return c;
  for (const c of candidates) if (clearsBody(c)) return c;
  return straight;
}

/** Ensures the first/last legs of a stored-bend-point wire stay orthogonal
 *  even when an endpoint has moved since those bends were placed (a live
 *  component drag, most commonly) -- inserts an elbow on whichever end needs
 *  one instead of drawing a stale straight (possibly diagonal) segment
 *  (P2.1, M4.2). The interior bend points themselves are left untouched. */
export function orthogonalPolyline(a: Vec2, mid: readonly Vec2[], b: Vec2): Vec2[] {
  if (mid.length === 0) return routeOrthogonal(a, b);
  const head = routeOrthogonal(a, mid[0]!);
  const tail = routeOrthogonal(mid[mid.length - 1]!, b);
  return [...head.slice(0, -1), ...mid, ...tail.slice(1)];
}

/** The exact points a wire is drawn through: explicit stored bends (re-elbowed
 *  to stay orthogonal if an endpoint moved since), or an auto-routed path
 *  avoiding `obstacles` when there are no stored bends. Hit-testing, dragging,
 *  and lasso containment all need this too -- using a plainer route than the
 *  one on screen means clicks land on a path that isn't what's visible. */
export function wireDisplayPoints(
  a: Vec2,
  b: Vec2,
  mid: readonly Vec2[],
  obstacles: readonly Rect[],
  wireObstacles: readonly Vec2[][] = [],
  grid = 16,
): Vec2[] {
  return mid.length
    ? orthogonalPolyline(a, mid, b)
    : routeAvoiding(a, b, obstacles, wireObstacles, grid);
}

/** The single source of truth for every wire's on-screen route, computed
 *  once and shared by drawing and every hit-test (wireAt, beginWireDrag,
 *  idsInRect, insert-on-wire) -- routing a wire around another wire makes
 *  each route depend on the routes computed before it (order-dependent), so
 *  a caller building its own private point list per hit-test independently
 *  of the draw loop drifts out of sync the moment a route actually detours
 *  (the M4.2 follow-up "route-consistency bug": every interactive hit-test
 *  checked a different, invisible path than the one on screen). Walks
 *  `wires` in board order, accumulating each computed polyline as an
 *  obstacle for the next; a stored-bend wire routes via `orthogonalPolyline`
 *  (unchanged) and still counts as an obstacle for the ones after it, but is
 *  never itself re-routed around another wire. */
export function computeWireRoutes(
  wires: readonly Wire[],
  resolveEnd: (end: WireEnd) => Vec2 | undefined,
  boundsById: ReadonlyMap<string, Rect>,
  grid: number,
): Map<string, Vec2[]> {
  const routes = new Map<string, Vec2[]>();
  const wireObstacles: Vec2[][] = [];
  const bodyObstacles = [...boundsById.values()];
  for (const wire of wires) {
    const a = resolveEnd(wire.a);
    const b = resolveEnd(wire.b);
    if (!a || !b) continue;
    // A wire with stored bends re-elbows through them (orthogonalPolyline)
    // rather than auto-routing, so a deliberately-placed corner survives an
    // endpoint moving nearby. But that re-elbow has no obstacle awareness at
    // all -- if a component later moves far enough that the stored-bend
    // route would now cut straight through a body (Task 6 follow-up: a
    // small stub left over from an earlier drag permanently disables
    // avoidance for that wire), fall back to a fresh routeAvoiding detour
    // instead of drawing through the obstacle.
    const stored = wire.points.length ? orthogonalPolyline(a, wire.points, b) : undefined;
    const pts =
      stored && !polylineCrossesAny(stored, bodyObstacles)
        ? stored
        : routeAvoiding(a, b, bodyObstacles, wireObstacles, grid);
    routes.set(wire.id, pts);
    wireObstacles.push(pts);
  }
  return routes;
}

/** Two-elbow (Z) route used by smart-connect, split at the x midpoint so a
 *  column of sources fans into a column of targets without overlap. */
export function routeTwoElbow(a: Vec2, b: Vec2): Vec2[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const midX = Math.round((a.x + b.x) / 2);
  return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
}

/** Proper-crossing test (shared endpoints and collinear overlaps read as no
 *  crossing, which is what the cut gesture wants). */
export function segmentsIntersect(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(b0, b1, a0);
  const d2 = cross(b0, b1, a1);
  const d3 = cross(a0, a1, b0);
  const d4 = cross(a0, a1, b1);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Full point list of a wire: resolved endpoint a, its bend points, endpoint b. */
export function wirePolyline(wire: Wire, resolveEnd: (end: WireEnd) => Vec2): Vec2[] {
  return [resolveEnd(wire.a), ...wire.points, resolveEnd(wire.b)];
}

/** Ids of every wire whose polyline the slash segment properly crosses. */
export function wiresCrossedBy(
  slash: [Vec2, Vec2],
  wires: readonly Wire[],
  resolveEnd: (end: WireEnd) => Vec2,
): Set<string> {
  const hit = new Set<string>();
  for (const wire of wires) {
    const pts = wirePolyline(wire, resolveEnd);
    for (let i = 0; i < pts.length - 1; i++) {
      if (segmentsIntersect(slash[0], slash[1], pts[i]!, pts[i + 1]!)) {
        hit.add(wire.id);
        break;
      }
    }
  }
  return hit;
}

/** True when segment p0->p1 touches or crosses rect (edges count, unlike
 *  segmentCrossesRect's obstacle-avoidance interior-only rule) -- lasso
 *  selection should catch a wire that only clips a corner of the drag box. */
export function segmentIntersectsRect(p0: Vec2, p1: Vec2, rect: Rect): boolean {
  const inRect = (p: Vec2) =>
    p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
  if (inRect(p0) || inRect(p1)) return true;
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  const edges: [Vec2, Vec2][] = [
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
    ],
    [
      { x: x1, y: y0 },
      { x: x1, y: y1 },
    ],
    [
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    [
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ],
  ];
  return edges.some(([e0, e1]) => segmentsIntersect(p0, p1, e0, e1));
}

/** True when any segment of the polyline touches or crosses rect -- the real
 *  hitbox for lasso-selecting a wire, as opposed to its bounding box (which
 *  falsely catches empty space inside an L-shaped wire's corner). */
export function polylineIntersectsRect(pts: readonly Vec2[], rect: Rect): boolean {
  for (let i = 0; i < pts.length - 1; i++)
    if (segmentIntersectsRect(pts[i]!, pts[i + 1]!, rect)) return true;
  return false;
}

/** Nearest point on a segment to p, for tap picking / segment-drag projection. */
export function projectOntoSegment(p: Vec2, s0: Vec2, s1: Vec2): Vec2 {
  const dx = s1.x - s0.x;
  const dy = s1.y - s0.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: s0.x, y: s0.y };
  let t = ((p.x - s0.x) * dx + (p.y - s0.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: s0.x + t * dx, y: s0.y + t * dy };
}

/** Cumulative segment lengths and the total, shared by the two arc-length
 *  helpers below so a point and its fraction always agree. */
function arcLengths(pts: readonly Vec2[]): { lens: number[]; total: number } {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    lens.push(d);
    total += d;
  }
  return { lens, total };
}

export interface PolylinePoint {
  pos: Vec2;
  /** The segment the point sits on, for anything needing the local direction. */
  segment: [Vec2, Vec2];
}

/** Position at arc-length fraction `t` (0..1) along a polyline. A fraction
 *  rather than a distance so a label keeps its place along a wire whose route
 *  reshapes under a component drag. */
export function pointAlongPolyline(pts: readonly Vec2[], t: number): PolylinePoint {
  const first = pts[0] ?? { x: 0, y: 0 };
  if (pts.length < 2) return { pos: { ...first }, segment: [{ ...first }, { ...first }] };
  const { lens, total } = arcLengths(pts);
  const seg: [Vec2, Vec2] = [pts[0]!, pts[1]!];
  if (total === 0) return { pos: { ...first }, segment: seg };
  const want = Math.min(1, Math.max(0, t)) * total;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i]!;
    if (acc + len >= want || i === lens.length - 1) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const f = len === 0 ? 0 : (want - acc) / len;
      return { pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, segment: [a, b] };
    }
    acc += len;
  }
  return { pos: { ...first }, segment: seg };
}

/** The arc-length fraction of the polyline point nearest `p` -- the inverse of
 *  pointAlongPolyline, for turning a cursor position back into a stored t. */
export function tAlongPolyline(pts: readonly Vec2[], p: Vec2): number {
  if (pts.length < 2) return 0;
  const { lens, total } = arcLengths(pts);
  if (total === 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const proj = projectOntoSegment(p, a, b);
    const d = Math.hypot(proj.x - p.x, proj.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = (acc + Math.hypot(proj.x - a.x, proj.y - a.y)) / total;
    }
    acc += lens[i]!;
  }
  return Math.min(1, Math.max(0, best));
}

/** Drops exact-duplicate consecutive points, then repeatedly drops an interior
 *  point whose neighbors are collinear with it on the same axis AND the two
 *  legs travel the same direction (a genuine straight pass-through, not a
 *  backtrack) -- a corner dragged back onto its neighbors' line really is
 *  gone, but a same-axis point where the path reverses (a spike) stays: it's
 *  a real shape, dissolving it would silently erase a visible bend. */
export function normalizeBends(pts: readonly Vec2[]): Vec2[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out: Vec2[] = [{ ...pts[0]! }];
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i]!;
    const prev = out[out.length - 1]!;
    if (cur.x === prev.x && cur.y === prev.y) continue;
    out.push({ ...cur });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      let monotonic = false;
      if (a.x === b.x && b.x === c.x) {
        const d1 = Math.sign(b.y - a.y);
        const d2 = Math.sign(c.y - b.y);
        monotonic = d1 === 0 || d2 === 0 || d1 === d2;
      } else if (a.y === b.y && b.y === c.y) {
        const d1 = Math.sign(b.x - a.x);
        const d2 = Math.sign(c.x - b.x);
        monotonic = d1 === 0 || d2 === 0 || d1 === d2;
      }
      if (monotonic) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** True when any three consecutive points sit on one axis but the path
 *  reverses direction across them (travels out past the middle point, then
 *  back) -- a candidate route that overshoots and doubles back on itself. */
function hasCollinearReversal(pts: readonly Vec2[]): boolean {
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    if (a.x === b.x && b.x === c.x) {
      const d1 = Math.sign(b.y - a.y);
      const d2 = Math.sign(c.y - b.y);
      if (d1 !== 0 && d2 !== 0 && d1 !== d2) return true;
    } else if (a.y === b.y && b.y === c.y) {
      const d1 = Math.sign(b.x - a.x);
      const d2 = Math.sign(c.x - b.x);
      if (d1 !== 0 && d2 !== 0 && d1 !== d2) return true;
    }
  }
  return false;
}

const pointsEqual = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

/** True KiCad corner drag: the vertex at `cornerIdx` in `displayPts` (a full
 *  polyline including both real endpoints) follows `target`; its two
 *  neighbors -- the previous/next vertex, which may themselves be a resolved
 *  wire endpoint -- stay fixed, and each adjacent leg is rebuilt orthogonally
 *  from its fixed anchor to `target` (never a diagonal). Endpoints (index 0
 *  and length-1) never move; `cornerIdx` outside the interior range is a
 *  no-op. Each leg tries both elbow flips (4 combinations total); a
 *  combination that backtracks over itself is rejected, and so is one whose
 *  normalization dissolves `target` away entirely *unless every* combination
 *  does (that means the drag genuinely straightened the wire, which is the
 *  one case a dissolved corner is correct). Ties broken by first-in-
 *  enumeration-order. */
export function dragCorner(displayPts: readonly Vec2[], cornerIdx: number, target: Vec2): Vec2[] {
  if (cornerIdx <= 0 || cornerIdx >= displayPts.length - 1)
    return displayPts.map((p) => ({ ...p }));
  const prevAnchor = displayPts[cornerIdx - 1]!;
  const nextAnchor = displayPts[cornerIdx + 1]!;
  const before = displayPts.slice(0, cornerIdx);
  const after = displayPts.slice(cornerIdx + 1);

  const candidates: Vec2[][] = [];
  for (const flipA of [false, true]) {
    for (const flipB of [false, true]) {
      const prevLeg = routeOrthogonal(prevAnchor, target, flipA);
      const nextLeg = routeOrthogonal(target, nextAnchor, flipB);
      const full = [...before, ...prevLeg.slice(1), ...nextLeg.slice(1, -1), ...after];
      candidates.push(normalizeBends(full));
    }
  }
  const keepsCorner = candidates.filter(
    (c) => !hasCollinearReversal(c) && c.some((p) => pointsEqual(p, target)),
  );
  const pool = keepsCorner.length ? keepsCorner : candidates;
  return pool.reduce((best, c) => (c.length < best.length ? c : best));
}

/** +90 rotation of a point about a pivot, screen-coords CW (y-down) -- same
 *  direction a single component's own `rot` already turns under R. */
export function rotatePointAround(p: Vec2, pivot: Vec2): Vec2 {
  return { x: pivot.x - (p.y - pivot.y), y: pivot.y + (p.x - pivot.x) };
}

/** rotatePointAround, snapped to grid -- for junction positions in a group
 *  rotate, which (unlike wire bend points) must stay grid-aligned. */
export function rotatePointSnapped(p: Vec2, pivot: Vec2, grid: number): Vec2 {
  const r = rotatePointAround(p, pivot);
  return { x: Math.round(r.x / grid) * grid, y: Math.round(r.y / grid) * grid };
}

export interface GroupRotateItem {
  id: string;
  bounds: Rect; // symbolBounds().bounds pre-rotation, caller-resolved
  rot: 0 | 90 | 180 | 270;
  /** Explicit pivot override (Task 8: a single-pin part hinges on its own
   *  pin's world position instead of its body centre). Ignored by
   *  `groupRotateComponent` itself (its own `pivot` param always wins) --
   *  read only by callers building the item list, e.g. `rotateSelection`. */
  pivot?: Vec2;
}
export interface GroupRotateResult {
  id: string;
  pos: Vec2;
  rot: 0 | 90 | 180 | 270;
}

/** Half of `dim`, floored to the nearest grid multiple -- unlike
 *  `Math.round`, this is a *consistent* representative (always the same
 *  direction) for a dimension that's an odd multiple of `grid` (e.g. a 9G-
 *  wide 2-input AND gate paired with its 4G height), where the true center
 *  isn't representable on-grid at all. `Math.round`'s tie-breaking flips
 *  direction depending on the sign of the offset being rounded, which is
 *  exactly what made a single component's own-center rotation drift by a
 *  half-grid step every turn instead of returning to its start after four. */
export function halfSnap(dim: number, grid: number): number {
  return Math.floor(dim / (2 * grid)) * grid;
}

/** Shift+R / R group rotate, per component: rotates the bounds' (grid-
 *  snapped) center about the group pivot, bumps rot by 90, and re-derives
 *  `pos` (glyph top-left, see symbolBounds) from the new center. Both
 *  `oldCenter` (via halfSnap) and `pivot` are already grid-aligned, so
 *  `rotatePointAround` is exact integer arithmetic here -- no further
 *  rounding of the result is needed or done. This "recentre" formula is
 *  deliberately NOT a true physical rotation of the shape's corners around
 *  an arbitrary point -- it always repositions the shape so its OWN
 *  (halfSnap-consistent) center lands exactly on `pivot`, which only
 *  matches true rotation when `pivot` really is that same approximated
 *  center (the own-body-rotate and Shift+R group-rotate cases, both of
 *  which pass a pivot derived via `halfSnap` for exactly this reason). Do
 *  NOT reuse this for an arbitrary external pivot (e.g. hinging on a pin
 *  sitting away from the body's middle) -- that needs `rotateAboutPivot`'s
 *  true corner-rotation below; using this formula there was found live to
 *  drift for every single-pin kind except LED (whose pin happened to sit at
 *  a coordinate this formula's approximation error cancelled at by
 *  coincidence). */
export function groupRotateComponent(
  item: GroupRotateItem,
  pivot: Vec2,
  grid: number,
): GroupRotateResult {
  const oldCenter = {
    x: item.bounds.x + halfSnap(item.bounds.w, grid),
    y: item.bounds.y + halfSnap(item.bounds.h, grid),
  };
  const newCenter = rotatePointAround(oldCenter, pivot);
  const newRot = ((item.rot + 90) % 360) as 0 | 90 | 180 | 270;
  const newW = item.bounds.h;
  const newH = item.bounds.w;
  return {
    id: item.id,
    pos: {
      x: newCenter.x - halfSnap(newW, grid),
      y: newCenter.y - halfSnap(newH, grid),
    },
    rot: newRot,
  };
}

/** True rigid rotation of `item.bounds`' four corners about an arbitrary
 *  `pivot`, taking their new min-x/min-y as `pos` -- exact whenever `pivot`
 *  and the bounds are grid-aligned (a real pin's world position always is,
 *  per the "wire-attach tip is snapped to grid" convention), since rotating
 *  two grid-aligned points via the 90-degree formula is pure integer
 *  arithmetic. Use this instead of `groupRotateComponent` whenever `pivot`
 *  is a genuine fixed point the shape hinges on (Task 8: a single-pin part
 *  rotating about its own pin) rather than an approximated body center. */
export function rotateAboutPivot(item: GroupRotateItem, pivot: Vec2): GroupRotateResult {
  const { x, y, w, h } = item.bounds;
  const corners = [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ];
  const rotated = corners.map((c) => rotatePointAround(c, pivot));
  const pos = {
    x: Math.min(...rotated.map((p) => p.x)),
    y: Math.min(...rotated.map((p) => p.y)),
  };
  const newRot = ((item.rot + 90) % 360) as 0 | 90 | 180 | 270;
  return { id: item.id, pos, rot: newRot };
}

export interface GroupRotateOutcome {
  items: GroupRotateResult[];
  /** Grid-snapped nudge to apply to every moved entity (components, rotated
   *  wire bends, junctions) in the same commit -- cancels the per-component
   *  grid-rounding bias in `groupRotateComponent` (odd-multiple-of-grid
   *  bounds, e.g. a 3G-wide switch, have a half-grid center; independently
   *  rounding each component's re-derived pos after rotation drifts the
   *  group's actual centre away from the pivot-rotated expected one, and the
   *  bias never cancels turn over turn). */
  correction: Vec2;
}

/** Shift+R: groupRotateComponent per item, plus a single group-level
 *  correction pass so a mixed-size selection returns to its exact starting
 *  layout after four turns (see GroupRotateOutcome). Owner decision: stay
 *  fully grid-snapped and correct with this delta, rather than switching to
 *  exact/unsnapped rotation or a half-grid lattice. */
export function groupRotate(
  items: GroupRotateItem[],
  pivot: Vec2,
  grid: number,
): GroupRotateOutcome {
  const results = items.map((item) => groupRotateComponent(item, pivot, grid));
  if (items.length === 0) return { items: results, correction: { x: 0, y: 0 } };

  let preMinX = Infinity;
  let preMinY = Infinity;
  let preMaxX = -Infinity;
  let preMaxY = -Infinity;
  for (const item of items) {
    preMinX = Math.min(preMinX, item.bounds.x);
    preMinY = Math.min(preMinY, item.bounds.y);
    preMaxX = Math.max(preMaxX, item.bounds.x + item.bounds.w);
    preMaxY = Math.max(preMaxY, item.bounds.y + item.bounds.h);
  }
  const preCenter = { x: (preMinX + preMaxX) / 2, y: (preMinY + preMaxY) / 2 };
  const expectedCenter = rotatePointAround(preCenter, pivot);

  let actMinX = Infinity;
  let actMinY = Infinity;
  let actMaxX = -Infinity;
  let actMaxY = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const r = results[i]!;
    // A +90 turn always swaps the bounding box's w/h (same fact
    // groupRotateComponent itself relies on).
    const w = item.bounds.h;
    const h = item.bounds.w;
    actMinX = Math.min(actMinX, r.pos.x);
    actMinY = Math.min(actMinY, r.pos.y);
    actMaxX = Math.max(actMaxX, r.pos.x + w);
    actMaxY = Math.max(actMaxY, r.pos.y + h);
  }
  const actualCenter = { x: (actMinX + actMaxX) / 2, y: (actMinY + actMaxY) / 2 };
  const correction = {
    x: Math.round((expectedCenter.x - actualCenter.x) / grid) * grid,
    y: Math.round((expectedCenter.y - actualCenter.y) / grid) * grid,
  };
  return { items: results, correction };
}

/** KiCad-style "drag stretch": when a component/junction at one or both ends
 *  of a wire moves by `delta`, the wire's stored bends follow so the wire
 *  never leaves stale bends behind (which `orthogonalPolyline` would then
 *  re-elbow into overlapping stubs). Both ends moving rigidly translates
 *  every point; one end moving only nudges the bend adjacent to that end,
 *  and only along whichever axis kept that leg orthogonal to begin with --
 *  an already-stale diagonal leg is left for `orthogonalPolyline`'s fallback
 *  re-elbow rather than guessed at here. */
export function stretchWirePoints(
  points: readonly Vec2[],
  aOld: Vec2,
  bOld: Vec2,
  aMoved: boolean,
  bMoved: boolean,
  delta: Vec2,
): Vec2[] {
  if (points.length === 0) return [];
  if (aMoved && bMoved) return points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
  const out = points.map((p) => ({ ...p }));
  if (aMoved) {
    const p0 = out[0]!;
    if (aOld.y === p0.y) p0.y += delta.y;
    if (aOld.x === p0.x) p0.x += delta.x;
  }
  if (bMoved) {
    const pl = out[out.length - 1]!;
    if (bOld.y === pl.y) pl.y += delta.y;
    if (bOld.x === pl.x) pl.x += delta.x;
  }
  const aNew = aMoved ? { x: aOld.x + delta.x, y: aOld.y + delta.y } : aOld;
  const bNew = bMoved ? { x: bOld.x + delta.x, y: bOld.y + delta.y } : bOld;
  return normalizeBends([aNew, ...out, bNew]).slice(1, -1);
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

/** KiCad-style "Align" toolbar: moves every selected item's bounds edge (or
 *  center, for centerX/centerY) to match the extreme -- or average -- across
 *  the whole selection. Returns a per-id delta rather than a new position so
 *  the caller can add it to whatever positional field the entity actually
 *  has (component `pos` isn't `bounds.x/y`) and reuse the same delta for
 *  attached-wire stretching. `left`/`right`/`top`/`bottom` targets are
 *  already grid-aligned (every bounds edge is); only the two `center*` modes
 *  can land on a half-grid average, so those alone get grid-snapped. */
export function alignDeltas(
  items: readonly { id: string; bounds: Rect }[],
  mode: AlignMode,
  grid: number,
): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  if (items.length < 2) return out;
  switch (mode) {
    case 'left': {
      const target = Math.min(...items.map((i) => i.bounds.x));
      for (const it of items) out.set(it.id, { x: target - it.bounds.x, y: 0 });
      break;
    }
    case 'right': {
      const target = Math.max(...items.map((i) => i.bounds.x + i.bounds.w));
      for (const it of items) out.set(it.id, { x: target - (it.bounds.x + it.bounds.w), y: 0 });
      break;
    }
    case 'top': {
      const target = Math.min(...items.map((i) => i.bounds.y));
      for (const it of items) out.set(it.id, { x: 0, y: target - it.bounds.y });
      break;
    }
    case 'bottom': {
      const target = Math.max(...items.map((i) => i.bounds.y + i.bounds.h));
      for (const it of items) out.set(it.id, { x: 0, y: target - (it.bounds.y + it.bounds.h) });
      break;
    }
    case 'centerX': {
      const avg = items.reduce((s, i) => s + (i.bounds.x + i.bounds.w / 2), 0) / items.length;
      const target = Math.round(avg / grid) * grid;
      for (const it of items) out.set(it.id, { x: target - (it.bounds.x + it.bounds.w / 2), y: 0 });
      break;
    }
    case 'centerY': {
      const avg = items.reduce((s, i) => s + (i.bounds.y + i.bounds.h / 2), 0) / items.length;
      const target = Math.round(avg / grid) * grid;
      for (const it of items) out.set(it.id, { x: 0, y: target - (it.bounds.y + it.bounds.h / 2) });
      break;
    }
  }
  return out;
}

export type DistributeAxis = 'x' | 'y';

/** KiCad-style "Distribute": equalizes the gaps between selected items'
 *  bounds along one axis, pinning the two extreme items (by position) and
 *  spacing the rest evenly between them -- "make space even" rather than
 *  equal center-to-center spacing, so items of different sizes still read as
 *  evenly gapped. Needs at least 3 items to mean anything; fewer returns no
 *  deltas. Each item's target coordinate is grid-snapped independently (the
 *  ideal gap is rarely a grid multiple) rather than compounding rounding
 *  error item to item -- the running `cursor` always advances from the
 *  exact ideal position, only the emitted delta is snapped. */
export function distributeDeltas(
  items: readonly { id: string; bounds: Rect }[],
  axis: DistributeAxis,
  grid: number,
): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  if (items.length < 3) return out;
  const dimKey = axis === 'x' ? 'w' : 'h';
  const coordKey = axis === 'x' ? 'x' : 'y';
  const sorted = [...items].sort((a, b) => a.bounds[coordKey] - b.bounds[coordKey]);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const totalSpan = last.bounds[coordKey] + last.bounds[dimKey] - first.bounds[coordKey];
  const totalSize = sorted.reduce((s, i) => s + i.bounds[dimKey], 0);
  const gap = (totalSpan - totalSize) / (sorted.length - 1);
  let cursor = first.bounds[coordKey];
  for (const it of sorted) {
    const target = Math.round(cursor / grid) * grid;
    const delta = target - it.bounds[coordKey];
    out.set(it.id, axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta });
    cursor += it.bounds[dimKey] + gap;
  }
  return out;
}

/** "Pack": distributeDeltas' degenerate zero-gap case as its own tool --
 *  butts every selected item's bounds up against the next one along an
 *  axis, closing every gap, instead of equalizing them. Pins the leftmost
 *  (or topmost) item and lines the rest up immediately after it in sorted
 *  order; only needs 2 items (a real gap to close), unlike distribute's 3+
 *  floor for "equalize" to mean anything. */
export function packDeltas(
  items: readonly { id: string; bounds: Rect }[],
  axis: DistributeAxis,
  grid: number,
): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  if (items.length < 2) return out;
  const dimKey = axis === 'x' ? 'w' : 'h';
  const coordKey = axis === 'x' ? 'x' : 'y';
  const sorted = [...items].sort((a, b) => a.bounds[coordKey] - b.bounds[coordKey]);
  let cursor = sorted[0]!.bounds[coordKey];
  for (const it of sorted) {
    const target = Math.round(cursor / grid) * grid;
    const delta = target - it.bounds[coordKey];
    out.set(it.id, axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta });
    cursor = target + it.bounds[dimKey];
  }
  return out;
}
