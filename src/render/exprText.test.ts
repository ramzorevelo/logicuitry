import { describe, expect, it } from 'vitest';
import { parseExpr, type Expr } from '../core/boolean/expr';
import { layoutExprText } from './exprText';

// Every glyph 10 wide, so positions are character counts times ten.
const ctx = {
  measureText: (s: string) => ({ width: s.length * 10 }),
} as unknown as CanvasRenderingContext2D;

const text = (e: Expr) =>
  layoutExprText(ctx, e)
    .runs.map((r) => r.text)
    .join('');

describe('layoutExprText', () => {
  it('stacks a bar above the bar inside it', () => {
    const l = layoutExprText(ctx, parseExpr("(A'B)'"));
    expect(l.runs.map((r) => r.text).join('')).toBe('AB');
    expect(l.bars).toBe(2);
    expect(l.barSpans).toEqual([
      { x0: 0, x1: 10, level: 1 },
      { x0: 0, x1: 20, level: 2 },
    ]);
  });

  it('brackets by precedence and never inside a bar', () => {
    expect(text(parseExpr("(A + B)C + (A + B)'"))).toBe('(A + B)C + A + B');
  });

  it('keeps a nested product of the same kind bracketed, as built', () => {
    const e: Expr = {
      kind: 'and',
      args: [
        {
          kind: 'and',
          args: [
            { kind: 'var', name: 'A' },
            { kind: 'var', name: 'B' },
          ],
        },
        { kind: 'var', name: 'C' },
      ],
    };
    expect(text(e)).toBe('(AB)C');
  });

  it('puts a dot beside a name that would fuse with its neighbour', () => {
    const e: Expr = {
      kind: 'and',
      args: [
        { kind: 'var', name: 'U3.13' },
        { kind: 'not', a: { kind: 'var', name: 'A' } },
      ],
    };
    expect(text(e)).toBe('U3.13·A');
  });
});
