// Exhaustive truth-table evaluation over a flattened CompiledCircuit, keyed
// by input/output *paths* (not net indices) so two structurally different
// compiles of "the same circuit" -- e.g. before/after a legal bubble-push --
// can still be compared row-for-row.

import type { CompiledCircuit } from '../model/compile';
import * as bv from '../value/busValue';
import type { BusValue } from '../value/busValue';
import { evaluateNets } from './evaluate';

/** Inputs ≤8 -> ≤256 rows, exhaustive and instant. */
export const MAX_TABLE_INPUTS = 8;

/** Terminal column address: a bare `path` (must resolve to a 1-bit net) or
 *  `path[i]` selecting bit i of a width-w terminal (M6.6 multi-bit Analyze). */
export function parseBitPath(p: string): { base: string; bit?: number } {
  const m = /^(.*)\[(\d+)\]$/.exec(p);
  return m ? { base: m[1]!, bit: Number(m[2]) } : { base: p };
}

export interface TruthTable {
  inputPaths: readonly string[];
  outputPaths: readonly string[];
  /** One entry per row (2^inputPaths.length), row index = input bits MSB-first over inputPaths. */
  rows: readonly (readonly BusValue[])[];
}

/** Net behind a terminal path: a source primitive's sole output, or -- for a
 *  pure-label terminal (top-level ports compile to no primitive) -- the
 *  net carrying that path as an alias (`main/<id>.y` etc.). */
export function resolveInputNet(circuit: CompiledCircuit, path: string): number {
  const i = circuit.pathToPrimitive.get(path);
  if (i !== undefined) {
    const net = circuit.primitives[i]!.outputs[0];
    if (net === undefined) throw new RangeError(`primitive at '${path}' has no output net`);
    return net;
  }
  const net = circuit.pathToNet.get(path);
  if (net === undefined) throw new RangeError(`no primitive or net at path '${path}'`);
  return net;
}

/** Net read by the sink primitive at `path` (its sole 'a' input), or the
 *  aliased net itself for a pure-label terminal path. */
export function resolveOutputNet(circuit: CompiledCircuit, path: string): number {
  const i = circuit.pathToPrimitive.get(path);
  if (i !== undefined) {
    const net = circuit.primitives[i]!.inputs[0];
    if (net === undefined) throw new RangeError(`primitive at '${path}' has no input net`);
    return net;
  }
  const net = circuit.pathToNet.get(path);
  if (net === undefined) throw new RangeError(`no primitive or net at path '${path}'`);
  return net;
}

/**
 * Builds the full truth table for `outputPaths` as a function of `inputPaths`,
 * one row per assignment of 1-bit values to the inputs, MSB-first (row 0 =
 * all inputs 0, row 2^n-1 = all inputs 1).
 */
export function buildTruthTable(
  circuit: CompiledCircuit,
  inputPaths: readonly string[],
  outputPaths: readonly string[],
): TruthTable {
  if (inputPaths.length === 0) throw new RangeError('truth table needs at least one input');
  if (inputPaths.length > MAX_TABLE_INPUTS)
    throw new RangeError(`truth table inputs ${inputPaths.length} exceeds max ${MAX_TABLE_INPUTS}`);

  // A bare path must be 1-bit (a width-N net silently reading bit 0 is a
  // wrong answer with no error); `path[i]` addresses bit i of a wide terminal.
  const resolveCol = (p: string, resolve: typeof resolveInputNet, dir: string) => {
    const { base, bit } = parseBitPath(p);
    const net = resolve(circuit, base);
    const w = circuit.nets[net]!.width;
    if (bit === undefined) {
      if (w !== 1) throw new RangeError(`truth table ${dir} '${p}' is ${w}-bit, not 1-bit`);
      return { net, bit: 0 };
    }
    if (bit >= w) throw new RangeError(`truth table ${dir} '${p}' addresses bit ${bit} of ${w}`);
    return { net, bit };
  };
  const inputCols = inputPaths.map((p) => resolveCol(p, resolveInputNet, 'input'));
  const outputCols = outputPaths.map((p) => resolveCol(p, resolveOutputNet, 'output'));
  // Seed exactly the primitives behind inputPaths (not just kind 'input'):
  // a toggle/button used as a table input must be driven by the row bits,
  // never evaluated from its own initial state. Pure-label terminals have no
  // primitive to skip; their net is driven directly below.
  const seeded = new Set(
    inputPaths
      .map((p) => circuit.pathToPrimitive.get(parseBitPath(p).base))
      .filter((i): i is number => i !== undefined),
  );
  const rowCount = 2 ** inputPaths.length;
  const rows: BusValue[][] = [];

  for (let r = 0; r < rowCount; r++) {
    // Bit columns sharing one wide net accumulate into a single driven value;
    // bits of a seeded net not addressed by any column are held at 0.
    const acc = new Map<number, number>();
    inputCols.forEach((c, i) => {
      const bit = (r >> (inputPaths.length - 1 - i)) & 1;
      acc.set(c.net, (acc.get(c.net) ?? 0) | (bit << c.bit));
    });
    const driven = new Map<number, BusValue>();
    for (const [net, v] of acc) driven.set(net, bv.known(v, circuit.nets[net]!.width));
    const resolved = evaluateNets(circuit, driven, seeded);
    rows.push(
      outputCols.map((c) => {
        const v = resolved.get(c.net) ?? bv.allZ(circuit.nets[c.net]!.width);
        return circuit.nets[c.net]!.width === 1 ? v : bv.slice(v, c.bit, 1);
      }),
    );
  }

  return { inputPaths, outputPaths, rows };
}

/**
 * Same function, inputs reordered: `order[i]` = original input index shown at
 * position i (a permutation). Row indices are re-derived so each new row's
 * MSB-first bits address the same input assignment (Analyze column reorder).
 */
export function permuteTableInputs(table: TruthTable, order: readonly number[]): TruthTable {
  const n = table.inputPaths.length;
  const sorted = [...order].sort((a, b) => a - b);
  if (sorted.length !== n || sorted.some((v, i) => v !== i))
    throw new RangeError('order must permute the inputs');
  const inputPaths = order.map((i) => table.inputPaths[i]!);
  const rows = table.rows.map((_, rNew) => {
    let rOld = 0;
    for (let i = 0; i < n; i++) if ((rNew >> (n - 1 - i)) & 1) rOld |= 1 << (n - 1 - order[i]!);
    return table.rows[rOld]!;
  });
  return { inputPaths, outputPaths: table.outputPaths, rows };
}

/** True if every row's outputs match exactly (same shape assumed). */
export function tablesEqual(a: TruthTable, b: TruthTable): boolean {
  return diffRows(a, b).length === 0;
}

/**
 * Row indices where `a` and `b` disagree. Tables must share row and output
 * count; a structural mismatch (different arity) is reported as every row
 * differing.
 */
export function diffRows(a: TruthTable, b: TruthTable): number[] {
  if (a.rows.length !== b.rows.length || a.outputPaths.length !== b.outputPaths.length)
    return a.rows.map((_, i) => i);
  const diffs: number[] = [];
  for (let r = 0; r < a.rows.length; r++) {
    const ra = a.rows[r]!;
    const rb = b.rows[r]!;
    if (ra.some((v, c) => !bv.equal(v, rb[c]!))) diffs.push(r);
  }
  return diffs;
}
