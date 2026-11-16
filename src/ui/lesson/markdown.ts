// The lesson prose subset: bold, italic, inline code, bullet lists and
// paragraphs. Built as React elements, never as HTML, so a lesson file cannot
// inject markup; links, images and raw HTML stay literal text.

import { createElement, type ReactNode } from 'react';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] };

export type Block = { kind: 'p'; lines: Inline[][] } | { kind: 'ul'; items: Inline[][] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Index of a closing delimiter, or -1; a closer needs a non-space before it,
 *  and `_` a non-word after it, so snake_case and `5 * 3` stay literal. */
function closerOf(text: string, delim: string, from: number): number {
  for (let at = text.indexOf(delim, from); at >= 0; at = text.indexOf(delim, at + 1)) {
    if (at === from || /\s/.test(text[at - 1]!)) continue;
    if (delim === '*' && text[at + 1] === '*') {
      at++;
      continue;
    }
    if (delim === '_' && isWordChar(text[at + 1])) continue;
    return at;
  }
  return -1;
}

function opens(text: string, i: number, delim: string): boolean {
  const after = text[i + delim.length];
  if (after === undefined || /\s/.test(after)) return false;
  return delim !== '_' || !isWordChar(text[i - 1]);
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    const delim = text.startsWith('**', i) ? '**' : ch === '*' || ch === '_' ? ch : null;
    if (delim && opens(text, i, delim)) {
      const start = i + delim.length;
      const end = closerOf(text, delim, start);
      if (end > start) {
        flush();
        const children = parseInline(text.slice(start, end));
        out.push(delim === '**' ? { kind: 'strong', children } : { kind: 'em', children });
        i = end + delim.length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** Blank lines part paragraphs; a run of `-` or `*` lines is one list. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      current = null;
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      if (current?.kind !== 'ul') {
        current = { kind: 'ul', items: [] };
        blocks.push(current);
      }
      current.items.push(parseInline(bullet[1]!.trim()));
      continue;
    }
    if (current?.kind !== 'p') {
      current = { kind: 'p', lines: [] };
      blocks.push(current);
    }
    current.lines.push(parseInline(line));
  }
  return blocks;
}

function inlineNodes(parts: readonly Inline[]): ReactNode[] {
  return parts.map((part, i) => {
    switch (part.kind) {
      case 'text':
        return part.text;
      case 'code':
        return createElement('code', { key: i }, part.text);
      case 'strong':
        return createElement('strong', { key: i }, ...inlineNodes(part.children));
      case 'em':
        return createElement('em', { key: i }, ...inlineNodes(part.children));
    }
  });
}

/** Lines of one paragraph join with a space, as Markdown reflows them. */
export function renderMarkdown(source: string): ReactNode[] {
  return parseMarkdown(source).map((block, i) =>
    block.kind === 'ul'
      ? createElement(
          'ul',
          { key: i },
          block.items.map((item, j) => createElement('li', { key: j }, ...inlineNodes(item))),
        )
      : createElement(
          'p',
          { key: i },
          ...block.lines.flatMap((line, j): ReactNode[] =>
            j === 0 ? inlineNodes(line) : [' ', ...inlineNodes(line)],
          ),
        ),
  );
}
