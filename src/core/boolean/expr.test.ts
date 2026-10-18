import { describe, expect, it } from 'vitest';
import {
  ExprError,
  evalExpr,
  exprVars,
  hasXor,
  parseExpr,
  printExpr,
  productNeedsDot,
  renameVarInExprText,
  truthTableOfExpr,
} from './expr';
import * as bv from '../value/busValue';
import type { BusValue } from '../value/busValue';

const bit = (v: BusValue): number => (bv.isFullyKnown(v, 1) ? v.v & 1 : -1);

const outputs = (src: string): number[] =>
  truthTableOfExpr(parseExpr(src)).rows.map((r) => bit(r[0]!));

describe('parseExpr', () => {
  it('reads the circled dot and the word XNOR as XNOR at XOR precedence', () => {
    expect(outputs('A ⊙ B')).toEqual([1, 0, 0, 1]);
    expect(outputs('A XNOR B')).toEqual([1, 0, 0, 1]);
    expect(printExpr(parseExpr('A ⊙ B'))).toBe("(A ⊕ B)'");
    expect(outputs('A + B ⊙ C')).toEqual(outputs('A + (B ⊙ C)'));
    expect(outputs('A ⊙ B ⊕ C')).toEqual(outputs('(A ⊙ B) ⊕ C'));
  });

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

describe('productNeedsDot', () => {
  const v = (name: string) => ({ kind: 'var', name }) as const;
  it('juxtaposes single-letter names, with or without digits and bars', () => {
    expect(productNeedsDot(v('A'), v('B1'))).toBe(false);
    expect(productNeedsDot({ kind: 'not', a: v('A') }, v('B'))).toBe(false);
  });
  it('dots a constant and a name that would fuse with its neighbour', () => {
    expect(productNeedsDot(v('A'), { kind: 'const', value: 1 })).toBe(true);
    expect(productNeedsDot(v('Cin'), v('A'))).toBe(true);
    expect(productNeedsDot(v('A'), { kind: 'not', a: v('U3.13') })).toBe(true);
  });
});

describe('bracketed names', () => {
  it('parse as one variable and print back with their brackets', () => {
    expect(printExpr(parseExpr("[Cin]A + [Cin]'B"))).toBe("[Cin]A + [Cin]'B");
    expect(() => parseExpr('[Cin')).toThrow(ExprError);
    expect(() => parseExpr('[]')).toThrow(ExprError);
  });
});

describe('renameVarInExprText', () => {
  const ABC = new Set(['A', 'B', 'C']);

  it('renames every use and keeps the typed spelling', () => {
    expect(renameVarInExprText("A'B + BC + A", 'A', 'X', ABC)).toBe("X'B + BC + X");
    expect(renameVarInExprText('A1 * B', 'A1', 'C', new Set(['A1', 'B']))).toBe('C * B');
  });

  it('leaves text that is not an expression using the variable', () => {
    expect(renameVarInExprText('Built circuit', 'A', 'X', ABC)).toBeNull();
    expect(renameVarInExprText('A +', 'A', 'X', ABC)).toBeNull();
    expect(renameVarInExprText('B + C', 'A', 'X', ABC)).toBeNull();
  });

  it('spells a multi-letter name in brackets so it stays one variable', () => {
    expect(renameVarInExprText("A'B + BC", 'A', 'Sel', ABC)).toBe("[Sel]'B + BC");
    const names = new Set(['Sel', 'B']);
    expect(renameVarInExprText("[Sel]'B", 'Sel', 'En', names)).toBe("[En]'B");
    expect(renameVarInExprText("[Sel]'B", 'Sel', 'X', names)).toBe("X'B");
    expect(exprVars(parseExpr("[Sel]'B + [Sel]"))).toEqual(['B', 'Sel']);
  });

  it('leaves a word label whose letters are not all inputs', () => {
    expect(renameVarInExprText('Cout', 'C', 'D', ABC)).toBeNull();
    expect(renameVarInExprText('Sum', 'S', 'X', new Set(['S']))).toBeNull();
  });

  it('refuses a name that would merge or misread', () => {
    expect(renameVarInExprText('A + B', 'A', 'B', ABC)).toBeNull();
  });
});
