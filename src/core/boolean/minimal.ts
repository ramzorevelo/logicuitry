// Whether a derivation is finished: the line is a minimum sum of products or
// a minimum product of sums, measured against the K-map's exact cover. Cost
// is terms first, then literals, the order the chapter ranks them in.

import * as bv from '../value/busValue';
import { type Expr, evalExpr, exprVars } from './expr';
import {
  groupTerm,
  MAX_KMAP_INPUTS,
  MIN_KMAP_INPUTS,
  minimumCovers,
  type KmapPolarity,
} from './kmap';
import type { TruthTable } from './truthTable';

export interface FormCost {
  terms: number;
  literals: number;
}

export type TwoLevelForm = 'sop' | 'pos';

export type MinimalCheck =
  | { kind: 'minimal'; form: TwoLevelForm; cost: FormCost }
  | { kind: 'not-minimal'; form: TwoLevelForm; cost: FormCost; minimum: FormCost }
  | { kind: 'not-two-level' }
  | { kind: 'too-many-vars'; count: number };

const isLiteral = (e: Expr): boolean =>
  e.kind === 'var' || (e.kind === 'not' && e.a.kind === 'var');

/** A constant left inside counts as a literal: a law still has to remove it. */
const isFactor = (e: Expr): boolean => e.kind === 'const' || isLiteral(e);

function twoLevelCost(e: Expr, outer: 'or' | 'and'): FormCost | null {
  if (e.kind === 'const') {
    // Constant 1 is the one empty product; constant 0 the one empty sum.
    const identity = outer === 'or' ? 0 : 1;
    return { terms: e.value === identity ? 0 : 1, literals: 0 };
  }
  const inner = outer === 'or' ? 'and' : 'or';
  const terms = e.kind === outer ? e.args : [e];
  let literals = 0;
  for (const t of terms) {
    if (t.kind === inner && t.args.every(isFactor)) literals += t.args.length;
    else if (isFactor(t)) literals += 1;
    else return null;
  }
  return { terms: terms.length, literals };
}

/** Terms and literals as a sum of products, or null when it is not one. */
export const sopCost = (e: Expr): FormCost | null => twoLevelCost(e, 'or');

/** Terms and literals as a product of sums, or null when it is not one. */
export const posCost = (e: Expr): FormCost | null => twoLevelCost(e, 'and');

/** The table over `names`, which may include names `e` never reads. */
function tableOver(e: Expr, names: readonly string[]): TruthTable {
  const rows = Array.from({ length: 1 << names.length }, (_, m) => {
    const env = new Map<string, 0 | 1>(
      names.map((name, i) => [name, ((m >> (names.length - 1 - i)) & 1) as 0 | 1]),
    );
    return [bv.known(evalExpr(e, env), 1)];
  });
  return { inputPaths: names, outputPaths: ['Y'], rows };
}

function minimumCost(table: TruthTable, polarity: KmapPolarity): FormCost {
  const cover = minimumCovers(table, 0, undefined, polarity, 1)[0] ?? [];
  return {
    terms: cover.length,
    literals: cover.reduce((n, g) => n + groupTerm(table, g, polarity).length, 0),
  };
}

const sameCost = (a: FormCost, b: FormCost): boolean =>
  a.terms === b.terms && a.literals === b.literals;

/** `vars` are the function's variables (the derivation's first line), since a
 *  finished line may have dropped some. */
export function checkMinimal(e: Expr, vars: readonly string[]): MinimalCheck {
  const names = [...new Set([...vars, ...exprVars(e)])].sort();
  if (names.length > MAX_KMAP_INPUTS) return { kind: 'too-many-vars', count: names.length };
  // The map needs two inputs; a variable the function never reads adds no
  // literal to any minimum.
  for (let i = 0; names.length < MIN_KMAP_INPUTS; i++) names.push(`#${i}`);

  const table = tableOver(e, names);
  const forms: [TwoLevelForm, FormCost][] = [];
  const sop = sopCost(e);
  const pos = posCost(e);
  if (sop) forms.push(['sop', sop]);
  if (pos) forms.push(['pos', pos]);
  if (forms.length === 0) return { kind: 'not-two-level' };

  const measured = forms.map(([form, cost]) => ({
    form,
    cost,
    minimum: minimumCost(table, form === 'sop' ? 'ones' : 'zeros'),
  }));
  const hit = measured.find((m) => sameCost(m.cost, m.minimum));
  if (hit) return { kind: 'minimal', form: hit.form, cost: hit.cost };
  const { form, cost, minimum } = measured[0]!;
  return { kind: 'not-minimal', form, cost, minimum };
}
