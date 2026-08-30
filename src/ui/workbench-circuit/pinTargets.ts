// Loose pin targeting: wiring snaps to the nearest compatible free pin.
// Compatibility filters before distance ranking so a near incompatible pin
// never beats a farther compatible one.

import type { ChipLibrary, Component, PinDir, PinRole, Wire } from '../../core/model/types';
import { resolveComponentPins, symbolBounds } from '../../render/glyphs/symbol';
import { MIN_HIT_RADIUS } from '../../render/hitTest';
import type { Vec2 } from '../../render/scene';
import type { Theme } from '../../render/theme';

export interface PinTarget {
  componentId: string;
  pinName: string;
  width: number;
  role: PinRole;
  order: number;
  dir: PinDir;
  worldPos: Vec2;
  free: boolean; // already wired = not a valid new-wire endpoint
}

export const occupancyKey = (componentId: string, pinName: string) => `${componentId} ${pinName}`;

/** A wire's width, read off whichever end is a resolvable pin (bus taps need
 *  this to know how much of the bus a click can pull off); undefined when
 *  neither end is a pin the library can resolve. */
export function wireWidth(
  wire: Wire,
  components: readonly Component[],
  chipLib: ChipLibrary,
): number | undefined {
  for (const end of [wire.a, wire.b]) {
    if (end.kind !== 'pin') continue;
    const comp = components.find((c) => c.id === end.component);
    if (!comp) continue;
    const def = comp.defId ? chipLib.get(comp.defId) : undefined;
    const width = resolveComponentPins(comp, def).find((p) => p.name === end.pin)?.width;
    if (width !== undefined) return width;
  }
  return undefined;
}

/** Every pin on the board with its world position and free/occupied state.
 *  Only `in` pins are ever marked occupied: an output may drive many inputs in
 *  parallel (fan-out), but an input accepts at most one driver. */
export function collectPinTargets(
  components: readonly Component[],
  wires: readonly Wire[],
  theme: Theme,
  chipLib: ChipLibrary,
): PinTarget[] {
  const occupied = new Set<string>();
  const dirByKey = new Map<string, PinDir>();
  for (const comp of components) {
    const def = comp.defId ? chipLib.get(comp.defId) : undefined;
    for (const spec of resolveComponentPins(comp, def))
      dirByKey.set(occupancyKey(comp.id, spec.name), spec.dir);
  }
  for (const w of wires) {
    for (const end of [w.a, w.b]) {
      if (end.kind !== 'pin') continue;
      const key = occupancyKey(end.component, end.pin);
      if (dirByKey.get(key) === 'in') occupied.add(key);
    }
  }

  const targets: PinTarget[] = [];
  for (const comp of components) {
    const def = comp.defId ? chipLib.get(comp.defId) : undefined;
    const { pins } = symbolBounds(comp, theme, def);
    const specs = resolveComponentPins(comp, def);
    for (const spec of specs) {
      const worldPos = pins.get(spec.name);
      if (!worldPos) continue;
      targets.push({
        componentId: comp.id,
        pinName: spec.name,
        width: spec.width,
        role: spec.role,
        order: spec.order,
        dir: spec.dir,
        worldPos,
        free: !occupied.has(occupancyKey(comp.id, spec.name)),
      });
    }
  }
  return targets;
}

// Keys of every pin carrying at least one wire end (either direction). Smart-
// connect uses this to skip re-suggesting an already-wired pin -- stricter than
// `free`, which deliberately keeps an output available for manual fan-out.
export function wiredPinKeys(wires: readonly Wire[]): Set<string> {
  const keys = new Set<string>();
  for (const w of wires)
    for (const end of [w.a, w.b])
      if (end.kind === 'pin') keys.add(occupancyKey(end.component, end.pin));
  return keys;
}

// Smart-connect's own pin pool: drops an already-wired INPUT (an input takes
// at most one driver, so re-suggesting it would double-drive it) but keeps an
// already-wired OUTPUT available -- same fan-out allowance as manual wiring's
// `free`, just computed fresh here since `free` only tracks inputs today.
export function smartConnectTargets(
  targets: readonly PinTarget[],
  wires: readonly Wire[],
): PinTarget[] {
  const wiredKeys = wiredPinKeys(wires);
  return targets.filter(
    (t) =>
      // A net label is joined by typing the same name, not by drawing a wire
      // to it, so smart-connect leaves it out of both pools entirely.
      t.dir !== 'passive' &&
      !(t.dir === 'in' && wiredKeys.has(occupancyKey(t.componentId, t.pinName))),
  );
}

// In/Out labels never count as a real driver (compile.ts aliases them, per
// labelDirectionConflict's own comment) -- so an occupied `in` pin may still
// accept a NEW wire whenever at most one of the two ends involved is a real
// driver. `free` alone can't express this (it's a global per-pin flag with no
// notion of who the existing driver is), so this walks the pin's current
// wire to find its other end.
export function labelExempt(
  components: readonly Component[],
  wires: readonly Wire[],
  fromComponentId: string,
  target: PinTarget,
): boolean {
  const isLabel = (id: string) => {
    const k = components.find((c) => c.id === id)?.kind;
    return k === 'inport' || k === 'outport';
  };
  if (isLabel(fromComponentId)) return true;
  const key = occupancyKey(target.componentId, target.pinName);
  // A REAL driver already on this pin blocks a new one regardless of
  // whether a label ALSO shares it -- short-circuiting true on the first
  // label-driven wire found (without checking every other wire touching
  // the same pin) let a switch cycle onto a pin another switch already
  // drives, as long as a label happened to share it too.
  for (const w of wires) {
    for (const end of [w.a, w.b]) {
      if (end.kind !== 'pin' || occupancyKey(end.component, end.pin) !== key) continue;
      const other = end === w.a ? w.b : w.a;
      if (other.kind === 'pin' && !isLabel(other.component)) return false;
    }
  }
  return true;
}

/** A net label declares neither direction nor width -- it takes the net's --
 *  so it pairs with anything, and anything pairs with it. */
const passiveEither = (a: PinDir, b: PinDir): boolean => a === 'passive' || b === 'passive';

// Same width, opposite direction. Role is not filtered: any pin wires to any
// other by hand; role only constrains smart-connect. `allowOccupied` (e.g.
// labelExempt) lets an otherwise-occupied `in` pin still qualify -- an In/Out
// label sharing a net with a real driver is legal, just not two real drivers.
export function nearestCompatiblePin(
  targets: readonly PinTarget[],
  cursor: Vec2,
  wanted: { width: number; dir: PinDir },
  /** Hit-target multiplier: presentation scaling and finger size, composed by
   *  the caller. 1 is a mouse at 100%. */
  scale: number,
  allowOccupied?: (t: PinTarget) => boolean,
): PinTarget | undefined {
  const radius = MIN_HIT_RADIUS * scale * 2; // loose = 2x click target
  let best: PinTarget | undefined;
  let bestDist = Infinity;
  for (const t of targets) {
    if (!t.free && !allowOccupied?.(t)) continue;
    if (!passiveEither(t.dir, wanted.dir) && (t.width !== wanted.width || t.dir === wanted.dir))
      continue;
    const d = Math.hypot(t.worldPos.x - cursor.x, t.worldPos.y - cursor.y);
    if (d < radius && d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}
