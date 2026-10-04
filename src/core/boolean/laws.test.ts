import { describe, expect, it } from 'vitest';
import { type Expr, evalExpr, exprVars, parseExpr, printExpr } from './expr';
import { LAWS, lawLabel } from './laws';

const equalOverAllAssignments = (a: Expr, b: Expr): boolean => {
  const vars = [...new Set([...exprVars(a), ...exprVars(b)])];
  for (let m = 0; m < 1 << vars.length; m++) {
    const env = new Map<string, 0 | 1>(vars.map((n, i) => [n, ((m >> i) & 1) as 0 | 1]));
    if (evalExpr(a, env) !== evalExpr(b, env)) return false;
  }
  return true;
};

const dualOf = (e: Expr): Expr => {
  switch (e.kind) {
    case 'const':
      return { kind: 'const', value: e.value === 1 ? 0 : 1 };
    case 'var':
      return e;
    case 'not':
      return { kind: 'not', a: dualOf(e.a) };
    case 'and':
      return { kind: 'or', args: e.args.map(dualOf) };
    case 'or':
      return { kind: 'and', args: e.args.map(dualOf) };
    case 'xor':
      throw new Error('XOR has no dual here');
  }
};

const byId = new Map(LAWS.map((l) => [l.id, l]));

describe('LAWS', () => {
  it('has the 29 rows of the chapter table, ids unique', () => {
    expect(LAWS).toHaveLength(29);
    expect(byId.size).toBe(29);
  });

  it.each(LAWS.map((l) => [l.id, l] as const))('row %s: lhs equals rhs', (_id, l) => {
    expect(equalOverAllAssignments(parseExpr(l.lhs), parseExpr(l.rhs))).toBe(true);
  });

  it.each(LAWS.filter((l) => l.dual).map((l) => [l.id, l] as const))(
    'row %s: dual is symmetric and is the partner row',
    (_id, l) => {
      const partner = byId.get(l.dual!)!;
      expect(partner.dual).toBe(l.id);
      expect(printExpr(dualOf(parseExpr(l.lhs)))).toBe(printExpr(parseExpr(partner.lhs)));
      expect(printExpr(dualOf(parseExpr(l.rhs)))).toBe(printExpr(parseExpr(partner.rhs)));
    },
  );

  it('leaves only the self-dual row 5 and the XOR/XNOR forms without a dual', () => {
    expect(LAWS.filter((l) => l.dual === null).map((l) => l.id)).toEqual([
      '5',
      '14a',
      '14b',
      '15a',
      '15b',
    ]);
  });
});

describe('lawLabel', () => {
  const WANT: Record<string, string> = {
    '1a': '1a (annulment law)',
    '1b': '1b (annulment law)',
    '2a': '2a (identity law)',
    '2b': '2b (identity law)',
    '3a': '3a (idempotent law)',
    '3b': '3b (idempotent law)',
    '4a': '4a (complement law)',
    '4b': '4b (complement law)',
    '5': '5 (double negation law)',
    '6a': '6a (commutative law)',
    '6b': '6b (commutative law)',
    '7a': '7a (associative law)',
    '7b': '7b (associative law)',
    '8a': '8a (first distributive law)',
    '8b': '8b (second distributive law)',
    '9a': "9a (De Morgan's theorem)",
    '9b': "9b (De Morgan's theorem)",
    '10a': '10a (absorption law)',
    '10b': '10b (absorption law)',
    '11a': '11a (redundancy law, uniting form)',
    '11b': '11b (redundancy law, uniting form)',
    '12a': '12a (redundancy law, elimination form)',
    '12b': '12b (redundancy law, elimination form)',
    '13a': '13a (consensus law)',
    '13b': '13b (consensus law)',
    '14a': '14a (exclusive-OR)',
    '14b': '14b (exclusive-OR)',
    '15a': '15a (equivalence)',
    '15b': '15b (equivalence)',
  };

  it('labels all 29 rows as the chapter writes them', () => {
    expect(LAWS.map((l) => lawLabel(l.id))).toEqual(LAWS.map((l) => WANT[l.id]));
    expect(Object.keys(WANT)).toHaveLength(LAWS.length);
  });
});
