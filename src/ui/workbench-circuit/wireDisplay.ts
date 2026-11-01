import type { ChipLibrary, Circuit, Component, Wire } from '../../core/model/types';
import { netPins, type PinRef } from '../../core/gates/netGraph';
import { resolveComponentPins } from '../../render/glyphs/symbol';
import { wireBusWidth } from './busBadge';

// A wire with no pin end walks its net for its width and colour, which per
// frame cost a large board more than drawing every wire did.

export interface WireDisplay {
  width: number;
  /** The pin whose signal colours the wire: its own pin end, else the first
   *  pin its net reaches. Undefined when the net holds no pin at all. */
  readPin: PinRef | undefined;
}

interface Entry {
  components: readonly Component[];
  chipLib: ChipLibrary;
  value: Map<string, WireDisplay>;
}

interface LastEntry extends Entry {
  wires: readonly Wire[];
}

const cache = new WeakMap<readonly Wire[], Entry>();
let last: LastEntry | undefined;

// Width and read pin follow connectivity alone, so a drag preview (new arrays
// every frame, only these fields changed) can keep the previous result.
const COMPONENT_PLACEMENT = new Set(['pos']);
const WIRE_PLACEMENT = new Set(['points', 'color']);

/** Same length, and each pair is one object or equal in every field but the
 *  `ignored` ones, compared by identity. */
function sameButFor<T extends object>(
  a: readonly T[],
  b: readonly T[],
  ignored: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const fieldsMatch = (x: object, y: object): boolean =>
    Object.keys(x).every(
      (k) =>
        ignored.has(k) || (x as Record<string, unknown>)[k] === (y as Record<string, unknown>)[k],
    );
  return a.every((x, i) => x === b[i] || (fieldsMatch(x, b[i]!) && fieldsMatch(b[i]!, x)));
}

function reusable(entry: LastEntry, circuit: Circuit, chipLib: ChipLibrary): boolean {
  return (
    entry.chipLib === chipLib &&
    sameButFor(entry.components, circuit.components, COMPONENT_PLACEMENT) &&
    sameButFor(entry.wires, circuit.wires, WIRE_PLACEMENT)
  );
}

/** Per wire, memoised on the circuit's arrays (every store edit replaces them).
 *  Never mutate the result: it is shared by every caller of the same board. */
export function wireDisplayInfo(
  circuit: Circuit,
  chipLib: ChipLibrary,
): ReadonlyMap<string, WireDisplay> {
  const hit = cache.get(circuit.wires);
  if (hit && hit.components === circuit.components && hit.chipLib === chipLib) {
    last = { ...hit, wires: circuit.wires };
    return hit.value;
  }
  if (last && reusable(last, circuit, chipLib)) {
    const value = last.value;
    cache.set(circuit.wires, { components: circuit.components, chipLib, value });
    last = { components: circuit.components, wires: circuit.wires, chipLib, value };
    return value;
  }
  const byId = new Map(circuit.components.map((c) => [c.id, c]));
  const hasPin = (ref: PinRef): boolean => {
    const comp = byId.get(ref.component);
    if (!comp) return false;
    const def = comp.defId ? chipLib.get(comp.defId) : undefined;
    return resolveComponentPins(comp, def).some((s) => s.name === ref.pin);
  };
  const value = new Map<string, WireDisplay>();
  for (const wire of circuit.wires) {
    let readPin: PinRef | undefined;
    for (const end of [wire.a, wire.b])
      if (!readPin && end.kind === 'pin' && hasPin(end)) readPin = end;
    for (const end of [wire.a, wire.b]) {
      if (readPin || end.kind === 'pin') continue;
      readPin = netPins(circuit, end).find(hasPin);
    }
    value.set(wire.id, { width: wireBusWidth(circuit, chipLib, wire), readPin });
  }
  cache.set(circuit.wires, { components: circuit.components, chipLib, value });
  last = { components: circuit.components, wires: circuit.wires, chipLib, value };
  return value;
}
