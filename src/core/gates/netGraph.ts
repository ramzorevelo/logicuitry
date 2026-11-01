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
// also hops between same-name labels in the same circuit and group, as compile
// scopes them. Everything built on
// this (label sync, width-mismatch checking, smart-connect's label
// exemption) therefore sees a name-joined net as the one net it really is.

import type { Circuit, Wire, WireEnd } from '../model/types';

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

/** A label joins only within its own group, as compile scopes it. */
function joinKey(group: string | undefined, name: string): string {
  return JSON.stringify([group ?? '', name]);
}

/** Join key -> the pins of every label carrying it. Built per walk; a
 *  circuit with no labels produces an empty map and costs one pass. */
function labelJoins(circuit: Circuit): Map<string, PinRef[]> {
  const byName = new Map<string, PinRef[]>();
  for (const c of circuit.components) {
    if (c.kind !== 'netlabel') continue;
    const name = (c.label ?? '').trim();
    if (!name) continue; // unnamed: joins nothing, same as compile
    const key = joinKey(c.group, name);
    const list = byName.get(key);
    const ref: PinRef = { component: c.id, pin: 'a' };
    if (list) list.push(ref);
    else byName.set(key, [ref]);
  }
  return byName;
}

/** Join key per label component id, so the walk looks a pin's key up
 *  instead of searching the component list at every step. */
function labelNames(circuit: Circuit): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of circuit.components) {
    if (c.kind !== 'netlabel') continue;
    const name = (c.label ?? '').trim();
    if (name) names.set(c.id, joinKey(c.group, name));
  }
  return names;
}

/** Wires by end key, each list in board order: the walk visits neighbours in
 *  the same order a scan of `circuit.wires` would, so results keep their order. */
function wiresByEnd(circuit: Circuit): Map<string, Wire[]> {
  const byEnd = new Map<string, Wire[]>();
  const add = (key: string, w: Wire) => {
    const list = byEnd.get(key);
    if (list) list.push(w);
    else byEnd.set(key, [w]);
  };
  for (const w of circuit.wires) {
    const aKey = endKey(w.a);
    const bKey = endKey(w.b);
    add(aKey, w);
    if (bKey !== aKey) add(bKey, w);
  }
  return byEnd;
}

/** Shared BFS: every pin and every wire directly or transitively reachable
 *  from `start` via wires/junctions -- `start` itself is never included in
 *  `pins`, even when it happens to be a pin. The indexes are built once per
 *  walk: scanning every wire at every step made a large board's redraw
 *  quadratic. */
function walkNet(circuit: Circuit, start: WireEnd): NetWalk {
  const startKey = endKey(start);
  const seenEndKeys = new Set<string>([startKey]);
  const seenWires = new Set<string>();
  const queue: WireEnd[] = [start];
  const pins: PinRef[] = [];
  const joins = labelJoins(circuit);
  const names = labelNames(circuit);
  const byEnd = wiresByEnd(circuit);

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const curKey = endKey(cur);
    // Name join: a label is electrically the same node as every label sharing
    // its name, with no wire in between.
    const name = cur.kind === 'pin' ? names.get(cur.component) : undefined;
    for (const sibling of name ? (joins.get(name) ?? []) : []) {
      const end: WireEnd = { kind: 'pin', component: sibling.component, pin: sibling.pin };
      const key = endKey(end);
      if (seenEndKeys.has(key)) continue;
      seenEndKeys.add(key);
      pins.push(sibling);
      queue.push(end);
    }
    for (const w of byEnd.get(curKey) ?? []) {
      if (seenWires.has(w.id)) continue;
      const other = endKey(w.a) === curKey ? w.b : w.a;
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

/** Every wire on the nets of the given wires: the given ones plus every wire
 *  joined to them through junctions, shared pins or same-name labels. */
export function netWiresOf(circuit: Circuit, wireIds: ReadonlySet<string>): Set<string> {
  const all = new Set<string>();
  for (const w of circuit.wires) {
    if (!wireIds.has(w.id) || all.has(w.id)) continue;
    all.add(w.id);
    for (const id of netWireIds(circuit, w.a)) all.add(id);
  }
  return all;
}
