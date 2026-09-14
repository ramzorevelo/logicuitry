// A group's border and its name are the handle for the group as a whole.
// Kept out of the component so the geometry is unit-testable.

import type { Circuit, Group } from '../../core/model/types';
import type { Rect, Vec2 } from '../../render/scene';

export interface GroupHandleQuery {
  groups: readonly Group[];
  rects: ReadonlyMap<string, Rect>;
  /** World-space slop, the caller's screen tolerance divided by the zoom. */
  tol: number;
  /** Cap height of the name, drawn sitting on the rect's top edge. */
  nameHeight: number;
  /** World width of the name as the scene draws it. */
  measureName: (name: string) => number;
}

const onBorder = (r: Rect, p: Vec2, tol: number): boolean => {
  if (p.x < r.x - tol || p.x > r.x + r.w + tol) return false;
  if (p.y < r.y - tol || p.y > r.y + r.h + tol) return false;
  // Inside the border band but clear of the stroke: that is the group's
  // interior, where a lasso must still start.
  const insideX = p.x > r.x + tol && p.x < r.x + r.w - tol;
  const insideY = p.y > r.y + tol && p.y < r.y + r.h - tol;
  return !(insideX && insideY);
};

const onName = (r: Rect, p: Vec2, w: number, h: number, tol: number): boolean =>
  p.x >= r.x - tol && p.x <= r.x + w + tol && p.y >= r.y - h - tol && p.y <= r.y;

/** The group whose border or name is under the point, innermost first: a
 *  child's border sitting close to its parent's must win, or a nested group
 *  could never be grabbed. */
export function groupHandleAt(q: GroupHandleQuery, world: Vec2): string | undefined {
  const candidates = q.groups
    .flatMap((g) => {
      const rect = q.rects.get(g.id);
      return rect ? [{ group: g, rect }] : [];
    })
    .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
  for (const { group, rect } of candidates) {
    if (onBorder(rect, world, q.tol)) return group.id;
    if (onName(rect, world, q.measureName(group.name), q.nameHeight, q.tol)) return group.id;
  }
  return undefined;
}

/** Everything grabbing the border should move: the group's own components,
 *  those of every descendant group, and the junctions the border encloses.
 *  Junctions carry no membership, so the drawn rect is what decides, which is
 *  also what the user sees the border promising. */
export function groupMemberIds(
  circuit: Circuit,
  groupId: string,
  rect: Rect | undefined,
): Set<string> {
  const scope = new Set([groupId]);
  // Parent links point upward only, so a pass per level settles the closure.
  for (let added = true; added; ) {
    added = false;
    for (const g of circuit.groups ?? [])
      if (g.parent !== undefined && scope.has(g.parent) && !scope.has(g.id)) {
        scope.add(g.id);
        added = true;
      }
  }
  const out = new Set<string>();
  for (const c of circuit.components) if (c.group && scope.has(c.group)) out.add(c.id);
  if (rect)
    for (const j of circuit.junctions)
      if (j.pos.x >= rect.x && j.pos.x <= rect.x + rect.w)
        if (j.pos.y >= rect.y && j.pos.y <= rect.y + rect.h) out.add(j.id);
  return out;
}

/** The innermost group whose drawn rect encloses a point, or undefined when
 *  none does. Placement reads membership off this, on the same promise the
 *  border already makes for junctions in groupMemberIds: what it encloses, it
 *  owns. Without it a part dropped inside a group is a stray -- it does not
 *  move with the border and its net labels resolve board-wide. */
export function groupContaining(
  groups: readonly Group[],
  rects: ReadonlyMap<string, Rect>,
  p: Vec2,
): string | undefined {
  let best: { id: string; area: number } | undefined;
  for (const g of groups) {
    const r = rects.get(g.id);
    if (!r) continue;
    if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
    const area = r.w * r.h;
    if (!best || area < best.area) best = { id: g.id, area };
  }
  return best?.id;
}
