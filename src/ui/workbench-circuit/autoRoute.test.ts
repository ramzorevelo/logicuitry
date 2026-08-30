import { describe, expect, it } from 'vitest';
import type { Board, Junction, Wire } from '../../core/model/types';
import type { Vec2 } from '../../render/scene';
import { compile, type CompiledCircuit } from '../../core/model/compile';
import { board, comp, wire } from '../../core/model/testFixtures';
import { autoRoute, type RoutableComponent, type RoutablePin } from './autoRoute';
import { normalizeBends, polylineCrossesAny } from './wireGeom';

const GRID = 16;

/** Component bodies are 64x64 with `a`/`b` inputs on the left edge and `y` on
 *  the right, which is enough shape for routing decisions. */
function routable(id: string, x: number, y: number): RoutableComponent {
  const pins = new Map<string, RoutablePin>([
    ['a', { pos: { x, y: y + 16 }, dir: 'in' }],
    ['b', { pos: { x, y: y + 48 }, dir: 'in' }],
    ['y', { pos: { x: x + 64, y: y + 32 }, dir: 'out' }],
  ]);
  return { id, bounds: { x, y, w: 64, h: 64 }, pins };
}

function polyline(w: Wire, comps: readonly RoutableComponent[], js: readonly Junction[]): Vec2[] {
  const at = (e: Wire['a']): Vec2 => {
    if (e.kind === 'junction') return js.find((j) => j.id === e.junction)!.pos;
    if (e.kind === 'pin') return comps.find((c) => c.id === e.component)!.pins.get(e.pin)!.pos;
    throw new Error(`unexpected end ${e.kind}`);
  };
  return normalizeBends([at(w.a), ...w.points, at(w.b)]);
}

function segments(pts: readonly Vec2[]): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i]!, pts[i + 1]!]);
  return out;
}

/** Length of collinear overlap shared by two axis-aligned segments. */
function overlapLength([a0, a1]: [Vec2, Vec2], [b0, b1]: [Vec2, Vec2]): number {
  const vertical = a0.x === a1.x && b0.x === b1.x && a0.x === b0.x;
  const horizontal = a0.y === a1.y && b0.y === b1.y && a0.y === b0.y;
  if (vertical) {
    const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
    const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
    return Math.max(0, hi - lo);
  }
  if (horizontal) {
    const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
    const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
    return Math.max(0, hi - lo);
  }
  return 0;
}

/** Every net as the sorted set of primitive pins on it -- the connectivity a
 *  board actually means, independent of how the wires are drawn. */
function netSignature(c: CompiledCircuit): string[] {
  const endpoints = c.nets.map((): string[] => []);
  c.primitives.forEach((p) => {
    p.inputs.forEach((net, i) => endpoints[net]?.push(`${p.componentId}.in${i}`));
    p.outputs.forEach((net, i) => endpoints[net]?.push(`${p.componentId}.out${i}`));
  });
  return endpoints
    .map((e) => e.sort().join(','))
    .filter((s) => s.length > 0)
    .sort();
}

describe('autoRoute', () => {
  const comps = [routable('sw', 48, 48), routable('g1', 224, 48), routable('g2', 224, 336)];
  const fanout: Wire[] = [
    wire('w1', ['sw', 'y'], ['g1', 'a']),
    wire('w2', ['sw', 'y'], ['g2', 'a']),
  ];

  it('branches fan-out through a junction instead of two wires from one pin', () => {
    const r = autoRoute({ components: comps, wires: fanout, junctions: [], grid: GRID });

    expect(r.routed).toBe(1);
    expect(r.junctions).toHaveLength(1);
    const originsAtPin = r.wires.filter(
      (w) =>
        (w.a.kind === 'pin' && w.a.component === 'sw') ||
        (w.b.kind === 'pin' && w.b.component === 'sw'),
    );
    expect(originsAtPin).toHaveLength(1);
  });

  it('gives each net its own lane so trunks never run on top of each other', () => {
    const wires: Wire[] = [
      ...fanout,
      wire('w3', ['g1', 'y'], ['g2', 'b']),
      wire('w4', ['sw', 'y'], ['g1', 'b']),
    ];
    const r = autoRoute({ components: comps, wires, junctions: [], grid: GRID });
    const polys = r.wires.map((w) => polyline(w, comps, r.junctions));

    let worst = 0;
    for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        for (const s of segments(polys[i]!)) {
          for (const t of segments(polys[j]!)) worst = Math.max(worst, overlapLength(s, t));
        }
      }
    }
    // Shared runs are exactly what makes the current boards unreadable.
    expect(worst).toBe(0);
  });

  it('routes every segment orthogonally', () => {
    const r = autoRoute({ components: comps, wires: fanout, junctions: [], grid: GRID });
    for (const w of r.wires) {
      for (const [p, q] of segments(polyline(w, comps, r.junctions))) {
        expect(p.x === q.x || p.y === q.y).toBe(true);
      }
    }
  });

  it('leaves a net alone when it has no single driver', () => {
    const contended: Wire[] = [wire('w1', ['g1', 'y'], ['g2', 'y'])];
    const r = autoRoute({ components: comps, wires: contended, junctions: [], grid: GRID });
    expect(r.routed).toBe(0);
    expect(r.wires).toEqual(contended);
  });

  it('routes right-to-left feedback instead of declining it', () => {
    const feedback: Wire[] = [wire('w1', ['g2', 'y'], ['g1', 'a'])];
    const r = autoRoute({ components: comps, wires: feedback, junctions: [], grid: GRID });
    expect(r.routed).toBe(1);
    expect(r.wires[0]!.points.length).toBeGreaterThan(0);
  });

  it('never draws a route through a body', () => {
    const wires: Wire[] = [
      ...fanout,
      wire('w3', ['g2', 'y'], ['g1', 'b']),
      wire('w4', ['g1', 'y'], ['g2', 'b']),
    ];
    const r = autoRoute({ components: comps, wires, junctions: [], grid: GRID });
    for (const w of r.wires) {
      const pts = polyline(w, comps, r.junctions);
      for (const c of comps) expect(polylineCrossesAny(pts, [c.bounds])).toBe(false);
    }
  });

  it('leaves a straight shot straight', () => {
    // sw.y sits at y+32 (80) and g1.a at y+16, so g1 at 64 puts them in one row.
    const aligned = [routable('sw', 48, 48), routable('g1', 224, 64)];
    const r = autoRoute({
      components: aligned,
      wires: [wire('w1', ['sw', 'y'], ['g1', 'a'])],
      junctions: [],
      grid: GRID,
    });
    expect(r.wires[0]!.points).toEqual([]);
  });

  it('keeps a lane between two parallel trunks', () => {
    const wide = [
      routable('s1', 48, 48),
      routable('s2', 48, 336),
      routable('g1', 400, 48),
      routable('g2', 400, 336),
    ];
    const r = autoRoute({
      components: wide,
      wires: [wire('w1', ['s1', 'y'], ['g2', 'a']), wire('w2', ['s2', 'y'], ['g1', 'a'])],
      junctions: [],
      grid: GRID,
    });
    const verticals = r.wires
      .flatMap((w) => segments(polyline(w, wide, r.junctions)))
      .filter(([p, q]) => p.x === q.x && p.y !== q.y)
      .map(([p]) => p.x);
    const xs = [...new Set(verticals)].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(2 * GRID);
  });

  it('passes through wires whose ends it cannot resolve, and freezes their net', () => {
    const withFree: Wire[] = [
      ...fanout,
      {
        id: 'w3',
        a: { kind: 'pin', component: 'sw', pin: 'y' },
        b: { kind: 'free', pos: { x: 0, y: 0 } },
        points: [],
      },
    ];
    const r = autoRoute({ components: comps, wires: withFree, junctions: [], grid: GRID });
    expect(r.routed).toBe(0);
    expect(r.junctions).toHaveLength(0);
    expect(r.wires).toHaveLength(3);
  });

  it('mints ids from emit order, not from what it replaced', () => {
    const renamed = fanout.map((w, i) => ({ ...w, id: `keep${i}` }));
    const a = autoRoute({ components: comps, wires: fanout, junctions: [], grid: GRID });
    const b = autoRoute({ components: comps, wires: renamed, junctions: [], grid: GRID });
    expect(b.wires.map((w) => w.id)).toEqual(a.wires.map((w) => w.id));
    expect(b.junctions.map((j) => j.id)).toEqual(a.junctions.map((j) => j.id));
  });

  it('is idempotent: routing an already-routed board changes nothing', () => {
    const once = autoRoute({ components: comps, wires: fanout, junctions: [], grid: GRID });
    const twice = autoRoute({
      components: comps,
      wires: once.wires,
      junctions: once.junctions,
      grid: GRID,
    });
    expect(twice.wires).toEqual(once.wires);
    expect(twice.junctions).toEqual(once.junctions);
  });
});

describe('autoRoute net equivalence', () => {
  // The one thing a cosmetic pass must never do is change what the board means.
  it('junction fan-out compiles to the same nets as parallel wires', () => {
    const comps = [routable('sw', 48, 48), routable('g1', 224, 48), routable('g2', 224, 336)];
    const before: Board = board({
      components: [comp('sw', 'toggle'), comp('g1', 'and'), comp('g2', 'and')],
      wires: [wire('w1', ['sw', 'y'], ['g1', 'a']), wire('w2', ['sw', 'y'], ['g2', 'a'])],
    });

    const r = autoRoute({
      components: comps,
      wires: before.wires,
      junctions: before.junctions,
      grid: GRID,
    });
    const after: Board = { ...before, wires: r.wires, junctions: r.junctions };

    expect(r.junctions.length).toBeGreaterThan(0);
    const lib = new Map();
    expect(netSignature(compile(after, lib))).toEqual(netSignature(compile(before, lib)));
  });
});
