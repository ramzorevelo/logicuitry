import { describe, expect, it } from 'vitest';
import {
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
