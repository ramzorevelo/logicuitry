// Flattening compiler: hierarchy in, flat index-addressed net-graph out.
// Simulation never sees ChipDefs; every instance is expanded once per use.

import type { Board, ChipDef, ChipLibrary, Circuit, Component, PinDir, WireEnd } from './types';
import type { Params } from '../sim/primitives/types';
import { CONNECTIVITY_KINDS, getPrimitive } from '../sim/primitives/registry';

export class CompileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'CompileError';
  }
}

export interface CompiledNet {
  width: number;
  /** Hierarchical aliases; first entry is canonical (e.g. main/U2:full-adder/n5). */
  paths: string[];
  /** Weak pull applied by the kernel to bits that resolve to Z. */
  pull?: 0 | 1;
}

export interface CompiledPrimitive {
  kind: string;
  params: Params;
  path: string;
  /** Fully-qualified `prefix + comp.id` -- unique per component even when
   *  `path` (label-derived) collides, e.g. two different components legally
   *  sharing one label via same-net label sharing (labelSync.ts). `path`
   *  stays the display/STA-facing name; this is the unambiguous lookup key. */
  componentId: string;
  /** Net index per input pin, in pins() order. */
  inputs: number[];
  /** Net index per output pin, in pins() order. */
  outputs: number[];
  /** 74LS binding for datasheet-mode delays. */
  part?: string;
}

export interface CompiledCircuit {
  primitives: CompiledPrimitive[];
  nets: CompiledNet[];
  /** netIndex -> primitive indices reading that net. */
  fanout: number[][];
  /** netIndex -> driving (primitive, output-slot) pairs. */
  drivers: { prim: number; out: number }[][];
  pathToNet: Map<string, number>;
  /** Ambiguous when two components share a label (same-net label sharing) --
   *  last-write-wins. Prefer `componentToPrimitive` when resolving a SPECIFIC
   *  component's own primitive, not just "something at this path". */
  pathToPrimitive: Map<string, number>;
  /** Unambiguous per-component lookup, keyed by the same `componentId` each
   *  primitive carries. */
  componentToPrimitive: Map<string, number>;
}

/** Union-find over global net ids, with width/path/pull merging at union time. */
class NetTable {
  private parent: number[] = [];
  widths: number[] = [];
  paths: string[][] = [];
  pulls: (0 | 1 | undefined)[] = [];

  create(width: number, path: string): number {
    this.parent.push(this.parent.length);
    this.widths.push(width);
    this.paths.push([path]);
    this.pulls.push(undefined);
    return this.parent.length - 1;
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[i] !== root) {
      const next = this.parent[i]!;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number, atPath: string): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    if (this.widths[ra] !== this.widths[rb])
      throw new CompileError(
        `width mismatch: ${this.widths[ra]} vs ${this.widths[rb]} ` +
          `(${this.paths[ra]![0]} vs ${this.paths[rb]![0]})`,
        atPath,
      );
    const pa = this.pulls[ra];
    const pb = this.pulls[rb];
    if (pa !== undefined && pb !== undefined && pa !== pb)
      throw new CompileError('conflicting pull-up and pull-down on one net', atPath);
    this.parent[rb] = ra;
    this.paths[ra] = [...this.paths[ra]!, ...this.paths[rb]!];
    this.pulls[ra] = pa ?? pb;
    return ra;
  }

  setPull(i: number, pull: 0 | 1, atPath: string): void {
    const r = this.find(i);
    const prev = this.pulls[r];
    if (prev !== undefined && prev !== pull)
      throw new CompileError('conflicting pull-up and pull-down on one net', atPath);
    this.pulls[r] = pull;
  }
}

/** String-keyed union-find for one hierarchy level's connection nodes. */
class LocalNodes {
  private ids = new Map<string, number>();
  private parent: number[] = [];

  private node(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.parent.length;
      this.ids.set(key, id);
      this.parent.push(id);
    }
    return id;
  }

  find(key: string): number {
    let i = this.node(key);
    while (this.parent[i] !== i) i = this.parent[i]!;
    return i;
  }

  union(a: string, b: string): void {
    this.parent[this.find(b)] = this.find(a);
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }
}

const pinKey = (comp: string, pin: string) => `pin:${comp}:${pin}`;
const endKey = (e: WireEnd): string => {
  if (e.kind === 'pin') return pinKey(e.component, e.pin);
  if (e.kind === 'junction') return `jct:${e.junction}`;
  throw new Error('tap ends are resolved through synthesized connectors, not endKey');
};

interface PinInfo {
  width: number;
  dir: PinDir;
}

function componentPins(comp: Component, lib: ChipLibrary, atPath: string): Map<string, PinInfo> {
  const map = new Map<string, PinInfo>();
  if (comp.kind === 'chip') {
    const def = comp.defId ? lib.get(comp.defId) : undefined;
    if (!def) throw new CompileError(`unknown chip def '${comp.defId}'`, atPath);
    for (const p of def.pins) map.set(p.name, { width: p.width, dir: p.dir });
  } else {
    for (const p of getPrimitive(comp.kind).pins(comp.params ?? {}))
      map.set(p.name, { width: p.width, dir: p.dir });
  }
  return map;
}

/** A net label's join key: its user-facing label, trimmed. Case-sensitive,
 *  matching KiCad -- `CLK` and `clk` are different nets. */
function netLabelName(comp: Component): string {
  return (comp.label ?? '').trim();
}

/** Path per component, unique within the circuit.
 *
 *  A component is named for its label where it has one, qualified by its group
 *  so two isolated circuits may each hold a switch called `A`. Where a name is
 *  still taken -- a switch and the LED it drives may legitimately share one,
 *  since they carry the same signal -- the later component falls back to its
 *  id, which is unique by construction. Deterministic: components are walked
 *  in board order.
 *
 *  Exported because the analysis layer has to address the same components by
 *  the same names; two copies of this rule would drift. */
export function componentPaths(circuit: Circuit, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const comp of circuit.components) {
    const scope = groupNameOf(circuit, comp.group);
    const wanted = prefix + scope + (comp.label || comp.id);
    const path = taken.has(wanted) ? prefix + scope + comp.id : wanted;
    taken.add(path);
    out.set(comp.id, path);
  }
  return out;
}

/** `Group.name` plus a separator for a grouped component, empty otherwise --
 *  the prefix a net path gets so two groups' same-named nets stay apart. */
function groupNameOf(circuit: Circuit, group: string | undefined): string {
  if (!group) return '';
  const found = circuit.groups?.find((g) => g.id === group);
  return `${found?.name ?? group}/`;
}

export function compile(top: Board | ChipDef, lib: ChipLibrary): CompiledCircuit {
  const nets = new NetTable();
  const primitives: CompiledPrimitive[] = [];

  expand(top, 'main/', new Map(), []);

  // Canonicalize the union-find into compact net indices.
  const rootToIndex = new Map<number, number>();
  const outNets: CompiledNet[] = [];
  const netIndex = (globalId: number): number => {
    const root = nets.find(globalId);
    let idx = rootToIndex.get(root);
    if (idx === undefined) {
      idx = outNets.length;
      rootToIndex.set(root, idx);
      const net: CompiledNet = { width: nets.widths[root]!, paths: nets.paths[root]! };
      if (nets.pulls[root] !== undefined) net.pull = nets.pulls[root]!;
      outNets.push(net);
    }
    return idx;
  };

  for (const prim of primitives) {
    prim.inputs = prim.inputs.map(netIndex);
    prim.outputs = prim.outputs.map(netIndex);
  }
  // Nets touched by no primitive (e.g. an In port wired straight to an Out)
  // still need canonical indices or their path aliases never resolve.
  for (let g = 0; g < nets.widths.length; g++) netIndex(g);

  const fanout: number[][] = outNets.map(() => []);
  const drivers: { prim: number; out: number }[][] = outNets.map(() => []);
  primitives.forEach((prim, pi) => {
    for (const n of prim.inputs) if (!fanout[n]!.includes(pi)) fanout[n]!.push(pi);
    prim.outputs.forEach((n, out) => drivers[n]!.push({ prim: pi, out }));
  });

  // One driver may fan out to many inputs freely; two or more drivers on one
  // net is only legal for kinds built to share: tristate (kernel resolves an
  // idle driver to Z) and tapdrive (each merges a disjoint bus sub-range, not
  // a competing value). Anything else is an editor slip -- e.g. two outputs
  // wired together -- caught here like the width/pull checks above.
  const SHARED_NET_KINDS = new Set(['tristate', 'tapdrive']);
  drivers.forEach((ds, i) => {
    if (ds.length <= 1) return;
    if (ds.some((d) => !SHARED_NET_KINDS.has(primitives[d.prim]!.kind))) {
      // Name the actual driving pins, not the synthetic net (main/n0 means
      // nothing to the person holding the mouse).
      const names = ds.map((d) => {
        const prim = primitives[d.prim]!;
        const outs = getPrimitive(prim.kind)
          .pins(prim.params)
          .filter((p) => p.dir === 'out');
        return `${prim.path}.${outs[d.out]?.name ?? d.out}`;
      });
      throw new CompileError(
        `pins ${names.join(' and ')} drive the same wire; only tristate outputs may share a net`,
        outNets[i]!.paths[0]!,
      );
    }
  });

  const pathToNet = new Map<string, number>();
  outNets.forEach((net, i) => net.paths.forEach((p) => pathToNet.set(p, i)));
  const pathToPrimitive = new Map<string, number>();
  primitives.forEach((prim, i) => pathToPrimitive.set(prim.path, i));
  const componentToPrimitive = new Map<string, number>();
  primitives.forEach((prim, i) => componentToPrimitive.set(prim.componentId, i));

  return {
    primitives,
    nets: outNets,
    fanout,
    drivers,
    pathToNet,
    pathToPrimitive,
    componentToPrimitive,
  };

  /**
   * Expands one level. boundary maps internal input/output component ids of a
   * ChipDef to the parent-side global net its boundary pin must join.
   */
  function expand(
    circuit: Circuit,
    prefix: string,
    boundary: Map<string, number>,
    defStack: string[],
  ): void {
    const local = new LocalNodes();
    // Tap wires join a bus sub-range to a stub net through a synthesized connector,
    // not a plain union (the two ends differ in width), so they are handled below.
    for (const wire of circuit.wires) {
      if (wire.a.kind === 'tap' || wire.b.kind === 'tap') continue;
      // A free (dangling) end contributes no connection.
      if (wire.a.kind === 'free' || wire.b.kind === 'free') continue;
      local.union(endKey(wire.a), endKey(wire.b));
    }

    // Net labels join same-name nets without wires, KiCad local-label style:
    // the join is scoped to THIS circuit, so a def and its parent board may
    // reuse a name without colliding. Matching is exact after trimming; an
    // unnamed label joins nothing (it is just a stub the user has not named).
    //
    // A group scopes it further, which is the whole point of a group: two
    // unconnected sub-circuits on one board may each name a net `A` and they
    // must not merge. A tunnel is the deliberate way across -- local label vs
    // global label, the same split KiCad draws.
    const labelAnchors = new Map<string, string>();
    for (const comp of circuit.components) {
      if (comp.kind !== 'netlabel') continue;
      const name = netLabelName(comp);
      if (!name) continue;
      const key = pinKey(comp.id, 'a');
      const scoped = JSON.stringify([comp.group ?? '', name]);
      const anchor = labelAnchors.get(scoped);
      if (anchor) local.union(anchor, key);
      else labelAnchors.set(scoped, key);
    }

    // Tunnels join same-name nets without wires.
    const tunnelAnchors = new Map<string, string>();
    for (const comp of circuit.components) {
      if (comp.kind !== 'tunnel') continue;
      const name = String(comp.params?.['name'] ?? '');
      if (!name) throw new CompileError('tunnel without a name', prefix + comp.id);
      const key = pinKey(comp.id, 'p');
      const anchor = tunnelAnchors.get(name);
      if (anchor) local.union(anchor, key);
      else tunnelAnchors.set(name, key);
    }

    // Deterministic local-net numbering: components in array order, pins in
    // declaration order, then junctions. First sight of a root names the net.
    const pinInfos = new Map<string, Map<string, PinInfo>>();
    const rootToGlobal = new Map<number, number>();
    let localCount = 0;
    const globalFor = (key: string, width: number): number => {
      const root = local.find(key);
      let g = rootToGlobal.get(root);
      if (g === undefined) {
        g = nets.create(width, `${prefix}n${localCount++}`);
        rootToGlobal.set(root, g);
      }
      return g;
    };

    for (const comp of circuit.components) {
      const pins = componentPins(comp, lib, prefix + comp.id);
      pinInfos.set(comp.id, pins);
      for (const [pinName, info] of pins) {
        // A passive pin (a net label) declares no width -- it takes the net's.
        // It must not create the net either, or a label visited before the
        // real pin would fix the net at the label's placeholder width.
        if (info.dir === 'passive') continue;
        // Unwired pins still get a (fresh, dangling) net: inputs read Z -> X.
        const g = globalFor(pinKey(comp.id, pinName), info.width);
        const netWidth = nets.widths[nets.find(g)];
        if (netWidth !== info.width)
          throw new CompileError(
            `width mismatch at ${comp.id}.${pinName}: net is ${netWidth}, pin is ${info.width}`,
            prefix + comp.id,
          );
      }
    }

    // Now emit primitives / recurse, all pins resolvable via globalFor.
    const paths = componentPaths(circuit, prefix);
    for (const comp of circuit.components) {
      const path = paths.get(comp.id)!;
      const pins = pinInfos.get(comp.id)!;

      if (comp.kind === 'chip') {
        const def = lib.get(comp.defId!)!;
        if (defStack.includes(def.id))
          throw new CompileError(
            `recursive chip reference: ${[...defStack, def.id].join(' -> ')}`,
            path,
          );
        const childBoundary = new Map<string, number>();
        for (const pinDef of def.pins) {
          const g = globalFor(pinKey(comp.id, pinDef.name), pinDef.width);
          childBoundary.set(pinDef.boundComponent, g);
        }
        expand(def, `${path}:${def.name}/`, childBoundary, [...defStack, def.id]);
        // A chip instance has no primitive of its own, so its boundary pins
        // get no path from the emit loop below; alias each one here (found
        // fresh, since the union inside expand() may have moved its root) so
        // wire coloring and the open-internals overlay can address an
        // instance's own pin, not just the def's internal net names.
        for (const pinDef of def.pins) {
          const g = nets.find(childBoundary.get(pinDef.boundComponent)!);
          nets.paths[g] = [...nets.paths[g]!, `${path}.${pinDef.name}`];
        }
        continue;
      }

      if (comp.kind === 'netlabel') continue; // aliased after the loop; see below

      const boundaryNet = boundary.get(comp.id);
      if (comp.kind === 'inport' || comp.kind === 'outport') {
        // Ports are pure labels: no primitive at any level (a top-level port
        // driver would falsely trip the multi-driver check when two In ports
        // share a net); the net gets a `<path>.<pin>` alias instead.
        const pinName = comp.kind === 'inport' ? 'y' : 'a';
        const g = globalFor(pinKey(comp.id, pinName), pins.get(pinName)!.width);
        if (boundaryNet !== undefined) nets.union(boundaryNet, g, path);
        const r = nets.find(g);
        nets.paths[r] = [...nets.paths[r]!, `${path}.${pinName}`];
        continue;
      }

      if (CONNECTIVITY_KINDS.has(comp.kind)) {
        if (comp.kind === 'pullup' || comp.kind === 'pulldown') {
          const g = globalFor(pinKey(comp.id, 'p'), pins.get('p')!.width);
          nets.setPull(g, comp.kind === 'pullup' ? 1 : 0, path);
        }
        continue; // tunnels already unioned above
      }

      const spec = getPrimitive(comp.kind);
      const params = comp.params ?? {};
      const inputs: number[] = [];
      const outputs: number[] = [];
      for (const pin of spec.pins(params)) {
        const g = globalFor(pinKey(comp.id, pin.name), pin.width);
        (pin.dir === 'in' ? inputs : outputs).push(g);
      }
      const prim: CompiledPrimitive = {
        kind: comp.kind,
        params,
        path,
        componentId: prefix + comp.id,
        inputs,
        outputs,
      };
      const part =
        typeof params['part'] === 'string'
          ? params['part']
          : typeof spec.defaultPart === 'function'
            ? spec.defaultPart(params)
            : spec.defaultPart;
      if (part) prim.part = part;
      primitives.push(prim);

      // Probes give their net a human alias for the waveform view.
      if (comp.kind === 'probe' && comp.label) {
        const g = nets.find(globalFor(pinKey(comp.id, 'a'), pins.get('a')!.width));
        // The probe names its NET, so this stays the label (group-qualified),
        // not the component path -- which may have fallen back to an id where
        // another component already held the name.
        nets.paths[g] = [
          ...nets.paths[g]!,
          `${prefix}${groupNameOf(circuit, comp.group)}${comp.label}`,
        ];
      }
    }

    // Net labels alias their net by NAME, after the loop: a label may sit
    // earlier in the array than the pin that gives its net a width, and it
    // declares no width of its own -- it takes the net's. A net carrying
    // nothing but labels has no width to take, so it falls back to 1.
    for (const comp of circuit.components) {
      if (comp.kind !== 'netlabel') continue;
      const key = pinKey(comp.id, 'a');
      const existing = rootToGlobal.get(local.find(key));
      const g = nets.find(existing ?? globalFor(key, 1));
      const name = netLabelName(comp);
      // A grouped label's path carries its group, so two groups naming a net
      // `A` stay distinguishable in probes, waveform rows and STA paths.
      const scope = groupNameOf(circuit, comp.group);
      if (name) nets.paths[g] = [...nets.paths[g]!, `${prefix}${scope}${name}`];
    }

    // Resolve bus taps once every pin net exists. A tap becomes an internal
    // slice/merge connector so the bus stays one BusValue net (no splitter
    // component, no N materialized nets), keeping the kernel untouched.
    let tapCount = 0;
    for (const wire of circuit.wires) {
      if (wire.a.kind !== 'tap' && wire.b.kind !== 'tap') continue;
      const at = `${prefix}${wire.id}`;
      const tapEnd = (wire.a.kind === 'tap' ? wire.a : wire.b) as Extract<WireEnd, { kind: 'tap' }>;
      const stubEnd = wire.a.kind === 'tap' ? wire.b : wire.a;
      if (stubEnd.kind !== 'pin')
        throw new CompileError('a bus tap must connect to a component pin', at);

      const bus = circuit.wires.find((w) => w.id === tapEnd.wire);
      if (!bus) throw new CompileError(`tap references unknown wire '${tapEnd.wire}'`, at);
      const busPin = [bus.a, bus.b].find((e) => e.kind === 'pin') as
        | Extract<WireEnd, { kind: 'pin' }>
        | undefined;
      if (!busPin) throw new CompileError('a tapped bus wire needs a pin endpoint', at);
      const busInfo = pinInfos.get(busPin.component)?.get(busPin.pin);
      if (!busInfo)
        throw new CompileError(
          `tap bus references unknown pin ${busPin.component}.${busPin.pin}`,
          at,
        );
      const busWidth = busInfo.width;

      const { hi, lo } = tapEnd.range;
      if (!Number.isInteger(hi) || !Number.isInteger(lo) || lo < 0 || hi < lo || hi >= busWidth)
        throw new CompileError(`tap range [${hi}:${lo}] outside bus 0..${busWidth - 1}`, at);
      const width = hi - lo + 1;

      const stubInfo = pinInfos.get(stubEnd.component)?.get(stubEnd.pin);
      if (!stubInfo)
        throw new CompileError(
          `tap references unknown pin ${stubEnd.component}.${stubEnd.pin}`,
          at,
        );
      if (stubInfo.width !== width)
        throw new CompileError(
          `tap range width ${width} does not match pin ${stubEnd.pin} width ${stubInfo.width}`,
          at,
        );

      const busNet = globalFor(pinKey(busPin.component, busPin.pin), busWidth);
      const stubNet = globalFor(pinKey(stubEnd.component, stubEnd.pin), width);
      const params = { busWidth, lo, width };
      const path = `${prefix}tap${tapCount++}`;
      // Pin direction picks the connector: a consumer reads the slice, a driver
      // merges its value into the bus sub-range.
      primitives.push(
        stubInfo.dir === 'in'
          ? {
              kind: 'tapread',
              params,
              path,
              componentId: path,
              inputs: [busNet],
              outputs: [stubNet],
            }
          : {
              kind: 'tapdrive',
              params,
              path,
              componentId: path,
              inputs: [stubNet],
              outputs: [busNet],
            },
      );
    }

    // Wires referencing unknown pins would silently float; fail loudly instead.
    for (const wire of circuit.wires) {
      for (const end of [wire.a, wire.b]) {
        if (end.kind === 'pin' && !pinInfos.get(end.component)?.has(end.pin))
          throw new CompileError(
            `wire '${wire.id}' references unknown pin ${end.component}.${end.pin}`,
            prefix,
          );
      }
    }
  }
}
