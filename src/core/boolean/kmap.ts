// Karnaugh-map model over an existing TruthTable (Harris & Harris §2.7):
// Gray-ordered grid, subcube validation for interactively circled groups,
// implicant read-off, and a deterministic minimal-cover search for the
// teacher-gated reveal. Pure data, no DOM -- drawing lives in render/kmap.ts.

import type { TruthTable } from './truthTable';
import { isFullyKnown, type BusValue } from '../value/busValue';

export const MIN_KMAP_INPUTS = 2;
export const MAX_KMAP_INPUTS = 4;

export interface KmapCell {
  /** Truth-table row index (input bits MSB-first over inputPaths). */
  minterm: number;
  /** 1/0 for a known output bit; 'x' for an instructor-marked don't-care; null for circuit X/Z. */
  value: 0 | 1 | 'x' | null;
}

export interface KmapGrid {
  /** Column variables: the first ceil(n/2) inputs in table order (MSB side). */
  colVars: readonly string[];
  /** Row variables: the remaining inputs. */
  rowVars: readonly string[];
  /** Gray-sequence axis codes (00,01,11,10 for 2 bits; 0,1 for one). */
  colCodes: readonly number[];
  rowCodes: readonly number[];
  /** cells[row][col] in axis-code order. */
  cells: readonly (readonly KmapCell[])[];
  inputCount: number;
}

const GRAY_1 = [0, 1] as const;
const GRAY_2 = [0, 1, 3, 2] as const;

function gray(bits: number): readonly number[] {
  return bits === 1 ? GRAY_1 : GRAY_2;
}

function bitValue(v: BusValue): 0 | 1 | null {
  if (!isFullyKnown(v, 1)) return null;
  return (v.v & 1) === 1 ? 1 : 0;
}

/** Axis assignment: disjoint index lists into `table.inputPaths`, covering all
 *  n inputs. Omitted -> default split (first ceil(n/2) inputs on columns). */
export interface KmapAxisLayout {
  cols: readonly number[];
  rows: readonly number[];
}

/** Grid for one output column of the table. 2..4 inputs only. */
export function buildKmap(
  table: TruthTable,
  outputIndex: number,
  layout?: KmapAxisLayout,
  dontCares?: ReadonlySet<number>,
): KmapGrid {
  const n = table.inputPaths.length;
  if (n < MIN_KMAP_INPUTS || n > MAX_KMAP_INPUTS)
    throw new RangeError(`K-map supports ${MIN_KMAP_INPUTS}..${MAX_KMAP_INPUTS} inputs, got ${n}`);
  if (outputIndex < 0 || outputIndex >= table.outputPaths.length)
    throw new RangeError(`output index ${outputIndex} out of range`);
  const colBits = Math.ceil(n / 2);
  const cols = layout?.cols ?? Array.from({ length: colBits }, (_, i) => i);
  const rows = layout?.rows ?? Array.from({ length: n - colBits }, (_, i) => colBits + i);
  const all = [...cols, ...rows].sort((a, b) => a - b);
  if (all.length !== n || all.some((v, i) => v !== i))
    throw new RangeError('layout must partition the inputs');
  if (cols.length < 1 || cols.length > 2 || rows.length < 1 || rows.length > 2)
    throw new RangeError('axis lengths must be 1..2');
  const colCodes = gray(cols.length);
  const rowCodes = gray(rows.length);
  // Minterm index = table row: each axis-code bit lands at its input's own
  // MSB-first weight, so any layout addresses the same table rows.
  const weight = (inputIdx: number) => 1 << (n - 1 - inputIdx);
  const minterm = (cc: number, rc: number): number => {
    let m = 0;
    cols.forEach((inputIdx, i) => {
      if ((cc >> (cols.length - 1 - i)) & 1) m |= weight(inputIdx);
    });
    rows.forEach((inputIdx, i) => {
      if ((rc >> (rows.length - 1 - i)) & 1) m |= weight(inputIdx);
    });
    return m;
  };
  const cells: KmapCell[][] = rowCodes.map((rc) =>
    colCodes.map((cc) => {
      const m = minterm(cc, rc);
      const value: KmapCell['value'] = dontCares?.has(m)
        ? 'x'
        : bitValue(table.rows[m]![outputIndex]!);
      return { minterm: m, value };
    }),
  );
  return {
    colVars: cols.map((i) => table.inputPaths[i]!),
    rowVars: rows.map((i) => table.inputPaths[i]!),
    colCodes,
    rowCodes,
    cells,
    inputCount: n,
  };
}

function analyzeSubcube(
  inputCount: number,
  minterms: readonly number[],
): { const1: number; const0: number; free: number } | null {
  const set = [...new Set(minterms)];
  const mask = (1 << inputCount) - 1;
  if (set.length === 0 || set.some((m) => m < 0 || m > mask)) return null;
  let and = mask;
  let or = 0;
  for (const m of set) {
    and &= m;
    or |= m;
  }
  const const1 = and;
  const const0 = mask & ~or;
  const free = mask & ~(const1 | const0);
  let freeCount = 0;
  for (let b = free; b; b >>= 1) freeCount += b & 1;
  // Distinct members agreeing on every fixed bit fill the 2^k subcube exactly
  // iff there are 2^k of them -- wraparound falls out of working on minterm
  // bits directly, no grid geometry involved.
  if (set.length !== 1 << freeCount) return null;
  return { const1, const0, free };
}

/** True iff `minterms` is a legal circling: a subcube whose cells are all
 *  1-or-don't-care, containing at least one real 1 (a pure-DC circle is
 *  pointless -- H&H p.80 Ex 2.11). */
export function isLegalGroup(
  table: TruthTable,
  outputIndex: number,
  minterms: readonly number[],
  dontCares?: ReadonlySet<number>,
): boolean {
  const cube = analyzeSubcube(table.inputPaths.length, minterms);
  if (!cube) return false;
  let sawReal1 = false;
  for (const m of minterms) {
    if (dontCares?.has(m)) continue;
    if (bitValue(table.rows[m]![outputIndex]!) !== 1) return false;
    sawReal1 = true;
  }
  // SPEC: a pure-DC subcube (no real 1) is rejected as illegal, same as any
  // other illegal group -- a circle over don't-cares alone claims nothing.
  return sawReal1;
}

export interface ImplicantLiteral {
  /** Input path (caller maps to a display name). */
  var: string;
  negated: boolean;
}

/** Product term read-off: the fixed variables, complemented where fixed at 0,
 *  in input order (MSB first). Empty list = the constant-1 whole-map group. */
export function implicantTerm(table: TruthTable, minterms: readonly number[]): ImplicantLiteral[] {
  const n = table.inputPaths.length;
  const cube = analyzeSubcube(n, minterms);
  if (!cube) throw new RangeError('not a subcube');
  const out: ImplicantLiteral[] = [];
  for (let i = 0; i < n; i++) {
    const bit = 1 << (n - 1 - i);
    if (cube.const1 & bit) out.push({ var: table.inputPaths[i]!, negated: false });
    else if (cube.const0 & bit) out.push({ var: table.inputPaths[i]!, negated: true });
  }
  return out;
}

function litCount(inputCount: number, cube: { free: number }): number {
  let freeCount = 0;
  for (let b = cube.free; b; b >>= 1) freeCount += b & 1;
  return inputCount - freeCount;
}

/** All subcubes whose cells are all 1-or-don't-care, as sorted minterm lists. */
function allCoverSubcubes(
  table: TruthTable,
  outputIndex: number,
  n: number,
  dontCares?: ReadonlySet<number>,
): number[][] {
  const cover = new Set<number>();
  for (let m = 0; m < 1 << n; m++) {
    if (dontCares?.has(m) || bitValue(table.rows[m]![outputIndex]!) === 1) cover.add(m);
  }
  const cubes: number[][] = [];
  const mask = (1 << n) - 1;
  // Enumerate every free-bit mask x fixed-value assignment (3^n total).
  for (let free = 0; free <= mask; free++) {
    const fixedBits = mask & ~free;
    for (let fixed = 0; ; fixed = ((fixed | ~fixedBits) + 1) & fixedBits) {
      const members: number[] = [];
      let allCovered = true;
      // Enumerate the subcube's members by spreading over the free bits.
      for (let sub = 0; ; sub = ((sub | ~free) + 1) & free) {
        const m = fixed | sub;
        if (!cover.has(m)) {
          allCovered = false;
          break;
        }
        members.push(m);
        if (sub === free) break;
      }
      if (allCovered && members.length > 0) cubes.push(members.sort((a, b) => a - b));
      if (fixed === fixedBits) break;
    }
  }
  return cubes;
}

function isSubset(a: readonly number[], b: readonly number[]): boolean {
  const bs = new Set(b);
  return a.every((m) => bs.has(m));
}

function compareLists(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * Deterministic exact minimum SOP cover (reveal only): fewest implicants,
 * tie-broken by fewest literals then lexicographically by covered-minterm
 * lists, so a given table always reveals the same cover even though the book
 * allows a non-unique minimum. Returns [] for a constant-0 output.
 */
export function minimalCover(
  table: TruthTable,
  outputIndex: number,
  dontCares?: ReadonlySet<number>,
): number[][] {
  const n = table.inputPaths.length;
  if (n < MIN_KMAP_INPUTS || n > MAX_KMAP_INPUTS)
    throw new RangeError(`K-map supports ${MIN_KMAP_INPUTS}..${MAX_KMAP_INPUTS} inputs, got ${n}`);
  const isReal1 = (m: number) => bitValue(table.rows[m]![outputIndex]!) === 1;
  const cubes = allCoverSubcubes(table, outputIndex, n, dontCares);
  if (cubes.length === 0) return [];
  // Prime implicants: cubes not strictly contained in a larger cover cube,
  // dropping any prime that covers no real 1 (a pure-DC prime is never a
  // useful cover target -- H&H p.80 Ex 2.11).
  const primes = cubes
    .filter((c) => !cubes.some((d) => d.length > c.length && isSubset(c, d)))
    .filter((c) => c.some((m) => isReal1(m)))
    .sort(compareLists);
  const need = new Set<number>();
  for (let m = 0; m < 1 << n; m++) if (isReal1(m)) need.add(m);
  const targets = [...need].sort((a, b) => a - b);

  let best: number[][] | null = null;
  let bestLits = Infinity;
  const literals = (cover: number[][]): number =>
    cover.reduce((sum, g) => sum + litCount(n, analyzeSubcube(n, g)!), 0);
  const covers = (cover: number[][]): boolean => {
    const got = new Set<number>();
    for (const g of cover) for (const m of g) got.add(m);
    return targets.every((m) => got.has(m));
  };
  // Iterative deepening over cover size; n<=4 keeps this tiny.
  const search = (size: number, start: number, acc: number[][]): void => {
    if (acc.length === size) {
      if (!covers(acc)) return;
      const lits = literals(acc);
      const cand = acc.map((g) => g.slice()).sort(compareLists);
      if (!best || lits < bestLits || (lits === bestLits && compareCovers(cand, best) < 0)) {
        best = cand;
        bestLits = lits;
      }
      return;
    }
    for (let i = start; i < primes.length; i++) search(size, i + 1, [...acc, primes[i]!]);
  };
  for (let size = 1; size <= primes.length && !best; size++) search(size, 0, []);
  return best ?? [];
}

function compareCovers(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareLists(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}
