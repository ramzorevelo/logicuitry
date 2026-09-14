import { describe, expect, it } from 'vitest';
import {
  ExprError,
  evalExpr,
  exprVars,
  hasXor,
  parseExpr,
  printExpr,
  truthTableOfExpr,
} from './expr';
import * as bv from '../value/busValue';
import type { BusValue } from '../value/busValue';

const bit = (v: BusValue): number => (bv.isFullyKnown(v, 1) ? v.v & 1 : -1);

const outputs = (src: string): number[] =>
  truthTableOfExpr(parseExpr(src)).rows.map((r) => bit(r[0]!));

describe('parseExpr', () => {
  it('reads juxtaposition as AND and a prime as NOT', () => {
    expect(printExpr(parseExpr("A'B + BC"))).toBe("A'B + BC");
  });

  it('accepts the C-style and word spellings of every operator', () => {
    const forms = ['A & B | C', 'A AND B OR C', 'A * B + C', 'A·B + C'];
    for (const src of forms) expect(outputs(src)).toEqual(outputs('AB + C'));
  });

  it('accepts every spelling of NOT', () => {
    for (const src of ["A'", '~A', '!A', '¬A', 'NOT A']) expect(outputs(src)).toEqual([1, 0]);
  });

  it('binds NOT tighter than AND, AND tighter than XOR, XOR tighter than OR', () => {
    expect(outputs("A'B")).toEqual(outputs("(A')B"));
    expect(outputs('A B ^ C')).toEqual(outputs('(AB) ^ C'));
    expect(outputs('A ^ B + C')).toEqual(outputs('(A ^ B) + C'));
  });

  it('handles multi-letter variable names with digits', () => {
    expect(exprVars(parseExpr('X1 X2 + X1'))).toEqual(['X1', 'X2']);
  });

  it('takes constants', () => {
    expect(outputs('A + 1')).toEqual([1, 1]);
    expect(outputs('A 0')).toEqual([0, 0]);
  });

  it('reports the offset of the offending character', () => {
    try {
      parseExpr('A + ');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExprError);
      expect((e as ExprError).offset).toBeGreaterThan(1);
    }
    try {
      parseExpr('A # B');
      expect.unreachable();
    } catch (e) {
      expect((e as ExprError).offset).toBe(2);
    }
  });

  it('rejects an unclosed parenthesis and an empty expression', () => {
    expect(() => parseExpr('(A + B')).toThrow(ExprError);
    expect(() => parseExpr('   ')).toThrow(ExprError);
  });
});

describe('printExpr', () => {
  it('parenthesises only where precedence needs it', () => {
    expect(printExpr(parseExpr('(A + B)C'))).toBe('(A + B)C');
    expect(printExpr(parseExpr("(A + B)'"))).toBe("(A + B)'");
    expect(printExpr(parseExpr('A + B + C'))).toBe('A + B + C');
  });

  it('round-trips back to the same function', () => {
    for (const src of ["A'B + BC", '(A + B)(B + C)', "A ^ B'", "A'(B + C')D"])
      expect(outputs(printExpr(parseExpr(src)))).toEqual(outputs(src));
  });

  it('keeps a dot where juxtaposition would fuse two tokens', () => {
    expect(outputs(printExpr(parseExpr('A 1')))).toEqual(outputs('A 1'));
  });
});

describe('truthTableOfExpr', () => {
  it('orders rows MSB-first over the sorted variables', () => {
    const t = truthTableOfExpr(parseExpr('A + B'));
    expect(t.inputPaths).toEqual(['A', 'B']);
    expect(t.rows.map((r) => bit(r[0]!))).toEqual([0, 1, 1, 1]);
  });

  it('evaluates XOR as parity across a chain', () => {
    expect(outputs('A ^ B ^ C')).toEqual([0, 1, 1, 0, 1, 0, 0, 1]);
  });

  it('refuses an environment missing a variable', () => {
    expect(() => evalExpr(parseExpr('A'), new Map())).toThrow(ExprError);
  });
});

describe('hasXor', () => {
  it('finds an XOR anywhere in the tree', () => {
    expect(hasXor(parseExpr("(A ^ B)'C"))).toBe(true);
    expect(hasXor(parseExpr("A'B + BC"))).toBe(false);
  });
});
