import type { GroupDiagnosis, KmapPolarity } from '../../core/boolean/kmap';
import type { FunctionIndices } from '../../core/boolean/canonical';

// Wording for the Analyze drawer's K-map: the problem statement, the
// grouping-rules tip, refusals, and the SOP-versus-POS comparison.

const list = (xs: readonly number[]): string => xs.join(',');

/** `Y = Σm(1,3) + Σd(2)` or `Y = ΠM(0,2) · ΠD(2)`. Not gated: it restates the
 *  problem, it does not solve it. */
export function functionLine(name: string, idx: FunctionIndices, polarity: KmapPolarity): string {
  if (polarity === 'ones') {
    const d = idx.dontCares.length > 0 ? ` + Σd(${list(idx.dontCares)})` : '';
    return `${name} = Σm(${list(idx.ones)})${d}`;
  }
  const d = idx.dontCares.length > 0 ? ` · ΠD(${list(idx.dontCares)})` : '';
  return `${name} = ΠM(${list(idx.zeros)})${d}`;
}

/** The six H&H grouping rules, in the book's order, worded for what is grouped. */
export function groupingRules(polarity: KmapPolarity): string[] {
  const v = polarity === 'ones' ? '1' : '0';
  return [
    `Use the fewest groups needed to cover all the ${v}s.`,
    `Every cell in a group must hold a ${v} (or a don't-care).`,
    'A group is a rectangle whose sides are 1, 2 or 4 cells.',
    'Each group should be as large as possible.',
    'A group may wrap around the edges of the map.',
    `A ${v} may be in more than one group if that means fewer groups.`,
  ];
}

/** One line naming the rule a refused circle broke. */
export function refusalMessage(d: Exclude<GroupDiagnosis, 'ok'>, polarity: KmapPolarity): string {
  const v = polarity === 'ones' ? '1' : '0';
  if (d === 'rule2') return `Rule 2: every cell in a group must hold a ${v}.`;
  if (d === 'rule3') return 'Rule 3: a group must be a rectangle of 1, 2 or 4 cells a side.';
  return `A group must hold at least one ${v}.`;
}

export interface FormSummary {
  terms: number;
  literals: number;
  /** Two-level implementation: one gate per multi-literal term, plus the output gate. */
  gates: number;
}

export function summarizeForm(literalsPerGroup: readonly number[]): FormSummary {
  const terms = literalsPerGroup.length;
  return {
    terms,
    literals: literalsPerGroup.reduce((a, b) => a + b, 0),
    gates: literalsPerGroup.filter((l) => l > 1).length + (terms > 1 ? 1 : 0),
  };
}

/** Don't-care cells where the SOP cover (which grabs 1s) and the POS cover
 *  (which grabs 0s) end up computing different values. */
export function dontCareDisagreements(
  dontCares: readonly number[],
  sopGroups: readonly (readonly number[])[],
  posGroups: readonly (readonly number[])[],
): number[] {
  const inSop = new Set(sopGroups.flat());
  const inPos = new Set(posGroups.flat());
  return dontCares.filter((m) => inSop.has(m) === inPos.has(m));
}
