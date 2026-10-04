import { ExprError, exprVars, parseExpr, type Expr } from '../../core/boolean/expr';
import { LAWS, type Law, type LawId } from '../../core/boolean/laws';
import {
  acKey,
  applicable,
  citeChain,
  citeStep,
  identifyStep,
  isNary,
  literalCount,
  nodeAt,
  normalize,
  type Step,
  type StepCheck,
} from '../../core/boolean/rewrite';
import { MAX_KMAP_INPUTS } from '../../core/boolean/kmap';
import type { MinimalCheck, TwoLevelForm } from '../../core/boolean/minimal';
import { derive } from '../../core/boolean/simplify';
import type { ExprSelection } from '../components/BoolExpr';

// The pure half of the Algebra tab, so the reveal order, the selection rules
// and the line checking are tested without a DOM.

// ---------------------------------------------------------------------------
// Laws

export type LawDrill = 'none' | 'rhs' | 'duals';

export interface LawRow {
  row: string;
  a: Law;
  /** Absent where the row has no dual column: 5, and the a and b of 7 and 13 on rows of their own. */
  b: Law | null;
}

const OWN_ROW = new Set(['7', '13']);

export function lawRows(): LawRow[] {
  const byRow = new Map<string, LawRow>();
  for (const law of LAWS) {
    const base = law.id.replace(/[ab]$/, '');
    const row = OWN_ROW.has(base) ? law.id : base;
    const cur = byRow.get(row);
    if (!cur) byRow.set(row, { row, a: law, b: null });
    else cur.b = law;
  }
  return [...byRow.values()];
}

/** The cells a drill hides, in reveal order (the table's row order). */
export function maskedLaws(drill: LawDrill): LawId[] {
  if (drill === 'none') return [];
  const laws =
    drill === 'rhs'
      ? LAWS
      : LAWS.filter((l) => l.id.endsWith('b') && !OWN_ROW.has(l.id.slice(0, -1)));
  return laws.map((l) => l.id);
}

/** The cell Enter reveals next, or null when everything is showing. */
export function nextMasked(drill: LawDrill, revealed: readonly LawId[]): LawId | null {
  return maskedLaws(drill).find((id) => !revealed.includes(id)) ?? null;
}

// ---------------------------------------------------------------------------
// Simplify

export interface Line {
  expr: Expr;
  /** The law cited at the right; null on the line the student started from. */
  cite: string | null;
  /** Accepted, but no single law gets there. */
  flagged?: boolean;
}

const samePath = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** What a click selects, given the deepest node under the pointer. A click
 *  takes the whole term first, since that is what the laws act on; clicking
 *  inside the selection again goes one level in, and past the innermost
 *  wraps back out. A click on a `+` lands on the sum itself, so the whole
 *  line is one click away too. */
export function clickTarget(
  expr: Expr,
  current: ExprSelection | null,
  leaf: readonly number[],
): number[] {
  const top = isNary(expr) && leaf.length > 0 ? 1 : 0;
  const chain: number[][] = [];
  for (let d = top; d <= leaf.length; d++) chain.push(leaf.slice(0, d));
  const at = current ? chain.findIndex((p) => samePath(p, current.at)) : -1;
  return chain[at >= 0 && at < chain.length - 1 ? at + 1 : 0]!;
}

const LAW_INDEX = new Map<string, number>(LAWS.map((l, i) => [l.id, i]));

const barCount = (e: Expr): number =>
  e.kind === 'not'
    ? 1 + barCount(e.a)
    : isNary(e)
      ? e.args.reduce((n, a) => n + barCount(a), 0)
      : 0;

/** Fewer literals, or as many with fewer bars (row 5). */
const shrinkOf = (s: Step): number => {
  const lits = literalCount(s.from) - literalCount(s.to);
  return lits !== 0 ? lits : Math.sign(barCount(s.from) - barCount(s.to)) * 0.5;
};

export interface StepMenu {
  /** Steps that shorten the line, biggest cut first. */
  shorter: Step[];
  /** The rest, in the laws table's order: same length or longer. */
  others: Step[];
}

/** What the step menu lists for a selection. A lone term also lists the laws
 *  it takes part in with its siblings: row 10b needs `X` and `XY` together, and
 *  clicking only `XY` is what a student tries first. */
export function stepsForSelection(e: Expr, sel: ExprSelection): StepMenu {
  const found = applicable(e, sel.at, sel.operands);
  if (!sel.operands && sel.at.length > 0) {
    const parent = sel.at.slice(0, -1);
    const index = sel.at[sel.at.length - 1]!;
    if (isNary(nodeAt(e, parent)))
      found.push(...applicable(e, parent).filter((s) => s.operands?.includes(index)));
  }
  const seen = new Set<string>();
  const steps = found.filter((s) => {
    const key = `${s.law}|${s.direction}|${acKey(s.to)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lawOrder = (s: Step): number => LAW_INDEX.get(s.law) ?? 0;
  const byLaw = (a: Step, b: Step): number =>
    lawOrder(a) - lawOrder(b) || (a.direction === b.direction ? 0 : a.direction === 'ltr' ? -1 : 1);
  const shorter = steps.filter((s) => shrinkOf(s) > 0);
  return {
    shorter: shorter.sort((a, b) => shrinkOf(b) - shrinkOf(a) || byLaw(a, b)),
    others: steps.filter((s) => shrinkOf(s) <= 0).sort(byLaw),
  };
}

/** The assignment of a truth-table row, MSB-first over the sorted names. */
export function rowAssignment(vars: readonly string[], row: number): string {
  return vars.map((v, i) => `${v}=${(row >> (vars.length - 1 - i)) & 1}`).join(' ');
}

export type LineCheck =
  | { ok: true; line: Line }
  | { ok: false; message: string; offset: number | null };

export function describeCheck(prev: Expr, next: Expr, check: StepCheck): LineCheck {
  const expr = normalize(next);
  switch (check.kind) {
    case 'not-equivalent': {
      const vars = [...new Set([...exprVars(prev), ...exprVars(next)])].sort();
      return {
        ok: false,
        message: `Not equal: the two differ at row ${check.row} (${rowAssignment(vars, check.row)}).`,
        offset: null,
      };
    }
    case 'reorder':
      return { ok: true, line: { expr, cite: citeStep({ law: 'reorder', direction: 'ltr' }) } };
    case 'chain':
      return { ok: true, line: { expr, cite: citeChain(check.steps) } };
    case 'equivalent-multi':
      return { ok: true, line: { expr, cite: 'equal, more than two laws', flagged: true } };
    case 'law':
      return {
        ok: true,
        line: { expr, cite: [...new Set(check.steps.map(citeStep))].join(' or ') },
      };
  }
}

/** Reads a typed next line and labels it, or refuses it with the reason. */
export function checkLine(prev: Expr, src: string): LineCheck {
  try {
    const next = parseExpr(src);
    return describeCheck(prev, next, identifyStep(prev, next));
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, message: e.message, offset: e.offset };
    throw e;
  }
}

const FORM_NAME: Record<TwoLevelForm, string> = {
  sop: 'sum of products',
  pos: 'product of sums',
};

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The answer to "Is it simplified?". Counts only, never the minimum itself. */
export function describeMinimal(check: MinimalCheck): { done: boolean; text: string } {
  switch (check.kind) {
    case 'minimal':
      return {
        done: true,
        text: `Simplified: a minimum ${FORM_NAME[check.form]} (${count(check.cost.terms, 'term')}, ${count(check.cost.literals, 'literal')}).`,
      };
    case 'not-minimal':
      return {
        done: false,
        text: `Not yet. This ${FORM_NAME[check.form]} has ${count(check.cost.terms, 'term')} and ${count(check.cost.literals, 'literal')}; a minimum one has ${count(check.minimum.terms, 'term')} and ${count(check.minimum.literals, 'literal')}.`,
      };
    case 'not-two-level':
      return {
        done: false,
        text: 'Not a sum of products or a product of sums yet, so there is no minimum to compare it with. Multiply out or factor first.',
      };
    case 'too-many-vars':
      return {
        done: false,
        text: `The check covers up to ${MAX_KMAP_INPUTS} variables, as the K-map does; this has ${check.count}.`,
      };
  }
}

/** The worked path as lines, after the starting one. */
export function derivedLines(start: Expr): Line[] {
  return derive(start).map((s) => ({ expr: normalize(s.to), cite: citeStep(s) }));
}

export interface Reveal {
  /** Lines whose cited law is on screen. */
  shown: number;
  /** Lines whose expression is unmasked; only lags `shown` while hiding. */
  open: number;
}

/** One Space press. Hiding splits a step into two presses, the law and then
 *  its result, so the class can predict the line from the citation. */
export function advanceReveal(r: Reveal, total: number, hiding: boolean): Reveal {
  if (!hiding) {
    const n = Math.min(r.shown + 1, total);
    return { shown: n, open: n };
  }
  if (r.open < r.shown) return { shown: r.shown, open: r.open + 1 };
  return { shown: Math.min(r.shown + 1, total), open: r.open };
}
