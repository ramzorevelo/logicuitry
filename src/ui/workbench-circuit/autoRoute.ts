// Maze router for authored wiring: an A* search per branch over the schematic
// grid, with component bodies as hard obstacles and other nets' segments as
// costed ones. Fan-out grows as a tree -- each further sink routes to the
// nearest point of what the net has already built -- so a driver leaves through
// one trunk with junction dots at the branches, not N stacked parallel runs.
//
// Why not computeWireRoutes: that one routes pairwise, in board order, with a
// single elbow and no global view. It is the right behaviour for click-to-click
// drawing, where the instructor tidies afterward, and it stays untouched. This
// is the authoring pass that bakes explicit `points` into the wire records.
//
// Why a maze search rather than channel assignment: a channel router only works
// where a clean vertical corridor exists between the driver's column and its
// sinks'. Feedback paths, a sink several columns downstream, and any net whose
// corridor is occupied all fall outside that, so a channel pass declines them
// -- which leaves the ugliest routes on the board exactly where they were. A*
// declines nothing reachable, and expresses "do not overlap", "do not cross"
// and "do not bend" as costs rather than as preconditions.
//
// Deterministic per product rule 3: fixed net order, fixed neighbour order and
// a total ordering on the frontier, so a given board always routes identically.

import type { Junction, PinDir, Wire, WireEnd } from '../../core/model/types';
import type { Rect, Vec2 } from '../../render/scene';
import { normalizeBends } from './wireGeom';

export interface RoutablePin {
  pos: Vec2;
  dir: PinDir;
}

export interface RoutableComponent {
  id: string;
  bounds: Rect;
  pins: ReadonlyMap<string, RoutablePin>;
  /** Group membership, read by autoPlace so a group's bodies stay contiguous.
   *  The router ignores it: a wire connects whichever side of a border it
   *  starts on. */
  group?: string;
}

export interface AutoRouteInput {
  components: readonly RoutableComponent[];
  wires: readonly Wire[];
  junctions: readonly Junction[];
  grid?: number;
  /** Component ids the caller is willing to have re-routed. A net qualifies
   *  only when every component on it is in the set, so tidying a selection
   *  never reshapes wiring the user did not select. Omitted means the lot.
   *  Components outside the set still count as obstacles. */
  only?: ReadonlySet<string>;
}

export interface AutoRouteResult {
  wires: Wire[];
  junctions: Junction[];
  /** Nets actually rewritten; the rest passed through unchanged. */
  routed: number;
}

/** One grid step. Every other weight is a multiple of it, so each reads as
 *  "worth this many extra cells of detour". */
const STEP = 10;
/** A corner. The graph-drawing literature prices a bend at 2-10x a unit of
 *  length; at the low end a router takes an 8px dogleg rather than a slightly
 *  longer straight run, which is exactly the defect this pass exists to
 *  remove, so we sit near the top of that range. */
const BEND = 64;
/** Crossing another net at right angles -- legible, but worth a detour. */
const CROSS = 80;
/** Running along another net's segment: two wires drawn on top of each other,
 *  the defect this pass exists to remove. Priced out of reach but not blocked,
 *  so a boxed-in net still routes rather than being abandoned. */
const SHARE = 6000;
/** Passing over a pin belonging to another net -- reads as a connection. */
const FOREIGN_PIN = 5000;
/** Hugging a body: just enough to prefer the next lane out. */
const HUG = 12;
/** Running one cell from a parallel neighbour. Two trunks a single grid step
 *  apart are legible on a laptop and a smear on a lecture-room TV, so pay a
 *  few cells of detour to leave a lane between them. */
const CROWD = 90;

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

type PinEnd = { kind: 'pin'; component: string; pin: string };

function isPinEnd(e: WireEnd): e is PinEnd {
  return e.kind === 'pin';
}

function pinKey(component: string, pin: string): string {
  return `${component} ${pin}`;
}

/** Priority queue over (f, g, cell * 4 + dir), popped in exactly that total
 *  order, so ties never depend on insertion order and the same board always
 *  yields the same routes. Costs are integers, so it buckets on f and keeps a
 *  small heap of (g, key) packed into one number per bucket: a project-size
 *  board pops millions of states, and one global tuple heap dominated. */
class Frontier {
  private buckets: number[][] = [];
  private touched: number[] = [];
  private cur = 0;
  /** Packing radix: a state key is below it, so g * radix + key is exact. */
  private radix = 1;
  size = 0;
  /** The last popped entry's g and state key. */
  topG = 0;
  topK = 0;

  clear(states: number): void {
    for (const f of this.touched) this.buckets[f]!.length = 0;
    this.touched.length = 0;
    this.size = 0;
    this.cur = Infinity;
    this.radix = 2 ** Math.ceil(Math.log2(states + 1));
  }

  push(f: number, g: number, k: number): void {
    let heap = this.buckets[f];
    if (!heap) heap = this.buckets[f] = [];
    if (heap.length === 0) this.touched.push(f);
    // Below the cursor only if the heuristic were inconsistent; moving the
    // cursor down keeps the pop order exact either way.
    if (f < this.cur) this.cur = f;
    const v = g * this.radix + k;
    let i = heap.length;
    heap.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]! <= v) break;
      heap[i] = heap[p]!;
      i = p;
    }
    heap[i] = v;
    this.size++;
  }

  /** Removes the least entry into topG/topK; the caller checks size first. */
  pop(): void {
    let heap = this.buckets[this.cur];
    while (!heap || heap.length === 0) heap = this.buckets[++this.cur];
    const top = heap[0]!;
    const last = heap.pop()!;
    const n = heap.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const m = l + 1 < n && heap[l + 1]! < heap[l]! ? l + 1 : l;
        if (heap[m]! >= last) break;
        heap[i] = heap[m]!;
        i = m;
      }
      heap[i] = last;
    }
    this.size--;
    this.topG = Math.floor(top / this.radix);
    this.topK = top - this.topG * this.radix;
  }
}

interface Net {
  /** The driver's pin key. Unique per net and derived from connectivity
   *  alone, so net order does not depend on wire ids or board order and a
   *  second pass over a routed board reproduces the first one exactly. */
  key: string;
  /** The net's original wire ids. Its wires are replaced wholesale, so these
   *  are only needed to know which ids the pass is free to reuse. */
  old: string[];
  /** Driver first, then sinks: the tree grows from the head. */
  ends: PinEnd[];
  cells: number[];
  /** One cell outward from each pin, along the face the pin sits on. The tree
   *  is built over THESE, so a fan-out branches on the trunk with a dot rather
   *  than on a component's pin -- a wire ending on another gate's input pin
   *  reads as a T on that pin, which is not what a branch means. */
  stubs: number[];
}

/** The search grid: one cell per `grid` units, offset so cell 0 sits in a
 *  margin outside everything, which is what lets a net go the long way round. */
class Grid {
  readonly blocked: Uint8Array;
  readonly hug: Uint8Array;
  /** Per cell, the owner id (see ownerId) of a pin there; 0 for no pin. */
  readonly pinOwner: Int32Array;
  /** Committed segments per orientation, so a later net prices running
   *  alongside one differently from crossing it. */
  readonly usedH: Uint8Array;
  readonly usedV: Uint8Array;
  /** Which net laid each committed run. A net running along its own trunk is
   *  merging with itself, which is free; only another net's run is overlap. */
  readonly byH: Int32Array;
  readonly byV: Int32Array;
  /** Owner keys as small ints, so the search compares numbers, not strings. */
  private readonly owners = new Map<string, number>();
  /** A* scratch, reused across searches: `best` is valid only where `seen`
   *  holds the current search's stamp, so no full-grid refill per search. */
  readonly best: Float64Array;
  readonly from: Int32Array;
  readonly seen: Uint32Array;
  stamp = 0;
  readonly frontier = new Frontier();

  constructor(
    readonly step: number,
    readonly x0: number,
    readonly y0: number,
    readonly cols: number,
    readonly rows: number,
    components: readonly RoutableComponent[],
  ) {
    const n = cols * rows;
    this.blocked = new Uint8Array(n);
    this.hug = new Uint8Array(n);
    this.pinOwner = new Int32Array(n);
    this.usedH = new Uint8Array(n);
    this.usedV = new Uint8Array(n);
    this.byH = new Int32Array(n);
    this.byV = new Int32Array(n);
    this.best = new Float64Array(n * 4);
    this.from = new Int32Array(n * 4);
    this.seen = new Uint32Array(n * 4);

    // A body blocks its border as well as its interior. Pins sit on the
    // border, so leaving the border walkable would let a route slide along an
    // edge and read as if it touched every pin on that side.
    for (const c of components) {
      const b = c.bounds;
      for (let r = this.row(b.y); r <= this.row(b.y + b.h); r++)
        for (let col = this.col(b.x); col <= this.col(b.x + b.w); col++) {
          const i = this.idx(col, r);
          if (i >= 0) this.blocked[i] = 1;
        }
    }
    for (let i = 0; i < n; i++) {
      if (this.blocked[i]) continue;
      const col = i % cols;
      const r = (i / cols) | 0;
      for (let d = 0; d < 4; d++) {
        const j = this.idx(col + DX[d]!, r + DY[d]!);
        if (j >= 0 && this.blocked[j]) {
          this.hug[i] = 1;
          break;
        }
      }
    }
  }

  col(x: number): number {
    return Math.round((x - this.x0) / this.step);
  }
  row(y: number): number {
    return Math.round((y - this.y0) / this.step);
  }
  idx(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }
  cellOf(p: Vec2): number {
    return this.idx(this.col(p.x), this.row(p.y));
  }
  pointOf(i: number): Vec2 {
    return {
      x: this.x0 + (i % this.cols) * this.step,
      y: this.y0 + ((i / this.cols) | 0) * this.step,
    };
  }

  ownerId(key: string): number {
    let id = this.owners.get(key);
    if (id === undefined) {
      id = this.owners.size + 1;
      this.owners.set(key, id);
    }
    return id;
  }

  /** Pins are the doors in an otherwise solid body. */
  openPin(i: number, owner: string): void {
    this.blocked[i] = 0;
    this.pinOwner[i] = this.ownerId(owner);
  }

  /** Open the run of border cells a pin shares its face with, so a wire can
   *  approach along the side the pin is on. Without this a pin whose only free
   *  neighbour is off the body -- the input of a rotated gate, whose face is
   *  the body's top edge -- is reachable only from a lane one step out, which
   *  costs two bends for nothing. A face is border, never interior, so this
   *  draws nothing through a body; sliding along one past another net's pin
   *  still pays FOREIGN_PIN. */
  openFace(bounds: Rect, pin: Vec2): void {
    const c0 = this.col(bounds.x);
    const c1 = this.col(bounds.x + bounds.w);
    const r0 = this.row(bounds.y);
    const r1 = this.row(bounds.y + bounds.h);
    const pc = this.col(pin.x);
    const pr = this.row(pin.y);
    if (pc === c0 || pc === c1)
      for (let r = r0; r <= r1; r++) {
        const i = this.idx(pc, r);
        if (i >= 0) this.blocked[i] = 0;
      }
    if (pr === r0 || pr === r1)
      for (let c = c0; c <= c1; c++) {
        const i = this.idx(c, pr);
        if (i >= 0) this.blocked[i] = 0;
      }
  }

  commit(path: readonly number[], ownerKey: string): void {
    const owner = this.ownerId(ownerKey);
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1]!;
      const b = path[k]!;
      const horizontal = b - a === 1 || a - b === 1;
      const used = horizontal ? this.usedH : this.usedV;
      const by = horizontal ? this.byH : this.byV;
      used[a] = 1;
      used[b] = 1;
      by[a] = owner;
      by[b] = owner;
    }
  }
}

class IdMint {
  private wireSeq = 0;
  private junctionSeq = 0;
  private readonly usedWires: Set<string>;
  private readonly usedJunctions: Set<string>;

  /** Seeded from what survives the pass, not from what went in. A wire or dot
   *  this pass is about to discard must not push its replacement's id along,
   *  or a second pass over an already-routed board renames everything on it
   *  and stops being the no-op it should be. */
  constructor(keptWires: Iterable<string>, keptJunctions: Iterable<string>) {
    this.usedWires = new Set(keptWires);
    this.usedJunctions = new Set(keptJunctions);
  }

  wire(): string {
    let id = `w${++this.wireSeq}`;
    while (this.usedWires.has(id)) id = `w${++this.wireSeq}`;
    this.usedWires.add(id);
    return id;
  }

  junction(): string {
    let id = `j${++this.junctionSeq}`;
    while (this.usedJunctions.has(id)) id = `j${++this.junctionSeq}`;
    this.usedJunctions.add(id);
    return id;
  }
}

interface BuiltNet {
  wires: Wire[];
  junctions: Junction[];
}

/**
 * Re-route what can be re-routed cleanly, preserving everything else. A net is
 * rewritten only when every one of its ends resolves to a pin (or to a junction
 * this pass is free to re-derive) and every sink is reachable; taps, free ends
 * and unreachable pins leave the whole net exactly as it was.
 */
export function autoRoute(input: AutoRouteInput): AutoRouteResult {
  const step = input.grid ?? 16;
  const byId = new Map(input.components.map((c) => [c.id, c]));
  const { nets, kept } = groupNets(input, byId);
  if (nets.length === 0)
    return { wires: [...input.wires], junctions: [...input.junctions], routed: 0 };

  const grid = makeGrid(input, step);
  const ownerOfPin = new Map<string, string>();
  for (const net of nets)
    for (const e of net.ends) ownerOfPin.set(pinKey(e.component, e.pin), net.key);
  // Every pin is a door, whether or not its net is being routed: an untouched
  // net's pin must not be walled in, and must still cost a foreign net to
  // walk over. Pins with no routable net get a key nothing else can match.
  for (const c of input.components)
    for (const [name, pin] of c.pins) {
      grid.openFace(c.bounds, pin.pos);
      const i = grid.cellOf(pin.pos);
      if (i >= 0) grid.openPin(i, ownerOfPin.get(pinKey(c.id, name)) ?? `unrouted ${c.id} ${name}`);
    }

  // Wires we are not touching are obstacles like any other: their geometry is
  // fixed, so a re-routed net routes around them, not over them.
  const jpos = new Map(input.junctions.map((j) => [j.id, j.pos]));
  for (const w of kept) {
    const pts = polylineOf(w, byId, jpos);
    if (pts) grid.commit(cellsAlong(grid, pts), `kept ${w.id}`);
  }

  for (const net of nets) {
    net.cells = net.ends.map((e) => grid.cellOf(byId.get(e.component)!.pins.get(e.pin)!.pos));
    net.stubs = net.ends.map((e, i) => {
      const comp = byId.get(e.component)!;
      return stubCell(grid, net.cells[i]!, comp.bounds);
    });
  }

  // Short nets first: they have the least freedom to detour, and a long net
  // has room to go around whatever a short one commits.
  const order = [...nets].sort(
    (a, b) => halfPerimeter(a, grid) - halfPerimeter(b, grid) || (a.key < b.key ? -1 : 1),
  );

  const keptJunctionIds = kept.flatMap((w) =>
    [w.a, w.b].flatMap((e) => (e.kind === 'junction' ? [e.junction] : [])),
  );
  const ids = new IdMint(
    kept.map((w) => w.id),
    keptJunctionIds,
  );
  const survivors = new Set(keptJunctionIds);
  const replacement = new Map<string, BuiltNet>();
  for (const net of order) {
    const built = routeNet(net, grid, ids);
    if (built) replacement.set(net.key, built);
  }
  return stitch(input, nets, replacement, survivors);
}

function makeGrid(input: AutoRouteInput, step: number): Grid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const c of input.components) {
    see(c.bounds.x, c.bounds.y);
    see(c.bounds.x + c.bounds.w, c.bounds.y + c.bounds.h);
    for (const p of c.pins.values()) see(p.pos.x, p.pos.y);
  }
  for (const j of input.junctions) see(j.pos.x, j.pos.y);
  // Enough margin that a net can always take the long way round the outside.
  const m = 4 * step;
  const x0 = Math.floor((minX - m) / step) * step;
  const y0 = Math.floor((minY - m) / step) * step;
  return new Grid(
    step,
    x0,
    y0,
    Math.ceil((maxX + m - x0) / step) + 1,
    Math.ceil((maxY + m - y0) / step) + 1,
    input.components,
  );
}

function halfPerimeter(net: Net, grid: Grid): number {
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (const cell of net.cells) {
    const col = cell % grid.cols;
    const row = (cell / grid.cols) | 0;
    minC = Math.min(minC, col);
    maxC = Math.max(maxC, col);
    minR = Math.min(minR, row);
    maxR = Math.max(maxR, row);
  }
  return maxC - minC + (maxR - minR);
}

function polylineOf(
  w: Wire,
  byId: ReadonlyMap<string, RoutableComponent>,
  jpos: ReadonlyMap<string, Vec2>,
): Vec2[] | undefined {
  const at = (e: WireEnd): Vec2 | undefined =>
    e.kind === 'pin'
      ? byId.get(e.component)?.pins.get(e.pin)?.pos
      : e.kind === 'junction'
        ? jpos.get(e.junction)
        : undefined;
  const a = at(w.a);
  const b = at(w.b);
  return a && b ? normalizeBends([a, ...w.points, b]) : undefined;
}

/** Cells an existing orthogonal polyline occupies, so it can be marked used.
 *  A diagonal leg (a stored bend gone stale) contributes nothing rather than
 *  being guessed at. */
function cellsAlong(grid: Grid, pts: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < pts.length; k++) {
    const from = grid.cellOf(pts[k - 1]!);
    const to = grid.cellOf(pts[k]!);
    if (from < 0 || to < 0) continue;
    let c = from % grid.cols;
    let r = (from / grid.cols) | 0;
    const c1 = to % grid.cols;
    const r1 = (to / grid.cols) | 0;
    const dc = Math.sign(c1 - c);
    const dr = Math.sign(r1 - r);
    if (dc !== 0 && dr !== 0) continue;
    out.push(grid.idx(c, r));
    while (c !== c1 || r !== r1) {
      c += dc;
      r += dr;
      out.push(grid.idx(c, r));
    }
  }
  return out.filter((i) => i >= 0);
}

/** Union-find over wire ends. A net is routable only when every wire on it
 *  ends on a pin or a junction: a junction is ours to re-derive, a tap or free
 *  end is not, and half-rerouting a net is worse than leaving it alone. */
function groupNets(
  input: AutoRouteInput,
  byId: ReadonlyMap<string, RoutableComponent>,
): { nets: Net[]; kept: Wire[] } {
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
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const endKey = (e: WireEnd): string | undefined =>
    e.kind === 'pin'
      ? pinKey(e.component, e.pin)
      : e.kind === 'junction'
        ? `${e.junction}`
        : undefined;

  for (const w of input.wires) {
    const a = endKey(w.a);
    const b = endKey(w.b);
    if (a && b) union(a, b);
  }

  const wiresByNet = new Map<string, Wire[]>();
  const frozen = new Set<string>();
  for (const w of input.wires) {
    const a = endKey(w.a);
    const b = endKey(w.b);
    // An end we cannot key (tap, free end) freezes whatever it hangs off.
    if (!a || !b) {
      const other = a ?? b;
      if (other) frozen.add(find(other));
      continue;
    }
    const root = find(a);
    const list = wiresByNet.get(root);
    if (list) list.push(w);
    else wiresByNet.set(root, [w]);
  }

  const nets: Net[] = [];
  const routable = new Set<string>();
  for (const root of [...wiresByNet.keys()].sort()) {
    if (frozen.has(root)) continue;
    const wires = wiresByNet.get(root)!;
    const ends: PinEnd[] = [];
    const seen = new Set<string>();
    let ok = true;
    for (const w of wires) {
      for (const e of [w.a, w.b]) {
        if (!isPinEnd(e)) continue;
        const k = pinKey(e.component, e.pin);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!byId.get(e.component)?.pins.has(e.pin)) ok = false;
        else if (input.only && !input.only.has(e.component)) ok = false;
        else ends.push(e);
      }
    }
    if (!ok || ends.length < 2) continue;
    // Exactly one driver, or this pass has no opinion about which pin should
    // be the root of the fan-out tree.
    const drivers = ends.filter((e) => byId.get(e.component)!.pins.get(e.pin)!.dir === 'out');
    if (drivers.length !== 1) continue;
    const driver = drivers[0]!;
    ends.sort((a, b) => {
      if (a === driver) return -1;
      if (b === driver) return 1;
      const ka = pinKey(a.component, a.pin);
      const kb = pinKey(b.component, b.pin);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    nets.push({
      key: pinKey(driver.component, driver.pin),
      old: wires.map((w) => w.id),
      ends,
      cells: [],
      stubs: [],
    });
    routable.add(root);
  }

  const kept = input.wires.filter((w) => {
    const a = endKey(w.a);
    return !(a && routable.has(find(a)));
  });
  return { nets, kept };
}

/** Route the net as a rectilinear Steiner tree.
 *
 *  Growing it greedily -- each further sink to the nearest cell of whatever
 *  the net had already built -- is what used to put junction dots wherever the
 *  search happened to touch, because the shape of the tree depended on the
 *  order the sinks were visited. A Steiner tree picks the branch points first,
 *  from the terminals alone, so the driver leaves on one trunk and branches
 *  where the drawing wants a dot.
 *
 *  The branch points come from the Hanan grid (every terminal x crossed with
 *  every terminal y, which provably contains an optimal Steiner point set) by
 *  iterated 1-Steiner: repeatedly add whichever candidate shortens the
 *  rectilinear spanning tree most, until none does. Nets here have 2-8
 *  terminals, so this is cheap; FLUTE and the delay-aware variants are
 *  chip-scale and would buy nothing at this size.
 *
 *  A* then routes each tree edge, so obstacle avoidance is unchanged. */
function routeNet(net: Net, grid: Grid, ids: IdMint): BuiltNet | undefined {
  if (net.cells.some((c) => c < 0) || new Set(net.cells).size < 2) return undefined;

  const links: [number, number][] = [];
  // Each pin is joined to its own stub first, so the pin is a LEAF of the tree
  // and can never become a branch point. Where a stub coincides with its pin
  // (no free cell off that face) the pin stays a terminal, as before.
  for (let i = 0; i < net.cells.length; i++) {
    const pin = net.cells[i]!;
    const stub = net.stubs[i]!;
    if (stub !== pin) links.push([pin, stub]);
  }

  const built = new Set<number>([net.stubs[0]!]);
  for (const [from, to] of steinerEdges(net.stubs, grid, net.key)) {
    // Route the edge the tree actually chose, from ITS branch point -- not
    // from everything the net has built so far. Searching the whole built set
    // lets A* reattach wherever is nearest, which throws the Steiner topology
    // away and puts the trunk back where the greedy version had it. Prim
    // emits edges parent-first, so `from` is always already routed.
    if (built.has(to)) continue;
    const path = search(grid, new Set<number>([from]), to, net.key);
    if (!path) return undefined;
    for (let k = 1; k < path.length; k++) links.push([path[k - 1]!, path[k]!]);
    for (const c of path) built.add(c);
    grid.commit(path, net.key);
  }
  return links.length ? emit(net, links, grid, ids) : undefined;
}

/** The cell one step outside `pin`, on whichever side of `bounds` the pin sits.
 *  Falls back to the pin itself when that cell is unusable, which keeps the
 *  old behaviour rather than refusing the net. */
function stubCell(grid: Grid, pin: number, bounds: Rect): number {
  if (pin < 0) return pin;
  const col = pin % grid.cols;
  const row = (pin / grid.cols) | 0;
  const candidates: number[] = [];
  if (col === grid.col(bounds.x)) candidates.push(grid.idx(col - 1, row));
  if (col === grid.col(bounds.x + bounds.w)) candidates.push(grid.idx(col + 1, row));
  if (row === grid.row(bounds.y)) candidates.push(grid.idx(col, row - 1));
  if (row === grid.row(bounds.y + bounds.h)) candidates.push(grid.idx(col, row + 1));
  for (const c of candidates) if (c >= 0 && !grid.blocked[c]) return c;
  return pin;
}

/** Cell distance in grid steps, rectilinear. */
function dist(grid: Grid, a: number, b: number): number {
  return (
    Math.abs((a % grid.cols) - (b % grid.cols)) +
    Math.abs(((a / grid.cols) | 0) - ((b / grid.cols) | 0))
  );
}

/** Minimum rectilinear spanning tree over `nodes`, as edges, plus its length.
 *  Prim's, seeded at index 0 (the driver) so the trunk grows from the source
 *  and ties break on cell order. */
function mst(grid: Grid, nodes: readonly number[]): { edges: [number, number][]; total: number } {
  const n = nodes.length;
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  best[0] = 0;
  const edges: [number, number][] = [];
  let total = 0;
  for (let it = 0; it < n; it++) {
    let pick = -1;
    for (let i = 0; i < n; i++)
      if (
        !inTree[i] &&
        (pick < 0 || best[i]! < best[pick]! || (best[i] === best[pick] && nodes[i]! < nodes[pick]!))
      )
        pick = i;
    if (pick < 0) break;
    inTree[pick] = true;
    if (from[pick]! >= 0) {
      edges.push([nodes[from[pick]!]!, nodes[pick]!]);
      total += best[pick]!;
    }
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = dist(grid, nodes[pick]!, nodes[i]!);
      if (d < best[i]!) {
        best[i] = d;
        from[i] = pick;
      }
    }
  }
  return { edges, total };
}

/** Terminals plus the Steiner points worth adding, as tree edges in the order
 *  they should be routed (driver first). Iterated 1-Steiner over the Hanan
 *  grid, with every tie broken on cell index so the result is deterministic. */
function steinerEdges(cells: readonly number[], grid: Grid, ownerKey: string): [number, number][] {
  const owner = grid.ownerId(ownerKey);
  const nodes = [...new Set(cells)];
  let current = mst(grid, nodes);

  for (let round = 0; round < 4; round++) {
    const cols = [...new Set(nodes.map((c) => c % grid.cols))].sort((a, b) => a - b);
    const rows = [...new Set(nodes.map((c) => (c / grid.cols) | 0))].sort((a, b) => a - b);
    let bestGain = 0;
    let bestCell = -1;
    for (const r of rows)
      for (const c of cols) {
        const cell = grid.idx(c, r);
        if (cell < 0 || nodes.includes(cell) || grid.blocked[cell]) continue;
        // A branch point on another net's pin draws a dot on that pin: the
        // one thing a reader is entitled to take as a connection. Being a
        // target rather than a step, no cost could have talked the search out
        // of it -- it has to be refused here.
        const at = grid.pinOwner[cell];
        if (at && at !== owner) continue;
        const gain = current.total - mst(grid, [...nodes, cell]).total;
        if (gain > bestGain || (gain === bestGain && gain > 0 && cell < bestCell)) {
          bestGain = gain;
          bestCell = cell;
        }
      }
    if (bestCell < 0) break;
    nodes.push(bestCell);
    current = mst(grid, nodes);
  }
  return current.edges;
}

/** A* from any cell in `sources` to `target`. State is (cell, incoming
 *  direction) so a bend can be charged; the heuristic is Manhattan distance in
 *  step cost, admissible because bends and penalties only ever add. */
function search(
  grid: Grid,
  sources: ReadonlySet<number>,
  target: number,
  ownerKey: string,
): number[] | undefined {
  const owner = grid.ownerId(ownerKey);
  const { best, from, seen, cols, rows, blocked, pinOwner, hug, usedH, usedV, byH, byV } = grid;
  const stamp = ++grid.stamp;
  const known = (k: number): number => (seen[k] === stamp ? best[k]! : Infinity);
  const tc = target % cols;
  const tr = (target / cols) | 0;
  const h = (cell: number): number =>
    (Math.abs((cell % cols) - tc) + Math.abs(((cell / cols) | 0) - tr)) * STEP;

  const frontier = grid.frontier;
  frontier.clear(best.length);
  // Seed each source cell in all four incoming directions at zero, so leaving
  // the tree is never charged a bend the route did not make.
  for (const s of [...sources].sort((a, b) => a - b))
    for (let d = 0; d < 4; d++) {
      const k = s * 4 + d;
      seen[k] = stamp;
      best[k] = 0;
      from[k] = -1;
      frontier.push(h(s), 0, k);
    }

  while (frontier.size) {
    frontier.pop();
    const g = frontier.topG;
    const key = frontier.topK;
    const cell = key >> 2;
    const dir = key & 3;
    if (known(key) < g) continue;
    if (cell === target) {
      const path: number[] = [];
      for (let k: number = key; k >= 0; k = from[k]!) path.push(k >> 2);
      return path.reverse();
    }
    const col = cell % cols;
    const row = (cell / cols) | 0;
    const pinHere = pinOwner[cell] !== 0;
    for (let d = 0; d < 4; d++) {
      const nc = col + DX[d]!;
      const nr = row + DY[d]!;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (blocked[next]) continue;
      const pin = pinOwner[next]!;
      // A route may END at a pin, never pass THROUGH one -- not even its own
      // net's. Passing through makes that pin a branch point, so the fan-out
      // is drawn as a T on a gate's input pin instead of a dot on the trunk.
      if (next !== target && pin) continue;
      let cost = STEP;
      // A pin has a facing, so the first move off one is not a corner anybody
      // sees -- charging it would push routes into a dogleg to avoid it.
      if (d !== dir && !pinHere) cost += BEND;
      if (hug[next]) cost += HUG;
      if (pin && pin !== owner) cost += FOREIGN_PIN;
      const horizontal = d < 2;
      const along = horizontal ? usedH : usedV;
      if (along[next]) {
        // Merging with this net's own trunk, not overlapping a stranger's.
        if ((horizontal ? byH : byV)[next] !== owner) cost += SHARE;
      } else if ((horizontal ? usedV : usedH)[next]) {
        if ((horizontal ? byV : byH)[next] !== owner) cost += CROSS;
      } else if (
        horizontal
          ? (nr > 0 && along[next - cols] === 1) || (nr + 1 < rows && along[next + cols] === 1)
          : (nc > 0 && along[next - 1] === 1) || (nc + 1 < cols && along[next + 1] === 1)
      ) {
        // A same-orientation run already sits in the next lane over.
        cost += CROWD;
      }
      const ng = g + cost;
      const k = next * 4 + d;
      if (seen[k] === stamp && ng >= best[k]!) continue;
      seen[k] = stamp;
      best[k] = ng;
      from[k] = key;
      frontier.push(ng + (Math.abs(nc - tc) + Math.abs(nr - tr)) * STEP, ng, k);
    }
  }
  return undefined;
}

/** Turn the net's cell adjacency into wires: one wire per run between two
 *  nodes, a node being a pin or a branch point, and a branch point that is not
 *  already a pin becoming a junction dot. */
function emit(net: Net, links: readonly [number, number][], grid: Grid, ids: IdMint): BuiltNet {
  const adj = new Map<number, Set<number>>();
  const at = (c: number): Set<number> => {
    let s = adj.get(c);
    if (!s) adj.set(c, (s = new Set()));
    return s;
  };
  for (const [a, b] of links) {
    if (a === b) continue;
    at(a).add(b);
    at(b).add(a);
  }

  const pinCell = new Map<number, PinEnd>();
  net.ends.forEach((e, i) => pinCell.set(net.cells[i]!, e));

  // Prune dead ends: a stub cell the tree never reached carries no connection,
  // and leaving it would end a run on a cell that is neither a pin nor a
  // branch, so there is no wire end to name it with.
  for (let pruned = true; pruned; ) {
    pruned = false;
    for (const [cell, links] of adj) {
      if (pinCell.has(cell) || links.size !== 1) continue;
      for (const other of links) adj.get(other)?.delete(cell);
      adj.delete(cell);
      pruned = true;
    }
  }

  const isNode = (c: number): boolean => pinCell.has(c) || (adj.get(c)?.size ?? 0) !== 2;

  const junctions: Junction[] = [];
  const junctionAt = new Map<number, string>();
  for (const c of [...adj.keys()].sort((a, b) => a - b)) {
    if (pinCell.has(c) || (adj.get(c)?.size ?? 0) < 3) continue;
    const id = ids.junction();
    junctionAt.set(c, id);
    junctions.push({ id, pos: grid.pointOf(c) });
  }
  const endOf = (c: number): WireEnd =>
    pinCell.get(c) ?? { kind: 'junction', junction: junctionAt.get(c)! };

  const wires: Wire[] = [];
  const walked = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (const start of [...adj.keys()].sort((a, b) => a - b)) {
    if (!isNode(start)) continue;
    for (const first of [...at(start)].sort((a, b) => a - b)) {
      if (walked.has(edgeKey(start, first))) continue;
      walked.add(edgeKey(start, first));
      const run = [start, first];
      let prev = start;
      let cur = first;
      while (!isNode(cur)) {
        const next = [...at(cur)].find((c) => c !== prev)!;
        walked.add(edgeKey(cur, next));
        run.push(next);
        prev = cur;
        cur = next;
      }
      const pts = normalizeBends(run.map((c) => grid.pointOf(c)));
      wires.push({
        id: ids.wire(),
        a: endOf(run[0]!),
        b: endOf(run[run.length - 1]!),
        points: pts.slice(1, -1),
      });
    }
  }
  return { wires, junctions };
}

/** Rebuild the wire list in the original order, so a re-route reads as a
 *  content diff rather than a reshuffle and running the pass twice is a
 *  no-op. */
function stitch(
  input: AutoRouteInput,
  nets: readonly Net[],
  replacement: ReadonlyMap<string, BuiltNet>,
  survivors: ReadonlySet<string>,
): AutoRouteResult {
  const netOfWire = new Map<string, string>();
  for (const net of nets) for (const id of net.old) netOfWire.set(id, net.key);

  const wireById = new Map(input.wires.map((w) => [w.id, w]));
  const netByKey = new Map(nets.map((n) => [n.key, n]));
  const outWires: Wire[] = [];
  const emitted = new Set<string>();
  for (const w of input.wires) {
    const key = netOfWire.get(w.id);
    const repl = key === undefined ? undefined : replacement.get(key);
    if (!repl) {
      outWires.push(w);
      continue;
    }
    if (emitted.has(key!)) continue;
    emitted.add(key!);
    // A rebuilt net shares no wire with the old one. A colour the whole net
    // wore survives; a mixed net comes out plain rather than spreading one
    // wire's colour over runs that never had it.
    const colors = new Set(netByKey.get(key!)!.old.map((id) => wireById.get(id)?.color));
    const color = colors.size === 1 ? [...colors][0] : undefined;
    outWires.push(...repl.wires.map((r) => (color ? { ...r, color } : r)));
  }

  const minted: Junction[] = [];
  for (const key of emitted) minted.push(...replacement.get(key)!.junctions);
  // A re-routed net's old dots are gone, ids and all -- carrying them over
  // would collide with the freshly minted ones, which reuse the same names.
  const junctions = [...input.junctions.filter((j) => survivors.has(j.id)), ...minted];

  return { wires: outWires, junctions, routed: emitted.size };
}
