// One worked derivation, a single law per step, in the order the chapter
// teaches: remove XOR, push complements in, multiply out, then the four moves.
// It never claims a minimum; it stops when no move applies.

import type { Expr } from './expr';
import type { LawId } from './laws';
import {
  acKey,
  allSteps,
  applicable,
  complement,
  isNary,
  literalCount,
  makeStep,
  type Nary,
  nodeAt,
  nodePaths,
  normalize,
  type Step,
} from './rewrite';

const CLEANUPS: ReadonlySet<LawId> = new Set(['5', '1a', '1b', '2a', '2b', '3a', '3b', '4a', '4b']);
const XOR_ROWS: ReadonlySet<LawId> = new Set(['15b', '14b']);
const COMBINE: ReadonlySet<LawId> = new Set(['11b']);
const ELIMINATE_TERMS: ReadonlySet<LawId> = new Set(['10b', '13b']);
const ELIMINATE_LITERALS: ReadonlySet<LawId> = new Set(['12b']);

/** A safety net, not a tuning knob: every move but the lookahead addition
 *  shrinks the expression, and that one is always followed by a removal. */
const MAX_STEPS = 200;

const LAW_RANK = (ids: readonly LawId[]): Map<string, number> =>
  new Map(ids.map((id, i) => [id, i]));

/** Where one list extends the other, the longer wins: `X·0` on `A·0·C` takes
 *  the whole product in one step. */
const compareNumbers = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return b.length - a.length;
};

/** Leftmost node in printed order, then leftmost operands, then the class's
 *  law order, then the shorter result. */
function pickLeftmost(e: Expr, steps: readonly Step[], order: readonly LawId[]): Step | null {
  if (steps.length === 0) return null;
  const pos = new Map(nodePaths(e).map((p, i) => [p.join('.'), i]));
  const rank = LAW_RANK(order);
  return [...steps].sort(
    (a, b) =>
      pos.get(a.at.join('.'))! - pos.get(b.at.join('.'))! ||
      compareNumbers(a.operands ?? [], b.operands ?? []) ||
      (rank.get(a.law) ?? 0) - (rank.get(b.law) ?? 0) ||
      literalCount(a.to) - literalCount(b.to) ||
      acKey(a.to).localeCompare(acKey(b.to)),
  )[0]!;
}

const ltrOf = (steps: readonly Step[], laws: ReadonlySet<LawId>): Step[] =>
  steps.filter((s) => s.direction === 'ltr' && s.law !== 'reorder' && laws.has(s.law));

const isLiteral = (e: Expr): boolean =>
  e.kind === 'var' || (e.kind === 'not' && e.a.kind === 'var');

const literalName = (e: Expr): string =>
  e.kind === 'var' ? e.name : e.kind === 'not' && e.a.kind === 'var' ? e.a.name : '';

/** Alphabetical within a product, as the chapter writes `BBC + BCC`. Folded
 *  into the multiply-out step, since reordering is implicit in every rewrite. */
function sortLiterals(args: readonly Expr[]): Expr[] {
  if (!args.every(isLiteral)) return [...args];
  return [...args].sort(
    (a, b) =>
      literalName(a).localeCompare(literalName(b)) ||
      (a.kind === 'not' ? 1 : 0) - (b.kind === 'not' ? 1 : 0),
  );
}

const product = (args: readonly Expr[]): Expr =>
  args.length === 1 ? args[0]! : { kind: 'and', args: [...args] };

function deMorganStep(e: Expr): Step | null {
  for (const at of nodePaths(e)) {
    const n = nodeAt(e, at);
    if (n.kind !== 'not' || (n.a.kind !== 'and' && n.a.kind !== 'or')) continue;
    const law = n.a.kind === 'and' ? '9a' : '9b';
    const sub: Expr = {
      kind: n.a.kind === 'and' ? 'or' : 'and',
      args: n.a.args.map(complement),
    };
    return makeStep(e, at, { law, direction: 'ltr' }, sub);
  }
  return null;
}

/** Row 8b right to left where two sums share a term (the shorter road), else
 *  row 8a over the whole leftmost product of sums. */
function multiplyOutStep(e: Expr, steps: readonly Step[]): Step | null {
  const factor = steps.filter((s) => s.law === '8b' && s.direction === 'rtl');
  if (factor.length > 0) return pickLeftmost(e, factor, ['8b']);
  for (const at of nodePaths(e)) {
    const n = nodeAt(e, at);
    if (n.kind !== 'and' || !n.args.some((a) => a.kind === 'or')) continue;
    let terms: Expr[][] = [[]];
    for (const a of n.args) {
      const choices = a.kind === 'or' ? a.args : [a];
      terms = terms.flatMap((t) => choices.map((c) => [...t, c]));
    }
    const sub: Expr = {
      kind: 'or',
      args: terms.map((t) => product(sortLiterals(normalizeAll(t)))),
    };
    return makeStep(e, at, { law: '8a', direction: 'ltr' }, sub, [...n.args.keys()]);
  }
  return null;
}

const normalizeAll = (args: readonly Expr[]): Expr[] =>
  args.flatMap((a) => {
    const n = normalize(a);
    return n.kind === 'and' ? n.args : [n];
  });

const operandsOf = (term: Expr): Expr[] => (term.kind === 'and' ? term.args : [term]);

const complementKey = (lit: Expr): string => acKey(complement(lit));

/** `F·L + F·L'·R`: factor F out (8a right to left), then row 12b inside the
 *  parentheses. The next multiply-out restores the sum, so the pair nets
 *  `F·L + F·R`, one literal fewer. This is the chapter's route through
 *  `A'(B + B'C'D')`. */
function factorThenEliminate(e: Expr): Step[] | null {
  const candidates: { at: number[]; consumed: number[]; steps: Step[] }[] = [];
  for (const at of nodePaths(e)) {
    const n = nodeAt(e, at);
    if (n.kind !== 'or') continue;
    for (let i = 0; i < n.args.length; i++)
      for (let j = 0; j < n.args.length; j++) {
        if (i === j) continue;
        const steps = tryFactor(e, at, n, i, j);
        if (steps) candidates.push({ at, consumed: [i, j].sort((a, b) => a - b), steps });
      }
  }
  if (candidates.length === 0) return null;
  const pos = new Map(nodePaths(e).map((p, i) => [p.join('.'), i]));
  candidates.sort(
    (a, b) =>
      pos.get(a.at.join('.'))! - pos.get(b.at.join('.'))! || compareNumbers(a.consumed, b.consumed),
  );
  return candidates[0]!.steps;
}

function tryFactor(e: Expr, at: number[], n: Nary, i: number, j: number): Step[] | null {
  const t1 = operandsOf(n.args[i]!);
  const t2 = operandsOf(n.args[j]!);
  if (!t1.every(isLiteral) || !t2.every(isLiteral)) return null;
  const k2 = t2.map(acKey);
  const common = t1.filter((a) => k2.includes(acKey(a)));
  const rest1 = t1.filter((a) => !k2.includes(acKey(a)));
  if (common.length === 0 || rest1.length !== 1) return null;
  const lit = rest1[0]!;
  const opposite = complementKey(lit);
  const commonKeys = common.map(acKey);
  const rest2 = t2.filter((a) => !commonKeys.includes(acKey(a)));
  const oppositeAt = rest2.findIndex((a) => acKey(a) === opposite);
  if (oppositeAt < 0 || rest2.length < 2) return null;

  const inner: Expr = { kind: 'or', args: [lit, product(rest2)] };
  const factored = product([...common, inner]);
  const first = Math.min(i, j);
  const args = n.args.flatMap((a, k) => (k === first ? [factored] : k === i || k === j ? [] : [a]));
  const sub: Expr = args.length === 1 ? args[0]! : { kind: 'or', args };
  const factor = makeStep(
    e,
    at,
    { law: '8a', direction: 'rtl' },
    sub,
    [i, j].sort((a, b) => a - b),
  );

  // Normalizing can flatten the factored product into an enclosing one and
  // move it; then there is no inner sum to rewrite and the move is skipped.
  const innerAt = [...at, ...(args.length === 1 ? [] : [first]), common.length];
  let eliminate: Step | undefined;
  try {
    eliminate = applicable(factor.to, innerAt).find(
      (s) => s.law === '12b' && s.direction === 'ltr',
    );
  } catch {
    return null;
  }
  return eliminate ? [factor, eliminate] : null;
}

/** Row 13b right to left, adding a consensus term, taken only when it lets a
 *  row 10b or 13b removal drop a term other than the new one or its parents. */
function lookaheadAddition(e: Expr): Step[] | null {
  for (const at of nodePaths(e)) {
    const n = nodeAt(e, at);
    if (n.kind !== 'or') continue;
    const terms = n.args.map(operandsOf);
    if (!terms.every((t) => t.every(isLiteral))) continue;
    for (let i = 0; i < terms.length; i++)
      for (let j = i + 1; j < terms.length; j++) {
        const c = consensus(terms[i]!, terms[j]!);
        if (!c) continue;
        const ck = new Set(c.map(acKey));
        if (terms.some((t) => t.every((a) => ck.has(acKey(a))))) continue;
        const added = product(c);
        const add = makeStep(
          e,
          at,
          { law: '13b', direction: 'rtl' },
          { kind: 'or', args: [...n.args, added] },
          [i, j],
        );
        const keep = [acKey(added), acKey(n.args[i]!), acKey(n.args[j]!)];
        const removals = ltrOf(allSteps(add.to), ELIMINATE_TERMS).filter((s) => {
          if (s.at.join('.') !== at.join('.')) return false;
          const node = nodeAt(s.to, at);
          const left = isNary(node) && node.kind === 'or' ? node.args.map(acKey) : [acKey(node)];
          return keep.every((k) => left.includes(k));
        });
        const removal = pickLeftmost(add.to, removals, ['10b', '13b']);
        if (removal) return [add, removal];
      }
  }
  return null;
}

/** The consensus of two products that clash in exactly one variable. */
function consensus(t1: readonly Expr[], t2: readonly Expr[]): Expr[] | null {
  const k2 = t2.map(acKey);
  const clashes = t1.filter((a) => k2.includes(complementKey(a)));
  if (clashes.length !== 1) return null;
  const x = clashes[0]!;
  const xk = acKey(x);
  const xbar = complementKey(x);
  const out: Expr[] = [];
  const seen = new Set<string>();
  for (const a of [...t1.filter((a) => acKey(a) !== xk), ...t2.filter((a) => acKey(a) !== xbar)]) {
    const k = acKey(a);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(a);
    }
  }
  return out.length > 0 ? out : null;
}

/** A chain `A ⊕ B ⊕ C` loses one operator at a time, left pair first. */
const pairwise = (s: Step): boolean => (s.operands?.length ?? 2) === 2;

function nextSteps(e: Expr): Step[] | null {
  const steps = allSteps(e);
  const one = (s: Step | null): Step[] | null => (s ? [s] : null);
  return (
    one(pickLeftmost(e, ltrOf(steps, CLEANUPS), [...CLEANUPS])) ??
    one(pickLeftmost(e, ltrOf(steps, XOR_ROWS).filter(pairwise), [...XOR_ROWS])) ??
    one(deMorganStep(e)) ??
    one(multiplyOutStep(e, steps)) ??
    one(pickLeftmost(e, ltrOf(steps, COMBINE), [...COMBINE])) ??
    one(pickLeftmost(e, ltrOf(steps, ELIMINATE_TERMS), [...ELIMINATE_TERMS])) ??
    one(pickLeftmost(e, ltrOf(steps, ELIMINATE_LITERALS), [...ELIMINATE_LITERALS])) ??
    factorThenEliminate(e) ??
    lookaheadAddition(e)
  );
}

/** One deterministic worked path from `e`; each step's `from` is the previous
 *  step's `to`. Empty when no move applies. */
export function derive(e: Expr): Step[] {
  const out: Step[] = [];
  let current = normalize(e);
  while (out.length < MAX_STEPS) {
    const next = nextSteps(current);
    if (!next) break;
    out.push(...next);
    current = next[next.length - 1]!.to;
  }
  return out;
}
