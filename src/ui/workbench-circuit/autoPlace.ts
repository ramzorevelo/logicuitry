// Placement pass for authored boards: a layered (Sugiyama) layout over the
// driver -> sink graph, then the schematic conventions the course draws by.
//
// Why layered rather than the nudge heuristics this replaced: the previous
// pass detected the columns a board already had and nudged rows to line pins
// up, but never reordered anything. That is Sugiyama with phase 2 missing, so
// crossings were never minimised and the router paid for every one of them in
// bends and detours. Tuning the spacing constants could not reach it.
//
// The three phases are the standard ones:
//   1. layer assignment  -- cycles broken by back-edge reversal, then longest
//      path, so sources land left and sinks right (H&H's schematic rule).
//   2. crossing minimisation -- median heuristic, alternating sweeps.
//   3. coordinate assignment -- Sugiyama's priority method, in PIN space: a
//      body is placed so its input pin meets its driver's output pin, which is
//      what makes a wire straight rather than merely short.
//
// On top of those sit the drawing conventions: a group feeding one multi-pin
// part gets an even pitch centred on that part, address and select lines run
// MSB-first top-down, and a body that is already where the layout wants it
// does not move.
//
// A hand-drawn board must survive this. The pass scores its own proposal
// against the board it was given and keeps the better one, so an instructor's
// deliberate drawing is never traded for a tidier but worse one.
//
// Deterministic per product rule 3: no randomness, fixed sweep count, every
// tie broken by component id.

import type { Wire, WireEnd } from '../../core/model/types';
import type { Vec2 } from '../../render/scene';
import type { RoutableComponent } from './autoRoute';

export interface AutoPlaceInput {
  components: readonly RoutableComponent[];
  wires: readonly Wire[];
  grid?: number;
}

export interface AutoPlaceResult {
  /** Component id -> the offset to add to its position. Only movers appear. */
  moved: Map<string, Vec2>;
}

/** Smallest gap between two layers, whatever the wiring needs. */
const MIN_GAP = 4;
/** Extra gap per net that needs its own vertical lane in it. */
const LANE = 2;
/** Smallest vertical gap between two bodies in one layer. */
const ROW_GAP = 2;
/** Gap where a layer crosses from one group to the next. Each border is drawn
 *  a step and a half outside its members and carries its name above it, so two
 *  adjacent bands need more room between them than two rows of one circuit. */
const BAND_GAP = 6;
/** Alternating median sweeps. Four is past the point of improvement for the
 *  10-40 body boards this draws; more only costs determinism nothing. */
const SWEEPS = 4;
/** Where the placed board's leftmost layer lands. */
const MARGIN = 6;

type PinEnd = { kind: 'pin'; component: string; pin: string };

function isPinEnd(e: WireEnd): e is PinEnd {
  return e.kind === 'pin';
}

interface Net {
  driver: PinEnd;
  sinks: PinEnd[];
}

/** Nets as driver-plus-sinks, from wires alone. A net with no single driver
 *  contributes no ordering, so it is skipped rather than guessed at. */
function netsOf(wires: readonly Wire[], byId: ReadonlyMap<string, RoutableComponent>): Net[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k);
    if (p === undefined) {
      parent.set(k, k);
      return k;
    }
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  const key = (e: WireEnd): string | undefined =>
    e.kind === 'pin' ? `${e.component} ${e.pin}` : e.kind === 'junction' ? e.junction : undefined;

  for (const w of wires) {
    const a = key(w.a);
    const b = key(w.b);
    if (!a || !b) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const members = new Map<string, PinEnd[]>();
  const seen = new Set<string>();
  for (const w of wires)
    for (const e of [w.a, w.b]) {
      if (!isPinEnd(e)) continue;
      const k = key(e)!;
      if (seen.has(k)) continue;
      seen.add(k);
      const root = find(k);
      const list = members.get(root);
      if (list) list.push(e);
      else members.set(root, [e]);
    }

  const nets: Net[] = [];
  for (const root of [...members.keys()].sort()) {
    const ends = members.get(root)!;
    const drivers = ends.filter((e) => byId.get(e.component)?.pins.get(e.pin)?.dir === 'out');
    if (drivers.length !== 1) continue;
    const driver = drivers[0]!;
    nets.push({ driver, sinks: ends.filter((e) => e !== driver) });
  }
  return nets;
}

/**
 * Layered placement. Returns the per-component offset; the caller applies it
 * to `pos` (and to anything else anchored to the component), so this stays
 * pure geometry with no model knowledge.
 */
export function autoPlace(input: AutoPlaceInput): AutoPlaceResult {
  const g = input.grid ?? 16;
  const byId = new Map(input.components.map((c) => [c.id, c]));
  if (byId.size === 0) return { moved: new Map() };
  const nets = netsOf(input.wires, byId);

  const layers = assignLayers(input.components, nets);
  const order = minimiseCrossings(layers, nets, byId);
  const proposed = assignCoordinates(order, nets, byId, g);

  // Keep the instructor's drawing when it is already the better one: a
  // deliberate layout must never be traded for a tidier but worse proposal.
  const current = new Map<string, Vec2>();
  for (const c of input.components) current.set(c.id, { x: c.bounds.x, y: c.bounds.y });
  if (score(proposed, nets, byId) >= score(current, nets, byId)) return { moved: new Map() };

  const moved = new Map<string, Vec2>();
  for (const c of input.components) {
    const to = proposed.get(c.id);
    if (!to) continue;
    const off = { x: to.x - c.bounds.x, y: to.y - c.bounds.y };
    if (off.x !== 0 || off.y !== 0) moved.set(c.id, off);
  }
  return { moved };
}

/** Total wire length plus a charge per crossing pair, in pin space. Lower is
 *  better. Length alone would happily stack two nets on one line, so the
 *  crossing term is what makes the two comparable. */
function score(
  at: ReadonlyMap<string, Vec2>,
  nets: readonly Net[],
  byId: ReadonlyMap<string, RoutableComponent>,
): number {
  const pinAt = (e: PinEnd): Vec2 | undefined => {
    const c = byId.get(e.component);
    const p = c?.pins.get(e.pin);
    const to = at.get(e.component);
    if (!c || !p || !to) return undefined;
    return { x: p.pos.x + (to.x - c.bounds.x), y: p.pos.y + (to.y - c.bounds.y) };
  };
  const spans: [Vec2, Vec2][] = [];
  let total = 0;
  for (const net of nets) {
    const d = pinAt(net.driver);
    if (!d) continue;
    for (const s of net.sinks) {
      const q = pinAt(s);
      if (!q) continue;
      total += Math.abs(q.x - d.x) + Math.abs(q.y - d.y);
      spans.push([d, q]);
    }
  }
  // A crossing costs about what a body's width of detour costs, which is what
  // the router will actually spend routing around it.
  for (let i = 0; i < spans.length; i++)
    for (let j = i + 1; j < spans.length; j++) if (segmentsCross(spans[i]!, spans[j]!)) total += 64;
  return total;
}

function segmentsCross([a, b]: [Vec2, Vec2], [c, d]: [Vec2, Vec2]): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const s1 = side(a, b, c);
  const s2 = side(a, b, d);
  const s3 = side(c, d, a);
  const s4 = side(c, d, b);
  return s1 !== s2 && s3 !== s4 && s1 !== 0 && s2 !== 0 && s3 !== 0 && s4 !== 0;
}

// --- Phase 1: layer assignment ---

/** Longest-path layering over driver -> sink edges. Cycles (every latch on
 *  the board is one) are broken first by reversing DFS back edges, the
 *  standard cycle-removal step; the reversal only affects layering, never the
 *  wires. A body with no driver starts at layer 0, so sources land on the left
 *  edge and outputs on the right -- H&H's schematic convention. */
function assignLayers(components: readonly RoutableComponent[], nets: readonly Net[]): string[][] {
  const ids = components.map((c) => c.id).sort();
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const net of nets)
    for (const s of net.sinks)
      if (s.component !== net.driver.component) out.get(net.driver.component)?.push(s.component);
  for (const list of out.values()) list.sort();

  // DFS back-edge detection. `state` 1 = on the current path, 2 = done.
  const state = new Map<string, number>();
  const back = new Set<string>();
  const edge = (u: string, v: string) => `${u}\u0000${v}`;
  const visit = (u: string): void => {
    state.set(u, 1);
    for (const v of out.get(u) ?? []) {
      const st = state.get(v) ?? 0;
      if (st === 1) back.add(edge(u, v));
      else if (st === 0) visit(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);

  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const u of ids)
    for (const v of out.get(u) ?? []) {
      if (back.has(edge(u, v))) continue;
      forward.get(u)!.push(v);
      indeg.set(v, indeg.get(v)! + 1);
    }

  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]!;
    for (const v of forward.get(u)!) {
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  const depth = Math.max(...layer.values()) + 1;
  const layers: string[][] = Array.from({ length: depth }, () => []);
  for (const id of ids) layers[layer.get(id)!]!.push(id);
  return layers;
}

// --- Phase 2: crossing minimisation ---

/** Median heuristic, alternating forward and backward sweeps. The initial
 *  order is the board's own top-to-bottom order, so a drawing that already
 *  reads well is the starting point and ties keep it. */
function minimiseCrossings(
  layers: readonly string[][],
  nets: readonly Net[],
  byId: ReadonlyMap<string, RoutableComponent>,
): string[][] {
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  for (const net of nets)
    for (const s of net.sinks) {
      if (s.component === net.driver.component) continue;
      push(succ, net.driver.component, s.component);
      push(pred, s.component, net.driver.component);
    }

  // A group must come out as one horizontal band, not interleaved with its
  // neighbour: two overlapping borders say the opposite of what a border is
  // for. Rank groups once, globally, and let it outrank the median inside
  // every layer -- crossing minimisation then runs WITHIN each band.
  const rank = groupRanks(layers, byId);
  const bandOf = (id: string) => rank.get(byId.get(id)!.group ?? '') ?? -1;

  let order = layers.map((ids) =>
    [...ids].sort(
      (a, b) =>
        bandOf(a) - bandOf(b) || byId.get(a)!.bounds.y - byId.get(b)!.bounds.y || (a < b ? -1 : 1),
    ),
  );
  let best = order.map((l) => [...l]);
  let bestCrossings = countCrossings(order, succ);

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const next = order.map((l) => [...l]);
    const from = down ? pred : succ;
    const range = down ? [...next.keys()].slice(1) : [...next.keys()].slice(0, -1).reverse();
    for (const k of range) {
      const ref = new Map<string, number>();
      const refLayer = next[down ? k - 1 : k + 1]!;
      refLayer.forEach((id, i) => ref.set(id, i));
      const pos = new Map<string, number>();
      next[k]!.forEach((id, i) => pos.set(id, i));
      next[k]!.sort((a, b) => {
        const band = bandOf(a) - bandOf(b);
        if (band !== 0) return band;
        const ma = median(a, from, ref, pos.get(a)!);
        const mb = median(b, from, ref, pos.get(b)!);
        return ma - mb || pos.get(a)! - pos.get(b)! || (a < b ? -1 : 1);
      });
    }
    order = next;
    const c = countCrossings(order, succ);
    if (c < bestCrossings) {
      bestCrossings = c;
      best = order.map((l) => [...l]);
    }
  }
  return best;
}

/** A stable band index per group, from the mean y its members start at, so a
 *  group keeps the vertical position the author drew it at while becoming
 *  contiguous. Ungrouped bodies rank above every group: on these boards they
 *  are the shared input switches, which belong to both circuits and so to
 *  neither band. */
function groupRanks(
  layers: readonly string[][],
  byId: ReadonlyMap<string, RoutableComponent>,
): Map<string, number> {
  const sum = new Map<string, { total: number; n: number }>();
  for (const ids of layers)
    for (const id of ids) {
      const g = byId.get(id)!.group;
      if (!g) continue;
      const at = sum.get(g) ?? { total: 0, n: 0 };
      at.total += byId.get(id)!.bounds.y;
      at.n += 1;
      sum.set(g, at);
    }
  const ordered = [...sum.entries()]
    .map(([g, { total, n }]) => [g, total / n] as const)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(ordered.map(([g], i) => [g, i]));
}

/** Median position of a body's neighbours in the adjacent layer. A body with
 *  no neighbour there keeps its own index, so it does not drift to the top. */
function median(
  id: string,
  adj: ReadonlyMap<string, string[]>,
  ref: ReadonlyMap<string, number>,
  fallback: number,
): number {
  const ps = (adj.get(id) ?? [])
    .map((n) => ref.get(n))
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  if (ps.length === 0) return fallback;
  const m = ps.length >> 1;
  return ps.length % 2 ? ps[m]! : (ps[m - 1]! + ps[m]!) / 2;
}

/** Crossings between every pair of adjacent layers, counted pairwise. At this
 *  size the O(n^2) count is far cheaper than the sort that calls it. */
function countCrossings(order: readonly string[][], succ: ReadonlyMap<string, string[]>): number {
  let total = 0;
  for (let k = 0; k + 1 < order.length; k++) {
    const pos = new Map<string, number>();
    order[k + 1]!.forEach((id, i) => pos.set(id, i));
    const edges: [number, number][] = [];
    order[k]!.forEach((u, i) => {
      for (const v of succ.get(u) ?? []) {
        const j = pos.get(v);
        if (j !== undefined) edges.push([i, j]);
      }
    });
    for (let i = 0; i < edges.length; i++)
      for (let j = i + 1; j < edges.length; j++) {
        const [a1, b1] = edges[i]!;
        const [a2, b2] = edges[j]!;
        if ((a1 - a2) * (b1 - b2) < 0) total++;
      }
  }
  return total;
}

// --- Phase 3: coordinate assignment ---

/** x per layer, then y by the priority method. Everything works in PIN space:
 *  a body is placed so the input pin meets its driver's output pin, because
 *  aligning bodies only makes a wire short, and aligning pins makes it
 *  straight. */
function assignCoordinates(
  order: readonly string[][],
  nets: readonly Net[],
  byId: ReadonlyMap<string, RoutableComponent>,
  g: number,
): Map<string, Vec2> {
  const at = new Map<string, Vec2>();
  const layerOf = new Map<string, number>();
  order.forEach((ids, k) => ids.forEach((id) => layerOf.set(id, k)));

  // x: each layer sits a gap behind the widest body of the one before it.
  let left = MARGIN * g;
  order.forEach((ids, k) => {
    if (k > 0) left += gapBefore(k, nets, layerOf) * g;
    for (const id of ids) at.set(id, { x: left, y: byId.get(id)!.bounds.y });
    left += Math.max(...ids.map((id) => byId.get(id)!.bounds.w));
  });

  const driverOf = new Map<string, PinEnd>();
  for (const net of nets)
    for (const s of net.sinks) driverOf.set(`${s.component} ${s.pin}`, net.driver);

  // y: layer by layer, so a body is placed against drivers already settled.
  // Priority = pin count, so the busiest body wins an alignment contest and
  // the leaves settle onto it rather than the other way round.
  order.forEach((ids, k) => {
    const want = new Map<string, number>();
    for (const id of ids) {
      const c = byId.get(id)!;
      const ys: number[] = [];
      for (const [name, pin] of c.pins) {
        if (pin.dir !== 'in') continue;
        const d = driverOf.get(`${id} ${name}`);
        if (!d || (layerOf.get(d.component) ?? 0) >= k) continue;
        const src = byId.get(d.component);
        const to = at.get(d.component);
        const q = src?.pins.get(d.pin);
        if (!src || !to || !q) continue;
        ys.push(q.pos.y + (to.y - src.bounds.y) - (pin.pos.y - c.bounds.y));
      }
      if (ys.length === 0) continue;
      // Unanimous wants align a pin exactly, which is the whole point. When
      // they disagree no y lines anything up, so the median would only cost
      // the column its pitch for nothing: keep the author's y if it already
      // lies between the drivers, and otherwise pull it just inside them.
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const here = byId.get(id)!.bounds.y;
      want.set(id, lo === hi ? lo : snap(Math.min(hi, Math.max(lo, here)), g));
    }
    packColumn(ids, want, byId, at, g);
  });

  applyGroupRules(order, nets, byId, at, layerOf, g);
  separateBands(order, byId, at, g);
  packSubgraphs(order, nets, byId, at, g);
  return at;
}

/** Stack disconnected subgraphs, each starting at the same left edge.
 *
 *  Two circuits with no wire between them share layer indices, so layering
 *  alone interleaves their columns; without this they end up woven together.
 *  They are stacked rather than set side by side because a logic circuit is
 *  far wider than it is tall: two of them in one row are too far apart to
 *  compare, which is the whole reason a board carries both. Stacked, the
 *  matching stages sit directly above one another. */
function packSubgraphs(
  order: readonly string[][],
  nets: readonly Net[],
  byId: ReadonlyMap<string, RoutableComponent>,
  at: Map<string, Vec2>,
  g: number,
): void {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const v = parent.get(k);
    if (v === undefined) {
      parent.set(k, k);
      return k;
    }
    if (v === k) return k;
    const r = find(v);
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const ids of order) for (const id of ids) find(id);
  for (const net of nets) for (const sink of net.sinks) union(net.driver.component, sink.component);

  const parts = new Map<string, string[]>();
  for (const ids of order)
    for (const id of ids) {
      const root = find(id);
      parts.set(root, [...(parts.get(root) ?? []), id]);
    }
  if (parts.size < 2) return;

  const box = (ids: readonly string[]) => ({
    left: Math.min(...ids.map((id) => at.get(id)!.x)),
    top: Math.min(...ids.map((id) => at.get(id)!.y)),
    bottom: Math.max(...ids.map((id) => at.get(id)!.y + byId.get(id)!.bounds.h)),
  });

  // Top to bottom in the order they already sit, so a board the instructor
  // arranged keeps its reading order.
  const ordered = [...parts.values()].sort(
    (a, b) => box(a).top - box(b).top || box(a).left - box(b).left,
  );

  const left = Math.min(...ordered.map((ids) => box(ids).left));
  let y = Math.min(...ordered.map((ids) => box(ids).top));
  for (const ids of ordered) {
    const own = box(ids);
    const dx = left - own.left;
    const dy = y - own.top;
    if (dx !== 0 || dy !== 0)
      for (const id of ids) {
        const p = at.get(id)!;
        at.set(id, { x: p.x + dx, y: p.y + dy });
      }
    y = own.bottom + dy + BAND_GAP * g;
  }
}

/** Push each group's members down until no two groups' extents overlap.
 *
 *  Ordering within a layer is not enough on its own: a group spans several
 *  layers, and its drawn border is the union over all of them, so a member
 *  placed low in one column can reach into the band below even though every
 *  column was ordered correctly. Two overlapping borders say the opposite of
 *  what a border is for, so separation is enforced on the extents themselves.
 *
 *  Ungrouped bodies (the shared input switches) are left where they are: they
 *  belong to every circuit on the board and so to no band. */
function separateBands(
  order: readonly string[][],
  byId: ReadonlyMap<string, RoutableComponent>,
  at: Map<string, Vec2>,
  g: number,
): void {
  const members = new Map<string, string[]>();
  for (const ids of order)
    for (const id of ids) {
      const group = byId.get(id)!.group;
      if (!group) continue;
      members.set(group, [...(members.get(group) ?? []), id]);
    }
  if (members.size < 2) return;

  const extent = (ids: readonly string[]) => ({
    top: Math.min(...ids.map((id) => at.get(id)!.y)),
    bottom: Math.max(...ids.map((id) => at.get(id)!.y + byId.get(id)!.bounds.h)),
  });

  const bands = [...members.entries()].sort(
    (a, b) => extent(a[1]).top - extent(b[1]).top || (a[0] < b[0] ? -1 : 1),
  );

  let floor = -Infinity;
  for (const [, ids] of bands) {
    const { top, bottom } = extent(ids);
    const shift = Math.max(0, floor - top);
    if (shift > 0) for (const id of ids) at.set(id, { x: at.get(id)!.x, y: at.get(id)!.y + shift });
    floor = bottom + shift + BAND_GAP * g;
  }
}

/** Lanes that must fit between layer k-1 and layer k: a net crossing the gap
 *  AND changing row needs one of its own; a net running straight through does
 *  not. Sizing the gap by that count is what keeps a simple board tight. */
function gapBefore(k: number, nets: readonly Net[], layerOf: ReadonlyMap<string, number>): number {
  let lanes = 0;
  for (const net of nets) {
    const from = layerOf.get(net.driver.component);
    if (from === undefined || from >= k) continue;
    if (net.sinks.some((s) => (layerOf.get(s.component) ?? 0) >= k)) lanes++;
  }
  return Math.max(MIN_GAP, LANE * lanes);
}

/** Place a layer's bodies at the y each one wants, in the order phase 2 fixed,
 *  never overlapping. Bodies with no preference keep their spacing. */
function packColumn(
  ids: readonly string[],
  want: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, RoutableComponent>,
  at: Map<string, Vec2>,
  g: number,
): void {
  let floor = -Infinity;
  let previous: string | undefined;
  for (const id of ids) {
    const c = byId.get(id)!;
    const crossesBand = previous !== undefined && previous !== (c.group ?? '');
    const y = Math.max(
      want.get(id) ?? c.bounds.y,
      crossesBand ? floor + (BAND_GAP - ROW_GAP) * g : floor,
    );
    at.set(id, { x: at.get(id)!.x, y });
    floor = y + c.bounds.h + ROW_GAP * g;
    previous = c.group ?? '';
  }
}

function snap(v: number, g: number): number {
  return Math.round(v / g) * g;
}

// --- The drawing conventions ---

/** A run of bodies wired to the numbered pins of ONE part gets an even pitch,
 *  centred on that part's pin span, ordered MSB at the top. This is the
 *  decoder's output ladder and the mux's data column: on a teaching board the
 *  even pitch and the bit order carry as much as the wiring does. */
function applyGroupRules(
  order: readonly string[][],
  nets: readonly Net[],
  byId: ReadonlyMap<string, RoutableComponent>,
  at: Map<string, Vec2>,
  layerOf: ReadonlyMap<string, number>,
  g: number,
): void {
  // Bodies that touch exactly one other component, keyed by that component.
  const partner = new Map<string, Set<string>>();
  const pinOn = new Map<string, string>();
  for (const net of nets) {
    for (const s of net.sinks) {
      if (s.component === net.driver.component) continue;
      note(s.component, net.driver.component, net.driver.pin);
      note(net.driver.component, s.component, s.pin);
    }
  }
  function note(who: string, other: string, otherPin: string): void {
    const set = partner.get(who) ?? new Set<string>();
    set.add(other);
    partner.set(who, set);
    pinOn.set(`${who}>${other}`, otherPin);
  }

  for (const ids of order) {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const ps = partner.get(id);
      if (!ps || ps.size !== 1) continue;
      const [other] = [...ps];
      if ((byId.get(other!)?.pins.size ?? 0) < 3) continue;
      const list = groups.get(other!) ?? [];
      list.push(id);
      groups.set(other!, list);
    }

    for (const [other, members] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (members.length < 3) continue;
      const part = byId.get(other)!;
      const anchor = at.get(other);
      if (!anchor || layerOf.get(other) === undefined) continue;

      // MSB topmost, by the trailing index on the pin each member drives or
      // is driven by -- never by label text, which is not a bit weight.
      const weight = (id: string) => indexOf(pinOn.get(`${id}>${other}`) ?? '');
      const indexed = members.every((id) => weight(id) >= 0);
      const sorted = [...members].sort((a, b) =>
        indexed ? weight(b) - weight(a) : at.get(a)!.y - at.get(b)!.y || (a < b ? -1 : 1),
      );

      // One pitch for the run, and centre it on the part's own pin span.
      const tallest = Math.max(...sorted.map((id) => byId.get(id)!.bounds.h));
      const pitch = Math.ceil((tallest + ROW_GAP * g) / g) * g;
      const pins = [...part.pins.values()].map((p) => p.pos.y - part.bounds.y + anchor.y);
      const mid = (Math.min(...pins) + Math.max(...pins)) / 2;
      let y = snap(mid - ((sorted.length - 1) * pitch + tallest) / 2, g);
      for (const id of sorted) {
        at.set(id, { x: at.get(id)!.x, y });
        y += pitch;
      }
    }
  }
}

/** Trailing decimal index of a pin name (`a2` -> 2, `y` -> -1). The bit weight
 *  a schematic orders by, taken from the pin, which is the only place it is
 *  unambiguous. */
function indexOf(pin: string): number {
  const m = /(\d+)$/.exec(pin);
  return m ? Number(m[1]) : -1;
}
