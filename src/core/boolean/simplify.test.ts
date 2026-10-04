import { describe, expect, it } from 'vitest';
import { parseExpr, printExpr } from './expr';
import { lawLabel, type LawId } from './laws';
import { citeStep, firstDifferingRow, identifyStep, normalize, sameUpToAC } from './rewrite';
import { derive } from './simplify';

// Goldens: the chapter's own worked examples, each line with its citation.
// Update deliberately; a changed line is a changed lesson.
const GOLDENS: [string, [string, string][]][] = [
  [
    "A'B + A'B'C'D' + ABCD'",
    [
      ["A'(B + B'C'D') + ABCD'", '8a (right to left)'],
      ["A'(B + C'D') + ABCD'", '12b'],
      ["A'B + A'C'D' + ABCD'", '8a'],
      ["B(A' + ACD') + A'C'D'", '8a (right to left)'],
      ["B(A' + CD') + A'C'D'", '12b'],
      ["A'B + BCD' + A'C'D'", '8a'],
    ],
  ],
  [
    // The order-dependent case: taking A'BD first reaches three terms.
    "A'C'D + A'BD + BCD + ABC + ACD'",
    [
      ["A'C'D + BCD + ABC + ACD'", '13b'],
      ["A'C'D + BCD + ACD'", '13b'],
    ],
  ],
  [
    "WX + XY + X'Z' + WY'Z'",
    [
      ["WX + XY + X'Z' + WY'Z' + WZ'", '13b (right to left)'],
      ["WX + XY + X'Z' + WZ'", '10b'],
      ["WX + XY + X'Z'", '13b'],
    ],
  ],
  [
    'A ^ B + AB',
    [
      ["A'B + AB' + AB", '14b'],
      ["B + AB'", '11b'],
      ['B + A', '12b'],
    ],
  ],
  [
    'AB + BC(B + C)',
    [
      ['AB + BBC + BCC', '8a'],
      ['AB + BC + BCC', '3a'],
      ['AB + BC + BC', '3a'],
      ['AB + BC', '3b'],
    ],
  ],
  [
    "((A + BC)' + (AB')')'",
    [
      ["(A + BC)AB'", '9b'],
      ["AAB' + ABB'C", '8a'],
      ["AB' + ABB'C", '3a'],
      ["AB' + A·0C", '4a'],
      ["AB' + 0", '1a'],
      ["AB'", '2b'],
    ],
  ],
  ['(A + B)(A + C)', [['A + BC', '8b (right to left)']]],
  ["ABC'D' + ABCD'", [["ABD'", '11b']]],
  ["A'B + A'BC", [["A'B", '10b']]],
  ["A'BC' + BCD + A'BD", [["A'BC' + BCD", '13b']]],
  [
    "(AB' + CD)'",
    [
      ["(AB')'(CD)'", '9b'],
      ["(A' + B)(CD)'", '9a'],
      ["(A' + B)(C' + D')", '9a'],
      ["A'C' + A'D' + BC' + BD'", '8a'],
    ],
  ],
  [
    "A(A' + B)",
    [
      ["AA' + AB", '8a'],
      ['0 + AB', '4a'],
      ['AB', '2b'],
    ],
  ],
  ['(A + B)C', [['AC + BC', '8a']]],
  ["(A')' + B", [['A + B', '5']]],
];

const lines = (src: string): [string, string][] =>
  derive(parseExpr(src)).map((s) => [printExpr(s.to), citeStep(s)]);

const labelled = (want: [string, string][]): [string, string][] =>
  want.map(([expr, cite]) => [expr, cite.replace(/^\d+[ab]?/, (id) => lawLabel(id as LawId))]);

describe('derive', () => {
  it.each(GOLDENS)('%s', (src, want) => {
    expect(lines(src)).toEqual(labelled(want));
  });

  it.each(GOLDENS.map(([src]) => [src]))(
    '%s: every step is its cited law and the result is equal',
    (src) => {
      const e = parseExpr(src);
      const steps = derive(e);
      let prev = normalize(e);
      for (const s of steps) {
        expect(sameUpToAC(s.from, prev)).toBe(true);
        const check = identifyStep(s.from, s.to);
        expect(check.kind).toBe('law');
        if (check.kind === 'law')
          expect(check.steps.some((x) => x.law === s.law && x.direction === s.direction)).toBe(
            true,
          );
        prev = s.to;
      }
      expect(firstDifferingRow(e, prev)).toBe(-1);
    },
  );

  it('removes XOR one pair at a time and ends in a sum of products', () => {
    const e = parseExpr('A ⊕ B ⊕ C');
    const steps = derive(e);
    expect(steps[0]!.law).toBe('14b');
    const last = steps[steps.length - 1]!.to;
    expect(firstDifferingRow(e, last)).toBe(-1);
    expect(printExpr(last)).toBe("ABC + A'B'C + A'BC' + AB'C'");
  });

  it('returns no steps when nothing applies', () => {
    expect(derive(parseExpr("AB + A'C"))).toEqual([]);
    expect(derive(parseExpr('A'))).toEqual([]);
  });

  it('is deterministic', () => {
    const src = "A'C'D + A'BD + BCD + ABC + ACD'";
    expect(lines(src)).toEqual(lines(src));
  });
});
