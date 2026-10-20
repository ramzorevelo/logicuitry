import { describe, expect, it } from 'vitest';
import {
  checkSentences,
  coverStatus,
  factorJoins,
  groupHint,
  kmapUnavailable,
  productJoins,
  dontCareDisagreements,
  functionLine,
  groupingRules,
  refusalMessage,
  summarizeForm,
} from './kmapText';

describe('kmapText', () => {
  const idx = { ones: [1, 3], zeros: [0, 2], dontCares: [] as number[] };

  it("prints the function in either notation, with don't-cares when present", () => {
    expect(functionLine('Y', idx, 'ones')).toBe('Y = Σm(1,3)');
    expect(functionLine('Y', idx, 'zeros')).toBe('Y = ΠM(0,2)');
    const dc = { ones: [1], zeros: [0], dontCares: [2] };
    expect(functionLine('Y', dc, 'ones')).toBe('Y = Σm(1) + Σd(2)');
    expect(functionLine('Y', dc, 'zeros')).toBe('Y = ΠM(0) · ΠD(2)');
  });

  it('words the rules for the polarity and keeps six of them', () => {
    expect(groupingRules('ones')).toHaveLength(6);
    expect(groupingRules('zeros')[1]).toContain('0');
    expect(groupingRules('ones')[1]).toContain('1');
  });

  it('names the broken rule', () => {
    expect(refusalMessage('rule2', 'ones')).toMatch(/^Rule 2/);
    expect(refusalMessage('rule3', 'zeros')).toMatch(/^Rule 3/);
    expect(refusalMessage('dc-only', 'zeros')).toContain('0');
  });

  it('summarizes a form as terms, literals and two-level gates', () => {
    expect(summarizeForm([1])).toEqual({ terms: 1, literals: 1, gates: 0 });
    expect(summarizeForm([2, 1, 3])).toEqual({ terms: 3, literals: 6, gates: 3 });
  });

  it("finds the don't-care cells the two forms disagree on", () => {
    // Cell 2: SOP takes it, POS leaves it at 1 -> agree. Cell 3: SOP skips it,
    // POS leaves it at 1 -> disagree. Cell 4: only POS takes it as 0, SOP leaves 0 -> agree.
    expect(dontCareDisagreements([2, 3, 4], [[2]], [[4]])).toEqual([3]);
  });
});

describe('productJoins', () => {
  it('dots multi-letter names apart and leaves single letters juxtaposed', () => {
    expect(productJoins(['sw1', 'sw2'])).toEqual(['', '·']);
    expect(productJoins(['A', 'B', 'C1'])).toEqual(['', '', '']);
    expect(productJoins(['A', 'Cin'])).toEqual(['', '·']);
  });
});

describe('functionLine with empty lists and unknown rows', () => {
  it('prints the constant instead of an empty index list', () => {
    const zero = { ones: [], zeros: [0, 1, 2, 3], dontCares: [] };
    expect(functionLine('Y', zero, 'ones')).toBe('Y = 0');
    const one = { ones: [0, 1, 2, 3], zeros: [], dontCares: [] };
    expect(functionLine('Y', one, 'zeros')).toBe('Y = 1');
  });

  it('claims no constant when unknown rows could hold the value', () => {
    const idx = { ones: [], zeros: [0, 1], dontCares: [] };
    expect(functionLine('Y', idx, 'ones', 2)).toBe('Y: no known row is 1');
  });
});

describe('factorJoins', () => {
  it('dots two bare multi-letter factors apart but not a bracketed sum', () => {
    expect(factorJoins([['sw1'], ['sw2']])).toEqual(['', '·']);
    expect(factorJoins([['A'], ['B']])).toEqual(['', '']);
    expect(
      factorJoins([
        ['A', 'B'],
        ['C', 'D'],
      ]),
    ).toEqual(['', '']);
  });
});

describe('coverStatus', () => {
  it('reports unknown rows rather than calling the function constant', () => {
    expect(coverStatus('ones', 0, 0, 2)).toBe('2 rows unknown (is an input floating?)');
    expect(coverStatus('ones', 0, 0, 0)).toBe('constant 0');
    expect(coverStatus('zeros', 0, 0, 0)).toBe('constant 1');
  });

  it('keeps the uncovered count and adds the unknown rows to it', () => {
    expect(coverStatus('ones', 3, 1, 0)).toBe('1 one still uncovered');
    expect(coverStatus('zeros', 3, 0, 1)).toBe(
      'all zeros covered; 1 row unknown (is an input floating?)',
    );
  });
});

describe('checkSentences', () => {
  const base = { coversAll: true, isMinimum: true, excess: null } as const;

  it('calls no circles on a constant function a minimum cover', () => {
    const s = checkSentences({ ...base, circles: [] }, 'ones', 0);
    expect(s.minimum).toBe('A minimum cover.');
    expect(s.covered).toBe('There is no one to cover.');
  });

  it('joins two findings on one circle into one sentence', () => {
    const s = checkSentences(
      { ...base, isMinimum: false, circles: [{ notPrime: true, redundant: true }] },
      'ones',
      2,
    );
    expect(s.circles[0]).toBe(': this group can grow (Rule 4) and is not needed (Rule 1).');
    expect(s.circles[0]!.split(':')).toHaveLength(2);
  });

  it('says why a cover is not a minimum', () => {
    const groups = checkSentences(
      { ...base, isMinimum: false, excess: 'groups', circles: [] },
      'ones',
      2,
    );
    expect(groups.minimum).toBe('Not a minimum cover: it uses more groups than needed.');
    const lits = checkSentences(
      { ...base, isMinimum: false, excess: 'literals', circles: [] },
      'zeros',
      2,
    );
    expect(lits.minimum).toBe('Not a minimum cover: it uses more literals than needed.');
  });
});

describe('kmapUnavailable', () => {
  it('tells too few inputs apart from too many', () => {
    expect(kmapUnavailable('Y', 1)).toBe('A K-map needs 2 to 4 inputs; Y reads 1.');
    expect(kmapUnavailable('Y', 5)).toMatch(/^A K-map shows at most 4 inputs; Y reads 5/);
  });
});

describe('groupHint and refusals', () => {
  it("names the don't-care gesture on a mouse, where Alt exists", () => {
    expect(groupHint(false)).toContain("Alt+click marks a don't-care");
    expect(groupHint(true)).not.toContain('Alt');
  });

  it('refuses a group that is already circled', () => {
    expect(refusalMessage('duplicate', 'ones')).toBe('That group is already circled.');
  });
});
