import { describe, expect, it } from 'vitest';
import { behaviorReport } from '../core/challenge/behavior';
import { WIRING_AIDS } from '../core/challenge/allowed';
import { challengeChanged } from '../core/challenge/fingerprint';
import { partsReport } from '../core/challenge/parts';
import { board, comp, wire } from '../core/model/testFixtures';
import type { Board, ChipDef, ChipLibrary, ComponentKind } from '../core/model/types';
import { builtinChipLibrary } from '../core/parts/packages';
import { CHALLENGES, EXAMPLES } from './index';

function exampleOf(id: string): { board: Board; lib: ChipLibrary } {
  const e = EXAMPLES.find((x) => x.id === id)!;
  return {
    board: e.board,
    lib: new Map<string, ChipDef>([
      ...builtinChipLibrary(),
      ...(e.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
    ]),
  };
}

/** Every row met: parts live, behavior from a check. */
function allMet(b: Board, lib: ChipLibrary): { parts: boolean; behavior: boolean } {
  const ch = b.challenge!;
  const parts = partsReport(b, lib, ch).every((r) => r.met);
  const r = behaviorReport(b, lib, ch, b.timing);
  const tests = !r.tests || (r.tests.passed === r.tests.total && r.tests.failures.length === 0);
  const table =
    !r.table || (r.table.error === undefined && r.table.matched === r.table.rows.length);
  return { parts, behavior: tests && table };
}

/** Y = NAND(NAND(A,B), NAND(B,C), NAND(A,C)): the majority in four NANDs. */
function nandMajority(starter: Board): Board {
  return board({
    ...starter,
    components: [
      ...starter.components,
      comp('g1', 'nand'),
      comp('g2', 'nand'),
      comp('g3', 'nand'),
      comp('g4', 'nand', { inputs: 3 }),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['g1', 'a']),
      wire('w2', ['b', 'y'], ['g1', 'b']),
      wire('w3', ['b', 'y'], ['g2', 'a']),
      wire('w4', ['c', 'y'], ['g2', 'b']),
      wire('w5', ['a', 'y'], ['g3', 'a']),
      wire('w6', ['c', 'y'], ['g3', 'b']),
      wire('w7', ['g1', 'y'], ['g4', 'a']),
      wire('w8', ['g2', 'y'], ['g4', 'b']),
      wire('w9', ['g3', 'y'], ['g4', 'c']),
      wire('w10', ['g4', 'y'], ['y', 'a']),
    ],
  });
}

const ANSWERS: [string, (starter: Board) => Board][] = [
  ['majority-vote-nand-only', nandMajority],
  [
    'minterms-on-a-74ls138',
    (s) => ({ ...exampleOf('decoder-logic-on-a-74ls138').board, challenge: s.challenge }),
  ],
  [
    'three-bit-counter-from-74ls-parts',
    (s) => ({ ...exampleOf('three-bit-counter-on-two-74ls74s').board, challenge: s.challenge }),
  ],
];

describe('sample challenges', () => {
  it('lists every starter under Challenges', () => {
    expect(EXAMPLES.filter((e) => e.group === CHALLENGES).map((e) => e.id)).toEqual(
      ANSWERS.map(([id]) => id),
    );
  });

  it.each(ANSWERS)('%s: set, unchanged, failing on the starter', (id) => {
    const { board: starter, lib } = exampleOf(id);
    expect(starter.challenge?.fingerprint).toBeDefined();
    expect(challengeChanged(starter.challenge!)).toBe(false);
    expect(starter.challenge!.allowed.filter((p) => WIRING_AIDS.has(p as ComponentKind))).toEqual(
      [],
    );
    expect(allMet(starter, lib)).not.toEqual({ parts: true, behavior: true });
  });

  it.each(ANSWERS)('%s: every row met on the answer board', (id, answerOf) => {
    const { board: starter, lib } = exampleOf(id);
    expect(allMet(answerOf(starter), lib)).toEqual({ parts: true, behavior: true });
  });
});
