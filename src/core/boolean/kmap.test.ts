import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import type { TruthTable } from './truthTable';
import { buildKmap, implicantTerm, isLegalGroup, minimalCover } from './kmap';

// Hand-built tables (no compile needed): one output column, bit per row.
function table(inputPaths: string[], onesList: number[]): TruthTable {
  const ones = new Set(onesList);
  const rows = Array.from({ length: 2 ** inputPaths.length }, (_, m) => [
    bv.known(ones.has(m) ? 1 : 0, 1),
  ]);
  return { inputPaths, outputPaths: ['Y'], rows };
}

describe('buildKmap', () => {
  it('lays out 3 vars as 2 column vars x 1 row var in Gray order', () => {
    const t = table(['A', 'B', 'C'], [0]);
    const g = buildKmap(t, 0);
    expect(g.colVars).toEqual(['A', 'B']);
    expect(g.rowVars).toEqual(['C']);
    expect(g.colCodes).toEqual([0, 1, 3, 2]);
    expect(g.rowCodes).toEqual([0, 1]);
    // Cell (row C=0, col AB=11) is minterm 110 = 6.
    expect(g.cells[0]![2]!.minterm).toBe(6);
    expect(g.cells[0]![0]!.value).toBe(1);
    expect(g.cells[1]![0]!.value).toBe(0);
  });

  it('every 3-var layout addresses the same table rows', () => {
    const ones = [0, 1, 4, 5, 6];
    const t = table(['A', 'B', 'C'], ones);
    const layouts = [
      { cols: [0, 1], rows: [2] }, // AB x C
      { cols: [0], rows: [1, 2] }, // A x BC
      { cols: [1, 2], rows: [0] }, // BC x A
      { cols: [2], rows: [0, 1] }, // C x AB
    ];
    for (const layout of layouts) {
      const g = buildKmap(t, 0, layout);
      expect(g.colVars).toEqual(layout.cols.map((i) => t.inputPaths[i]!));
      for (const row of g.cells)
        for (const cell of row) expect(cell.value).toBe(ones.includes(cell.minterm) ? 1 : 0);
      // Every minterm appears exactly once.
      const seen = g.cells.flat().map((c) => c.minterm);
      expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it('groups stay legal across layouts (minterm lists are layout-free)', () => {
    const t = table(['A', 'B', 'C'], [0, 1, 4, 5, 6]);
    buildKmap(t, 0, { cols: [2], rows: [0, 1] });
    expect(isLegalGroup(t, 0, [0, 1, 4, 5])).toBe(true);
    expect(isLegalGroup(t, 0, [4, 6])).toBe(true);
  });

  it('2-var layout swap flips the axes', () => {
    const t = table(['A', 'B'], [1]);
    const g = buildKmap(t, 0, { cols: [1], rows: [0] });
    expect(g.colVars).toEqual(['B']);
    expect(g.rowVars).toEqual(['A']);
    expect(g.cells[0]![1]!.minterm).toBe(1); // row A=0, col B=1
    expect(g.cells[0]![1]!.value).toBe(1);
  });

  it('rejects a non-partitioning or oversized-axis layout', () => {
    const t = table(['A', 'B', 'C'], [0]);
    expect(() => buildKmap(t, 0, { cols: [0, 1], rows: [1] })).toThrow(RangeError);
    expect(() => buildKmap(t, 0, { cols: [0, 1, 2], rows: [] })).toThrow(RangeError);
  });

  it('rejects 1 and 5 inputs', () => {
    expect(() => buildKmap(table(['A'], [0]), 0)).toThrow(RangeError);
    expect(() => buildKmap(table(['A', 'B', 'C', 'D', 'E'], [0]), 0)).toThrow(RangeError);
  });
});

describe('isLegalGroup (subcube validation on minterm bits)', () => {
  const t3 = table(['A', 'B', 'C'], [0, 1, 4, 5, 6]); // Example 2.9 ones
  it('accepts singletons, pairs, quads of 1s', () => {
    expect(isLegalGroup(t3, 0, [6])).toBe(true);
    expect(isLegalGroup(t3, 0, [4, 6])).toBe(true);
    expect(isLegalGroup(t3, 0, [0, 1, 4, 5])).toBe(true);
  });
  it('accepts edge wraparound pairs (bit test, no grid geometry)', () => {
    expect(isLegalGroup(t3, 0, [0, 4])).toBe(true); // wraps left-right columns
  });
  it('accepts the 4-corner wrap on a 4-var map', () => {
    const t4 = table(['A', 'B', 'C', 'D'], [0, 2, 8, 10]);
    expect(isLegalGroup(t4, 0, [0, 2, 8, 10])).toBe(true);
  });
  it('rejects a group containing a 0 cell', () => {
    expect(isLegalGroup(t3, 0, [0, 2])).toBe(false); // 2 is a 0
  });
  it('rejects non-power-of-2, diagonal, and non-subcube selections', () => {
    expect(isLegalGroup(t3, 0, [0, 1, 4])).toBe(false); // size 3
    expect(isLegalGroup(t3, 0, [0, 5])).toBe(false); // diagonal
    expect(isLegalGroup(t3, 0, [0, 1, 4, 6])).toBe(false); // power of 2 but not a subcube (Fig 2.52-style error)
  });
});

describe('implicantTerm (book read-off rule)', () => {
  it('Fig 2.44: single 1 at minterm 0 reads notA.notB', () => {
    const t = table(['A', 'B'], [0]);
    expect(implicantTerm(t, [0])).toEqual([
      { var: 'A', negated: true },
      { var: 'B', negated: true },
    ]);
  });
  it('Example 2.9 / Fig 2.46: quad reads notB, pair reads A.notC', () => {
    const t = table(['A', 'B', 'C'], [0, 1, 4, 5, 6]);
    expect(implicantTerm(t, [0, 1, 4, 5])).toEqual([{ var: 'B', negated: true }]);
    expect(implicantTerm(t, [4, 6])).toEqual([
      { var: 'A', negated: false },
      { var: 'C', negated: true },
    ]);
  });
  it('whole-map group reads the empty (constant 1) term', () => {
    const t = table(['A', 'B'], [0, 1, 2, 3]);
    expect(implicantTerm(t, [0, 1, 2, 3])).toEqual([]);
  });
});

describe('minimalCover (deterministic reveal)', () => {
  it('Fig 2.44: cover is exactly the notA.notB singleton', () => {
    const t = table(['A', 'B'], [0]);
    expect(minimalCover(t, 0)).toEqual([[0]]);
  });

  it('Example 2.9: two implicants, three literals (Y = A.notC + notB)', () => {
    const t = table(['A', 'B', 'C'], [0, 1, 4, 5, 6]);
    const cover = minimalCover(t, 0);
    expect(cover).toHaveLength(2);
    const lits = cover.reduce((s, g) => s + implicantTerm(t, g).length, 0);
    expect(lits).toBe(3);
  });

  it('seven-segment Sa (Fig 2.50): four implicants, eleven literals (cost, not one variant)', () => {
    // Sa = 1 for digits 0,2,3,5,6,7,8,9; 10-15 treated as 0 (don't-cares deferred).
    const t = table(['D3', 'D2', 'D1', 'D0'], [0, 2, 3, 5, 6, 7, 8, 9]);
    const cover = minimalCover(t, 0);
    expect(cover).toHaveLength(4);
    const lits = cover.reduce((s, g) => s + implicantTerm(t, g).length, 0);
    expect(lits).toBe(11);
    // Deterministic: the same table always reveals the identical cover.
    expect(minimalCover(t, 0)).toEqual(cover);
    // Every group is legal and every 1 covered.
    for (const g of cover) expect(isLegalGroup(t, 0, g)).toBe(true);
    const covered = new Set(cover.flat());
    for (const m of [0, 2, 3, 5, 6, 7, 8, 9]) expect(covered.has(m)).toBe(true);
  });

  it('constant-0 output reveals an empty cover', () => {
    expect(minimalCover(table(['A', 'B'], []), 0)).toEqual([]);
  });
});

describe("don't-care support (H&H §2.7.3, Ex 2.11)", () => {
  it('1+DC subcube is legal; pure-DC is illegal; DC+0 is illegal', () => {
    const t = table(['A', 'B'], [0]); // minterm 0 = 1, rest 0
    expect(isLegalGroup(t, 0, [0, 1], new Set([1]))).toBe(true); // 1 + DC
    expect(isLegalGroup(t, 0, [1, 3], new Set([1, 3]))).toBe(false); // pure DC
    expect(isLegalGroup(t, 0, [0, 2], new Set([1]))).toBe(false); // 2 is a real 0, not DC-marked
  });

  it('four-corner wrap stays legal with two corners marked DC', () => {
    const t4 = table(['A', 'B', 'C', 'D'], [0, 8]);
    expect(isLegalGroup(t4, 0, [0, 2, 8, 10], new Set([2, 10]))).toBe(true);
  });

  it("seven-segment Sa with don't-cares (Fig 2.53 / Ex 2.11): 4 implicants, 6 literals", () => {
    const ones = [0, 2, 3, 5, 6, 7, 8, 9];
    const dc = new Set([10, 11, 12, 13, 14, 15]);
    const t = table(['D3', 'D2', 'D1', 'D0'], ones);
    const cover = minimalCover(t, 0, dc);
    expect(cover).toHaveLength(4);
    const lits = cover.reduce((s, g) => s + implicantTerm(t, g).length, 0);
    expect(lits).toBe(6); // book: Sa = D3 + D2.D0 + notD2.notD0 + D1
    expect(lits).toBeLessThan(11); // strictly fewer literals than the no-DC cover
    for (const g of cover) expect(isLegalGroup(t, 0, g, dc)).toBe(true);
    const covered = new Set(cover.flat());
    for (const m of ones) expect(covered.has(m)).toBe(true);
    // Deterministic.
    expect(minimalCover(t, 0, dc)).toEqual(cover);
  });
});
