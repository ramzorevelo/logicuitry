import { describe, expect, it } from 'vitest';
import type { ChipDef, ChipLibrary, Circuit } from '../../core/model/types';
import { EXAMPLES } from '../../examples/index';
import { builtinChipLibrary } from '../../core/parts/packages';
import { makeTestTheme } from '../../render/theme.fixture';
import { circuitRoutes, componentGeometry, endResolver, previewRoutes } from './routeCache';
import { computeWireRoutes, polylineCrossesAny } from './wireGeom';
import { symbolBounds } from '../../render/glyphs/symbol';
import '../../core/sim/primitives/registry';
import '../../render/glyphs/gates';
import '../../render/glyphs/io';
import '../../render/glyphs/chip';
import '../../render/glyphs/power';
import '../../render/glyphs/timer';

const theme = makeTestTheme();
const g = theme.gridSchematic;
const example = EXAMPLES.find((e) => e.board.components.length > 300)!;
const lib: ChipLibrary = new Map<string, ChipDef>([
  ...builtinChipLibrary(),
  ...(example.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
]);
const board: Circuit = example.board;

describe('routeCache', () => {
  it('routes exactly as computeWireRoutes does', () => {
    const bounds = new Map(
      board.components.map((c) => [
        c.id,
        symbolBounds(c, theme, c.defId ? lib.get(c.defId) : undefined).bounds,
      ]),
    );
    const direct = computeWireRoutes(board.wires, endResolver(board, lib, theme), bounds, g);
    expect([...circuitRoutes(board, lib, theme, g)]).toEqual([...direct]);
  });

  it('reuses the result while every input array is the same', () => {
    expect(circuitRoutes(board, lib, theme, g)).toBe(circuitRoutes(board, lib, theme, g));
    expect(componentGeometry(board.components, lib, theme)).toBe(
      componentGeometry(board.components, lib, theme),
    );
  });

  it('recomputes when any input changes', () => {
    const first = circuitRoutes(board, lib, theme, g);
    const moved: Circuit = {
      ...board,
      components: board.components.map((c, i) =>
        i === 0 ? { ...c, pos: { x: c.pos.x + 8 * g, y: c.pos.y } } : c,
      ),
    };
    expect(circuitRoutes(moved, lib, theme, g)).not.toBe(first);
    expect(circuitRoutes({ ...board, junctions: [...board.junctions] }, lib, theme, g)).not.toBe(
      first,
    );
    expect(circuitRoutes(board, new Map(lib), theme, g)).not.toBe(first);
    expect(circuitRoutes(board, lib, { ...theme }, g)).not.toBe(first);
    expect(circuitRoutes(board, lib, theme, g * 2)).not.toBe(first);
  });

  it('moves a pin end with its component', () => {
    const comp = board.components[0]!;
    const moved = { ...board, components: [{ ...comp, pos: { x: comp.pos.x + g, y: 0 } }] };
    const before = componentGeometry(board.components, lib, theme).get(comp.id)!;
    const after = componentGeometry(moved.components, lib, theme).get(comp.id)!;
    expect(after.bounds.x - before.bounds.x).toBe(g);
  });

  it('keeps the geometry of every component a new array did not replace', () => {
    const moved = board.components.map((c, i) =>
      i === 0 ? { ...c, pos: { x: c.pos.x + g, y: c.pos.y } } : c,
    );
    const before = componentGeometry(board.components, lib, theme);
    const after = componentGeometry(moved, lib, theme);
    expect(after.get(board.components[1]!.id)).toBe(before.get(board.components[1]!.id));
  });
});

describe('previewRoutes', () => {
  const chip = board.components.find((c) => c.defId)!;
  const dragged: Circuit = {
    ...board,
    components: board.components.map((c) =>
      c === chip ? { ...c, pos: { x: c.pos.x, y: c.pos.y + 2 * g } } : c,
    ),
  };
  const touchesChip = (id: string) => {
    const w = board.wires.find((x) => x.id === id)!;
    return [w.a, w.b].some((e) => e.kind === 'pin' && e.component === chip.id);
  };

  it('matches the full routing when nothing moved', () => {
    const committed = circuitRoutes(board, lib, theme, g);
    const copy: Circuit = { ...board, wires: [...board.wires] };
    expect([...previewRoutes(copy, board, lib, theme, g)]).toEqual([...committed]);
    const recoloured: Circuit = {
      ...board,
      wires: board.wires.map((w) => ({ ...w, color: 'g2' })),
    };
    expect([...previewRoutes(recoloured, board, lib, theme, g)]).toEqual([...committed]);
    const regrouped: Circuit = { ...board, groups: [] };
    expect(previewRoutes(regrouped, board, lib, theme, g)).toBe(committed);
  });

  it("reroutes the moved part's wires and keeps every untouched route", () => {
    const committed = circuitRoutes(board, lib, theme, g);
    const preview = previewRoutes(dragged, board, lib, theme, g);
    const chipBody = componentGeometry(dragged.components, lib, theme).get(chip.id)!.bounds;
    const ends = endResolver(dragged, lib, theme);
    let rerouted = 0;
    let kept = 0;
    for (const w of board.wires) {
      const pts = preview.get(w.id)!;
      if (touchesChip(w.id)) {
        rerouted++;
        const end = w.a.kind === 'pin' && w.a.component === chip.id ? w.a : w.b;
        expect([pts[0], pts[pts.length - 1]]).toContainEqual(ends(end));
      } else if (pts === committed.get(w.id)) kept++;
      else expect(polylineCrossesAny(committed.get(w.id)!, [chipBody])).toBe(true);
    }
    expect(rerouted).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(board.wires.length / 2);
  });

  it('reroutes a wire the moved body now covers, and leaves a committed board to route in full', () => {
    const wire = (id: string, a: string, b: string, pin: [string, string]) => ({
      id,
      a: { kind: 'pin' as const, component: a, pin: pin[0] },
      b: { kind: 'pin' as const, component: b, pin: pin[1] },
      points: [],
    });
    const base: Circuit = {
      components: [
        { id: 'sw', kind: 'toggle', pos: { x: 0, y: 0 }, params: {} },
        { id: 'led', kind: 'led', pos: { x: 40 * g, y: 0 }, params: {} },
        { id: 'sw2', kind: 'toggle', pos: { x: 20 * g, y: 30 * g }, params: {} },
      ],
      junctions: [],
      wires: [wire('w', 'sw', 'led', ['y', 'a'])],
    };
    const committed = circuitRoutes(base, lib, theme, g).get('w')!;
    const geoBefore = componentGeometry(base.components, lib, theme);
    const straight = committed[0]!.y;
    const body = geoBefore.get('sw2')!.bounds;
    const over: Circuit = {
      ...base,
      components: base.components.map((c) =>
        c.id === 'sw2'
          ? { ...c, pos: { x: c.pos.x, y: c.pos.y + straight - (body.y + body.h / 2) } }
          : c,
      ),
    };
    const coveredBody = componentGeometry(over.components, lib, theme).get('sw2')!.bounds;
    expect(polylineCrossesAny(committed, [coveredBody])).toBe(true);
    const shown = previewRoutes(over, base, lib, theme, g).get('w')!;
    expect(polylineCrossesAny(shown, [coveredBody])).toBe(false);

    const aside: Circuit = {
      ...base,
      components: base.components.map((c) =>
        c.id === 'sw2' ? { ...c, pos: { x: c.pos.x + g, y: c.pos.y } } : c,
      ),
    };
    expect(previewRoutes(aside, base, lib, theme, g).get('w')).toBe(committed);
    expect(circuitRoutes(over, lib, theme, g).get('w')).toEqual(shown);
  });
});
