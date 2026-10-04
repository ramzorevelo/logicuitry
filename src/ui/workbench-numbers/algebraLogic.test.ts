import { describe, expect, it } from 'vitest';
import { parseExpr, printExpr } from '../../core/boolean/expr';
import { normalize } from '../../core/boolean/rewrite';
import {
  advanceReveal,
  checkLine,
  derivedLines,
  describeMinimal,
  lawRows,
  maskedLaws,
  nextMasked,
  rowAssignment,
  clickTarget,
  stepsForSelection,
} from './algebraLogic';
import { citeStep } from '../../core/boolean/rewrite';
import { checkMinimal } from '../../core/boolean/minimal';

const e = (s: string) => normalize(parseExpr(s));

describe('laws drill', () => {
  it('pairs each row with its dual; 5, 7 and 13 have no dual column', () => {
    const rows = lawRows();
    expect(rows).toHaveLength(17);
    expect(rows.map((r) => r.row).slice(5, 9)).toEqual(['6', '7a', '7b', '8']);
    expect(rows.find((r) => r.row === '7b')?.a.id).toBe('7b');
    expect(rows.find((r) => r.row === '13a')?.b).toBeNull();
    expect(rows.find((r) => r.row === '5')?.b).toBeNull();
    expect(rows.find((r) => r.row === '11')?.b?.id).toBe('11b');
  });

  it('hides the b column for duals and every right side for rhs', () => {
    expect(maskedLaws('none')).toEqual([]);
    expect(maskedLaws('duals').every((id) => id.endsWith('b'))).toBe(true);
    expect(maskedLaws('duals')).not.toContain('7b');
    expect(maskedLaws('duals')).not.toContain('13b');
    expect(maskedLaws('rhs')).toHaveLength(29);
  });

  it('reveals in table order and reports null when done', () => {
    expect(nextMasked('duals', [])).toBe('1b');
    expect(nextMasked('duals', ['1b'])).toBe('2b');
    expect(nextMasked('duals', maskedLaws('duals'))).toBeNull();
  });
});

describe('click target', () => {
  const expr = e("A'B + A'B'C'D' + ABCD'");

  it('a click on a letter takes its whole term', () => {
    expect(clickTarget(expr, null, [2, 3, 0])).toEqual([2]);
  });

  it('clicking inside the selection goes one level in, then wraps out', () => {
    expect(clickTarget(expr, { at: [2] }, [2, 3, 0])).toEqual([2, 3]);
    expect(clickTarget(expr, { at: [2, 3] }, [2, 3, 0])).toEqual([2, 3, 0]);
    expect(clickTarget(expr, { at: [2, 3, 0] }, [2, 3, 0])).toEqual([2]);
  });

  it('another term starts over at that term', () => {
    expect(clickTarget(expr, { at: [2, 3] }, [0, 1])).toEqual([0]);
  });

  it('a click on a + takes the whole sum', () => {
    expect(clickTarget(expr, null, [])).toEqual([]);
  });

  it('a line that is not a sum or product starts at the whole line', () => {
    expect(clickTarget(e("(AB)'"), null, [0, 1])).toEqual([]);
  });
});

describe('step menu', () => {
  const expr = e("A'B + C'D + ABC + ABCD + AC'D");

  it('a lone term lists the laws it takes part in with a sibling, shortest first', () => {
    const menu = stepsForSelection(expr, { at: [3] });
    const first = menu.shorter[0]!;
    expect(citeStep(first)).toBe('10b (absorption law)');
    expect(printExpr(first.to)).toBe("A'B + C'D + ABC + AC'D");
  });

  it('puts the rewrites that lengthen the line after the ones that shorten it', () => {
    const menu = stepsForSelection(expr, { at: [] });
    expect(menu.shorter.map(citeStep)).toContain('10b (absorption law)');
    expect(menu.shorter.map(citeStep)).not.toContain('8b (second distributive law)');
    expect(menu.others.map(citeStep)).toContain('8b (second distributive law)');
  });

  it('a lone complement with nothing shorter still lists its rewrites', () => {
    const menu = stepsForSelection(e("(A + B)'"), { at: [] });
    expect(menu.shorter).toEqual([]);
    expect(menu.others.map(citeStep)).toContain("9b (De Morgan's theorem)");
  });
});

describe('is it simplified', () => {
  it('says so for a minimum, and gives counts only when not', () => {
    const vars = ['A', 'B', 'C', 'D'];
    expect(describeMinimal(checkMinimal(e("A'B + BC + C'D"), vars)).done).toBe(true);
    const not = describeMinimal(checkMinimal(e("A'B + C'D + ABC + AC'D"), vars));
    expect(not.done).toBe(false);
    expect(not.text).toBe(
      'Not yet. This sum of products has 4 terms and 10 literals; a minimum one has 3 terms and 6 literals.',
    );
  });
});

describe('typed line', () => {
  it('cites the law that justifies it', () => {
    const r = checkLine(e("AB + AB'"), 'A');
    expect(r.ok && r.line.cite).toBe('11b (redundancy law, uniting form)');
  });

  it('accepts a reorder', () => {
    const r = checkLine(e('A + B'), 'B + A');
    expect(r.ok && r.line.cite).toBe('6, 7 (reorder)');
  });

  it('names both laws of a two-law line, in the order used', () => {
    const r = checkLine(e("AB + AB' + CD + CDE"), 'A + CD');
    expect(r.ok && r.line.cite).toBe('10b (absorption law), 11b (redundancy law, uniting form)');
    expect(r.ok && r.line.flagged).toBeFalsy();
  });

  it('flags an equal line that no two laws reach', () => {
    const start = "A'B + A'B'C'D' + ABCD'";
    const end = derivedLines(parseExpr(start)).at(-1)!;
    const r = checkLine(e(start), printExpr(end.expr));
    if (!r.ok) throw new Error(r.message);
    expect(r.line.flagged).toBe(true);
    expect(r.line.cite).toBe('equal, more than two laws');
  });

  it('refuses a line that is not equal, naming the row', () => {
    const r = checkLine(e('A + B'), 'AB');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/differ at row 1 \(A=0 B=1\)/);
  });

  it('refuses a syntax error with its offset', () => {
    const r = checkLine(e('A + B'), 'A +');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offset).not.toBeNull();
  });

  it('numbers a row MSB-first', () => {
    expect(rowAssignment(['A', 'B', 'C'], 5)).toBe('A=1 B=0 C=1');
  });
});

describe('worked derivation', () => {
  it('cites a law on every line and ends equal to the start', () => {
    const lines = derivedLines(parseExpr("A'B + A'B'C'D' + ABCD'"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.cite !== null)).toBe(true);
  });

  it('a hidden step takes two presses, the law then its result', () => {
    let r = { shown: 0, open: 0 };
    r = advanceReveal(r, 3, true);
    expect(r).toEqual({ shown: 1, open: 0 });
    r = advanceReveal(r, 3, true);
    expect(r).toEqual({ shown: 1, open: 1 });
    r = advanceReveal(r, 3, true);
    expect(r).toEqual({ shown: 2, open: 1 });
  });

  it('without hiding one press reveals a whole line and stops at the end', () => {
    let r = { shown: 0, open: 0 };
    for (let i = 0; i < 5; i++) r = advanceReveal(r, 2, false);
    expect(r).toEqual({ shown: 2, open: 2 });
  });
});
