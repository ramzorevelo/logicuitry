import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../examples/index';
import { board, comp, wire } from '../model/testFixtures';
import type { Board, Challenge, ChipDef, ChipLibrary, TimingSetting } from '../model/types';
import { builtinChipLibrary } from '../parts/packages';
import type { StimulusJson } from '../runner/stimulus';
import { behaviorReport, truthTableFromBoard } from './behavior';
import { emptyChallenge, testsFromSequence } from './challenge';
import { resolveName } from './names';

const IDEAL: TimingSetting = { mode: 'ideal', datasheet: 'typ', vendor: 'ti' };
const DATASHEET: TimingSetting = { mode: 'datasheet', datasheet: 'typ', vendor: 'ti' };
const lib = builtinChipLibrary();

function exampleOf(id: string): { board: Board; lib: ChipLibrary } {
  const e = EXAMPLES.find((x) => x.id === id)!;
  return {
    board: e.board,
    lib: new Map<string, ChipDef>([
      ...lib,
      ...(e.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
    ]),
  };
}

const withTests = (tests: StimulusJson): Challenge => ({ ...emptyChallenge(), tests });

/** Y = A NAND B, on a NAND gate and an LED. */
const nandBoard = (over: Partial<Board> = {}) =>
  board({
    components: [
      comp('a', 'toggle', undefined, 'A'),
      comp('b', 'toggle', undefined, 'B'),
      comp('g', 'nand'),
      comp('y', 'led', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['g', 'a']),
      wire('w2', ['b', 'y'], ['g', 'b']),
      wire('w3', ['g', 'y'], ['y', 'a']),
    ],
    ...over,
  });

const nandTable = (yColumn: (0 | 1 | null)[]): Challenge => ({
  ...emptyChallenge(),
  truthTable: {
    inputs: ['A', 'B'],
    outputs: ['Y'],
    rows: [0, 1, 2, 3].map((r) => [(r >> 1) as 0 | 1, (r & 1) as 0 | 1, yColumn[r]!]),
  },
});

describe.each([
  ['ideal', IDEAL],
  ['datasheet', DATASHEET],
])('behaviorReport tests, %s timing', (_, timing) => {
  it('passes and fails test rows on a clocked board, naming the row', () => {
    const { board: b, lib: l } = exampleOf('three-bit-counter-on-two-74ls74s');
    const pass = behaviorReport(
      b,
      l,
      withTests({ steps: [{ set: { '/CLR': 1 }, ticks: 3, expect: { Q2: 0, Q1: 1, Q0: 1 } }] }),
      timing,
    );
    expect(pass.timing).toBe(timing.mode);
    expect(pass.tests).toMatchObject({ total: 1, passed: 1, failures: [] });
    const fail = behaviorReport(
      b,
      l,
      withTests({
        steps: [
          { set: { '/CLR': 1 }, ticks: 3, expect: { Q2: 0 } },
          { ticks: 1, expect: { Q2: 0 } },
        ],
      }),
      timing,
    );
    expect(fail.tests).toMatchObject({ total: 2, passed: 1 });
    expect(fail.tests!.failures).toEqual([
      { step: 1, tick: 4, name: 'Q2', expected: '0', actual: '1' },
    ]);
    expect(fail.tests!.components).toHaveLength(1);
  });

  it('runs a 555 clock board', () => {
    const { board: b, lib: l } = exampleOf('clock-module');
    const r = behaviorReport(
      b,
      l,
      withTests({ steps: [{ ticks: 2, expect: { CLK: 0 } }] }),
      timing,
    );
    expect(r.tests).toMatchObject({ total: 1, passed: 1 });
  });
});

describe('behaviorReport tests', () => {
  it('reads an active-low LED lit and a display as a digit', () => {
    const lamps = board({
      components: [
        comp('s', 'toggle', undefined, 'S'),
        comp('l', 'led', { activeLow: true }, 'LOW'),
      ],
      wires: [wire('w', ['s', 'y'], ['l', 'a'])],
    });
    const r = behaviorReport(
      lamps,
      lib,
      withTests({ steps: [{ set: { S: 0 }, wait: { ms: 1 }, expect: { LOW: 1 } }] }),
      IDEAL,
    );
    expect(r.tests!.passed).toBe(1);
    const { board: d, lib: l } = exampleOf('seven-segment-display-on-a-74ls47');
    const digit = behaviorReport(
      d,
      l,
      withTests({
        steps: [{ set: { D: 0, C: 1, B: 0, A: 1 }, wait: { ms: 0.001 }, expect: { ds: 5 } }],
      }),
      IDEAL,
    );
    expect(digit.tests!.passed).toBe(1);
  });

  it('fails an output gone X with no expected value', () => {
    const floating = board({
      components: [comp('n', 'not'), comp('y', 'led', undefined, 'Y')],
      wires: [wire('w', ['n', 'y'], ['y', 'a'])],
    });
    const r = behaviorReport(
      floating,
      lib,
      withTests({ steps: [{ wait: { ms: 1 }, expect: { Y: 1 } }] }),
      IDEAL,
    );
    expect(r.tests!.failures).toContainEqual({ step: 0, tick: 0, name: 'Y', actual: 'X' });
    expect(r.tests!.passed).toBe(0);
  });

  it('fails the row naming a missing or a doubled input, keeping the rows before it', () => {
    const b = nandBoard();
    const missing = behaviorReport(
      b,
      lib,
      withTests({
        steps: [
          { set: { A: 1, B: 1 }, wait: { ms: 1 }, expect: { Y: 0 } },
          { set: { C: 1 }, wait: { ms: 1 } },
        ],
      }),
      IDEAL,
    );
    expect(missing.tests).toMatchObject({
      total: 2,
      passed: 1,
      error: { step: 1, message: 'No input named C on this board' },
    });
    const grouped = nandBoard({
      groups: [{ id: 'g', name: 'alu' }],
      components: [
        ...nandBoard().components,
        { ...comp('a2', 'toggle', undefined, 'A'), group: 'g' },
      ],
    });
    // The board-level A wins over alu/A.
    expect(resolveName(grouped, 'A', 'input')).toMatchObject({ path: 'A' });
    const twoGroups = board({
      groups: [
        { id: 'g1', name: 'alu' },
        { id: 'g2', name: 'mem' },
      ],
      components: [
        { ...comp('a1', 'toggle', undefined, 'A'), group: 'g1' },
        { ...comp('a2', 'toggle', undefined, 'A'), group: 'g2' },
      ],
    });
    const dup = behaviorReport(
      twoGroups,
      lib,
      withTests({ steps: [{ set: { A: 1 }, wait: { ms: 1 } }] }),
      IDEAL,
    );
    expect(dup.tests!.error).toEqual({ step: 0, message: 'Two parts named A: alu/A and mem/A' });
    const qualified = behaviorReport(
      twoGroups,
      lib,
      withTests({ steps: [{ set: { 'mem/A': 1 }, wait: { ms: 1 } }] }),
      IDEAL,
    );
    expect(qualified.tests!.passed).toBe(1);
  });

  it('fails ticks on a board with no clock', () => {
    const r = behaviorReport(nandBoard(), lib, withTests({ steps: [{ ticks: 1 }] }), IDEAL);
    expect(r.tests!.error!.message).toMatch(/no clock or astable 555/);
  });

  it('stops at the event budget on an oscillating board', () => {
    // A NAND fed back on itself rings once its enable goes high.
    const ring = board({
      components: [
        comp('c', 'clock', { periodPs: 1_000_000_000 }, 'CLK'),
        comp('en', 'toggle', undefined, 'EN'),
        comp('n', 'nand'),
        comp('y', 'led', undefined, 'Y'),
      ],
      wires: [
        wire('w1', ['en', 'y'], ['n', 'a']),
        wire('w2', ['n', 'y'], ['n', 'b']),
        wire('w3', ['n', 'y'], ['y', 'a']),
      ],
    });
    const r = behaviorReport(
      ring,
      lib,
      withTests({ steps: [{ ticks: 1 }, { set: { EN: 1 }, ticks: 1 }] }),
      IDEAL,
    );
    expect(r.tests!.error).toMatchObject({ step: 1, message: expect.stringMatching(/oscillates/) });
    expect(r.tests!.passed).toBe(1);
  }, 30_000);

  it('reports a bad stimulus without throwing', () => {
    const r = behaviorReport(nandBoard(), lib, withTests({ steps: [{ ticks: -1 }] }), IDEAL);
    expect(r.tests!.error!.message).toMatch(/ticks/);
  });
});

describe('behaviorReport truth table', () => {
  it('passes a matching table and fails one row with its actual value', () => {
    expect(behaviorReport(nandBoard(), lib, nandTable([1, 1, 1, 0]), IDEAL).table).toMatchObject({
      matched: 4,
      components: [],
    });
    const r = behaviorReport(nandBoard(), lib, nandTable([1, 1, 0, 0]), IDEAL).table!;
    expect(r.matched).toBe(3);
    expect(r.rows[2]).toEqual({ inputs: [1, 0], expected: [0], actual: ['1'], ok: false });
    expect(r.components).toEqual(['y']);
  });

  it('treats a null cell as do not care', () => {
    expect(
      behaviorReport(nandBoard(), lib, nandTable([1, null, null, 0]), IDEAL).table!.matched,
    ).toBe(4);
  });

  it('reads an active-low LED lit', () => {
    const inverted = nandBoard({
      components: nandBoard().components.map((c) =>
        c.id === 'y' ? { ...c, params: { activeLow: true } } : c,
      ),
    });
    expect(behaviorReport(inverted, lib, nandTable([0, 0, 0, 1]), IDEAL).table!.matched).toBe(4);
  });

  it('refuses a sequential board, a wide terminal and a missing name', () => {
    const { board: latch, lib: l } = exampleOf('three-bit-counter-on-two-74ls74s');
    const seq = behaviorReport(
      latch,
      l,
      { ...emptyChallenge(), truthTable: { inputs: ['/CLR'], outputs: ['Q0'], rows: [[0, 0]] } },
      IDEAL,
    ).table!;
    expect(seq.error).toMatch(/stores state/);
    const wide = board({
      components: [comp('t', 'toggle', { width: 4 }, 'N'), comp('l', 'led', { width: 4 }, 'L')],
      wires: [wire('w', ['t', 'y'], ['l', 'a'])],
    });
    const w = behaviorReport(
      wide,
      lib,
      { ...emptyChallenge(), truthTable: { inputs: ['N'], outputs: ['L'], rows: [] } },
      IDEAL,
    ).table!;
    expect(w.error).toBe('N is 4 bits: a truth table names 1-bit inputs and outputs');
    const gone = behaviorReport(
      nandBoard(),
      lib,
      { ...nandTable([1, 1, 1, 0]), truthTable: { inputs: ['A', 'Q'], outputs: ['Y'], rows: [] } },
      IDEAL,
    ).table!;
    expect(gone.error).toBe('No input named Q on this board');
  });

  it('takes the board answer as a target table', () => {
    expect(truthTableFromBoard(nandBoard(), lib)).toEqual({
      inputs: ['A', 'B'],
      outputs: ['Y'],
      rows: [
        [0, 0, 1],
        [0, 1, 1],
        [1, 0, 1],
        [1, 1, 0],
      ],
    });
    const { board: c, lib: l } = exampleOf('three-bit-counter-on-two-74ls74s');
    expect(truthTableFromBoard(c, l)).toMatch(/stores state|no label/);
  });

  it('is the same report on the same board', () => {
    const a = behaviorReport(nandBoard(), lib, nandTable([1, 1, 0, 0]), IDEAL);
    expect(behaviorReport(nandBoard(), lib, nandTable([1, 1, 0, 0]), IDEAL)).toEqual(a);
  });
});

describe('testsFromSequence', () => {
  it('converts the Sequence by label and refuses an unlabeled column', () => {
    const b = nandBoard({
      sequence: {
        inputs: ['a', 'b'],
        expect: ['y'],
        rows: [
          { set: [1, 1], expect: [0] },
          { set: [0, 1], expect: [null], note: 'free' },
        ],
        advance: { mode: 'key' },
        hideExpected: false,
      },
    });
    const tests = testsFromSequence(b);
    expect(tests).toEqual({
      steps: [
        { set: { A: 1, B: 1 }, expect: { Y: 0 } },
        { set: { A: 0, B: 1 }, note: 'free' },
      ],
    });
    expect(behaviorReport(b, lib, withTests(tests as StimulusJson), IDEAL).tests!.passed).toBe(2);
    const unlabeled = {
      ...b,
      components: b.components.map((c) => (c.id === 'b' ? { ...c, label: '' } : c)),
    };
    expect(testsFromSequence(unlabeled)).toMatch(/column b has no label/);
    expect(testsFromSequence(nandBoard())).toMatch(/no Sequence rows/);
  });
});
