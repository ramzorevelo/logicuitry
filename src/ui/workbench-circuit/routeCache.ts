import type {
  ChipLibrary,
  Circuit,
  Component,
  Junction,
  Wire,
  WireEnd,
} from '../../core/model/types';
import type { Rect, Vec2 } from '../../render/scene';
import type { Theme } from '../../render/theme';
import { symbolBounds } from '../../render/glyphs/symbol';
import { computeWireRoutes, polylineCrossesAny } from './wireGeom';

// Every store edit clones the circuit, so array identity is a sound change
// key: an unchanged array is unchanged content. Without this, a board of a few
// hundred wires rerouted on every frame and again in every pointer hit-test.

export interface ComponentGeometry {
  bounds: Rect;
  pins: Map<string, Vec2>;
}

interface GeometryEntry {
  chipLib: ChipLibrary;
  theme: Theme;
  value: Map<string, ComponentGeometry>;
}

interface RouteEntry {
  components: readonly Component[];
  junctions: readonly Junction[];
  chipLib: ChipLibrary;
  theme: Theme;
  grid: number;
  value: Map<string, Vec2[]>;
}

interface SymbolEntry {
  chipLib: ChipLibrary;
  theme: Theme;
  value: ComponentGeometry;
}

const geometryCache = new WeakMap<readonly Component[], GeometryEntry>();
// A drag preview replaces the array every frame but keeps every unmoved component object.
const symbolCache = new WeakMap<Component, SymbolEntry>();
const routeCache = new WeakMap<readonly Wire[], RouteEntry>();

function symbolGeometry(c: Component, chipLib: ChipLibrary, theme: Theme): ComponentGeometry {
  const hit = symbolCache.get(c);
  if (hit && hit.chipLib === chipLib && hit.theme === theme) return hit.value;
  const value = symbolBounds(c, theme, c.defId ? chipLib.get(c.defId) : undefined);
  symbolCache.set(c, { chipLib, theme, value });
  return value;
}

/** Body bounds and pin positions per component. Callers must not mutate the
 *  result: it is shared by every caller holding the same component array. */
export function componentGeometry(
  components: readonly Component[],
  chipLib: ChipLibrary,
  theme: Theme,
): ReadonlyMap<string, ComponentGeometry> {
  const hit = geometryCache.get(components);
  if (hit && hit.chipLib === chipLib && hit.theme === theme) return hit.value;
  const value = new Map(components.map((c) => [c.id, symbolGeometry(c, chipLib, theme)]));
  geometryCache.set(components, { chipLib, theme, value });
  return value;
}

export function circuitBounds(
  components: readonly Component[],
  chipLib: ChipLibrary,
  theme: Theme,
): Map<string, Rect> {
  return new Map(
    [...componentGeometry(components, chipLib, theme)].map(([id, g]) => [id, g.bounds]),
  );
}

/** Resolves a wire end against cached geometry, the same rule the draw loop
 *  and every hit-test use. */
export function endResolver(
  circuit: Pick<Circuit, 'components' | 'junctions'>,
  chipLib: ChipLibrary,
  theme: Theme,
): (end: WireEnd) => Vec2 | undefined {
  const geo = componentGeometry(circuit.components, chipLib, theme);
  const junctions = new Map(circuit.junctions.map((j) => [j.id, j.pos]));
  return (end) => {
    if (end.kind === 'pin') return geo.get(end.component)?.pins.get(end.pin);
    if (end.kind === 'junction') return junctions.get(end.junction);
    return end.pos;
  };
}

/** `computeWireRoutes` for a whole circuit, memoised on its arrays. Shared, so
 *  never mutate a returned route. */
export function circuitRoutes(
  circuit: Pick<Circuit, 'components' | 'junctions' | 'wires'>,
  chipLib: ChipLibrary,
  theme: Theme,
  grid: number,
): ReadonlyMap<string, Vec2[]> {
  const hit = routeCache.get(circuit.wires);
  if (
    hit &&
    hit.components === circuit.components &&
    hit.junctions === circuit.junctions &&
    hit.chipLib === chipLib &&
    hit.theme === theme &&
    hit.grid === grid
  )
    return hit.value;
  const value = computeWireRoutes(
    circuit.wires,
    endResolver(circuit, chipLib, theme),
    circuitBounds(circuit.components, chipLib, theme),
    grid,
  );
  routeCache.set(circuit.wires, {
    components: circuit.components,
    junctions: circuit.junctions,
    chipLib,
    theme,
    grid,
    value,
  });
  return value;
}

/** Routes for a preview built from the committed `base` (a drag, a bend or
 *  free-end edit): a wire reroutes when it changed, an end moved, or a moved
 *  body now covers its committed route; every other wire keeps that route.
 *  Not exact (a wire that detoured round a body's old spot keeps the detour
 *  until the drop), so a committed board always routes in full. */
export function previewRoutes(
  board: Pick<Circuit, 'components' | 'junctions' | 'wires'>,
  base: Pick<Circuit, 'components' | 'junctions' | 'wires'>,
  chipLib: ChipLibrary,
  theme: Theme,
  grid: number,
): ReadonlyMap<string, Vec2[]> {
  const committed = circuitRoutes(base, chipLib, theme, grid);
  if (
    board.components === base.components &&
    board.junctions === base.junctions &&
    board.wires === base.wires
  )
    return committed;
  const baseComponents = new Map(base.components.map((c) => [c.id, c]));
  const baseJunctions = new Map(base.junctions.map((j) => [j.id, j]));
  const baseWires = new Map(base.wires.map((w) => [w.id, w]));
  const geo = componentGeometry(board.components, chipLib, theme);
  const moved = new Set<string>();
  const movedBodies: Rect[] = [];
  for (const c of board.components)
    if (baseComponents.get(c.id) !== c) {
      moved.add(c.id);
      movedBodies.push(geo.get(c.id)!.bounds);
    }
  for (const j of board.junctions) if (baseJunctions.get(j.id) !== j) moved.add(j.id);
  const endMoved = (end: WireEnd): boolean =>
    (end.kind === 'pin' && moved.has(end.component)) ||
    (end.kind === 'junction' && moved.has(end.junction));
  const dirty = new Set<string>();
  for (const w of board.wires) {
    const route = committed.get(w.id);
    if (
      !route ||
      baseWires.get(w.id) !== w ||
      endMoved(w.a) ||
      endMoved(w.b) ||
      polylineCrossesAny(route, movedBodies)
    )
      dirty.add(w.id);
  }
  return computeWireRoutes(
    board.wires,
    endResolver(board, chipLib, theme),
    circuitBounds(board.components, chipLib, theme),
    grid,
    { routes: committed, dirty },
  );
}
