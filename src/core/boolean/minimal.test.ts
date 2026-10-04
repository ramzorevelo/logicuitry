import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr';
import { checkMinimal, posCost, sopCost } from './minimal';
import { normalize } from './rewrite';

const e = (s: string) => normalize(parseExpr(s));

describe('two-level cost', () => {
  it('counts terms and literals of a sum of products', () => {
    expect(sopCost(e("A'B + BC + C'D"))).toEqual({ terms: 3, literals: 6 });
    expect(sopCost(e('A'))).toEqual({ terms: 1, literals: 1 });
    expect(sopCost(e('A(B + C)'))).toBeNull();
  });

  it('counts a product of sums the dual way', () => {
    expect(posCost(e('A(B + C)'))).toEqual({ terms: 2, literals: 3 });
    expect(posCost(e("A'B + C"))).toBeNull();
  });

  it('reads a constant as the empty product or sum', () => {
    expect(sopCost(e('1'))).toEqual({ terms: 1, literals: 0 });
    expect(sopCost(e('0'))).toEqual({ terms: 0, literals: 0 });
    expect(posCost(e('0'))).toEqual({ terms: 1, literals: 0 });
    expect(posCost(e('1'))).toEqual({ terms: 0, literals: 0 });
  });

  it('counts a constant left inside as a literal still to remove', () => {
    expect(sopCost(e('A + 0'))).toEqual({ terms: 2, literals: 2 });
  });
});

describe('checkMinimal', () => {
  const abcd = ['A', 'B', 'C', 'D'];

  it('accepts a minimum sum of products', () => {
    expect(checkMinimal(e("A'B + BC + C'D"), abcd)).toMatchObject({ kind: 'minimal', form: 'sop' });
  });

  it('refuses a redundant one with both counts', () => {
    expect(checkMinimal(e("A'B + BC + C'D + BD"), abcd)).toEqual({
      kind: 'not-minimal',
      form: 'sop',
      cost: { terms: 4, literals: 8 },
      minimum: { terms: 3, literals: 6 },
    });
  });

  it('accepts a minimum product of sums', () => {
    expect(checkMinimal(e('A(B + C)'), ['A', 'B', 'C'])).toMatchObject({
      kind: 'minimal',
      form: 'pos',
    });
  });

  it('uses the first line`s variables, so a dropped one still counts', () => {
    // AB + AB' reduced to A: one variable left, the function still has two.
    expect(checkMinimal(e('A'), ['A', 'B'])).toMatchObject({ kind: 'minimal' });
    expect(checkMinimal(e('1'), ['A'])).toMatchObject({ kind: 'minimal' });
    expect(checkMinimal(e('A + 1'), ['A'])).toMatchObject({ kind: 'not-minimal' });
  });

  it('declines a line that is neither form', () => {
    expect(checkMinimal(e('A(B + CD)'), abcd)).toEqual({ kind: 'not-two-level' });
    expect(checkMinimal(e('A ⊕ B'), ['A', 'B'])).toEqual({ kind: 'not-two-level' });
  });

  it('stops at the K-map limit', () => {
    expect(checkMinimal(e('ABCDE'), [])).toEqual({ kind: 'too-many-vars', count: 5 });
  });
});
