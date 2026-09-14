// No geometry is hand-computed: the seed only has to be legal, and the same
// passes Tidy wiring uses assign the real positions.

import type { Circuit, Component, Point, Wire } from '../../core/model/types';
import type { SynthNetlist } from '../../core/boolean/synthesize';
import { resolveComponentPins, symbolBounds } from '../../render/glyphs/symbol';
import { schematicTheme, type Theme } from '../../render/theme';
import { autoPlace } from './autoPlace';
import { autoRoute, type RoutableComponent, type RoutablePin } from './autoRoute';

/** Longest path from a source, so the seed already reads left to right and the
 *  layering pass has nothing pathological to untangle. */
function depthOf(net: SynthNetlist, id: string): number {
  const from = new Map<string, string[]>();
  for (const [a, b] of net.links) {
    const to = b.split('.')[0]!;
    const src = a.split('.')[0]!;
    from.set(to, [...(from.get(to) ?? []), src]);
  }
  const walking = new Set<string>();
  const walk = (n: string): number => {
    if (walking.has(n)) return 0;
    walking.add(n);
    const ups = from.get(n) ?? [];
    const d = ups.length ? Math.max(...ups.map(walk)) + 1 : 0;
    walking.delete(n);
    return d;
  };
  return walk(id);
}

function routableOf(c: Component, theme: Theme): RoutableComponent {
  const { bounds, pins } = symbolBounds(c, theme, undefined);
  const dirs = new Map(resolveComponentPins(c, undefined).map((p) => [p.name, p.dir]));
  const routable = new Map<string, RoutablePin>();
  for (const [name, pos] of pins) {
    const dir = dirs.get(name);
    if (dir) routable.set(name, { pos, dir });
  }
  return { id: c.id, bounds, pins: routable };
}

/** `from` names a part, meaning its `y` output; `to` is already `id.pin`. */
function wireEnd(ref: string, dir: 'in' | 'out'): Wire['a'] {
  const [component, pin] = ref.includes('.') ? ref.split('.') : [ref, dir === 'out' ? 'y' : 'a'];
  return { kind: 'pin', component: component!, pin: pin! };
}

/** Ids stay the netlist's own; the store remaps them on commit, so building
 *  twice never collides. `origin` clears whatever is already on the board. */
export function circuitFromNetlist(net: SynthNetlist, origin: Point = { x: 0, y: 0 }): Circuit {
  const theme = schematicTheme();
  const components: Component[] = net.parts.map((p, i) => ({
    id: p.id,
    kind: p.kind as Component['kind'],
    pos: { x: 48 + 176 * depthOf(net, p.id), y: 48 + 96 * i },
    ...(p.label ? { label: p.label } : {}),
    ...(p.inputs || p.params
      ? { params: { ...(p.params ?? {}), ...(p.inputs ? { inputs: p.inputs } : {}) } }
      : {}),
  }));
  const wires: Wire[] = net.links.map(([from, to], i) => ({
    id: `w${i + 1}`,
    a: wireEnd(from, 'out'),
    b: wireEnd(to, 'in'),
    points: [],
  }));

  const { moved } = autoPlace({
    components: components.map((c) => routableOf(c, theme)),
    wires,
    grid: theme.gridSchematic,
    centreOnDrivers: true,
  });
  const placed = components.map((c) => {
    const off = moved.get(c.id);
    return off ? { ...c, pos: { x: c.pos.x + off.x, y: c.pos.y + off.y } } : c;
  });
  const routed = autoRoute({
    components: placed.map((c) => routableOf(c, theme)),
    wires,
    junctions: [],
    grid: theme.gridSchematic,
  });

  // The passes work in the seed's own coordinates, so the move to `origin`
  // has to come after them or it would be placed away again.
  const shift = <T extends Point>(p: T): T => ({ ...p, x: p.x + origin.x, y: p.y + origin.y });
  return {
    components: placed.map((c) => ({ ...c, pos: shift(c.pos) })),
    wires: routed.wires.map((w) => ({ ...w, points: w.points.map(shift) })),
    junctions: routed.junctions.map((j) => ({ ...j, pos: shift(j.pos) })),
  };
}
