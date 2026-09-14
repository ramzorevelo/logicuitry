// Harris & Harris syntax, widened to the spellings students arrive with: the
// C-style and word operators both reference tools accept.
// Precedence is NOT > AND > XOR > OR.

import * as bv from '../value/busValue';
import type { TruthTable } from './truthTable';
import { MAX_TABLE_INPUTS } from './truthTable';

export type Expr =
  | { kind: 'const'; value: 0 | 1 }
  | { kind: 'var'; name: string }
  | { kind: 'not'; a: Expr }
  | { kind: 'and'; args: Expr[] }
  | { kind: 'or'; args: Expr[] }
  | { kind: 'xor'; args: Expr[] };

/** `offset` so the dialog can put a caret under the offending character. */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

type TokenKind = 'var' | 'const' | 'and' | 'or' | 'xor' | 'not' | 'post-not' | '(' | ')';

interface Token {
  kind: TokenKind;
  text: string;
  offset: number;
}

const WORDS: Record<string, TokenKind> = {
  AND: 'and',
  OR: 'or',
  XOR: 'xor',
  NOT: 'not',
};

const SYMBOLS: Record<string, TokenKind> = {
  '·': 'and', // middle dot
  '*': 'and',
  '&': 'and',
  '+': 'or',
  '|': 'or',
  '^': 'xor',
  '⊕': 'xor', // circled plus
  '~': 'not',
  '!': 'not',
  '¬': 'not', // not sign
  "'": 'post-not',
  '(': '(',
  ')': ')',
};

const isLetter = (c: string): boolean => /[A-Za-z]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);

/** A name is one letter plus digits, so `AB` is the product the textbook means.
 *  Word operators match first, or `AND` would read as three variables. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const sym = SYMBOLS[c];
    if (sym) {
      out.push({ kind: sym, text: c, offset: i });
      i++;
      continue;
    }
    if (isDigit(c)) {
      if (c !== '0' && c !== '1') throw new ExprError(`only 0 and 1 are constants, not ${c}`, i);
      out.push({ kind: 'const', text: c, offset: i });
      i++;
      continue;
    }
    if (isLetter(c)) {
      const word = /^[A-Za-z]+/.exec(src.slice(i))![0];
      const op = WORDS[word.toUpperCase()];
      if (op) {
        out.push({ kind: op, text: word, offset: i });
        i += word.length;
        continue;
      }
      let j = i + 1;
      while (j < src.length && isDigit(src[j]!)) j++;
      out.push({ kind: 'var', text: src.slice(i, j), offset: i });
      i = j;
      continue;
    }
    throw new ExprError(`unexpected character ${c}`, i);
  }
  return out;
}

export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const endOffset = (): number => tokens[tokens.length - 1]?.offset ?? src.length;

  const expect = (kind: TokenKind, what: string): Token => {
    const t = peek();
    if (!t) throw new ExprError(`expected ${what}`, endOffset() + 1);
    if (t.kind !== kind) throw new ExprError(`expected ${what}, found ${t.text}`, t.offset);
    pos++;
    return t;
  };

  // Juxtaposition is AND, so an operand where an operator could go is the
  // signal for it.
  const startsOperand = (t: Token | undefined): boolean =>
    t !== undefined &&
    (t.kind === 'var' || t.kind === 'const' || t.kind === '(' || t.kind === 'not');

  const primary = (): Expr => {
    const t = peek();
    if (!t) throw new ExprError('expected a variable or a constant', endOffset() + 1);
    if (t.kind === '(') {
      pos++;
      const inner = or();
      expect(')', 'a closing parenthesis');
      return inner;
    }
    if (t.kind === 'var') {
      pos++;
      return { kind: 'var', name: t.text };
    }
    if (t.kind === 'const') {
      pos++;
      return { kind: 'const', value: t.text === '1' ? 1 : 0 };
    }
    throw new ExprError(`expected a variable or a constant, found ${t.text}`, t.offset);
  };

  const postfix = (): Expr => {
    let e = primary();
    while (peek()?.kind === 'post-not') {
      pos++;
      e = { kind: 'not', a: e };
    }
    return e;
  };

  const unary = (): Expr => {
    if (peek()?.kind === 'not') {
      pos++;
      return { kind: 'not', a: unary() };
    }
    return postfix();
  };

  const and = (): Expr => {
    const args = [unary()];
    for (;;) {
      if (peek()?.kind === 'and') pos++;
      else if (!startsOperand(peek())) break;
      args.push(unary());
    }
    return args.length === 1 ? args[0]! : { kind: 'and', args };
  };

  const xor = (): Expr => {
    const args = [and()];
    while (peek()?.kind === 'xor') {
      pos++;
      args.push(and());
    }
    return args.length === 1 ? args[0]! : { kind: 'xor', args };
  };

  function or(): Expr {
    const args = [xor()];
    while (peek()?.kind === 'or') {
      pos++;
      args.push(xor());
    }
    return args.length === 1 ? args[0]! : { kind: 'or', args };
  }

  if (tokens.length === 0) throw new ExprError('the expression is empty', 0);
  const e = or();
  const rest = peek();
  if (rest) throw new ExprError(`unexpected ${rest.text}`, rest.offset);
  return e;
}

/** Sorted, so the same function always yields the same column order. */
export function exprVars(e: Expr): string[] {
  const names = new Set<string>();
  const walk = (n: Expr): void => {
    if (n.kind === 'var') names.add(n.name);
    else if (n.kind === 'not') walk(n.a);
    else if (n.kind !== 'const') n.args.forEach(walk);
  };
  walk(e);
  return [...names].sort();
}

export function evalExpr(e: Expr, env: ReadonlyMap<string, 0 | 1>): 0 | 1 {
  switch (e.kind) {
    case 'const':
      return e.value;
    case 'var': {
      const v = env.get(e.name);
      if (v === undefined) throw new ExprError(`no value for ${e.name}`, 0);
      return v;
    }
    case 'not':
      return evalExpr(e.a, env) === 1 ? 0 : 1;
    case 'and':
      return e.args.every((a) => evalExpr(a, env) === 1) ? 1 : 0;
    case 'or':
      return e.args.some((a) => evalExpr(a, env) === 1) ? 1 : 0;
    case 'xor':
      return e.args.reduce((acc: 0 | 1, a) => (acc ^ evalExpr(a, env)) as 0 | 1, 0);
  }
}

/** The existing `TruthTable` shape, so every K-map consumer works on an
 *  expression unchanged. */
export function truthTableOfExpr(e: Expr, outputName = 'Y'): TruthTable {
  const vars = exprVars(e);
  if (vars.length > MAX_TABLE_INPUTS)
    throw new ExprError(
      `${vars.length} variables, at most ${MAX_TABLE_INPUTS} can be tabulated`,
      0,
    );
  const rows = Array.from({ length: 1 << vars.length }, (_, m) => {
    const env = new Map<string, 0 | 1>(
      vars.map((name, i) => [name, ((m >> (vars.length - 1 - i)) & 1) as 0 | 1]),
    );
    return [bv.known(evalExpr(e, env), 1)];
  });
  return { inputPaths: vars, outputPaths: [outputName], rows };
}

const PRECEDENCE: Record<Expr['kind'], number> = {
  const: 4,
  var: 4,
  not: 3,
  and: 2,
  xor: 1,
  or: 0,
};

/** Harris & Harris spelling, parenthesised only where precedence needs it, so
 *  a round trip through the parser is stable. */
export function printExpr(e: Expr): string {
  const wrap = (child: Expr, minimum: number): string => {
    const text = printExpr(child);
    return PRECEDENCE[child.kind] < minimum ? `(${text})` : text;
  };
  switch (e.kind) {
    case 'const':
      return String(e.value);
    case 'var':
      return e.name;
    case 'not':
      return `${wrap(e.a, PRECEDENCE.not)}'`;
    case 'and':
      // Juxtaposition, except where it would fuse into one token: `A` next to
      // the constant `1` has to keep a dot or it re-parses as the variable A1.
      return e.args
        .map((a) => wrap(a, PRECEDENCE.and))
        .reduce((acc, text) => (/^[0-9]/.test(text) ? `${acc}·${text}` : acc + text));
    case 'xor':
      return e.args.map((a) => wrap(a, PRECEDENCE.xor)).join(' ⊕ ');
    case 'or':
      return e.args.map((a) => wrap(a, PRECEDENCE.or)).join(' + ');
  }
}

/** Disables the NAND-only option, the same restriction Logisim applies. */
export function hasXor(e: Expr): boolean {
  if (e.kind === 'xor') return true;
  if (e.kind === 'not') return hasXor(e.a);
  if (e.kind === 'const' || e.kind === 'var') return false;
  return e.args.some(hasXor);
}
