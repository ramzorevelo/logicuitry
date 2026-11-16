import { describe, expect, it } from 'vitest';
import type { Challenge } from '../model/types';
import { canonicalJson, challengeChanged, challengeFingerprint } from './fingerprint';
import { challengeErrors, emptyChallenge } from './challenge';

const sample = (): Challenge => ({
  title: 'Majority, NAND only',
  brief: 'Y is 1 when two of A, B, C are 1.',
  allowed: ['nand', 'toggle', 'led'],
  maxGates: 4,
  required: [{ anyOf: ['nand'], count: 1 }],
  truthTable: { inputs: ['A'], outputs: ['Y'], rows: [[0, 0]] },
});

describe('challengeFingerprint', () => {
  it('is stable across key order and ignores the fingerprint field', () => {
    const a = sample();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as Challenge;
    expect(Object.keys(reordered)[0]).toBe('truthTable');
    expect(challengeFingerprint(reordered)).toBe(challengeFingerprint(a));
    expect(challengeFingerprint({ ...a, fingerprint: 'x' })).toBe(challengeFingerprint(a));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('changes on any field', () => {
    const base = challengeFingerprint(sample());
    const edits: Partial<Challenge>[] = [
      { title: 'x' },
      { brief: 'x' },
      { allowed: ['nand'] },
      { maxGates: 5 },
      { ics: { min: 1 } },
      { required: [] },
      { truthTable: { inputs: ['A'], outputs: ['Y'], rows: [[0, 1]] } },
      { tests: { steps: [] } },
    ];
    for (const e of edits) expect(challengeFingerprint({ ...sample(), ...e })).not.toBe(base);
  });

  it('marks a set challenge changed after an edit, and never a draft', () => {
    const set = { ...sample(), fingerprint: challengeFingerprint(sample()) };
    expect(challengeChanged(set)).toBe(false);
    expect(challengeChanged({ ...set, maxGates: 9 })).toBe(true);
    expect(challengeChanged({ ...sample(), maxGates: 9 })).toBe(false);
  });
});

describe('challengeErrors', () => {
  it('accepts an empty challenge and a good one', () => {
    expect(challengeErrors(emptyChallenge())).toEqual([]);
    expect(challengeErrors(sample())).toEqual([]);
  });

  it('names a reversed IC range, a bad test step and a malformed table', () => {
    const bad: Challenge = {
      ...sample(),
      ics: { min: 5, max: 2 },
      tests: { steps: [{ ticks: 1, wait: { ms: 1 } }] },
      truthTable: {
        inputs: ['A', 'B'],
        outputs: ['A'],
        rows: [
          [0, 1],
          [null, 0, 1],
          [0, 1, 1],
        ],
      },
    };
    const errors = challengeErrors(bad);
    expect(errors).toContain('/challenge/ics min 5 is above max 2');
    expect(errors.some((e) => e.startsWith('/challenge/tests steps[0]: use ticks or wait'))).toBe(
      true,
    );
    expect(errors).toContain('/challenge/truthTable names A twice');
    expect(errors).toContain('/challenge/truthTable/rows/0 has 2 cells, expected 3');
    expect(errors).toContain('/challenge/truthTable/rows/1 leaves an input blank');
    expect(errors).toContain('/challenge/truthTable/rows/2 repeats inputs 01');
  });
});
