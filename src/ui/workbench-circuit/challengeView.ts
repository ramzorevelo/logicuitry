import type { BehaviorReport, TableReport, TestsReport } from '../../core/challenge/behavior';
import type { PartUse, PartsRow } from '../../core/challenge/parts';
import type { Challenge, ChallengeTruthTable } from '../../core/model/types';
import { PALETTE } from './palette';

export type RowState = 'met' | 'unmet' | 'pending';

export interface ChallengeRowView {
  id: string;
  state: RowState;
  title: string;
  detail?: string;
  /** Board-level components a click selects and pans to. */
  components: string[];
  /** A checked truth table, shown under its row. */
  table?: { spec: ChallengeTruthTable; report: TableReport };
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  sevenseg: '7-seg display',
  constant: 'Constant',
  ...Object.fromEntries(
    PALETTE.filter((p) => p.kind !== 'chip' && p.kind !== 'sevenseg' && p.kind !== 'constant')
      .reverse()
      .map((p) => [p.kind, p.label]),
  ),
};

/** What a list entry is called on screen: a part number as written, a kind by its palette name. */
export function partLabel(part: string): string {
  return KIND_NAMES[part] ?? part;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listed(items: readonly string[]): string {
  return items.length <= 2
    ? items.join(' or ')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

const useName = (u: PartUse) => `${u.name} ${partLabel(u.part)}`;
const componentsOf = (uses: readonly PartUse[]) => [...new Set(uses.map((u) => u.component))];

function andMore(uses: readonly PartUse[], shown: number): string {
  const rest = uses.length - shown;
  return rest > 0 ? ` and ${rest} more` : '';
}

function icsTitle(ics: NonNullable<Challenge['ics']>): string {
  const { min, max } = ics;
  if (min !== undefined && max !== undefined)
    return min === max ? `Exactly ${plural(min, 'IC')}` : `${min} to ${max} ICs`;
  if (min !== undefined) return `At least ${plural(min, 'IC')}`;
  return `At most ${plural(max ?? 0, 'IC')}`;
}

/** The live Parts rows, worded for the tab. */
export function partsRowViews(challenge: Challenge, rows: readonly PartsRow[]): ChallengeRowView[] {
  return rows.map((row): ChallengeRowView => {
    const state: RowState = row.met ? 'met' : 'unmet';
    switch (row.id) {
      case 'library': {
        const p = row.problems[0]!;
        const why =
          p.kind === 'missing'
            ? `${p.name}: chip ${p.defId} is not in the library`
            : `${p.name}: chip ${p.defId} contains itself`;
        const more = row.problems.length - 1;
        return {
          id: row.id,
          state,
          title: 'Chips the board uses',
          detail: `${why}${more > 0 ? ` and ${more} more` : ''}.`,
          components: [...new Set(row.problems.map((q) => q.component))],
        };
      }
      case 'allowed': {
        const title = `Only parts from the list (${challenge.allowed.map(partLabel).join(', ')})`;
        if (row.met)
          return {
            id: row.id,
            state,
            title,
            detail: `${plural(row.count, 'part')}, all on the list.`,
            components: [],
          };
        const shown = row.uses.slice(0, 2);
        return {
          id: row.id,
          state,
          title,
          detail: `${shown.map(useName).join(', ')}${andMore(row.uses, shown.length)} not on the list.`,
          components: componentsOf(row.uses),
        };
      }
      case 'ics':
        return {
          id: row.id,
          state,
          title: icsTitle(challenge.ics ?? {}),
          detail: `${plural(row.count, 'IC')} on the board.`,
          components: row.met ? [] : componentsOf(row.uses),
        };
      case 'gates': {
        const max = challenge.maxGates ?? 0;
        return {
          id: row.id,
          state,
          title: `At most ${plural(max, 'gate')}`,
          detail: row.met
            ? `${plural(row.count, 'gate')}.`
            : `${plural(row.count, 'gate')}, ${row.count - max} too many. A gate counts its bit width.`,
          components: row.met ? [] : componentsOf(row.uses),
        };
      }
      default: {
        const req = challenge.required[Number(row.id.slice('required-'.length))]!;
        const shown = row.uses.slice(0, 3);
        return {
          id: row.id,
          state,
          title: `At least ${req.count} ${listed(req.anyOf.map(partLabel))}`,
          detail:
            row.count === 0
              ? 'None on the board.'
              : `${shown.map(useName).join(', ')}${andMore(row.uses, shown.length)}.`,
          components: [],
        };
      }
    }
  });
}

/** The first reason a test row failed, the way a student reads it. */
function firstTestIssue(tests: TestsReport): string | undefined {
  const f = [...tests.failures].sort((a, b) => a.step - b.step)[0];
  const err = tests.error;
  if (f && (!err || f.step <= err.step)) {
    const when = f.tick > 0 ? `, after ${plural(f.tick, 'tick')}` : '';
    const want = f.expected === undefined ? '' : `, expected ${f.expected}`;
    return `Row ${f.step + 1}${when}: ${f.name} is ${f.actual}${want}.`;
  }
  if (err) return `Row ${err.step + 1}: ${err.message}.`;
  return undefined;
}

const bits = (cells: readonly (0 | 1 | null)[]) =>
  cells.map((c) => (c === null ? '-' : c)).join(' ');

/** The Behavior rows: pending until a check, then the check's outcome. */
export function behaviorRowViews(
  challenge: Challenge,
  report: BehaviorReport | null,
): ChallengeRowView[] {
  const rows: ChallengeRowView[] = [];
  const steps = challenge.tests?.steps.length ?? 0;
  if (challenge.tests) {
    const title = `Behavior tests (${plural(steps, 'row')})`;
    const tests = report?.tests;
    if (!tests) rows.push({ id: 'tests', state: 'pending', title, components: [] });
    else {
      const ok = tests.passed === tests.total && !tests.error && tests.failures.length === 0;
      const summary = `${tests.passed} of ${tests.total} rows pass.`;
      const issue = ok ? undefined : firstTestIssue(tests);
      rows.push({
        id: 'tests',
        state: ok ? 'met' : 'unmet',
        title,
        detail: issue ? `${summary} ${issue}` : summary,
        components: tests.components,
      });
    }
  }
  const spec = challenge.truthTable;
  if (spec) {
    const title = `Truth table of ${spec.outputs.join(', ')} from ${spec.inputs.join(', ')} (${plural(spec.rows.length, 'row')})`;
    const table = report?.table;
    if (!table) rows.push({ id: 'table', state: 'pending', title, components: [] });
    else if (table.error !== undefined)
      rows.push({
        id: 'table',
        state: 'unmet',
        title,
        detail: `${table.error}.`,
        components: table.components,
      });
    else {
      const ok = table.matched === table.rows.length;
      const bad = table.rows.find((r) => !r.ok);
      let detail = ok
        ? `All ${plural(table.rows.length, 'row')} match.`
        : `${table.matched} of ${table.rows.length} rows match.`;
      if (bad) {
        const j = bad.expected.findIndex(
          (want, k) => want !== null && bad.actual[k] !== String(want),
        );
        detail += ` ${spec.inputs.join(' ')} = ${bits(bad.inputs)}: ${spec.outputs[j]} is ${bad.actual[j]}, expected ${bad.expected[j]}.`;
      }
      rows.push({
        id: 'table',
        state: ok ? 'met' : 'unmet',
        title,
        detail,
        components: table.components,
        table: { spec, report: table },
      });
    }
  }
  return rows;
}

export interface ChallengeTally {
  met: number;
  unmet: number;
  pending: number;
  total: number;
}

export function tally(rows: readonly ChallengeRowView[]): ChallengeTally {
  const count = (s: RowState) => rows.filter((r) => r.state === s).length;
  return {
    met: count('met'),
    unmet: count('unmet'),
    pending: count('pending'),
    total: rows.length,
  };
}
