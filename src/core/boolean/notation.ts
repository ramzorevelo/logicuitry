// Reads a function given as index lists: `F(A,B,C) = Σm(1,3,5) + Σd(7)` or
// `ΠM(0,2) · ΠD(7)`. Errors carry an offset like ExprError.

import * as bv from '../value/busValue';
import { ExprError } from './expr';
import { MAX_TABLE_INPUTS, type TruthTable } from './truthTable';

export interface FunctionSpec {
  table: TruthTable;
  dontCares: Set<number>;
  form: 'sop' | 'pos';
}

type ListKind = 'm' | 'd' | 'M' | 'D';

// Longest names first so `sum` is not read as `m`'s neighbour.
const LIST_NAMES: readonly (readonly [string, ListKind])[] = [
  ['Σm', 'm'],
  ['Σd', 'd'],
  ['ΠM', 'M'],
  ['ΠD', 'D'],
  ['sum', 'm'],
  ['prod', 'M'],
  ['m', 'm'],
  ['d', 'd'],
  ['M', 'M'],
  ['D', 'D'],
];

const PREFIX = /^\s*[A-Za-z]\w*\s*\(\s*([A-Za-z]\d*(?:\s*,\s*[A-Za-z]\d*)*)\s*\)\s*=/;

function matchListName(src: string, at: number): { kind: ListKind; end: number } | null {
  for (const [name, kind] of LIST_NAMES) {
    const isWord = /^[a-z]+$/i.test(name) && name.length > 1;
    const head = src.slice(at, at + name.length);
    if (isWord ? head.toLowerCase() !== name : head !== name) continue;
    let end = at + name.length;
    while (/\s/.test(src[end] ?? '')) end++;
    if (src[end] === '(') return { kind, end };
  }
  return null;
}

/** `defaultVars` supplies the variable names when there is no `F(A,B,C) =` prefix,
 *  since `Σm(1,3)` does not say whether it is two variables or three. */
export function parseFunctionSpec(src: string, defaultVars: readonly string[]): FunctionSpec {
  let pos = 0;
  let vars = defaultVars;
  const prefix = PREFIX.exec(src);
  if (prefix) {
    vars = prefix[1]!.split(',').map((v) => v.trim());
    if (new Set(vars).size !== vars.length) throw new ExprError('a variable is named twice', 0);
    pos = prefix[0].length;
  }
  if (vars.length < 1 || vars.length > MAX_TABLE_INPUTS)
    throw new ExprError(`${vars.length} variables, use 1 to ${MAX_TABLE_INPUTS}`, 0);
  const size = 1 << vars.length;

  const lists = new Map<ListKind, Set<number>>();
  const skipSpace = (): void => {
    while (/\s/.test(src[pos] ?? '')) pos++;
  };

  skipSpace();
  if (pos >= src.length) throw new ExprError('the function is empty', pos);
  for (;;) {
    skipSpace();
    const name = matchListName(src, pos);
    if (!name) throw new ExprError('expected Σm(...), Σd(...), ΠM(...) or ΠD(...)', pos);
    if (lists.has(name.kind)) throw new ExprError(`${name.kind}(...) is given twice`, pos);
    pos = name.end + 1;
    const set = new Set<number>();
    skipSpace();
    // An empty list is allowed: Σm() is the constant 0.
    if (src[pos] !== ')') {
      for (;;) {
        skipSpace();
        const digits = /^\d+/.exec(src.slice(pos));
        if (!digits) throw new ExprError('expected a row number', pos);
        const index = Number(digits[0]);
        if (index >= size)
          throw new ExprError(`row ${index} is out of range for ${vars.length} variables`, pos);
        set.add(index);
        pos += digits[0].length;
        skipSpace();
        if (src[pos] === ',') {
          pos++;
          continue;
        }
        break;
      }
    }
    if (src[pos] !== ')') throw new ExprError('expected a comma or a closing parenthesis', pos);
    pos++;
    lists.set(name.kind, set);
    skipSpace();
    if (pos >= src.length) break;
    if (src[pos] === '+' || src[pos] === '·' || src[pos] === '*') pos++;
    else throw new ExprError(`unexpected ${src[pos]}`, pos);
  }

  const sumForm = lists.has('m') || lists.has('d');
  const productForm = lists.has('M') || lists.has('D');
  if (sumForm && productForm) throw new ExprError('mix of sum and product lists', 0);
  if (!lists.has('m') && !lists.has('M'))
    throw new ExprError('a function needs a Σm(...) or ΠM(...) list', 0);

  const form = sumForm ? 'sop' : 'pos';
  const listed = lists.get(sumForm ? 'm' : 'M')!;
  const dontCares = lists.get(sumForm ? 'd' : 'D') ?? new Set<number>();
  for (const i of dontCares)
    if (listed.has(i)) throw new ExprError(`row ${i} is both listed and a don't-care`, 0);

  // A don't-care row is stored as 0; the set, not the value, marks it.
  const rows = Array.from({ length: size }, (_, i) => {
    const one = form === 'sop' ? listed.has(i) : !listed.has(i) && !dontCares.has(i);
    return [bv.known(one ? 1 : 0, 1)];
  });
  return {
    table: { inputPaths: vars, outputPaths: ['F'], rows },
    dontCares: new Set(dontCares),
    form,
  };
}
