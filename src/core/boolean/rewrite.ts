// Applying one row of the laws table to an expression, and naming the row a
// hand-written step used. Reordering and regrouping (rows 6 and 7) are implicit
// in every rewrite, so every comparison is modulo AC.

import { type Expr, exprVars, evalExpr, ExprError, parseExpr } from './expr';
import { LAWS, lawLabel, type LawId } from './laws';
import { MAX_TABLE_INPUTS } from './truthTable';

export interface Step {
  from: Expr;
  to: Expr;
  law: LawId | 'reorder';
  direction: 'ltr' | 'rtl';
  /** Path to the rewritten node in `from` (in `to` for a right-to-left step
   *  identifyStep found by reading the typed line back); a `not` node's
   *  child is index 0. */
  at: number[];
  /** Which operands of the n-ary node at `at` the pattern consumed. */
  operands?: number[];
  /** The same law at this many places in one line; `at` names the first. */
  times?: number;
  /** What now stands at `at`, before normalizing; absent on a step read back
   *  from a typed line. */
  replaced?: Expr;
}

export type StepCheck =
  | { kind: 'law'; steps: Step[] }
  /** Two laws one after the other, in the order they were used. */
  | { kind: 'chain'; steps: [Step, Step] }
  | { kind: 'reorder' }
  | { kind: 'equivalent-multi' }
  | { kind: 'not-equivalent'; row: number };

export type Nary = Extract<Expr, { args: Expr[] }>;
type NaryKind = Nary['kind'];

export const isNary = (e: Expr): e is Nary =>
  e.kind === 'and' || e.kind === 'or' || e.kind === 'xor';

const nary = (kind: NaryKind, args: Expr[]): Expr =>
  args.length === 1 ? args[0]! : { kind, args };

const not = (a: Expr): Expr => ({ kind: 'not', a });

/** Substituting into a law never writes a double bar: X = C' makes X' read C,
 *  as the chapter writes it. Row 5 stays for a double complement the
 *  expression itself holds. */
export const complement = (a: Expr): Expr => (a.kind === 'not' ? a.a : not(a));

/** Flattens nested AND/OR/XOR of one kind and unwraps one-operand nodes;
 *  nothing else, so a law step never hides inside it. */
export function normalize(e: Expr): Expr {
  if (e.kind === 'not') return not(normalize(e.a));
  if (!isNary(e)) return e;
  const args: Expr[] = [];
  for (const a of e.args) {
    const n = normalize(a);
    if (n.kind === e.kind) args.push(...n.args);
    else args.push(n);
  }
  return nary(e.kind, args);
}

/** Operand order does not count, so this is the key two expressions share when
 *  they differ only by rows 6 and 7. Callers pass normalized trees. */
export function acKey(e: Expr): string {
  switch (e.kind) {
    case 'const':
      return String(e.value);
    case 'var':
      return `v${e.name}`;
    case 'not':
      return `!(${acKey(e.a)})`;
    default:
      return `${e.kind}(${e.args.map(acKey).sort().join(',')})`;
  }
}

export const literalCount = (e: Expr): number =>
  e.kind === 'var'
    ? 1
    : e.kind === 'const'
      ? 0
      : e.kind === 'not'
        ? literalCount(e.a)
        : e.args.reduce((n, a) => n + literalCount(a), 0);

export function sameUpToAC(a: Expr, b: Expr): boolean {
  return acKey(normalize(a)) === acKey(normalize(b));
}

// ---------------------------------------------------------------------------
// Matching

type Bindings = ReadonlyMap<string, Expr>;

interface MatchOptions {
  /** Lets a pattern `Y'` meet `A` by binding Y to `A'`, the way the chapter
   *  reads row 12b on `A' + ACD'`. Off for row 5, which would otherwise turn
   *  every complement into a triple one. */
  complementFallback: boolean;
}

const bind = (b: Bindings, name: string, v: Expr): Bindings => new Map(b).set(name, v);

function matchNode(p: Expr, t: Expr, b: Bindings, opt: MatchOptions): Bindings[] {
  switch (p.kind) {
    case 'var': {
      const bound = b.get(p.name);
      if (bound) return acKey(bound) === acKey(t) ? [b] : [];
      return [bind(b, p.name, t)];
    }
    case 'const':
      return t.kind === 'const' && t.value === p.value ? [b] : [];
    case 'not':
      if (t.kind === 'not') return matchNode(p.a, t.a, b, opt);
      if (opt.complementFallback && p.a.kind === 'var') return matchNode(p.a, not(t), b, opt);
      return [];
    default:
      if (t.kind !== p.kind) return [];
      return matchOperands(p, t.args, b, true, opt).map((m) => m.b);
  }
}

interface OperandMatch {
  b: Bindings;
  consumed: number[];
}

/** Matches the operands of an n-ary pattern against a sub-multiset of
 *  `targets` (all of them when `full`). A variable may absorb several operands.
 *  Under AND and OR a bound variable may reuse an operand another pattern
 *  operand already took, since X·X = X: that is how `YZ` in row 13b meets
 *  `A'BD` when Y and Z share the B. XOR is not idempotent and gets no reuse. */
function matchOperands(
  p: Nary,
  targets: readonly Expr[],
  b: Bindings,
  full: boolean,
  opt: MatchOptions,
): OperandMatch[] {
  const out: OperandMatch[] = [];
  const keys = targets.map(acKey);
  const reuse = p.kind !== 'xor';

  const go = (pats: readonly Expr[], free: number[], used: number[], b: Bindings): void => {
    if (pats.length === 0) {
      if (!full || free.length === 0) out.push({ b, consumed: [...used].sort((x, y) => x - y) });
      return;
    }
    // Compound patterns first, then bound variables, then free ones: the
    // earlier kinds pin down bindings the later ones must agree with.
    let pick = pats.findIndex((q) => q.kind !== 'var');
    if (pick < 0) pick = pats.findIndex((q) => q.kind === 'var' && b.has(q.name));
    if (pick < 0) pick = 0;
    const q = pats[pick]!;
    const rest = pats.filter((_, i) => i !== pick);

    if (q.kind !== 'var') {
      for (const i of free)
        for (const b2 of matchNode(q, targets[i]!, b, opt))
          go(
            rest,
            free.filter((j) => j !== i),
            [...used, i],
            b2,
          );
      return;
    }

    const bound = b.get(q.name);
    if (bound) {
      const parts = bound.kind === p.kind ? bound.args : [bound];
      const left = [...free];
      const took: number[] = [];
      for (const part of parts) {
        const k = acKey(part);
        const at = left.findIndex((j) => keys[j] === k);
        if (at >= 0) took.push(left.splice(at, 1)[0]!);
        else if (!(reuse && used.some((j) => keys[j] === k))) return;
      }
      if (took.length === 0) return;
      go(rest, left, [...used, ...took], b);
      return;
    }

    if (free.length === 0) return;
    const last = rest.length === 0;
    if (last && full) {
      go(
        rest,
        [],
        [...used, ...free],
        bind(
          b,
          q.name,
          nary(
            p.kind,
            free.map((j) => targets[j]!),
          ),
        ),
      );
      return;
    }
    if (!full) {
      // Unselected, a free variable at the top takes one operand or all that
      // are left: every subset would be 3^n steps on an n-term sum. A
      // shift-click selection arrives as `full` and reaches any subset.
      const options = free.map((j) => [j]);
      if (free.length > 1) options.push(free);
      for (const take of options)
        go(
          rest,
          free.filter((j) => !take.includes(j)),
          [...used, ...take],
          bind(
            b,
            q.name,
            nary(
              p.kind,
              take.map((j) => targets[j]!),
            ),
          ),
        );
      return;
    }
    for (let mask = 1; mask < 1 << free.length; mask++) {
      const take = free.filter((_, i) => mask & (1 << i));
      const keep = free.filter((_, i) => !(mask & (1 << i)));
      go(
        rest,
        keep,
        [...used, ...take],
        bind(
          b,
          q.name,
          nary(
            p.kind,
            take.map((j) => targets[j]!),
          ),
        ),
      );
    }
  };

  go(p.args, [...targets.keys()], [], b);
  return out;
}

function instantiate(template: Expr, b: Bindings): Expr {
  switch (template.kind) {
    case 'var': {
      const v = b.get(template.name);
      if (!v) throw new Error(`unbound pattern variable ${template.name}`);
      return v;
    }
    case 'const':
      return template;
    case 'not':
      return complement(instantiate(template.a, b));
    default:
      return { kind: template.kind, args: template.args.map((a) => instantiate(a, b)) };
  }
}

// ---------------------------------------------------------------------------
// Rewriting at a node

/** Puts `result` where `consumed` operands of `node` were. A result operand
 *  equal to a consumed one keeps that operand, as written, in its slot; new ones fill the first
 *  freed slot or go last, so a removed term vanishes in place and an added
 *  consensus term appears at the end, as the chapter prints them. */
function splice(node: Nary, consumed: readonly number[], result: Expr): Expr {
  const slots: (Expr[] | null)[] = node.args.map((a, i) => (consumed.includes(i) ? null : [a]));
  const pieces = result.kind === node.kind ? result.args : [result];
  const fresh: Expr[] = [];
  const open = new Set(consumed);
  for (const piece of pieces) {
    const k = acKey(piece);
    const same = consumed.find((i) => open.has(i) && acKey(node.args[i]!) === k);
    if (same !== undefined) {
      open.delete(same);
      slots[same] = [node.args[same]!];
    } else fresh.push(piece);
  }
  const firstOpen = [...open].sort((x, y) => x - y)[0];
  if (firstOpen !== undefined) slots[firstOpen] = fresh;
  const args = slots.flatMap((s) => s ?? []);
  if (firstOpen === undefined) args.push(...fresh);
  return nary(node.kind, args);
}

export function nodeAt(e: Expr, at: readonly number[]): Expr {
  let n = e;
  for (const i of at) {
    if (n.kind === 'not' && i === 0) n = n.a;
    else if (isNary(n) && i < n.args.length) n = n.args[i]!;
    else throw new RangeError(`no node at ${at.join('.')}`);
  }
  return n;
}

export function replaceAt(e: Expr, at: readonly number[], sub: Expr): Expr {
  if (at.length === 0) return sub;
  const [i, ...rest] = at as [number, ...number[]];
  if (e.kind === 'not') return not(replaceAt(e.a, rest, sub));
  if (!isNary(e)) throw new RangeError(`no node at ${at.join('.')}`);
  return { kind: e.kind, args: e.args.map((a, j) => (j === i ? replaceAt(a, rest, sub) : a)) };
}

interface Rule {
  law: LawId;
  direction: 'ltr' | 'rtl';
  pattern: Expr;
  template: Expr;
}

const REGROUP_ROWS: ReadonlySet<LawId> = new Set(['6a', '6b', '7a', '7b']);

const isSubset = (a: readonly string[], b: readonly string[]): boolean =>
  a.every((x) => b.includes(x));

/** Right to left only where the right side keeps every variable of the left,
 *  since a missing one has no binding to invent (the typed next line supplies
 *  it, through identifyStep). A bare-variable right side (rows 2, 3, 5) would
 *  match every node, so it is reachable through identifyStep only too. */
const RULES: readonly Rule[] = LAWS.filter((l) => !REGROUP_ROWS.has(l.id)).flatMap((l) => {
  const lhs = normalize(parseExpr(l.lhs));
  const rhs = normalize(parseExpr(l.rhs));
  const rules: Rule[] = [{ law: l.id, direction: 'ltr', pattern: lhs, template: rhs }];
  if (rhs.kind !== 'var' && isSubset(exprVars(lhs), exprVars(rhs)))
    rules.push({ law: l.id, direction: 'rtl', pattern: rhs, template: lhs });
  return rules;
});

const LAW_ORDER = new Map<string, number>(LAWS.map((l, i) => [l.id, i]));

export function makeStep(
  from: Expr,
  at: number[],
  rule: Pick<Rule, 'law' | 'direction'>,
  sub: Expr,
  operands?: number[],
): Step {
  const to = normalize(replaceAt(from, at, sub));
  const step: Step = { from, to, law: rule.law, direction: rule.direction, at, replaced: sub };
  if (operands) step.operands = operands;
  return step;
}

/** The part of the line a step rewrote and what it became, `ABC + ABCD` and
 *  `ABC` for row 10b on a longer sum, so a menu can show the change alone. */
export function localChange(s: Step): { before: Expr; after: Expr } | null {
  if (!s.replaced) return null;
  const node = nodeAt(s.from, s.at);
  const operands = s.operands;
  if (!operands || !isNary(node) || operands.length === node.args.length)
    return { before: node, after: normalize(s.replaced) };
  const before = nary(
    node.kind,
    operands.map((i) => node.args[i]!),
  );
  // The untouched operands stay in the rewritten node; what is left is the result.
  const pieces = s.replaced.kind === node.kind ? [...s.replaced.args] : [s.replaced];
  node.args.forEach((a, i) => {
    if (operands.includes(i)) return;
    const k = acKey(a);
    const at = pieces.findIndex((p) => acKey(p) === k);
    if (at >= 0) pieces.splice(at, 1);
  });
  if (pieces.length === 0) return { before: node, after: normalize(s.replaced) };
  return { before, after: normalize(nary(node.kind, pieces)) };
}

/** Row 8a over a whole sum, and over every sum of a product at once: the
 *  chapter multiplies `(A + B)(A + C)` out to four terms in one cited step. */
function generalDistribute(from: Expr, at: number[], node: Nary): Step[] {
  if (node.kind !== 'and') return [];
  const out: Step[] = [];
  const rule = { law: '8a' as const, direction: 'ltr' as const };
  const sums = node.args.flatMap((a, i) => (a.kind === 'or' ? [i] : []));
  for (const s of sums) {
    const others = node.args.map((_, i) => i).filter((i) => i !== s);
    for (let mask = 1; mask < 1 << others.length; mask++) {
      const factor = others.filter((_, i) => mask & (1 << i));
      const x = factor.map((i) => node.args[i]!);
      const terms = (node.args[s] as Nary).args.map((t) => nary('and', [...x, t]));
      const consumed = [...factor, s].sort((p, q) => p - q);
      const sub = splice(node, consumed, normalize(nary('or', terms)));
      out.push(makeStep(from, at, rule, sub, consumed));
    }
  }
  if (sums.length >= 2) {
    let terms: Expr[][] = [[]];
    for (const a of node.args) {
      const choices = a.kind === 'or' ? a.args : [a];
      terms = terms.flatMap((t) => choices.map((c) => [...t, c]));
    }
    const all = node.args.map((_, i) => i);
    out.push(
      makeStep(
        from,
        at,
        rule,
        nary(
          'or',
          terms.map((t) => nary('and', t)),
        ),
        all,
      ),
    );
  }
  return out;
}

/** Rows 9a/9b over every operand at once, the generalized theorem. */
function generalDeMorgan(from: Expr, at: number[], node: Expr): Step[] {
  if (node.kind !== 'not' || (node.a.kind !== 'and' && node.a.kind !== 'or')) return [];
  if (node.a.args.length < 3) return [];
  const law = node.a.kind === 'and' ? '9a' : '9b';
  const sub = nary(node.a.kind === 'and' ? 'or' : 'and', node.a.args.map(complement));
  return [makeStep(from, at, { law, direction: 'ltr' }, sub)];
}

function stepsAtNode(
  from: Expr,
  at: number[],
  operands?: readonly number[],
  rules: readonly Rule[] = RULES,
): Step[] {
  const node = nodeAt(from, at);
  const selected = operands ? [...operands].sort((x, y) => x - y) : null;
  const raw: Step[] = [];
  for (const rule of rules) {
    const opt = { complementFallback: rule.law !== '5' };
    if (isNary(rule.pattern)) {
      if (!isNary(node) || node.kind !== rule.pattern.kind) continue;
      const pool = selected ? selected.map((i) => node.args[i]!) : node.args;
      for (const m of matchOperands(rule.pattern, pool, new Map(), selected !== null, opt)) {
        const consumed = selected ? m.consumed.map((i) => selected[i]!) : m.consumed;
        const sub = splice(node, consumed, normalize(instantiate(rule.template, m.b)));
        raw.push(makeStep(from, at, rule, sub, consumed));
      }
    } else {
      for (const b of matchNode(rule.pattern, node, new Map(), opt))
        raw.push(makeStep(from, at, rule, instantiate(rule.template, b)));
    }
  }
  const general = (law: LawId): boolean => rules.some((r) => r.law === law);
  if (isNary(node) && general('8a')) raw.push(...generalDistribute(from, at, node));
  if (general('9a') || general('9b'))
    raw.push(...generalDeMorgan(from, at, node).filter((s) => general(s.law as LawId)));

  const want = selected ? selected.join(',') : null;
  const fromKey = acKey(from);
  const seen = new Set<string>();
  return raw.filter((s) => {
    if (want !== null && (s.operands ?? []).join(',') !== want) return false;
    const key = `${s.law}|${s.direction}|${acKey(s.to)}`;
    if (acKey(s.to) === fromKey || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every single-law step at the node `at` of `normalize(e)`, in the laws
 *  table's order. `operands` limits it to steps consuming exactly those
 *  operands of an n-ary node (a shift-click selection); omitted, any subset. */
export function applicable(e: Expr, at: number[], operands?: number[]): Step[] {
  return sortSteps(stepsAtNode(normalize(e), at, operands));
}

/** Paths in pre-order, parent before child, so "leftmost" reads as printed. */
export function nodePaths(e: Expr): number[][] {
  const out: number[][] = [];
  const walk = (n: Expr, path: number[]): void => {
    out.push(path);
    if (n.kind === 'not') walk(n.a, [...path, 0]);
    else if (isNary(n)) n.args.forEach((a, i) => walk(a, [...path, i]));
  };
  walk(e, []);
  return out;
}

/** Every single-law step anywhere in `normalize(e)`. */
export function allSteps(e: Expr): Step[] {
  return stepsEverywhere(normalize(e), RULES);
}

const stepsEverywhere = (from: Expr, rules: readonly Rule[]): Step[] =>
  nodePaths(from).flatMap((p) => stepsAtNode(from, p, undefined, rules));

const sortSteps = (steps: Step[]): Step[] =>
  steps
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        LAW_ORDER.get(a.s.law)! - LAW_ORDER.get(b.s.law)! ||
        (a.s.direction === b.s.direction ? 0 : a.s.direction === 'ltr' ? -1 : 1) ||
        a.i - b.i,
    )
    .map(({ s }) => s);

// ---------------------------------------------------------------------------
// Checking a typed line

/** First truth-table row (MSB-first over the sorted union of names) where the
 *  two differ, or -1. */
export function firstDifferingRow(a: Expr, b: Expr): number {
  const vars = [...new Set([...exprVars(a), ...exprVars(b)])].sort();
  if (vars.length > MAX_TABLE_INPUTS)
    throw new ExprError(`${vars.length} variables, at most ${MAX_TABLE_INPUTS} can be compared`, 0);
  for (let m = 0; m < 1 << vars.length; m++) {
    const env = new Map<string, 0 | 1>(
      vars.map((n, i) => [n, ((m >> (vars.length - 1 - i)) & 1) as 0 | 1]),
    );
    if (evalExpr(a, env) !== evalExpr(b, env)) return m;
  }
  return -1;
}

const MAX_REPEATS = 3;
const REPEAT_FRONTIER_CAP = 300;

/** Rows that multiply an expression out fan out to hundreds of states per
 *  level; the chapter repeats only the rows that shrink or push a bar in. */
const NOT_REPEATED: ReadonlySet<LawId> = new Set(['8a', '8b', '14a', '14b', '15a', '15b']);

/** The chapter writes `AB + BBC + BCC = AB + BC + BC` as one line: one law at
 *  several places. Breadth-first over that law alone, left to right only. */
function repeatedLaw(from: Expr, to: Expr): Step[] {
  const target = acKey(to);
  const found: Step[] = [];
  for (const l of LAWS) {
    if (NOT_REPEATED.has(l.id)) continue;
    const rules = RULES.filter((r) => r.law === l.id && r.direction === 'ltr');
    if (rules.length === 0) continue;
    let frontier: { e: Expr; first: Step | null }[] = [{ e: from, first: null }];
    const seen = new Set([acKey(from)]);
    let hit: Step | null = null;
    for (let depth = 1; depth <= MAX_REPEATS && !hit && frontier.length > 0; depth++) {
      const next: typeof frontier = [];
      for (const { e, first } of frontier) {
        for (const s of stepsEverywhere(e, rules)) {
          const k = acKey(s.to);
          if (seen.has(k)) continue;
          seen.add(k);
          const head = first ?? s;
          if (k === target && depth >= 2) {
            hit = { ...head, from, to, times: depth };
            break;
          }
          if (next.length < REPEAT_FRONTIER_CAP) next.push({ e: s.to, first: head });
        }
        if (hit) break;
      }
      frontier = next;
    }
    if (hit) found.push(hit);
  }
  return found;
}

/** Equivalence is settled by exhaustive evaluation before any law search, so
 *  a wrong line can never be labelled with a law. */
export function identifyStep(fromIn: Expr, toIn: Expr): StepCheck {
  const from = normalize(fromIn);
  const to = normalize(toIn);
  const row = firstDifferingRow(from, to);
  if (row >= 0) return { kind: 'not-equivalent', row };
  if (acKey(from) === acKey(to)) return { kind: 'reorder' };

  const target = acKey(to);
  const steps: Step[] = [];
  const seen = new Set<string>();
  const add = (s: Step): void => {
    const k = `${s.law}|${s.direction}`;
    if (seen.has(k)) return;
    seen.add(k);
    steps.push(s);
  };
  const out = allSteps(from);
  const back = allSteps(to);
  for (const s of out) if (acKey(s.to) === target) add({ ...s, to });
  // A right-to-left step is a left-to-right one read backwards from the
  // typed line; this is the only route to rows whose right side drops a
  // variable (1a, 4b, 13b right to left).
  const source = acKey(from);
  for (const s of back)
    if (s.direction === 'ltr' && acKey(s.to) === source)
      add({ from, to, law: s.law, direction: 'rtl', at: s.at });
  if (steps.length > 0) return { kind: 'law', steps: sortSteps(steps) };

  const repeated = repeatedLaw(from, to);
  if (repeated.length > 0) return { kind: 'law', steps: sortSteps(repeated) };
  const chain = twoLaws(from, to, out, back);
  if (chain) return { kind: 'chain', steps: chain };
  return { kind: 'equivalent-multi' };
}

const flip = (d: Step['direction']): Step['direction'] => (d === 'ltr' ? 'rtl' : 'ltr');

const LTR_RULES = RULES.filter((r) => r.direction === 'ltr');

/** Meets in the middle: a step out of `from` landing where a step out of `to`,
 *  read backwards, also lands. A second law that drops a variable (10b, 11b,
 *  13b) has no backward reading, so those are searched forward, but only after
 *  first steps that do not lengthen the line, or a multiply-out: the rest
 *  fan out to hundreds. Left-to-right pairs first. */
function twoLaws(
  from: Expr,
  to: Expr,
  out: readonly Step[],
  back: readonly Step[],
): [Step, Step] | null {
  const target = acKey(to);
  const into = new Map<string, Step[]>();
  for (const s of back) {
    const k = acKey(s.to);
    into.set(k, [...(into.get(k) ?? []), s]);
  }
  const pairs: [Step, Step][] = [];
  const size = literalCount(from);
  for (const first of out) {
    for (const b of into.get(acKey(first.to)) ?? [])
      pairs.push([
        { ...first, from },
        { from: first.to, to, law: b.law, direction: flip(b.direction), at: b.at },
      ]);
    const multiplyOut = first.law === '8a' && first.direction === 'ltr';
    if (literalCount(first.to) > size && !multiplyOut) continue;
    for (const second of stepsEverywhere(first.to, LTR_RULES))
      if (acKey(second.to) === target)
        pairs.push([
          { ...first, from },
          { ...second, to },
        ]);
  }
  const rtl = (p: readonly Step[]): number => p.filter((s) => s.direction === 'rtl').length;
  pairs.sort(
    (a, b) =>
      rtl(a) - rtl(b) ||
      LAW_ORDER.get(a[0].law)! - LAW_ORDER.get(b[0].law)! ||
      LAW_ORDER.get(a[1].law)! - LAW_ORDER.get(b[1].law)!,
  );
  return pairs[0] ?? null;
}

/** Two laws in turn read `10b (absorption law), 12b (...)`; one law twice reads `10b (absorption law) (twice)`. */
export function citeChain(steps: readonly Step[]): string {
  const [a, b] = steps;
  if (a && b && steps.length === 2 && a.law === b.law && a.direction === b.direction)
    return citeStep({ ...a, times: 2 });
  return steps.map(citeStep).join(', ');
}

const TIMES_WORDS = ['', '', 'twice', 'three times'];

/** The citation printed at the right of a derivation line. */
export function citeStep(s: Pick<Step, 'law' | 'direction' | 'times'>): string {
  if (s.law === 'reorder') return '6, 7 (reorder)';
  const notes: string[] = [];
  if (s.direction === 'rtl') notes.push('right to left');
  if (s.times && s.times > 1) notes.push(TIMES_WORDS[s.times] ?? `${s.times} times`);
  const label = lawLabel(s.law);
  return notes.length ? `${label} (${notes.join(', ')})` : label;
}
