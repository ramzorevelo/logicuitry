// Task 4: a packaged def's analysis table must not gain a redundant input
// variable just because a second In-label pin was attached to a net an
// existing terminal already covers: labels are packaging aliases, not
// additional logical inputs (analysisTablesOf's net dedup, unlike
// truthTableOf's, is safe here since it isn't diffed against a different
// topology the way bubble-push's whole-board check is).

import { describe, expect, it } from 'vitest';
import { comp, wire, board } from '../model/testFixtures';
import type { ChipLibrary, Component } from '../model/types';
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

describe('stored state refuses a truth table', () => {
  const stateful: [string, string, string][] = [
    ['dff', 'd', 'q'],
    ['dlatch', 'd', 'q'],
    ['register', 'd', 'q'],
    ['srlatch', 's', 'q'],
    ['counter', 'clk', 'tc'],
    ['shiftreg', 'si', 'so'],
  ];

  for (const [kind, inPin, outPin] of stateful) {
    // A gate beside the stateful part, on its own output, must still analyze.
    const b = board({
      components: [
        comp('a', 'toggle', undefined, 'A'),
        comp('b', 'toggle', undefined, 'B'),
        comp('u', kind as Component['kind']),
        comp('g', 'not'),
        comp('l1', 'led', undefined, 'Y1'),
        comp('l2', 'led', undefined, 'Y2'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['u', inPin]),
        wire('w2', ['u', outPin], ['l1', 'a']),
        wire('w3', ['b', 'y'], ['g', 'a']),
        wire('w4', ['g', 'y'], ['l2', 'a']),
      ],
    });

    it(`${kind}: Analyze refuses the output it feeds and keeps the other`, () => {
      const [fed, other] = analysisTablesOf(b, noLib);
      expect(fed!.table).toBeNull();
      expect(fed!.error).toBe('Y1 depends on a flip-flop or latch, so it has no truth table');
      expect(other!.error).toBeNull();
      expect(other!.table!.rows.length).toBe(2);
    });

    it(`${kind}: bubble verify refuses the board`, () => {
      expect(() => boardDiffRows(b, b, noLib)).toThrow(/stores state/);
    });
  }
});

describe('analysisTablesOf keeps unwired inputs of the output group', () => {
  const inGroup = (c: Component, group: string): Component => ({ ...c, group });

  it('a built four-input table whose output is D analyses over A, B, C and D', () => {
    const b = board({
      groups: [{ id: 'g1', name: 'Built' }],
      components: [
        ...['A', 'B', 'C', 'D'].map((n) =>
          inGroup(comp(n.toLowerCase(), 'toggle', undefined, n), 'g1'),
        ),
        inGroup(comp('y', 'led', undefined, 'D out'), 'g1'),
      ],
      wires: [wire('w1', ['d', 'y'], ['y', 'a'])],
    });
    const [only] = analysisTablesOf(b, noLib);
    expect(only!.table!.inputPaths).toEqual([
      'main/Built/A',
      'main/Built/B',
      'main/Built/C',
      'main/Built/D',
    ]);
    expect(only!.table!.rows.map((r) => r[0]!.v)).toEqual(
      Array.from({ length: 16 }, (_, m) => m & 1),
    );
  });

  it('an input driving only the first output of a group stays out of the second', () => {
    const b = board({
      groups: [{ id: 'g1', name: 'Pair' }],
      components: [
        inGroup(comp('a', 'toggle', undefined, 'A'), 'g1'),
        inGroup(comp('b', 'toggle', undefined, 'B'), 'g1'),
        inGroup(comp('c', 'toggle', undefined, 'C'), 'g1'),
        inGroup(comp('ga', 'buf'), 'g1'),
        inGroup(comp('gb', 'buf'), 'g1'),
        inGroup(comp('y1', 'led', undefined, 'Y1'), 'g1'),
        inGroup(comp('y2', 'led', undefined, 'Y2'), 'g1'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['ga', 'a']),
        wire('w2', ['ga', 'y'], ['y1', 'a']),
        wire('w3', ['b', 'y'], ['gb', 'a']),
        wire('w4', ['gb', 'y'], ['y2', 'a']),
      ],
    });
    const [y1, y2] = analysisTablesOf(b, noLib);
    expect(y1!.table!.inputPaths).toEqual(['main/Pair/A', 'main/Pair/C']);
    expect(y2!.table!.inputPaths).toEqual(['main/Pair/B', 'main/Pair/C']);
  });

  it('a stray unwired switch on the board joins a board output, not a grouped one', () => {
    const b = board({
      groups: [{ id: 'g1', name: 'Other' }],
      components: [
        comp('a', 'toggle', undefined, 'A'),
        comp('s', 'toggle', undefined, 'S'),
        comp('g', 'not'),
        comp('y', 'led', undefined, 'Y'),
        inGroup(comp('z', 'toggle', undefined, 'Z'), 'g1'),
      ],
      wires: [wire('w1', ['a', 'y'], ['g', 'a']), wire('w2', ['g', 'y'], ['y', 'a'])],
    });
    expect(analysisTablesOf(b, noLib)[0]!.table!.inputPaths).toEqual(['main/A', 'main/S']);
  });

  it('an output nothing drives is not connected, even beside an unwired switch', () => {
    const b = board({
      components: [comp('s', 'toggle', undefined, 'S'), comp('y', 'led', undefined, 'Y')],
    });
    expect(analysisTablesOf(b, noLib)[0]!.error).toBe('Y is not connected to any input');
  });

  it('counts unwired inputs against the five-input limit', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const b = board({
      components: [
        ...names.map((n) => comp(n, 'toggle', undefined, n)),
        comp('y', 'led', undefined, 'Y'),
      ],
      wires: [wire('w1', ['A', 'y'], ['y', 'a'])],
    });
    expect(analysisTablesOf(b, noLib)[0]!.error).toBe('Y reads 6 inputs; Analyze handles up to 5');
  });
});
