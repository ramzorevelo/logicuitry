import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { parseInline, parseMarkdown, renderMarkdown } from './markdown';

const text = (t: string) => ({ kind: 'text', text: t });

describe('parseInline', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('**V** is *set* when `y` is _odd_')).toEqual([
      { kind: 'strong', children: [text('V')] },
      text(' is '),
      { kind: 'em', children: [text('set')] },
      text(' when '),
      { kind: 'code', text: 'y' },
      text(' is '),
      { kind: 'em', children: [text('odd')] },
    ]);
  });

  it('nests italic inside bold', () => {
    expect(parseInline('**a *b* c**')).toEqual([
      {
        kind: 'strong',
        children: [text('a '), { kind: 'em', children: [text('b')] }, text(' c')],
      },
    ]);
  });

  it('keeps code literal', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
  });

  it('leaves arithmetic, snake_case and unmatched marks alone', () => {
    expect(parseInline('5 * 3 * 2')).toEqual([text('5 * 3 * 2')]);
    expect(parseInline('a_b_c')).toEqual([text('a_b_c')]);
    expect(parseInline('**open')).toEqual([text('**open')]);
    expect(parseInline('a ` b')).toEqual([text('a ` b')]);
  });

  it('keeps links, images and HTML as plain text', () => {
    expect(parseInline('[x](http://e) ![i](p.png) <b>hi</b>')).toEqual([
      text('[x](http://e) ![i](p.png) <b>hi</b>'),
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and groups bullets', () => {
    expect(parseMarkdown('One\ntwo\n\n- a\n* b\n\nThree')).toEqual([
      { kind: 'p', lines: [[text('One')], [text('two')]] },
      { kind: 'ul', items: [[text('a')], [text('b')]] },
      { kind: 'p', lines: [[text('Three')]] },
    ]);
  });

  it('reads CRLF files and drops empty input', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2);
    expect(parseMarkdown('  \n')).toEqual([]);
  });

  it('does not read a bold line as a bullet', () => {
    expect(parseMarkdown('**V** flag')[0]?.kind).toBe('p');
  });
});

describe('renderMarkdown', () => {
  it('builds plain elements with no inner HTML', () => {
    const nodes = renderMarkdown('**V** <i>x</i>\n\n- one');
    const [p, ul] = nodes as ReactElement<Record<string, unknown>>[];
    expect(isValidElement(p) && p.type).toBe('p');
    expect(isValidElement(ul) && ul.type).toBe('ul');
    const walk = (n: unknown): void => {
      if (!isValidElement(n)) return;
      const props = n.props as Record<string, unknown>;
      expect(props['dangerouslySetInnerHTML']).toBeUndefined();
      const kids = props['children'];
      (Array.isArray(kids) ? kids : [kids]).forEach(walk);
    };
    nodes.forEach(walk);
    expect((p!.props['children'] as unknown[])[1]).toBe(' <i>x</i>');
  });
});
