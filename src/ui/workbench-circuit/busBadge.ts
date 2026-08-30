import type { ChipLibrary, Circuit, Wire, WireEnd } from '../../core/model/types';
import { netPins, type PinRef } from '../../core/gates/netGraph';
import { resolveComponentPins } from '../../render/glyphs/symbol';
import { busSlashGeometry } from '../../render/glyphs/chip';
import type { Vec2 } from '../../render/scene';
import { occupancyKey } from './pinTargets';
import { pointAlongPolyline, type PolylinePoint } from './wireGeom';

// Which wide pins still state their own width. The wire a pin connects to
// draws the same slash + bit-count glyph, so once a pin is wired the pin's own
// badge is a second statement of one fact -- noise on a board full of buses.

export interface BusBadgeContext {
  /** Pins carrying at least one wire end. */
  wired: ReadonlySet<string>;
  /** Pins on a width-mismatched wire: there, both widths ARE the diagnostic. */
  mismatched: ReadonlySet<string>;
  alwaysShow: boolean;
}

export function shouldShowPinBusBadge(width: number, key: string, ctx: BusBadgeContext): boolean {
  if (width <= 1) return false;
  return ctx.alwaysShow || ctx.mismatched.has(key) || !ctx.wired.has(key);
}

/** Pin keys of every end of a wire in `wireIds`, in `wiredPinKeys`'s own key
 *  shape so both sets are looked up the same way. */
export function pinKeysOfWires(
  wires: readonly Wire[],
  wireIds: ReadonlySet<string> | undefined,
): Set<string> {
  const keys = new Set<string>();
  if (!wireIds || wireIds.size === 0) return keys;
  for (const w of wires) {
    if (!wireIds.has(w.id)) continue;
    for (const end of [w.a, w.b])
      if (end.kind === 'pin') keys.add(occupancyKey(end.component, end.pin));
  }
  return keys;
}

function pinWidth(circuit: Circuit, chipLib: ChipLibrary, ref: PinRef): number | undefined {
  const comp = circuit.components.find((c) => c.id === ref.component);
  if (!comp) return undefined;
  const def = comp.defId ? chipLib.get(comp.defId) : undefined;
  return resolveComponentPins(comp, def).find((s) => s.name === ref.pin)?.width;
}

/** The width a wire is DRAWN at, and so whether it carries a bus badge at all.
 *  Direct pin ends first; a wire with neither end on a pin (split off a bus and
 *  dropped in empty space) walks the net to the nearest reachable pin rather
 *  than defaulting to a thin 1-bit wire. Shared by the draw path and the
 *  badge's own hit-test so the two can never disagree about which wires have
 *  a label to grab. */
export function wireBusWidth(
  circuit: Circuit,
  chipLib: ChipLibrary,
  wire: { a: WireEnd; b: WireEnd },
): number {
  for (const end of [wire.a, wire.b])
    if (end.kind === 'pin') {
      const w = pinWidth(circuit, chipLib, { component: end.component, pin: end.pin });
      if (w !== undefined) return w;
    }
  for (const end of [wire.a, wire.b]) {
    if (end.kind === 'pin') continue;
    for (const ref of netPins(circuit, end)) {
      const w = pinWidth(circuit, chipLib, ref);
      if (w !== undefined) return w;
    }
  }
  return 1;
}

/** The bus badge's slash + number, placed at a point along the wire and
 *  oriented by that point's own segment rather than by the endpoints, so a
 *  bent bus wire still reads correctly. */
export function busLabelGeometry(
  at: PolylinePoint,
  g: number,
): { slashA: Vec2; slashB: Vec2; badgePos: Vec2 } {
  const [segA, segB] = at.segment;
  const geom = busSlashGeometry(segA, segB, g);
  // busSlashGeometry centres on its own segment's midpoint; shift the whole
  // mark to the requested point so a dragged label lands where it was dropped.
  const mid = { x: (segA.x + segB.x) / 2, y: (segA.y + segB.y) / 2 };
  const dx = at.pos.x - mid.x;
  const dy = at.pos.y - mid.y;
  const move = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy });
  return { slashA: move(geom.slashA), slashB: move(geom.slashB), badgePos: move(geom.badgePos) };
}

/** The two points a pointer can grab a bus label by: the slash on the wire and
 *  the number beside it. */
export function busLabelHitPoints(pts: readonly Vec2[], t: number | undefined, g: number): Vec2[] {
  const at = pointAlongPolyline(pts, t ?? 0.5);
  return [at.pos, busLabelGeometry(at, g).badgePos];
}
