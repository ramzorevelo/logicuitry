import { describe, expect, it } from 'vitest';
import { canonicalPos, canonicalRows, canonicalSop, piOf, sigmaOf } from './canonical';
import { evalExpr, exprVars, parseExpr, printExpr, truthTableOfExpr } from './expr';
import { parseFunctionSpec } from './notation';
import { diffRows } from './truthTable';

const table = (src: string) => truthTableOfExpr(parseExpr(src), 'F');

describe('canonicalRows', () => {
  it('complements opposite variables in minterm and maxterm', () => {
    const rows = canonicalRows(table('A + B'));
    expect(rows.map((r) => printExpr(r.minterm))).toEqual(["A'B'", "A'B", "AB'", 'AB']);
    expect(rows.map((r) => printExpr(r.maxterm))).toEqual(['A + B', "A + B'", "A' + B", "A' + B'"]);
    expect(rows.map((r) => r.value)).toEqual([0, 1, 1, 1]);
  });

  it('marks don-t-care rows', () => {
    expect(canonicalRows(table('A + B'), new Set([0]))[0]!.value).toBe('x');
  });
});

describe('canonicalSop and canonicalPos', () => {
  it('print the textbook forms', () => {
    const t = table('A + B');
    expect(printExpr(canonicalSop(t))).toBe("A'B + AB' + AB");
    expect(printExpr(canonicalPos(t))).toBe('A + B');
  });

  it('are the constants for a constant function', () => {
    expect(canonicalSop(table("A A'"))).toEqual({ kind: 'const', value: 0 });
    expect(canonicalPos(table("A + A'"))).toEqual({ kind: 'const', value: 1 });
  });

  it('both equal the function over every assignment', () => {
    for (const src of ['A ⊕ B ⊕ C', "AB + A'C", "(A + B)'C + D", 'A']) {
      const t = table(src);
      for (const e of [canonicalSop(t), canonicalPos(t)]) {
        const vars = exprVars(parseExpr(src));
        const back = truthTableOfExpr({ kind: 'and', args: [e, e] }, 'F');
        // Same variables only if the function uses them all; pad by name.
        expect(back.inputPaths.every((v) => vars.includes(v))).toBe(true);
        if (back.inputPaths.length === vars.length) expect(diffRows(back, t)).toEqual([]);
        else
          for (let m = 0; m < t.rows.length; m++) {
            const env = new Map(
              vars.map((v, i) => [v, ((m >> (vars.length - 1 - i)) & 1) as 0 | 1]),
            );
            expect(evalExpr(e, env)).toBe(evalExpr(parseExpr(src), env));
          }
      }
    }
  });
});

describe('sigmaOf', () => {
  it('lists ones, zeros and don-t-cares', () => {
    const { table: t, dontCares } = parseFunctionSpec('Σm(1,3) + Σd(5)', ['A', 'B', 'C']);
    expect(sigmaOf(t, dontCares)).toEqual({
      ones: [1, 3],
      zeros: [0, 2, 4, 6, 7],
      dontCares: [5],
    });
    expect(piOf(t, dontCares)).toEqual(sigmaOf(t, dontCares));
  });
});
