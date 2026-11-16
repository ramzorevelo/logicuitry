import { componentPaths } from '../model/compile';
import type { Board, Challenge, ChipLibrary, ChallengeTruthTable } from '../model/types';
import { parseStimulus, type StimulusJson, type StimulusStepJson } from '../runner/stimulus';
import { isPackageDef } from './allowed';
import { partsCensus } from './parts';

export function emptyChallenge(): Challenge {
  return { title: '', brief: '', allowed: [], required: [] };
}

/** What the schema cannot express about a challenge block. */
export function challengeErrors(challenge: Challenge): string[] {
  const errors: string[] = [];
  const { ics, tests, truthTable } = challenge;
  if (ics?.min !== undefined && ics.max !== undefined && ics.min > ics.max)
    errors.push(`/challenge/ics min ${ics.min} is above max ${ics.max}`);
  if (tests) {
    try {
      parseStimulus(tests);
    } catch (e) {
      errors.push(`/challenge/tests ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (truthTable) errors.push(...truthTableErrors(truthTable));
  return errors;
}

function truthTableErrors(table: ChallengeTruthTable): string[] {
  const errors: string[] = [];
  const names = [...table.inputs, ...table.outputs];
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) errors.push(`/challenge/truthTable names ${dup} twice`);
  const width = names.length;
  const seen = new Set<string>();
  table.rows.forEach((row, i) => {
    const at = `/challenge/truthTable/rows/${i}`;
    if (row.length !== width) errors.push(`${at} has ${row.length} cells, expected ${width}`);
    const ins = row.slice(0, table.inputs.length);
    if (ins.some((b) => b === null)) errors.push(`${at} leaves an input blank`);
    const key = ins.join('');
    if (seen.has(key)) errors.push(`${at} repeats inputs ${key}`);
    seen.add(key);
  });
  return errors;
}

/**
 * The board's Sequence as challenge test rows, keyed by label so they work on
 * a student's board with other ids. A row in key mode settles the logic with
 * no clock movement; in clock mode it takes one clock tick, as the Sequence tab does.
 */
export function testsFromSequence(board: Board): StimulusJson | string {
  const seq = board.sequence;
  if (!seq || seq.rows.length === 0) return 'The board has no Sequence rows to take';
  const byId = new Map(board.components.map((c) => [c.id, c]));
  const paths = componentPaths(board, '');
  const nameOf = (id: string): string | undefined => {
    const c = byId.get(id);
    return c?.label?.trim() ? paths.get(id) : undefined;
  };
  for (const id of [...seq.inputs, ...seq.expect]) {
    if (nameOf(id) === undefined)
      return `The Sequence column ${id} has no label: name it on the board first`;
  }
  let clock: string | undefined;
  if (seq.advance.mode === 'clock') {
    clock = nameOf(seq.advance.clock);
    if (clock === undefined)
      return `The Sequence clock ${seq.advance.clock} has no label: name it on the board first`;
  }
  const steps = seq.rows.map((row): StimulusStepJson => {
    const set: StimulusStepJson['set'] = {};
    seq.inputs.forEach((id, i) => {
      const v = row.set[i] ?? 0;
      set[nameOf(id)!] = byId.get(id)!.kind === 'spdt' ? (v ? 'b' : 'a') : v;
    });
    const expect: NonNullable<StimulusStepJson['expect']> = {};
    seq.expect.forEach((id, i) => {
      const want = row.expect?.[i];
      if (want !== null && want !== undefined) expect[nameOf(id)!] = want;
    });
    return {
      ...(Object.keys(set).length ? { set } : {}),
      ...(clock === undefined ? {} : { ticks: 1 }),
      ...(Object.keys(expect).length ? { expect } : {}),
      ...(row.note ? { note: row.note } : {}),
    };
  });
  return { ...(clock === undefined ? {} : { clock }), steps };
}

/** Distinct parts the board uses, as allowed-list entries, ICs first. */
export function partsOnBoard(board: Board, library: ChipLibrary): string[] {
  const census = partsCensus(board, library);
  const ics = census.parts.filter((p) => {
    const def = library.get(p.part);
    return def !== undefined && isPackageDef(def);
  });
  const rest = census.parts.filter((p) => !ics.includes(p));
  return [...new Set([...ics, ...rest].map((p) => p.part))];
}
