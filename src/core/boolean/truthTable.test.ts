import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import * as bv from '../value/busValue';
import {
  buildTruthTable,
  diffRows,
  MAX_TABLE_INPUTS,
  permuteTableInputs,
  tablesEqual,
  type TruthTable,
} from './truthTable';

const noLib: ChipLibrary = new Map();

/** a NAND b, built as two primitives (AND then NOT) to exercise multi-gate chains. */
function nandBoard() {
  return board({
    components: [
      comp('a', 'inport'),
      comp('b', 'inport'),
      comp('g1', 'and'),
      comp('n1', 'not'),
      comp('o', 'outport'),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['g1', 'a']),
      wire('w2', ['b', 'y'], ['g1', 'b']),
      wire('w3', ['g1', 'y'], ['n1', 'a']),
      wire('w4', ['n1', 'y'], ['o', 'a']),
    ],
  });
}

/** Directly a De Morgan-equivalent circuit: NOT a OR NOT b (one NAND ≡ this). */
function deMorganNandBoard() {
  return board({
    components: [
      comp('a', 'inport'),
      comp('b', 'inport'),
      comp('na', 'not'),
      comp('nb', 'not'),
      comp('g1', 'or'),
      comp('o', 'outport'),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['na', 'a']),
      wire('w2', ['b', 'y'], ['nb', 'a']),
      wire('w3', ['na', 'y'], ['g1', 'a']),
      wire('w4', ['nb', 'y'], ['g1', 'b']),
      wire('w5', ['g1', 'y'], ['o', 'a']),
    ],
  });
}

describe('buildTruthTable', () => {
  it('produces the standard NAND table over 2 inputs', () => {
    const c = compile(nandBoard(), noLib);
    const t = buildTruthTable(c, ['main/a.y', 'main/b.y'], ['main/o.a']);
    expect(t.rows.map((r) => bv.toString(r[0]!, 1))).toEqual(['1', '1', '1', '0']);
  });

  it('rejects more than MAX_TABLE_INPUTS inputs', () => {
    const c = compile(board({ components: [comp('o', 'outport')] }), noLib);
    const paths = Array.from({ length: MAX_TABLE_INPUTS + 1 }, (_, i) => `main/i${i}`);
    expect(() => buildTruthTable(c, paths, ['main/o'])).toThrow(RangeError);
  });

  it('rejects an unknown path', () => {
    const c = compile(nandBoard(), noLib);
    expect(() => buildTruthTable(c, ['main/nope'], ['main/o.a'])).toThrow(
      /no primitive or net at path/,
    );
  });

  it('rejects a width>1 input terminal (M6.5 regression: silently read bit 0)', () => {
    const b = board({
      components: [comp('t', 'toggle', { width: 4 }), comp('o', 'outport', { width: 4 })],
      wires: [wire('w1', ['t', 'y'], ['o', 'a'])],
    });
    const c = compile(b, noLib);
    expect(() => buildTruthTable(c, ['main/t'], ['main/o.a'])).toThrow(/is 4-bit, not 1-bit/);
  });

  it('rejects a width>1 output terminal', () => {
    const b = board({
      components: [
        comp('a', 'inport'),
        comp('k', 'constant', { width: 4, value: 5 }),
        comp('o', 'outport', { width: 4 }),
      ],
      wires: [wire('w1', ['k', 'y'], ['o', 'a'])],
    });
    const c = compile(b, noLib);
    expect(() => buildTruthTable(c, ['main/a.y'], ['main/o.a'])).toThrow(/is 4-bit, not 1-bit/);
  });
});

describe('tablesEqual / diffRows', () => {
  it('recognizes a De Morgan-equivalent circuit as functionally identical', () => {
    const nand = buildTruthTable(
      compile(nandBoard(), noLib),
      ['main/a.y', 'main/b.y'],
      ['main/o.a'],
    );
    const equiv = buildTruthTable(
      compile(deMorganNandBoard(), noLib),
      ['main/a.y', 'main/b.y'],
      ['main/o.a'],
    );
    expect(tablesEqual(nand, equiv)).toBe(true);
    expect(diffRows(nand, equiv)).toEqual([]);
  });

  it('flags exactly the mismatched rows for a non-equivalent circuit', () => {
    // AND instead of NAND: differs from the NAND table on every row.
    const andBoard = board({
      components: [
        comp('a', 'inport'),
        comp('b', 'inport'),
        comp('g1', 'and'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['g1', 'a']),
        wire('w2', ['b', 'y'], ['g1', 'b']),
        wire('w3', ['g1', 'y'], ['o', 'a']),
      ],
    });
    const nand = buildTruthTable(
      compile(nandBoard(), noLib),
      ['main/a.y', 'main/b.y'],
      ['main/o.a'],
    );
    const and = buildTruthTable(compile(andBoard, noLib), ['main/a.y', 'main/b.y'], ['main/o.a']);
    expect(tablesEqual(nand, and)).toBe(false);
    expect(diffRows(nand, and)).toEqual([0, 1, 2, 3]);
  });
});

describe('permuteTableInputs', () => {
  // A AND NOT B, hand-built: one output bit per row.
  const base: TruthTable = {
    inputPaths: ['A', 'B'],
    outputPaths: ['Y'],
    rows: [0, 0, 1, 0].map((v) => [bv.known(v, 1)]),
  };

  it('reorders columns while addressing the same assignments', () => {
    const p = permuteTableInputs(base, [1, 0]);
    expect(p.inputPaths).toEqual(['B', 'A']);
    // New row 1 = B=0, A=1 -> the original A=1,B=0 row (value 1).
    expect(p.rows.map((r) => r[0]!.v & 1)).toEqual([0, 1, 0, 0]);
  });

  it('identity order returns an equal table', () => {
    expect(tablesEqual(permuteTableInputs(base, [0, 1]), base)).toBe(true);
  });

  it('rejects a non-permutation', () => {
    expect(() => permuteTableInputs(base, [0, 0])).toThrow(RangeError);
  });
});
