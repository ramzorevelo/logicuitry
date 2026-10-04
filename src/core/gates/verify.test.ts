// Task 4: a packaged def's analysis table must not gain a redundant input
// variable just because a second In-label pin was attached to a net an
// existing terminal already covers: labels are packaging aliases, not
// additional logical inputs (analysisTablesOf's net dedup, unlike
// truthTableOf's, is safe here since it isn't diffed against a different
// topology the way bubble-push's whole-board check is).

import { describe, expect, it } from 'vitest';
import { comp, wire, board } from '../model/testFixtures';
import type { ChipLibrary } from '../model/types';
import { analysisTablesOf, boardDiffRows, truthTableOf } from './verify';

const noLib: ChipLibrary = new Map();

describe('analysisTablesOf label dedup (Task 4)', () => {
  it('a second In label sharing an existing input net does not add a table variable', () => {
    const withoutLabel = board({
      components: [comp('in1', 'inport'), comp('g', 'buf'), comp('o', 'outport')],
      wires: [wire('w1', ['in1', 'y'], ['g', 'a']), wire('w2', ['g', 'y'], ['o', 'a'])],
    });
    const withLabel = board({
      components: [
        comp('in1', 'inport'),
        comp('in2', 'inport'), // second alias, same net as in1
        comp('g', 'buf'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w1', ['in1', 'y'], ['g', 'a']),
        wire('w2', ['g', 'y'], ['o', 'a']),
        wire('w3', ['in2', 'y'], ['in1', 'y']),
      ],
    });
    const before = analysisTablesOf(withoutLabel, noLib)[0]!.table!;
    const after = analysisTablesOf(withLabel, noLib)[0]!.table!;
    expect(after.inputPaths.length).toBe(before.inputPaths.length);
    expect(after.rows).toEqual(before.rows);
  });

  it('a switch and an In label naming its net collapse to one input (the packaging repro)', () => {
    const b = board({
      components: [
        comp('sw', 'toggle'),
        comp('in1', 'inport'),
        comp('g', 'buf'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w1', ['sw', 'y'], ['in1', 'y']),
        wire('w2', ['in1', 'y'], ['g', 'a']),
        wire('w3', ['g', 'y'], ['o', 'a']),
      ],
    });
    const table = analysisTablesOf(b, noLib)[0]!.table!;
    expect(table.inputPaths).toHaveLength(1);
  });
});

describe('truthTableOf stays per-terminal (no net dedup)', () => {
  it('two In labels sharing a net still each get their own column (whole-board defense-in-depth)', () => {
    const b = board({
      components: [comp('in1', 'inport'), comp('in2', 'inport'), comp('g', 'and')],
      wires: [wire('w1', ['in1', 'y'], ['g', 'a']), wire('w2', ['in2', 'y'], ['g', 'a'])],
    });
    const table = truthTableOf(b, noLib);
    expect(table.inputPaths).toHaveLength(2);
  });
});

describe('boardDiffRows over independent groups', () => {
  const chains = (n: number, invertLast = false) =>
    board({
      components: Array.from({ length: n }, (_, i) => [
        comp(`i${i}`, 'inport'),
        comp(`g${i}`, invertLast && i === n - 1 ? 'not' : 'buf'),
        comp(`o${i}`, 'outport'),
      ]).flat(),
      wires: Array.from({ length: n }, (_, i) => [
        wire(`a${i}`, [`i${i}`, 'y'], [`g${i}`, 'a']),
        wire(`b${i}`, [`g${i}`, 'y'], [`o${i}`, 'a']),
      ]).flat(),
    });

  it('11 inputs that never meet are checked per output, where the whole-board table refuses', () => {
    const b = chains(11);
    expect(() => truthTableOf(b, noLib)).toThrow(/exceeds max/);
    expect(boardDiffRows(b, chains(11), noLib)).toEqual([]);
  });

  it('still catches a changed function inside one cone', () => {
    expect(boardDiffRows(chains(11), chains(11, true), noLib).length).toBeGreaterThan(0);
  });

  it('refuses one output that really needs more than 8 inputs', () => {
    const wide = board({
      components: [
        ...Array.from({ length: 9 }, (_, i) => comp(`i${i}`, 'inport')),
        comp('g', 'and', { inputs: 8 }),
        comp('g2', 'and'),
        comp('o', 'outport'),
      ],
      wires: [
        ...Array.from({ length: 8 }, (_, i) =>
          wire(`w${i}`, [`i${i}`, 'y'], ['g', String.fromCharCode(97 + i)]),
        ),
        wire('w8', ['g', 'y'], ['g2', 'a']),
        wire('w9', ['i8', 'y'], ['g2', 'b']),
        wire('wo', ['g2', 'y'], ['o', 'a']),
      ],
    });
    expect(() => boardDiffRows(wide, wide, noLib)).toThrow(/max 8/);
  });
});

describe('analysisTablesOf across a net-label name join', () => {
  const label = (id: string, name: string) => comp(id, 'netlabel', undefined, name);

  it('two In ports joined only by a label name collapse to one input variable', () => {
    // in1 and in2 are wired to nothing in common -- the join is the shared
    // label name CLK. If compile's union works, Analyze sees one variable.
    const joined = board({
      components: [
        comp('in1', 'inport'),
        comp('in2', 'inport'),
        label('L1', 'CLK'),
        label('L2', 'CLK'),
        comp('g', 'and'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w1', ['in1', 'y'], ['L1', 'a']),
        wire('w2', ['in1', 'y'], ['g', 'a']),
        wire('w3', ['in2', 'y'], ['L2', 'a']),
        wire('w4', ['in2', 'y'], ['g', 'b']),
        wire('w5', ['g', 'y'], ['o', 'a']),
      ],
    });
    const split = board({
      components: [
        comp('in1', 'inport'),
        comp('in2', 'inport'),
        comp('g', 'and'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w2', ['in1', 'y'], ['g', 'a']),
        wire('w4', ['in2', 'y'], ['g', 'b']),
        wire('w5', ['g', 'y'], ['o', 'a']),
      ],
    });
    expect(analysisTablesOf(split, noLib)[0]!.table!.inputPaths.length).toBe(2);
    expect(analysisTablesOf(joined, noLib)[0]!.table!.inputPaths.length).toBe(1);
  });
});
