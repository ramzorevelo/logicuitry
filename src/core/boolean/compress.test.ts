import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import type { TruthTable } from './truthTable';
import { compressTable } from './compress';

// Hand-built single-output tables (no compile needed), matching kmap.test.ts's pattern.
function table(inputPaths: string[], onesList: number[]): TruthTable {
  const ones = new Set(onesList);
  const rows = Array.from({ length: 2 ** inputPaths.length }, (_, m) => [
    bv.known(ones.has(m) ? 1 : 0, 1),
  ]);
  return { inputPaths, outputPaths: ['Y'], rows };
}

describe('compressTable (Fig 2.29 priority-circuit outputs)', () => {
  const inputs = ['A3', 'A2', 'A1', 'A0'];

  it('Y3 (ones 8..15) compresses to two rows', () => {
    const t = table(inputs, [8, 9, 10, 11, 12, 13, 14, 15]);
    expect(compressTable(t, 0)).toEqual([
      { bits: [0, null, null, null], value: 0 },
      { bits: [1, null, null, null], value: 1 },
    ]);
  });

  it('Y2 (ones 4..7) compresses to three rows', () => {
    const t = table(inputs, [4, 5, 6, 7]);
    expect(compressTable(t, 0)).toEqual([
      { bits: [0, 0, null, null], value: 0 },
      { bits: [0, 1, null, null], value: 1 },
      { bits: [1, null, null, null], value: 0 },
    ]);
  });

  it('Y1 (ones {2,3}) compresses to four rows', () => {
    const t = table(inputs, [2, 3]);
    expect(compressTable(t, 0)).toEqual([
      { bits: [0, 0, 0, null], value: 0 },
      { bits: [0, 0, 1, null], value: 1 },
      { bits: [0, 1, null, null], value: 0 },
      { bits: [1, null, null, null], value: 0 },
    ]);
  });

  it('Y0 (ones {1}) compresses to five rows', () => {
    const t = table(inputs, [1]);
    expect(compressTable(t, 0)).toEqual([
      { bits: [0, 0, 0, 0], value: 0 },
      { bits: [0, 0, 0, 1], value: 1 },
      { bits: [0, 0, 1, null], value: 0 },
      { bits: [0, 1, null, null], value: 0 },
      { bits: [1, null, null, null], value: 0 },
    ]);
  });
});

describe("compressTable (don't-cares and edge cases)", () => {
  it("a uniform don't-care region compresses to one value-x row", () => {
    const t = table(['A', 'B'], []); // all 0
    const dc = new Set([2, 3]);
    const rows = compressTable(t, 0, dc);
    expect(rows).toEqual([
      { bits: [0, null], value: 0 },
      { bits: [1, null], value: 'x' },
    ]);
  });

  it('a constant output compresses to one all-X row', () => {
    const t = table(['A', 'B', 'C'], [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(compressTable(t, 0)).toEqual([{ bits: [null, null, null], value: 1 }]);
  });
});
