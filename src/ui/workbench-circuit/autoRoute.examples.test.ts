// Guard for the bundled examples. The shipped boards are authored geometry --
// the instructor hand-drew them -- so this asserts properties, never equality
// with what the passes would emit. Re-routing is cosmetic, so every board must
// compile to exactly the same nets before and after; and the shipped geometry
// must hold the three properties the owner reported missing -- no wire left to
// the fallback, none drawn through a body, none stacked on another.

import { describe, expect, it } from 'vitest';
import type { ChipDef, ChipLibrary, Component, Wire } from '../../core/model/types';
import type { Vec2 } from '../../render/scene';
import { compile, type CompiledCircuit } from '../../core/model/compile';
import { EXAMPLES, type Example } from '../../examples/index';
import { resolveComponentPins, symbolBounds } from '../../render/glyphs/symbol';
import { makeTestTheme } from '../../render/theme.fixture';
import { autoRoute, type RoutableComponent, type RoutablePin } from './autoRoute';
import { normalizeBends, polylineCrossesAny } from './wireGeom';
import '../../core/sim/primitives/registry';
import '../../render/glyphs/gates';
import '../../render/glyphs/io';
import '../../render/glyphs/chip';

const theme = makeTestTheme();

function libraryOf(e: Example): ChipLibrary {
  return new Map<string, ChipDef>((e.chips ?? []).map((d) => [d.id, d]));
}

function routableOf(c: Component, lib: ChipLibrary): RoutableComponent {
  const def = c.defId ? lib.get(c.defId) : undefined;
  const { bounds, pins } = symbolBounds(c, theme, def);
  const dirs = new Map(resolveComponentPins(c, def).map((p) => [p.name, p.dir]));
  const routable = new Map<string, RoutablePin>();
  for (const [name, pos] of pins) {
    const dir = dirs.get(name);
    if (dir) routable.set(name, { pos, dir });
  }
  return { id: c.id, bounds, pins: routable };
}

function reroute(e: Example) {
  const lib = libraryOf(e);
  return autoRoute({
    components: e.board.components.map((c) => routableOf(c, lib)),
    wires: e.board.wires,
    junctions: e.board.junctions,
    grid: theme.gridSchematic,
  });
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

/** Resolve either end of a wire on an example board to a point. */
function resolver(e: Example): (end: Wire['a']) => Vec2 | undefined {
  const lib = libraryOf(e);
  const pins = new Map(e.board.components.map((c) => [c.id, routableOf(c, lib).pins]));
  return (end) =>
    end.kind === 'pin'
      ? pins.get(end.component)?.get(end.pin)?.pos
      : end.kind === 'junction'
        ? e.board.junctions.find((j) => j.id === end.junction)?.pos
        : undefined;
}

function pointsOf(w: Wire, at: (end: Wire['a']) => Vec2 | undefined): Vec2[] | undefined {
  const a = at(w.a);
  const b = at(w.b);
  return a && b ? normalizeBends([a, ...w.points, b]) : undefined;
}

/** Longest run two polylines share on one line -- the "two wires drawn on top
 *  of each other" defect, as a number. Touching at a point is not overlap. */
function worstOverlap(p: readonly Vec2[], q: readonly Vec2[]): number {
  let worst = 0;
  for (let i = 0; i < p.length - 1; i++)
    for (let j = 0; j < q.length - 1; j++) {
      const [a0, a1] = [p[i]!, p[i + 1]!];
      const [b0, b1] = [q[j]!, q[j + 1]!];
      if (a0.x === a1.x && b0.x === b1.x && a0.x === b0.x)
        worst = Math.max(
          worst,
          Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) -
            Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)),
        );
      if (a0.y === a1.y && b0.y === b1.y && a0.y === b0.y)
        worst = Math.max(
          worst,
          Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) -
            Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)),
        );
    }
  return Math.max(0, worst);
}

/** Nets by union-find over wire ends -- the grouping autoRoute itself uses,
 *  derived from connectivity rather than from the compiled circuit, so the
 *  test does not depend on how paths happen to be named. */
function netGrouping(e: Example): (w: Wire) => string {
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
  const keyOf = (x: Wire['a']): string =>
    x.kind === 'pin'
      ? `${x.component} ${x.pin}`
      : x.kind === 'junction'
        ? `j:${x.junction}`
        : 'free';
  for (const w of e.board.wires) {
    const ra = find(keyOf(w.a));
    const rb = find(keyOf(w.b));
    if (ra !== rb) parent.set(ra, rb);
  }
  return (w) => find(keyOf(w.a));
}

describe('bundled example boards', () => {
  for (const e of EXAMPLES) {
    describe(e.name, () => {
      // The shipped geometry is authored, so this is a budget rather than an
      // equality: re-routing may differ in detail, but it must never spend
      // more bends than the board already ships with. That is the assertion
      // that fails if a placement or router change starts sprawling again.
      it('re-routes within the bend budget it ships with', () => {
        const r = reroute(e);
        const shipped = e.board.wires.reduce((n, w) => n + w.points.length, 0);
        const after = r.wires.reduce((n, w) => n + w.points.length, 0);
        expect({ board: e.id, after: after <= shipped }).toEqual({ board: e.id, after: true });
      });

      // Deterministic per product rule 3, and the property that makes the
      // authoring script safe to re-run: routing an already-routed board
      // reproduces it exactly.
      it('re-routes to a fixed point', () => {
        const once = reroute(e);
        const lib = libraryOf(e);
        const twice = autoRoute({
          components: e.board.components.map((c) => routableOf(c, lib)),
          wires: once.wires,
          junctions: once.junctions,
          grid: theme.gridSchematic,
        });
        expect({ wires: twice.wires, junctions: twice.junctions }).toEqual({
          wires: once.wires,
          junctions: once.junctions,
        });
      });

      it('keeps identical nets through a re-route', () => {
        const r = reroute(e);
        const lib = libraryOf(e);
        const after = { ...e.board, wires: r.wires, junctions: r.junctions };
        expect(netSignature(compile(after, lib))).toEqual(netSignature(compile(e.board, lib)));
      });
    });
  }

  // The defects the owner reported on the shipped boards. These are
  // whole-board properties, not per-net ones, so they live outside the loop.
  it('ships with no wire left on the pairwise fallback', () => {
    let fallback = 0;
    for (const e of EXAMPLES) {
      const at = resolver(e);
      for (const w of e.board.wires) {
        const a = at(w.a);
        const b = at(w.b);
        if (a && b && a.x !== b.x && a.y !== b.y && w.points.length === 0) fallback++;
      }
    }
    expect(fallback).toBe(0);
  });

  it('never draws a wire through a body', () => {
    for (const e of EXAMPLES) {
      const lib = libraryOf(e);
      const bodies = e.board.components.map((c) => routableOf(c, lib).bounds);
      const at = resolver(e);
      for (const w of e.board.wires) {
        const pts = pointsOf(w, at);
        if (pts)
          expect({ board: e.id, wire: w.id, hits: polylineCrossesAny(pts, bodies) }).toEqual({
            board: e.id,
            wire: w.id,
            hits: false,
          });
      }
    }
  });

  // A wire running over a pin that belongs to a DIFFERENT net reads as a
  // connection: H&H figure 2.24 makes a T or a dot the connect symbol, and a
  // reader cannot tell a passing wire from a joined one. Reported by the owner
  // on de-morgan-pair, where a Steiner branch point had landed on an
  // inverter's input pin and drew the two input nets as joined.
  it('never runs a wire over a foreign pin', () => {
    const touches = (p: Vec2, a: Vec2, b: Vec2) =>
      (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) ||
      (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x));

    for (const e of EXAMPLES) {
      const lib = libraryOf(e);
      const at = resolver(e);
      const netOf = netGrouping(e);
      const pinAt = new Map(
        e.board.components.map((c) => [c.id, routableOf(c, lib).pins] as const),
      );

      // Every pin the board wires up, and which net owns it.
      const owned: { pos: Vec2; net: string }[] = [];
      for (const w of e.board.wires)
        for (const end of [w.a, w.b])
          if (end.kind === 'pin') {
            const pos = pinAt.get(end.component)?.get(end.pin)?.pos;
            if (pos) owned.push({ pos, net: netOf(w) });
          }

      for (const w of e.board.wires) {
        const pts = pointsOf(w, at);
        if (!pts) continue;
        const mine = netOf(w);
        for (const { pos, net } of owned) {
          if (net === mine) continue;
          const hit = pts.some((_, i) => i > 0 && touches(pos, pts[i - 1]!, pts[i]!));
          expect({ board: e.id, wire: w.id, overPin: hit ? `${pos.x},${pos.y}` : 'none' }).toEqual({
            board: e.id,
            wire: w.id,
            overPin: 'none',
          });
        }
      }
    }
  });

  // A fan-out branches at a DOT on the trunk, never on a component's pin: a
  // second wire leaving a gate's input pin reads as a T on that pin. Reported
  // by the owner, who rewired basic-gates by hand to put the branch back on
  // the trunk.
  it('branches at a junction, never on a pin', () => {
    for (const e of EXAMPLES) {
      const wiresPerPin = new Map<string, number>();
      for (const w of e.board.wires)
        for (const end of [w.a, w.b])
          if (end.kind === 'pin') {
            const at = `${end.component}.${end.pin}`;
            wiresPerPin.set(at, (wiresPerPin.get(at) ?? 0) + 1);
          }
      for (const [at, n] of wiresPerPin)
        expect({ board: e.id, pin: at, wires: n }).toEqual({ board: e.id, pin: at, wires: 1 });
    }
  });

  it('never draws two wires on top of each other', () => {
    for (const e of EXAMPLES) {
      const at = resolver(e);
      const polys = e.board.wires
        .map((w) => ({ id: w.id, pts: pointsOf(w, at) }))
        .filter((p): p is { id: string; pts: Vec2[] } => p.pts !== undefined);
      for (let i = 0; i < polys.length; i++)
        for (let j = i + 1; j < polys.length; j++) {
          const worst = worstOverlap(polys[i]!.pts, polys[j]!.pts);
          expect({ board: e.id, pair: `${polys[i]!.id}/${polys[j]!.id}`, worst }).toEqual({
            board: e.id,
            pair: `${polys[i]!.id}/${polys[j]!.id}`,
            worst: 0,
          });
        }
    }
  });
});
