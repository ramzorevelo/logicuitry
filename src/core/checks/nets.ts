// One circuit level's nets from its own drawing: wires, junctions, group-scoped
// net labels, tunnels, tied pins and bus taps. Not from compile, so a circuit
// that does not compile still has nets to check.

import type { ChipDef, ChipLibrary, Circuit, Component, PinDir } from '../model/types';
import { driverFloats } from '../model/pinSlots';
import { getPrimitive, hasPrimitive } from '../sim/primitives/registry';
import { getPackage } from '../parts/packages';

/** What a pin does on its net, as far as the checks care. */
export interface NetPin {
  component: string;
  pin: string;
  dir: PinDir;
  /** A driver whose drive can go to Z. */
  floats: boolean;
  /** A weak pull: holds the net but neither drives it hard nor reads it. */
  pull: boolean;
  /** A package's supply pin, checked as power rather than as an input. */
  supply?: 'vcc' | 'gnd';
  /** An input left open on purpose: no "not wired" row. */
  openOk?: true;
  /** A waveform probe: it watches the net, it is not a load. */
  probe: boolean;
}

export interface CheckNet {
  pins: NetPin[];
  wires: string[];
  /** Name of the first named label or tunnel on the net, for display. */
  name?: string;
}

const CONNECTORS = new Set(['netlabel', 'tunnel']);

/** Datasheet pin number and supply role per pin name of a built-in package def. */
export function packagePins(
  def: ChipDef | undefined,
): Map<string, { number: number; fn: string }> | undefined {
  if (!def?.appearance?.package) return undefined;
  const entry = getPackage(def.id);
  if (!entry) return undefined;
  return new Map(entry.pins.map((p) => [p.name, { number: p.pin, fn: p.fn }]));
}

/** The checkable pins of one component, connectors excluded. */
export function componentNetPins(comp: Component, lib: ChipLibrary): NetPin[] {
  if (CONNECTORS.has(comp.kind)) return [];
  const base = { component: comp.id, probe: comp.kind === 'probe' };
  if (comp.kind === 'chip') {
    const def = comp.defId ? lib.get(comp.defId) : undefined;
    if (!def) return [];
    const pkg = packagePins(def);
    return def.pins.flatMap((p): NetPin[] => {
      const fn = pkg?.get(p.name)?.fn;
      if (fn === 'nc') return [];
      return [
        {
          ...base,
          pin: p.name,
          dir: p.dir,
          floats: p.dir === 'inout' || (p.dir === 'out' && chipPinFloats(def, p.name, lib)),
          pull: false,
          ...(fn === 'vcc' || fn === 'gnd' ? { supply: fn } : {}),
          ...(fn && OPEN_OK_FNS.has(`${def.id}:${fn}`) ? { openOk: true as const } : {}),
        },
      ];
    });
  }
  if (!hasPrimitive(comp.kind)) return [];
  const params = comp.params ?? {};
  const pull = comp.kind === 'pullup' || comp.kind === 'pulldown';
  return getPrimitive(comp.kind)
    .pins(params)
    .map((p) => ({
      ...base,
      pin: p.name,
      dir: p.dir,
      floats: driverFloats(p, params),
      pull,
      ...(comp.kind === 'sevenseg' && SEGMENT_PINS.has(p.name) ? { openOk: true as const } : {}),
    }));
}

// SPEC: the '47/'48 BI/RBO is a pulled-up node the datasheet leaves open, and the
// sim reads it high; an unwired segment is just a dark one, as the segment-a boards use.
const OPEN_OK_FNS = new Set(['74LS47:bi', '74LS48:bi']);
const SEGMENT_PINS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp']);

const floatMemo = new WeakMap<ChipDef, { lib: ChipLibrary; pins: Map<string, boolean> }>();

/** Whether a def's output pin can go to Z: every driver inside on its net
 *  floats, the way a '374 output does. An In port passing a parent signal
 *  straight through counts as plain, and so does a pin nothing inside drives. */
function chipPinFloats(def: ChipDef, pinName: string, lib: ChipLibrary): boolean {
  let entry = floatMemo.get(def);
  if (entry?.lib !== lib) floatMemo.set(def, (entry = { lib, pins: new Map() }));
  const memo = entry.pins;
  const known = memo.get(pinName);
  if (known !== undefined) return known;
  const bound = def.pins.find((p) => p.name === pinName)?.boundComponent;
  const net = bound ? circuitNets(def, lib).byPin.get(pinRef(bound, 'a')) : undefined;
  const drivers = (net?.pins ?? []).filter((p) => isDriver(p) && p.component !== bound);
  const floats = drivers.length > 0 && drivers.every((p) => p.floats);
  memo.set(pinName, floats);
  return floats;
}

export const pinRef = (component: string, pin: string) => `${component}.${pin}`;

export const isDriver = (p: NetPin) => !p.pull && (p.dir === 'out' || p.dir === 'inout');
export const isReader = (p: NetPin) => !p.pull && !p.probe && (p.dir === 'in' || p.dir === 'inout');

class UnionFind {
  private parent = new Map<string, string>();

  find(k: string): string {
    let root = k;
    for (let next = this.parent.get(root); next !== undefined && next !== root; ) {
      root = next;
      next = this.parent.get(root);
    }
    for (let cur = k; cur !== root; ) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

export interface CircuitNets {
  nets: CheckNet[];
  /** pinRef -> its net. Every checkable pin has one, wired or not. */
  byPin: Map<string, CheckNet>;
}

const netsMemo = new WeakMap<Circuit, { lib: ChipLibrary; nets: CircuitNets }>();

/** Nets of one circuit level, memoised per circuit object and library. */
export function circuitNets(circuit: Circuit, lib: ChipLibrary): CircuitNets {
  const hit = netsMemo.get(circuit);
  if (hit && hit.lib === lib) return hit.nets;
  // A def that contains itself does not compile; answer it with no nets, not a loop.
  if (building.has(circuit)) return { nets: [], byPin: new Map() };
  building.add(circuit);
  try {
    const nets = buildNets(circuit, lib);
    netsMemo.set(circuit, { lib, nets });
    return nets;
  } finally {
    building.delete(circuit);
  }
}

const building = new Set<Circuit>();

function buildNets(circuit: Circuit, lib: ChipLibrary): CircuitNets {
  const uf = new UnionFind();
  const pinKey = (c: string, p: string) => `p:${c}:${p}`;
  const wireKey = (w: string) => `w:${w}`;
  for (const w of circuit.wires) {
    for (const end of [w.a, w.b]) {
      if (end.kind === 'pin') uf.union(wireKey(w.id), pinKey(end.component, end.pin));
      else if (end.kind === 'junction') uf.union(wireKey(w.id), `j:${end.junction}`);
      // A tap joins the stub to the tapped bus: checks ask "wired?", not "which bits?".
      else if (end.kind === 'tap') uf.union(wireKey(w.id), wireKey(end.wire));
    }
  }
  const names = new Map<string, string>();
  const joinBy = (scope: string, comp: Component, pin: string) => {
    const anchor = names.get(scope);
    if (anchor) uf.union(anchor, pinKey(comp.id, pin));
    else names.set(scope, pinKey(comp.id, pin));
  };
  for (const comp of circuit.components) {
    if (comp.kind === 'netlabel') {
      const name = (comp.label ?? '').trim();
      if (name) joinBy(JSON.stringify(['label', comp.group ?? '', name]), comp, 'a');
    } else if (comp.kind === 'tunnel') {
      const name = String(comp.params?.['name'] ?? '');
      if (name) joinBy(JSON.stringify(['tunnel', name]), comp, 'p');
    } else if (comp.kind !== 'chip' && hasPrimitive(comp.kind)) {
      for (const group of getPrimitive(comp.kind).tiedPins ?? [])
        for (const pin of group.slice(1))
          uf.union(pinKey(comp.id, group[0]!), pinKey(comp.id, pin));
    }
  }

  const byRoot = new Map<string, CheckNet>();
  const netOf = (key: string): CheckNet => {
    const root = uf.find(key);
    let net = byRoot.get(root);
    if (!net) byRoot.set(root, (net = { pins: [], wires: [] }));
    return net;
  };
  const byPin = new Map<string, CheckNet>();
  for (const comp of circuit.components) {
    for (const p of componentNetPins(comp, lib)) {
      const net = netOf(pinKey(comp.id, p.pin));
      net.pins.push(p);
      byPin.set(pinRef(comp.id, p.pin), net);
    }
    const connectorPin = comp.kind === 'netlabel' ? 'a' : comp.kind === 'tunnel' ? 'p' : null;
    if (connectorPin) {
      const name =
        comp.kind === 'netlabel' ? (comp.label ?? '').trim() : String(comp.params?.['name'] ?? '');
      const net = netOf(pinKey(comp.id, connectorPin));
      if (name) net.name ??= name;
    }
  }
  for (const w of circuit.wires) netOf(wireKey(w.id)).wires.push(w.id);
  return { nets: [...byRoot.values()], byPin };
}
