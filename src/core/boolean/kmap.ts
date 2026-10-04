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

/** Which output value a circle groups: 1s (SOP) or 0s (POS). */
export type KmapPolarity = 'ones' | 'zeros';

const targetBit = (polarity: KmapPolarity): 0 | 1 => (polarity === 'ones' ? 1 : 0);

export type GroupDiagnosis = 'ok' | 'rule2' | 'rule3' | 'dc-only';

/** Why a circle is refused: a wrong-valued cell (rule 2, checked first), not a
 *  power-of-two subcube (rule 3), or nothing but don't-cares. */
export function diagnoseGroup(
  table: TruthTable,
  outputIndex: number,
  minterms: readonly number[],
  dontCares?: ReadonlySet<number>,
  polarity: KmapPolarity = 'ones',
): GroupDiagnosis {
  const want = targetBit(polarity);
  let sawReal = false;
  for (const m of minterms) {
    if (dontCares?.has(m)) continue;
    if (bitValue(table.rows[m]![outputIndex]!) !== want) return 'rule2';
    sawReal = true;
  }
  if (!analyzeSubcube(table.inputPaths.length, minterms)) return 'rule3';
  // SPEC: a pure-DC subcube (no real target) is rejected as illegal, same as any
  // other illegal group -- a circle over don't-cares alone claims nothing.
  return sawReal ? 'ok' : 'dc-only';
}

/** True iff `minterms` is a legal circling: a subcube whose cells are all
 *  target-or-don't-care, containing at least one real target (a pure-DC circle
 *  is pointless -- H&H p.80 Ex 2.11). */
export function isLegalGroup(
  table: TruthTable,
  outputIndex: number,
  minterms: readonly number[],
  dontCares?: ReadonlySet<number>,
  polarity: KmapPolarity = 'ones',
): boolean {
  return diagnoseGroup(table, outputIndex, minterms, dontCares, polarity) === 'ok';
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

/** Term read-off for either polarity. 'ones': product, complemented where fixed
 *  at 0. 'zeros': sum, complemented where fixed at 1. */
export function groupTerm(
  table: TruthTable,
  minterms: readonly number[],
  polarity: KmapPolarity = 'ones',
): ImplicantLiteral[] {
  if (polarity === 'ones') return implicantTerm(table, minterms);
  const n = table.inputPaths.length;
  const cube = analyzeSubcube(n, minterms);
  if (!cube) throw new RangeError('not a subcube');
  const out: ImplicantLiteral[] = [];
  for (let i = 0; i < n; i++) {
    const bit = 1 << (n - 1 - i);
    if (cube.const1 & bit) out.push({ var: table.inputPaths[i]!, negated: true });
    else if (cube.const0 & bit) out.push({ var: table.inputPaths[i]!, negated: false });
  }
  return out;
}

function litCount(inputCount: number, cube: { free: number }): number {
  let freeCount = 0;
  for (let b = cube.free; b; b >>= 1) freeCount += b & 1;
  return inputCount - freeCount;
}

/** All subcubes whose cells are all target-or-don't-care, as sorted minterm lists. */
function allCoverSubcubes(
  table: TruthTable,
  outputIndex: number,
  n: number,
  dontCares: ReadonlySet<number> | undefined,
  polarity: KmapPolarity,
): number[][] {
  const want = targetBit(polarity);
  const cover = new Set<number>();
  for (let m = 0; m < 1 << n; m++) {
    if (dontCares?.has(m) || bitValue(table.rows[m]![outputIndex]!) === want) cover.add(m);
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

function checkedInputCount(table: TruthTable): number {
  const n = table.inputPaths.length;
  if (n < MIN_KMAP_INPUTS || n > MAX_KMAP_INPUTS)
    throw new RangeError(`K-map supports ${MIN_KMAP_INPUTS}..${MAX_KMAP_INPUTS} inputs, got ${n}`);
  return n;
}

interface CoverContext {
  n: number;
  primes: number[][];
  targets: number[];
  cubes: number[][];
}

function coverContext(
  table: TruthTable,
  outputIndex: number,
  dontCares: ReadonlySet<number> | undefined,
  polarity: KmapPolarity,
): CoverContext {
  const n = checkedInputCount(table);
  const want = targetBit(polarity);
  const isReal = (m: number) =>
    !dontCares?.has(m) && bitValue(table.rows[m]![outputIndex]!) === want;
  const cubes = allCoverSubcubes(table, outputIndex, n, dontCares, polarity);
  // Primes: cubes not strictly inside a larger cover cube, dropping any that
  // covers no real target (a pure-DC prime is never a useful cover target --
  // H&H p.80 Ex 2.11).
  const primes = cubes
    .filter((c) => !cubes.some((d) => d.length > c.length && isSubset(c, d)))
    .filter((c) => c.some(isReal))
    .sort(compareLists);
  const targets: number[] = [];
  for (let m = 0; m < 1 << n; m++) if (isReal(m)) targets.push(m);
  return { n, primes, targets, cubes };
}

/** Every prime group (implicant, or implicate for 'zeros') covering a real target. */
export function primeImplicants(
  table: TruthTable,
  outputIndex: number,
  dontCares?: ReadonlySet<number>,
  polarity: KmapPolarity = 'ones',
): number[][] {
  return coverContext(table, outputIndex, dontCares, polarity).primes;
}

/** Primes that are the only cover of some real target. */
export function essentialPrimes(
  table: TruthTable,
  outputIndex: number,
  dontCares?: ReadonlySet<number>,
  polarity: KmapPolarity = 'ones',
): number[][] {
  const { primes, targets } = coverContext(table, outputIndex, dontCares, polarity);
  return primes.filter((p) =>
    p.some((m) => targets.includes(m) && primes.filter((q) => q.includes(m)).length === 1),
  );
}

const literalTotal = (n: number, cover: readonly (readonly number[])[]): number =>
  cover.reduce((sum, g) => sum + litCount(n, analyzeSubcube(n, g)!), 0);

/**
 * Deterministic exact minimum covers (reveal only): fewest groups, then fewest
 * literals, sorted lexicographically by covered-minterm lists so a given table
 * always reveals the same first cover even though the book allows several
 * minima. Returns [] when there is no real target cell.
 */
export function minimumCovers(
  table: TruthTable,
  outputIndex: number,
  dontCares?: ReadonlySet<number>,
  polarity: KmapPolarity = 'ones',
  limit = 16,
): number[][][] {
  const { n, primes, targets } = coverContext(table, outputIndex, dontCares, polarity);
  if (targets.length === 0) return [];
  const covers = (cover: number[][]): boolean => {
    const got = new Set<number>();
    for (const g of cover) for (const m of g) got.add(m);
    return targets.every((m) => got.has(m));
  };
  let found: number[][][] = [];
  let bestLits = Infinity;
  // Iterative deepening over cover size; n<=4 keeps this tiny.
  const search = (size: number, start: number, acc: number[][]): void => {
    if (acc.length === size) {
      if (!covers(acc)) return;
      const lits = literalTotal(n, acc);
      if (lits > bestLits) return;
      if (lits < bestLits) found = [];
      bestLits = lits;
      found.push(acc.map((g) => g.slice()).sort(compareLists));
      return;
    }
    for (let i = start; i < primes.length; i++) search(size, i + 1, [...acc, primes[i]!]);
  };
  for (let size = 1; size <= primes.length && found.length === 0; size++) search(size, 0, []);
  return found.sort(compareCovers).slice(0, limit);
}

/** The single deterministic minimum SOP cover the reveal shows. */
export function minimalCover(
  table: TruthTable,
  outputIndex: number,
  dontCares?: ReadonlySet<number>,
): number[][] {
  return minimumCovers(table, outputIndex, dontCares)[0] ?? [];
}

export interface CircleCheck {
  /** Rule 4: a larger legal group contains this circle. */
  notPrime: boolean;
  /** Rule 1: every real target in this circle is covered by the other circles. */
  redundant: boolean;
}

export interface GroupCheck {
  circles: CircleCheck[];
  coversAll: boolean;
  /** Same group count and literal count as the minimum cover. */
  isMinimum: boolean;
}

/** Explicit Check action over legal circles; never run live. */
export function checkGroups(
  table: TruthTable,
  outputIndex: number,
  circles: readonly (readonly number[])[],
  dontCares?: ReadonlySet<number>,
  polarity: KmapPolarity = 'ones',
): GroupCheck {
  const { n, targets, cubes } = coverContext(table, outputIndex, dontCares, polarity);
  const targetSet = new Set(targets);
  const perCircle = circles.map((c, i) => {
    const others = new Set<number>();
    circles.forEach((o, j) => {
      if (j !== i) for (const m of o) others.add(m);
    });
    return {
      notPrime: cubes.some((d) => d.length > c.length && isSubset(c, d)),
      redundant: c.filter((m) => targetSet.has(m)).every((m) => others.has(m)),
    };
  });
  const got = new Set<number>();
  for (const c of circles) for (const m of c) got.add(m);
  const coversAll = targets.every((m) => got.has(m));
  const best = minimumCovers(table, outputIndex, dontCares, polarity, 1)[0];
  const isMinimum =
    !!best &&
    coversAll &&
    circles.every((c) => analyzeSubcube(n, c)) &&
    circles.length === best.length &&
    literalTotal(n, circles) === literalTotal(n, best);
  return { circles: perCircle, coversAll, isMinimum };
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
