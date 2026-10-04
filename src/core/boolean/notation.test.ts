import { describe, expect, it } from 'vitest';
import { canonicalSop, sigmaOf } from './canonical';
import { ExprError } from './expr';
import { parseFunctionSpec } from './notation';

const V3 = ['A', 'B', 'C'];

describe('parseFunctionSpec', () => {
  it('reads every spelling of a sum of minterms', () => {
    for (const src of ['Σm(1,3,5)', 'm(1,3,5)', 'sum(1, 3, 5)', 'SUM (1,3,5)']) {
      const s = parseFunctionSpec(src, V3);
      expect(s.form).toBe('sop');
      expect(sigmaOf(s.table).ones).toEqual([1, 3, 5]);
    }
  });

  it('reads a product of maxterms', () => {
    for (const src of ['ΠM(0,2)', 'M(0,2)', 'prod(0,2)']) {
      const s = parseFunctionSpec(src, V3);
      expect(s.form).toBe('pos');
      expect(sigmaOf(s.table).zeros).toEqual([0, 2]);
    }
  });

  it('reads don-t-cares on either form', () => {
    const sop = parseFunctionSpec('Σm(1,3) + Σd(7)', V3);
    expect([...sop.dontCares]).toEqual([7]);
    const pos = parseFunctionSpec('ΠM(0) · ΠD(7)', V3);
    expect([...pos.dontCares]).toEqual([7]);
    expect(sigmaOf(pos.table, pos.dontCares).zeros).toEqual([0]);
    expect(parseFunctionSpec('m(1) + d(2)', V3).dontCares.has(2)).toBe(true);
    expect(parseFunctionSpec('M(1) * D(2)', V3).dontCares.has(2)).toBe(true);
  });

  it('takes the variables from a prefix', () => {
    const s = parseFunctionSpec('F(W,X) = Σm(1,2)', V3);
    expect(s.table.inputPaths).toEqual(['W', 'X']);
    expect(s.table.rows).toHaveLength(4);
    expect(s.table.outputPaths).toEqual(['F']);
  });

  it('uses the default variables and row index MSB-first', () => {
    const s = parseFunctionSpec('Σm(1)', ['A', 'B']);
    expect(canonicalSop(s.table)).toEqual({
      kind: 'and',
      args: [
        { kind: 'not', a: { kind: 'var', name: 'A' } },
        { kind: 'var', name: 'B' },
      ],
    });
  });

  it('accepts an empty list as the constant', () => {
    expect(sigmaOf(parseFunctionSpec('Σm()', V3).table).ones).toEqual([]);
  });

  it('errors with an offset', () => {
    const fail = (src: string, vars = V3): ExprError => {
      try {
        parseFunctionSpec(src, vars);
      } catch (e) {
        if (e instanceof ExprError) return e;
      }
      throw new Error(`no ExprError for ${src}`);
    };
    expect(fail('Σm(8)').offset).toBe(3);
    expect(fail('Σm(1,x)').offset).toBe(5);
    expect(fail('Σm(1) + Σd(1)').message).toMatch(/both/);
    expect(fail('Σm(1) · ΠM(2)').message).toMatch(/mix/);
    expect(fail('Σd(1)').message).toMatch(/Σm/);
    expect(fail('').message).toMatch(/empty/);
    expect(fail('Σm(1,3').message).toMatch(/closing/);
    expect(fail('F(A,A) = Σm(1)').message).toMatch(/twice/);
    expect(fail('Σm(1) Σm(2)').offset).toBe(6);
    expect(fail('Σm(1)', []).message).toMatch(/variables/);
  });
});
