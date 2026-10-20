import type { GroupCheck, GroupDiagnosis, KmapPolarity } from '../../core/boolean/kmap';
import type { FunctionIndices } from '../../core/boolean/canonical';
import { productNeedsDot, type Expr } from '../../core/boolean/expr';

// Wording for the Analyze drawer's K-map: the problem statement, the
// grouping-rules tip, refusals, and the SOP-versus-POS comparison.

const list = (xs: readonly number[]): string => xs.join(',');

/** `Y = Σm(1,3) + Σd(2)` or `Y = ΠM(0,2) · ΠD(2)`. Not gated: it restates the
 *  problem, it does not solve it. An empty list is the constant it stands for,
 *  unless unknown rows leave that constant unknown too. */
export function functionLine(
  name: string,
  idx: FunctionIndices,
  polarity: KmapPolarity,
  unknown = 0,
): string {
  const sop = polarity === 'ones';
  const listed = sop ? idx.ones : idx.zeros;
  if (listed.length === 0)
    return unknown > 0 ? `${name}: no known row is ${sop ? 1 : 0}` : `${name} = ${sop ? 0 : 1}`;
  if (sop) {
    const d = idx.dontCares.length > 0 ? ` + Σd(${list(idx.dontCares)})` : '';
    return `${name} = Σm(${list(idx.ones)})${d}`;
  }
  const d = idx.dontCares.length > 0 ? ` · ΠD(${list(idx.dontCares)})` : '';
  return `${name} = ΠM(${list(idx.zeros)})${d}`;
}

const asVar = (name: string) => ({ kind: 'var', name }) as const;

/** What goes before each literal of a drawn product: `·` where juxtaposed names would fuse, as
 *  `sw1sw2` did, by the same rule the As built line uses. */
export function productJoins(names: readonly string[]): string[] {
  return names.map((name, i) =>
    i > 0 && productNeedsDot(asVar(names[i - 1]!), asVar(name)) ? '·' : '',
  );
}

/** The same rule between the factors of a drawn POS, each given as its literal names: a
 *  bracketed sum never fuses, two bare `sw1` `sw2` factors would. */
export function factorJoins(factors: readonly (readonly string[])[]): string[] {
  const asExpr = (names: readonly string[]): Expr =>
    names.length === 0
      ? { kind: 'const', value: 0 }
      : names.length === 1
        ? asVar(names[0]!)
        : { kind: 'or', args: names.map(asVar) };
  return factors.map((f, i) =>
    i > 0 && productNeedsDot(asExpr(factors[i - 1]!), asExpr(f)) ? '·' : '',
  );
}

/** Both halves: removal is what a user wants the moment a circle exists. */
export function groupHint(coarse: boolean): string {
  return coarse
    ? 'Long-press a cell, then drag, to circle a group. Long-press a circle to remove it.'
    : "Ctrl+click or Ctrl+drag cells to circle a group. Shift+click a circle to remove it. Alt+click marks a don't-care.";
}

/** The count under the map. Unknown rows are said apart, since a floating input
 *  is not a constant function. */
export function coverStatus(
  polarity: KmapPolarity,
  targets: number,
  uncovered: number,
  unknown: number,
): string {
  const word = polarity === 'ones' ? 'one' : 'zero';
  const parts: string[] = [];
  if (uncovered > 0)
    parts.push(`${uncovered} ${word}${uncovered === 1 ? '' : 's'} still uncovered`);
  else if (targets > 0) parts.push(`all ${word}s covered`);
  else if (unknown === 0) parts.push(polarity === 'ones' ? 'constant 0' : 'constant 1');
  if (unknown > 0)
    parts.push(`${unknown} row${unknown === 1 ? '' : 's'} unknown (is an input floating?)`);
  return parts.join('; ');
}

export interface CheckSentences {
  /** Per circle, what is wrong with it after its term, or null when nothing is. */
  circles: (string | null)[];
  covered: string;
  minimum: string;
}

export function checkSentences(
  check: GroupCheck,
  polarity: KmapPolarity,
  targets: number,
): CheckSentences {
  const word = polarity === 'ones' ? 'one' : 'zero';
  return {
    circles: check.circles.map((c) =>
      c.notPrime && c.redundant
        ? ': this group can grow (Rule 4) and is not needed (Rule 1).'
        : c.notPrime
          ? ': Rule 4, this group can grow.'
          : c.redundant
            ? ': Rule 1, this group is not needed.'
            : null,
    ),
    covered:
      targets === 0
        ? `There is no ${word} to cover.`
        : check.coversAll
          ? `Every ${word} is covered.`
          : `Some ${word}s are not covered.`,
    minimum: check.isMinimum
      ? 'A minimum cover.'
      : check.excess === 'groups'
        ? 'Not a minimum cover: it uses more groups than needed.'
        : check.excess === 'literals'
          ? 'Not a minimum cover: it uses more literals than needed.'
          : 'Not a minimum cover.',
  };
}

/** Why no K-map shows, told apart for too few and too many inputs. */
export function kmapUnavailable(name: string, inputs: number): string {
  return inputs < 2
    ? `A K-map needs 2 to 4 inputs; ${name} reads ${inputs}.`
    : `A K-map shows at most 4 inputs; ${name} reads ${inputs}, so the truth table is the whole view.`;
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
export function refusalMessage(
  d: Exclude<GroupDiagnosis, 'ok'> | 'duplicate',
  polarity: KmapPolarity,
): string {
  const v = polarity === 'ones' ? '1' : '0';
  if (d === 'duplicate') return 'That group is already circled.';
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
