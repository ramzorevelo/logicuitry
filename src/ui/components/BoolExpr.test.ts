import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseExpr } from '../../core/boolean/expr';
import { BoolExpr } from './BoolExpr';

const html = (src: string, bracketed = false) =>
  renderToStaticMarkup(createElement(BoolExpr, { expr: parseExpr(src), bracketed }));
const text = (h: string) => h.replace(/<[^>]+>/g, '');

describe('BoolExpr', () => {
  it('stacks a bar per nesting level instead of one merged overline', () => {
    const h = html("((A'B)')'");
    expect(h.match(/boolexpr__not/g)).toHaveLength(3);
  });

  it('brackets only where precedence needs it', () => {
    expect(text(html('(A + B)C'))).toBe('(A + B)C');
    expect(text(html('AB + C'))).toBe('AB + C');
    expect(text(html('A(BC)'))).toBe('A(BC)');
  });

  it('keeps a same-kind grouping, as the associative law prints it', () => {
    expect(text(html('X + (Y + Z)'))).toBe('X + (Y + Z)');
  });

  it('a complement is never bracketed by its parent', () => {
    expect(text(html("(A + B)'"))).toBe('A + B');
  });

  it('brackets a whole maxterm on request', () => {
    expect(text(html("A + B'", true))).toBe('(A + B)');
  });
});
