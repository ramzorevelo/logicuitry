// Wire-junction splitting: turns a click on a wire's body into a real electrical
// connection by rewriting the wires that meet there to share a Junction WireEnd,
// instead of the decorative dot-only behavior `Junction` started as. Pure over
// a Circuit draft; no DOM/canvas.

import type { Circuit, Point, Wire, WireEnd } from '../../core/model/types';
import { projectOntoSegment, routeOrthogonal } from './wireGeom';
import { WIRE_BODY_HIT_RADIUS } from '../../render/hitTest';

export type ResolveWireEnd = (end: WireEnd) => Point | undefined;

export interface WireHit {
  wire: Wire;
  seg: number;
  snapped: Point;
}

/** Grid-snap along a (typically orthogonal) segment without leaving it. */
function snapAlongSegment(p: Point, s0: Point, s1: Point, g: number): Point {
  const clamp = (v: number, a: number, b: number) =>
    Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
  if (s0.x === s1.x) return { x: s0.x, y: clamp(Math.round(p.y / g) * g, s0.y, s1.y) };
  if (s0.y === s1.y) return { x: clamp(Math.round(p.x / g) * g, s0.x, s1.x), y: s0.y };
  return p;
}

/** Per-wire closest-segment hit within the fat click radius, one entry per wire
 *  that has any segment close enough (not just the single overall closest). */
function hitsForPos(
  wires: readonly Wire[],
  pos: Point,
  grid: number,
  resolveEnd: ResolveWireEnd,
): (WireHit & { d: number })[] {
  const hits: (WireHit & { d: number })[] = [];
  for (const w of wires) {
    const a = resolveEnd(w.a);
    const b = resolveEnd(w.b);
    if (!a || !b) continue;
    const pts = w.points.length ? [a, ...w.points, b] : routeOrthogonal(a, b);
    let best: (WireHit & { d: number }) | undefined;
    for (let i = 0; i < pts.length - 1; i++) {
      const proj = projectOntoSegment(pos, pts[i]!, pts[i + 1]!);
      const d = Math.hypot(proj.x - pos.x, proj.y - pos.y);
      if (d <= WIRE_BODY_HIT_RADIUS && (!best || d < best.d))
        best = { wire: w, seg: i, snapped: snapAlongSegment(proj, pts[i]!, pts[i + 1]!, grid), d };
    }
    if (best) hits.push(best);
  }
  return hits;
}

/** Nearest wire segment to pos, snapped along it, within the fat click radius;
 *  undefined if nothing is close enough. */
export function findWireHit(
  wires: readonly Wire[],
  pos: Point,
  grid: number,
  resolveEnd: ResolveWireEnd,
): WireHit | undefined {
  const hits = hitsForPos(wires, pos, grid, resolveEnd);
  if (hits.length === 0) return undefined;
  return hits.reduce((a, b) => (a.d <= b.d ? a : b));
}

/** Every distinct wire whose polyline passes within tolerance of pos -- unlike
 *  `findWireHit`, doesn't discard the second wire at a genuine crossing.
 *  All returned hits share one canonical snapped point so a single junction
 *  sits exactly once at their meeting point. */
export function findWireHitsAt(
  wires: readonly Wire[],
  pos: Point,
  grid: number,
  resolveEnd: ResolveWireEnd,
): WireHit[] {
  const hits = hitsForPos(wires, pos, grid, resolveEnd);
  if (hits.length === 0) return [];
  const canonical = hits.reduce((a, b) => (a.d <= b.d ? a : b)).snapped;
  return hits.map((h) => ({ wire: h.wire, seg: h.seg, snapped: canonical }));
}

/** Existing junction within grid-snap tolerance of pos, if any -- reused instead
 *  of splitting a second time on top of an already-junctioned point. */
export function junctionNear(
  junctions: Circuit['junctions'],
  pos: Point,
  grid: number,
): Circuit['junctions'][number] | undefined {
  return junctions.find((j) => Math.hypot(j.pos.x - pos.x, j.pos.y - pos.y) < grid * 0.4);
}

/** Splits `hit.wire` at `hit.snapped` into two wires sharing a new junction end,
 *  mutating `draft` in place: drops the original wire, pushes both halves. Bend
 *  points on either side of the split stay with their half. Caller is
 *  responsible for pushing the shared `Junction` itself (once, even when
 *  splitting several wires at the same crossing point). */
export function splitWireAtHit(
  draft: Circuit,
  hit: WireHit,
  junctionId: string,
  genWireId: () => string,
): void {
  const idx = draft.wires.findIndex((x) => x.id === hit.wire.id);
  if (idx < 0) return;
  const before = hit.wire.points.slice(0, hit.seg);
  const after = hit.wire.points.slice(hit.seg);
  draft.wires.splice(
    idx,
    1,
    {
      id: genWireId(),
      a: hit.wire.a,
      b: { kind: 'junction', junction: junctionId },
      points: before,
    },
    {
      id: genWireId(),
      a: { kind: 'junction', junction: junctionId },
      b: hit.wire.b,
      points: after,
    },
  );
}

/** Which end of `hit.wire`, if any, is a free end sitting right at `hit.snapped`
 *  (same tolerance as `junctionNear`) -- landing a new connection exactly on a
 *  dangling free end should convert that end in place, not carve a
 *  zero-length stub via `splitWireAtHit` (the split point would coincide with
 *  the wire's own endpoint). */
export function freeEndAtHit(hit: WireHit, grid: number): 'a' | 'b' | undefined {
  const tol = grid * 0.4;
  const near = (end: WireEnd) =>
    end.kind === 'free' && Math.hypot(end.pos.x - hit.snapped.x, end.pos.y - hit.snapped.y) < tol;
  if (near(hit.wire.a)) return 'a';
  if (near(hit.wire.b)) return 'b';
  return undefined;
}

/** Attaches a junction at `hit`: converts a free end sitting right there in
 *  place (no split), otherwise splits the wire's body as `splitWireAtHit`
 *  does. The single entry point callers should use instead of calling
 *  `splitWireAtHit` directly, so a click landing exactly on a dangling free
 *  end always joins it instead of leaving a same-position stub wire behind. */
export function attachAtHit(
  draft: Circuit,
  hit: WireHit,
  junctionId: string,
  grid: number,
  genWireId: () => string,
): void {
  const end = freeEndAtHit(hit, grid);
  if (end) {
    const w = draft.wires.find((x) => x.id === hit.wire.id);
    if (w) w[end] = { kind: 'junction', junction: junctionId };
    return;
  }
  splitWireAtHit(draft, hit, junctionId, genWireId);
}

/** Resolves a WireEnd using only data already in the circuit draft (no render
 *  geometry) -- 'free' and 'tap' ends carry their own position, 'junction'
 *  resolves against the draft's own junctions; 'pin' needs external geometry
 *  and resolves to undefined here. */
function pureResolveEnd(draft: Circuit, end: WireEnd): Point | undefined {
  if (end.kind === 'free' || end.kind === 'tap') return end.pos;
  if (end.kind === 'junction') return draft.junctions.find((j) => j.id === end.junction)?.pos;
  return undefined;
}

/** True when p1 -> mid -> p2 is a single straight orthogonal run (same axis,
 *  same direction of travel through mid) -- an ordinary 2-way pass-through, not
 *  an L-bend or a doubling-back. */
function collinearThrough(p1: Point, mid: Point, p2: Point): boolean {
  const v1x = mid.x - p1.x;
  const v1y = mid.y - p1.y;
  const v2x = p2.x - mid.x;
  const v2y = p2.y - mid.y;
  if (v1x === 0 && v1y === 0) return false;
  if (v2x === 0 && v2y === 0) return false;
  if (v1y === 0 && v2y === 0) return Math.sign(v1x) === Math.sign(v2x);
  if (v1x === 0 && v2x === 0) return Math.sign(v1y) === Math.sign(v2y);
  return false;
}

/** Post-mutation cleanup: removes a junction once it stops being a genuine
 *  branch. A junction referenced by zero wires is a stale leftover and is
 *  dropped; by exactly one wire, that wire's end becomes a plain free end at
 *  the junction's old position; by exactly two wires that run straight through
 *  it (collinear, opposite travel direction), the two wires are merged into one
 *  and the junction disappears -- an ordinary join needs no dot. A 3+-way
 *  meeting point, or a 2-way L-bend/unresolvable pair, is left untouched: it is
 *  a real branch, or we can't yet prove it isn't one.
 *  `resolveEnd`, when given, additionally resolves 'pin' ends (needs render
 *  geometry the pure circuit model doesn't have) so straight pin-to-pin wires
 *  can collapse too; without it, only free/junction-ended wires are eligible. */
/**
 * `mergeCorners` drops the collinearity requirement for a 2-way junction and
 * keeps its position as an ordinary bend instead. Off by default: on a live
 * board an explicitly-placed junction at a corner must stick. Packaging turns
 * it on, because a def's internals only ever need a junction at a real branch,
 * and a 2-way leftover there is debris from a stripped switch or LED.
 */
export function collapseJunctions(
  draft: Circuit,
  genWireId: () => string,
  resolveEnd?: ResolveWireEnd,
  mergeCorners = false,
): void {
  const resolve = (end: WireEnd): Point | undefined =>
    resolveEnd?.(end) ?? pureResolveEnd(draft, end);

  let changed = true;
  while (changed) {
    changed = false;
    for (const j of [...draft.junctions]) {
      const refs: { wire: Wire; end: 'a' | 'b' }[] = [];
      for (const w of draft.wires) {
        if (w.a.kind === 'junction' && w.a.junction === j.id) refs.push({ wire: w, end: 'a' });
        if (w.b.kind === 'junction' && w.b.junction === j.id) refs.push({ wire: w, end: 'b' });
      }
      if (refs.length === 0) {
        draft.junctions = draft.junctions.filter((x) => x.id !== j.id);
        changed = true;
        continue;
      }
      if (refs.length === 1) {
        const { wire, end } = refs[0]!;
        if (end === 'a') wire.a = { kind: 'free', pos: j.pos };
        else wire.b = { kind: 'free', pos: j.pos };
        draft.junctions = draft.junctions.filter((x) => x.id !== j.id);
        changed = true;
        continue;
      }
      if (refs.length !== 2) continue; // 3+-way: a real branch, leave it

      const [r1, r2] = refs as [{ wire: Wire; end: 'a' | 'b' }, { wire: Wire; end: 'a' | 'b' }];
      if (r1.wire.id === r2.wire.id) continue; // self-loop through one junction: leave it
      const near1 = r1.end === 'a' ? r1.wire.points[0] : r1.wire.points[r1.wire.points.length - 1];
      const near2 = r2.end === 'a' ? r2.wire.points[0] : r2.wire.points[r2.wire.points.length - 1];
      const other1 = r1.end === 'a' ? r1.wire.b : r1.wire.a;
      const other2 = r2.end === 'a' ? r2.wire.b : r2.wire.a;
      let keepCorner = false;
      if (!mergeCorners) {
        const p1 = near1 ?? resolve(other1);
        const p2 = near2 ?? resolve(other2);
        if (!p1 || !p2 || !collinearThrough(p1, j.pos, p2)) continue; // L-bend or unresolvable
      } else {
        const p1 = near1 ?? resolve(other1);
        const p2 = near2 ?? resolve(other2);
        keepCorner = !p1 || !p2 || !collinearThrough(p1, j.pos, p2);
      }

      const seg1 = r1.end === 'a' ? [...r1.wire.points].reverse() : r1.wire.points;
      const seg2 = r2.end === 'a' ? r2.wire.points : [...r2.wire.points].reverse();
      const merged: Wire = {
        id: genWireId(),
        a: other1,
        b: other2,
        points: keepCorner ? [...seg1, j.pos, ...seg2] : [...seg1, ...seg2],
      };
      draft.wires = draft.wires.filter((w) => w.id !== r1.wire.id && w.id !== r2.wire.id);
      draft.wires.push(merged);
      draft.junctions = draft.junctions.filter((x) => x.id !== j.id);
      changed = true;
    }
  }
}
