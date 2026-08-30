// Wire/junction connectivity helpers: find every pin directly or transitively
// reachable from a wire end across junctions and multi-segment wiring, not
// just direct pin-to-pin wires. A 'tap' end is its own distinct node (per
// `endKey`), it never extends the tapped bus's net, matching the tap
// convention: the walk simply can't cross it. bubble-pushing's own callers
// stay scoped to the single-bit gate
// set by construction (a gate never has a tap on its pins), not by anything
// this module restricts.
//
// A `netlabel` joins by NAME, not by a wire (KiCad's local label), so the walk
// also hops between same-name labels in the same circuit. Everything built on
// this (label sync, width-mismatch checking, smart-connect's label
// exemption) therefore sees a name-joined net as the one net it really is.

import type { Circuit, WireEnd } from '../model/types';

export interface PinRef {
  component: string;
  pin: string;
}

function endKey(e: WireEnd): string {
  switch (e.kind) {
    case 'pin':
      return `p:${e.component}:${e.pin}`;
    case 'junction':
      return `j:${e.junction}`;
    case 'free':
      return `f:${e.pos.x}:${e.pos.y}`;
    case 'tap':
      return `t:${e.wire}:${e.range.hi}:${e.range.lo}`;
  }
}

interface NetWalk {
  pins: PinRef[];
  wireIds: Set<string>;
}

/** Net-label name -> the pins of every label carrying it. Built per walk; a
 *  circuit with no labels produces an empty map and costs one pass. */
function labelJoins(circuit: Circuit): Map<string, PinRef[]> {
  const byName = new Map<string, PinRef[]>();
  for (const c of circuit.components) {
    if (c.kind !== 'netlabel') continue;
    const name = (c.label ?? '').trim();
    if (!name) continue; // unnamed: joins nothing, same as compile
    const list = byName.get(name);
    const ref: PinRef = { component: c.id, pin: 'a' };
    if (list) list.push(ref);
    else byName.set(name, [ref]);
  }
  return byName;
}

/** The name a net label pin carries, or undefined if this pin is not one. */
function labelNameOfPin(circuit: Circuit, end: WireEnd): string | undefined {
  if (end.kind !== 'pin') return undefined;
  const comp = circuit.components.find((c) => c.id === end.component);
  if (comp?.kind !== 'netlabel') return undefined;
  const name = (comp.label ?? '').trim();
  return name || undefined;
}

/** Shared BFS: every pin and every wire directly or transitively reachable
 *  from `start` via wires/junctions -- `start` itself is never included in
 *  `pins`, even when it happens to be a pin. */
function walkNet(circuit: Circuit, start: WireEnd): NetWalk {
  const startKey = endKey(start);
  const seenEndKeys = new Set<string>([startKey]);
  const seenWires = new Set<string>();
  const queue: WireEnd[] = [start];
  const pins: PinRef[] = [];
  const joins = labelJoins(circuit);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curKey = endKey(cur);
    // Name join: a label is electrically the same node as every label sharing
    // its name, with no wire in between.
    const name = labelNameOfPin(circuit, cur);
    for (const sibling of name ? (joins.get(name) ?? []) : []) {
      const end: WireEnd = { kind: 'pin', component: sibling.component, pin: sibling.pin };
      const key = endKey(end);
      if (seenEndKeys.has(key)) continue;
      seenEndKeys.add(key);
      pins.push(sibling);
      queue.push(end);
    }
    for (const w of circuit.wires) {
      if (seenWires.has(w.id)) continue;
      const aKey = endKey(w.a);
      const bKey = endKey(w.b);
      let other: WireEnd | undefined;
      if (aKey === curKey) other = w.b;
      else if (bKey === curKey) other = w.a;
      if (!other) continue;
      seenWires.add(w.id);
      const otherKey = endKey(other);
      if (seenEndKeys.has(otherKey)) continue;
      seenEndKeys.add(otherKey);
      if (other.kind === 'pin') pins.push({ component: other.component, pin: other.pin });
      queue.push(other);
    }
  }
  return { pins, wireIds: seenWires };
}

/** Every pin directly or transitively connected to `start` (any wire end, not
 *  just a pin) via wires/junctions -- `start` itself is never included, even
 *  when it happens to be a pin. */
export function netPins(circuit: Circuit, start: WireEnd): PinRef[] {
  return walkNet(circuit, start).pins;
}

/** Every other pin directly or transitively connected to `start` via wires/junctions. */
export function connectedPins(circuit: Circuit, start: PinRef): PinRef[] {
  return netPins(circuit, { kind: 'pin', component: start.component, pin: start.pin });
}

/** Every wire directly or transitively connected to `start` via wires/junctions
 *  -- the whole physically-joined wire run, crossing through any number of
 *  junctions, not just the ones touching `start` directly. */
export function netWireIds(circuit: Circuit, start: WireEnd): Set<string> {
  return walkNet(circuit, start).wireIds;
}
