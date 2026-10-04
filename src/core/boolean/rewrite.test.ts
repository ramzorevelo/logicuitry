import { describe, expect, it } from 'vitest';
import { parseExpr, printExpr } from './expr';
import { lawLabel } from './laws';
import {
  acKey,
  allSteps,
  applicable,
  citeChain,
  citeStep,
  firstDifferingRow,
  identifyStep,
  localChange,
  normalize,
  sameUpToAC,
  type StepCheck,
} from './rewrite';

const p = parseExpr;

// Row ids only: these cases pin which law is found, not how it is worded.
const cites = (c: StepCheck): string[] =>
  c.kind === 'law'
    ? c.steps.map((s) =>
        s.law === 'reorder' ? citeStep(s) : citeStep(s).replace(lawLabel(s.law), s.law),
      )
    : [];

describe('normalize and sameUpToAC', () => {
  it('flattens nested operators of one kind and nothing else', () => {
    expect(normalize(p('A(BC)'))).toEqual(p('ABC'));
    expect(normalize(p('A + (B + C)'))).toEqual(p('A + B + C'));
    expect(printExpr(normalize(p("(A')'")))).toBe("A''");
    expect(printExpr(normalize(p('A + A')))).toBe('A + A');
  });

  it('ignores operand order and grouping, never idempotence', () => {
    expect(sameUpToAC(p('AB + C'), p('C + BA'))).toBe(true);
    expect(sameUpToAC(p('(A + B) + C'), p('A + (C + B)'))).toBe(true);
    expect(sameUpToAC(p('A + A'), p('A'))).toBe(false);
  });
});

describe('applicable', () => {
  it('matches two terms out of a four-term sum, in any order', () => {
    const steps = applicable(p("AB + C + AB' + D"), []);
    const uniting = steps.find((s) => s.law === '11b');
    expect(uniting?.operands).toEqual([0, 2]);
    expect(printExpr(uniting!.to)).toBe('A + C + D');
  });

  it('binds a pattern variable to a whole product', () => {
    const s = applicable(p("ABC'D' + ABCD'"), []).find((x) => x.law === '11b');
    expect(printExpr(s!.to)).toBe("ABD'");
  });

  it("reads Y' against a positive literal when Y is complemented", () => {
    const s = applicable(p("A' + ACD'"), []).find((x) => x.law === '12b');
    expect(printExpr(s!.to)).toBe("A' + CD'");
  });

  it('lets consensus terms share a literal, since X·X = X', () => {
    const s = applicable(p("A'BC' + BCD + A'BD"), []).find((x) => x.law === '13b');
    expect(printExpr(s!.to)).toBe("A'BC' + BCD");
  });

  it('never writes a double bar while substituting', () => {
    const s = applicable(p("(AB')'"), []).find((x) => x.law === '9a');
    expect(printExpr(s!.to)).toBe("A' + B");
  });

  it('keeps the untouched operands in place and a kept term as written', () => {
    const s = applicable(p("A'C'D + A'BD + BCD"), []).find((x) => x.law === '13b');
    expect(printExpr(s!.to)).toBe("A'C'D + BCD");
  });

  it('never offers a right-to-left step that would invent a variable', () => {
    const offered = (src: string): string[] =>
      allSteps(p(src))
        .filter((s) => s.direction === 'rtl')
        .map((s) => s.law);
    expect(offered('0')).not.toContain('1a');
    expect(offered('1')).not.toContain('4b');
    expect(offered('A')).toEqual([]);
  });

  it('offers row 13b right to left, since YZ uses only bound names', () => {
    const s = applicable(p("XY + X'Z"), []).find((x) => x.law === '13b');
    expect(s?.direction).toBe('rtl');
    expect(printExpr(s!.to)).toBe("XY + X'Z + YZ");
  });

  it('offers factoring as row 8a read right to left', () => {
    const s = applicable(p('AB + AC'), []).find((x) => x.law === '8a' && x.direction === 'rtl');
    expect(printExpr(s!.to)).toBe('A(B + C)');
  });

  it('multiplies a whole product of sums out as one row 8a step', () => {
    const tos = applicable(p('(A + B)(A + C)'), [])
      .filter((s) => s.law === '8a')
      .map((s) => printExpr(s.to));
    expect(tos).toContain('AA + AC + BA + BC');
  });

  it('limits steps to the selected operands, reaching any subset', () => {
    const e = p('A + B + C + 1');
    const tos = applicable(e, [], [0, 1, 3])
      .filter((s) => s.law === '1b')
      .map((s) => printExpr(s.to));
    expect(tos).toEqual(['C + 1']);
  });

  it('stays fast on an 8-term, 4-variable sum (the largest the lab uses)', () => {
    const big = p("A'B'C'D + A'BC'D' + AB'CD + ABC'D + A'B'CD' + AB'C'D' + ABCD' + A'BCD");
    const t0 = performance.now();
    const n = allSteps(big).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(5000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('identifyStep', () => {
  it.each([
    ['X + XY', 'X', '10b'],
    ["XY + XY'", 'X', '11b'],
    ["X + X'Y", 'X + Y', '12b'],
    ["XY + X'Z + YZ", "XY + X'Z", '13b'],
    ["(X + Y)'", "X'Y'", '9b'],
    ["(XY)'", "X' + Y'", '9a'],
    ["A(A' + B)", "AA' + AB", '8a'],
    ['(A + B)(A + C)', 'A + BC', '8b (right to left)'],
    ['(A + B)(A + C)', 'AA + AC + BA + BC', '8a'],
    ['A ⊕ B', "A'B + AB'", '14b'],
    ['A ⊙ B', "A'B' + AB", '15b'],
    ["(A')'", 'A', '5'],
    ["A'B + A'B'C'D' + ABCD'", "A'(B + B'C'D') + ABCD'", '8a (right to left)'],
  ])('%s = %s is row %s', (from, to, cite) => {
    expect(cites(identifyStep(p(from), p(to)))[0]).toBe(cite);
  });

  it('reaches rows whose right side drops a variable, read right to left', () => {
    expect(cites(identifyStep(p('0'), p('A·0')))).toContain('1a (right to left)');
    expect(cites(identifyStep(p('1'), p("B + B'")))).toContain('4b (right to left)');
    expect(cites(identifyStep(p("WX + X'Z'"), p("WX + X'Z' + WZ'")))).toContain(
      '13b (right to left)',
    );
  });

  it('reports every law that justifies a line, lowest row first', () => {
    const c = cites(identifyStep(p('A + A'), p('A')));
    expect(c[0]).toBe('3b');
  });

  it('labels a pure reorder', () => {
    expect(identifyStep(p('AB + C'), p('C + BA'))).toEqual({ kind: 'reorder' });
  });

  it('accepts one law at several places in one line, as the chapter writes it', () => {
    expect(cites(identifyStep(p('AB + BBC + BCC'), p('AB + BC + BC')))).toEqual(['3a (twice)']);
  });

  it('flags a line that is equal but not one law', () => {
    expect(identifyStep(p('A ⊕ B + AB'), p('A + B'))).toEqual({ kind: 'equivalent-multi' });
  });

  it('refuses a wrong line with the first differing row, before any law search', () => {
    // A'B vs A: rows over (A, B), MSB first; they first differ at A=0, B=1.
    expect(identifyStep(p("A'B + AB"), p("A'B"))).toEqual({ kind: 'not-equivalent', row: 3 });
    expect(identifyStep(p('X + XY'), p('XY'))).toEqual({ kind: 'not-equivalent', row: 2 });
    expect(firstDifferingRow(p('A'), p('A'))).toBe(-1);
  });
});

describe('citeStep', () => {
  it('prints the chapter style', () => {
    expect(citeStep({ law: '11b', direction: 'ltr' })).toBe('11b (redundancy law, uniting form)');
    expect(citeStep({ law: '8a', direction: 'rtl' })).toBe(
      '8a (first distributive law) (right to left)',
    );
    expect(citeStep({ law: 'reorder', direction: 'ltr' })).toBe('6, 7 (reorder)');
    expect(citeStep({ law: '3a', direction: 'ltr', times: 2 })).toBe('3a (idempotent law) (twice)');
  });
});

describe('identifyStep, two laws', () => {
  const n = (s: string) => normalize(parseExpr(s));

  it('finds two laws used in one line and orders them as used', () => {
    const c = identifyStep(n("XY + XY' + Z + ZW"), n('X + Z'));
    expect(c.kind).toBe('chain');
    if (c.kind === 'chain') {
      expect(citeChain(c.steps)).toBe('10b (absorption law), 11b (redundancy law, uniting form)');
      expect(acKey(c.steps[0].to)).toBe(acKey(c.steps[1].from));
    }
  });

  it('cites one law used twice as twice', () => {
    expect(
      citeChain([
        { from: n('A'), to: n('A'), law: '10b', direction: 'ltr', at: [] },
        { from: n('A'), to: n('A'), law: '10b', direction: 'ltr', at: [] },
      ]),
    ).toBe('10b (absorption law) (twice)');
  });
});

describe('localChange', () => {
  const n = (s: string) => normalize(parseExpr(s));

  it('shows only the terms a step used and what they became', () => {
    const line = n("A'B + C'D + ABC + ABCD + AC'D");
    const step = applicable(line, []).find((s) => s.law === '10b' && s.operands?.join() === '2,3')!;
    const change = localChange(step)!;
    expect(printExpr(change.before)).toBe('ABC + ABCD');
    expect(printExpr(change.after)).toBe('ABC');
  });

  it('shows the whole node when the step rewrote all of it', () => {
    const step = applicable(n("(A + B)'"), [])[0]!;
    const change = localChange(step)!;
    expect(printExpr(change.before)).toBe("(A + B)'");
    expect(printExpr(change.after)).toBe("A'B'");
  });
});
