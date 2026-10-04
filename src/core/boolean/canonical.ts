// Canonical forms of a one-output truth table (Harris & Harris Ch 4 §4.3):
// one minterm per 1-row, one maxterm per 0-row.

import type { Expr } from './expr';
import type { TruthTable } from './truthTable';
import { isFullyKnown } from '../value/busValue';

export interface CanonicalRow {
  index: number;
  minterm: Expr;
  maxterm: Expr;
  /** 'x' for a don't-care; null for a circuit X/Z. */
  value: 0 | 1 | 'x' | null;
}

export interface FunctionIndices {
  ones: number[];
  zeros: number[];
  dontCares: number[];
}

const variable = (name: string): Expr => ({ kind: 'var', name });
const complement = (name: string): Expr => ({ kind: 'not', a: variable(name) });

function rowBit(table: TruthTable, row: number, output: number): 0 | 1 | null {
  const v = table.rows[row]![output]!;
  if (!isFullyKnown(v, 1)) return null;
  return (v.v & 1) === 1 ? 1 : 0;
}

function valueAt(
  table: TruthTable,
  row: number,
  output: number,
  dc?: ReadonlySet<number>,
): CanonicalRow['value'] {
  return dc?.has(row) ? 'x' : rowBit(table, row, output);
}

/** Bit of `row` for input `i`, MSB-first over `inputPaths`. */
const inputBit = (row: number, n: number, i: number): number => (row >> (n - 1 - i)) & 1;

/** The maxterm complements a variable where the row holds 1, the reversal §4.3 warns about. */
export function canonicalRows(
  table: TruthTable,
  dc?: ReadonlySet<number>,
  output = 0,
): CanonicalRow[] {
  const names = table.inputPaths;
  const n = names.length;
  return table.rows.map((_, index) => {
    const minterm: Expr[] = [];
    const maxterm: Expr[] = [];
    names.forEach((name, i) => {
      const one = inputBit(index, n, i) === 1;
      minterm.push(one ? variable(name) : complement(name));
      maxterm.push(one ? complement(name) : variable(name));
    });
    return {
      index,
      minterm: n === 1 ? minterm[0]! : { kind: 'and', args: minterm },
      maxterm: n === 1 ? maxterm[0]! : { kind: 'or', args: maxterm },
      value: valueAt(table, index, output, dc),
    };
  });
}

/** Sum of the minterms of every 1-row (don't-cares left out); constant 0 when there is none. */
export function canonicalSop(table: TruthTable, dc?: ReadonlySet<number>, output = 0): Expr {
  const terms = canonicalRows(table, dc, output)
    .filter((r) => r.value === 1)
    .map((r) => r.minterm);
  if (terms.length === 0) return { kind: 'const', value: 0 };
  return terms.length === 1 ? terms[0]! : { kind: 'or', args: terms };
}

/** Product of the maxterms of every 0-row (don't-cares left out); constant 1 when there is none. */
export function canonicalPos(table: TruthTable, dc?: ReadonlySet<number>, output = 0): Expr {
  const terms = canonicalRows(table, dc, output)
    .filter((r) => r.value === 0)
    .map((r) => r.maxterm);
  if (terms.length === 0) return { kind: 'const', value: 1 };
  return terms.length === 1 ? terms[0]! : { kind: 'and', args: terms };
}

/** Index lists for printing `Σm(...) + Σd(...)` and `ΠM(...) · ΠD(...)`. */
export function sigmaOf(table: TruthTable, dc?: ReadonlySet<number>, output = 0): FunctionIndices {
  const out: FunctionIndices = { ones: [], zeros: [], dontCares: [] };
  canonicalRows(table, dc, output).forEach((r) => {
    if (r.value === 'x') out.dontCares.push(r.index);
    else if (r.value === 1) out.ones.push(r.index);
    else if (r.value === 0) out.zeros.push(r.index);
  });
  return out;
}

/** Same lists as `sigmaOf`; named apart so the product call site reads as one. */
export const piOf = sigmaOf;
