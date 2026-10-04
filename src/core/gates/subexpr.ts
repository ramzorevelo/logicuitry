// The expression each gate output computes, as built: an operator over its
// inputs' expressions, never simplified. Read off the compiled netlist, since
// compile already resolves junctions, net labels, tunnels and groups.

import type { Expr } from '../boolean/expr';
import { resolveInputNet, resolveOutputNet } from '../boolean/truthTable';
import { compile, componentPaths } from '../model/compile';
import type { Board, ChipLibrary, Component } from '../model/types';
import { intParam } from '../sim/primitives/types';
import { lowerCircuit } from './lower';
import { INPUT_TERMINAL_KINDS, OUTPUT_TERMINAL_KINDS, terminalRefs } from './verify';

/** Packages made of nothing but gates: annotated through to their DIP pins. */
export const GATE_PACKAGE_IDS: ReadonlySet<string> = new Set([
  '74LS00',
  '74LS02',
  '74LS04',
  '74LS08',
  '74LS32',
  '74LS86',
]);

const not = (a: Expr): Expr => ({ kind: 'not', a });

const GATE_OPS: Readonly<Record<string, (args: Expr[]) => Expr>> = {
  and: (args) => ({ kind: 'and', args }),
  or: (args) => ({ kind: 'or', args }),
  xor: (args) => ({ kind: 'xor', args }),
  nand: (args) => not({ kind: 'and', args }),
  nor: (args) => not({ kind: 'or', args }),
  xnor: (args) => not({ kind: 'xor', args }),
  not: (args) => not(args[0]!),
  buf: (args) => args[0]!,
};

export interface SubExpressions {
  /** `<componentId>.<pin>` -> expression, for each board-level gate output and
   *  each output pin of a gate package. */
  pins: Map<string, Expr>;
  /** Output terminal column, as `analysisTablesOf` names it -> expression. */
  outputs: Map<string, Expr>;
}

const displayName = (c: Component): string => c.label || c.id;

/** A DIP pin by its number (`U3.13`), which is how the lab sheet names it. */
const pinNumber = (pin: { id: string; name: string }): string =>
  /^pin-(\d+)$/.exec(pin.id)?.[1] ?? pin.name;

export function gateExpressions(board: Board, lib: ChipLibrary): SubExpressions {
  const loweredLib: ChipLibrary = new Map([...lib].map(([id, def]) => [id, lowerCircuit(def)]));
  const compiled = compile(lowerCircuit(board), loweredLib);
  const paths = componentPaths(board, 'main/');
  const width = (net: number): number => compiled.nets[net]!.width;

  const named = new Map<number, string>();
  for (const c of board.components) {
    if (!INPUT_TERMINAL_KINDS.has(c.kind)) continue;
    const path = paths.get(c.id)!;
    const net = netOr(() => resolveInputNet(compiled, c.kind === 'inport' ? `${path}.y` : path));
    if (net !== undefined && width(net) === 1 && !named.has(net)) named.set(net, displayName(c));
  }

  // SPEC: a chip that is not a gate package is opaque; its output enters
  // downstream expressions as a variable named for the instance and pin.
  const chips: { comp: Component; prefix: string; transparent: boolean }[] = [];
  for (const c of board.components) {
    if (c.kind !== 'chip' || !c.defId) continue;
    const def = lib.get(c.defId);
    if (!def) continue;
    const path = paths.get(c.id)!;
    const transparent = GATE_PACKAGE_IDS.has(def.id);
    chips.push({ comp: c, prefix: `${path}:`, transparent });
    if (transparent) continue;
    for (const pin of def.pins) {
      if (pin.dir !== 'out') continue;
      const net = compiled.pathToNet.get(`${path}.${pin.name}`);
      if (net !== undefined && width(net) === 1 && !named.has(net))
        named.set(net, `${displayName(c)}.${pinNumber(pin)}`);
    }
  }
  const ownerOf = (componentId: string) => chips.find((ch) => componentId.startsWith(ch.prefix));

  const memo = new Map<number, Expr | null>();
  const open = new Set<number>();
  // SPEC: only gates, constants and named terminals carry an expression. A
  // sequential element, an MSI primitive or a combinational loop leaves its
  // net unlabelled, and every gate reading it too, rather than guess.
  const exprOf = (net: number): Expr | null => {
    const known = memo.get(net);
    if (known !== undefined) return known;
    if (open.has(net)) return null;
    open.add(net);
    const e = compute(net);
    open.delete(net);
    memo.set(net, e);
    return e;
  };
  const compute = (net: number): Expr | null => {
    if (width(net) !== 1) return null;
    const name = named.get(net);
    if (name !== undefined) return { kind: 'var', name };
    const ds = compiled.drivers[net]!;
    if (ds.length !== 1) return null;
    const prim = compiled.primitives[ds[0]!.prim]!;
    const owner = ownerOf(prim.componentId);
    if (owner && !owner.transparent) return null;
    // A package gates every output on its supply pins; that is power, not
    // logic, so the output reads as the gate behind it.
    if (owner && prim.kind === 'tristate') return exprOf(prim.inputs[0]!);
    if (prim.kind === 'vcc') return { kind: 'const', value: 1 };
    if (prim.kind === 'gnd') return { kind: 'const', value: 0 };
    if (prim.kind === 'constant')
      return { kind: 'const', value: (intParam(prim.params, 'value', 0) & 1) as 0 | 1 };
    const op = GATE_OPS[prim.kind];
    if (!op) return null;
    const args: Expr[] = [];
    for (const input of prim.inputs) {
      const a = exprOf(input);
      if (!a) return null;
      args.push(a);
    }
    return op(args);
  };

  const pins = new Map<string, Expr>();
  for (const c of board.components) {
    const at = compiled.componentToPrimitive.get(`main/${c.id}`);
    if (at === undefined) continue;
    const prim = compiled.primitives[at]!;
    if (!GATE_OPS[prim.kind] || prim.outputs.length !== 1) continue;
    const e = exprOf(prim.outputs[0]!);
    if (e) pins.set(`${c.id}.y`, e);
  }
  for (const ch of chips) {
    if (!ch.transparent) continue;
    const path = paths.get(ch.comp.id)!;
    for (const pin of lib.get(ch.comp.defId!)!.pins) {
      if (pin.dir !== 'out') continue;
      const net = compiled.pathToNet.get(`${path}.${pin.name}`);
      const e = net === undefined ? null : exprOf(net);
      if (e) pins.set(`${ch.comp.id}.${pin.name}`, e);
    }
  }

  const outputs = new Map<string, Expr>();
  for (const ref of terminalRefs(board, OUTPUT_TERMINAL_KINDS)) {
    const net = netOr(() => resolveOutputNet(compiled, ref.path));
    const e = net === undefined ? null : exprOf(net);
    if (e) outputs.set(ref.path, e);
  }
  return { pins, outputs };
}

function netOr(resolve: () => number): number | undefined {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}

/** True when some gate output on the board has an expression to show. */
export function hasSubExpressions(board: Board, lib: ChipLibrary): boolean {
  try {
    return gateExpressions(board, lib).pins.size > 0;
  } catch {
    return false;
  }
}
