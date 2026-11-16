import { describe, expect, it } from 'vitest';
import { board, chipComp, chipDef, comp, wire } from '../model/testFixtures';
import type { Challenge, ChipDef, ChipLibrary } from '../model/types';
import { builtinChipLibrary } from '../parts/packages';
import { allowedOf, chipDefAllowed } from './allowed';
import { partsCensus, partsReport, type PartsRow } from './parts';
import { emptyChallenge, partsOnBoard } from './challenge';

const challenge = (over: Partial<Challenge>): Challenge => ({ ...emptyChallenge(), ...over });

/** Two NANDs: a student "inverter pair" chip. */
const pairDef = chipDef({
  id: 'pair',
  name: 'pair',
  pins: [],
  components: [comp('n1', 'nand'), comp('n2', 'nand'), comp('i', 'inport'), comp('o', 'outport')],
});
/** Two pairs inside: nested twice. */
const quadDef = chipDef({
  id: 'quad',
  name: 'quad',
  pins: [],
  components: [chipComp('p1', 'pair', 'P1'), chipComp('p2', 'pair', 'P2')],
});
const loopDef = chipDef({
  id: 'loop',
  name: 'loop',
  pins: [],
  components: [chipComp('self', 'loop', 'S')],
});

const lib: ChipLibrary = new Map<string, ChipDef>([
  ...builtinChipLibrary(),
  ['pair', pairDef],
  ['quad', quadDef],
  ['loop', loopDef],
]);

const rowOf = (rows: PartsRow[], id: string) => rows.find((r) => r.id === id)!;

describe('allowedOf', () => {
  it('allows anything under an empty list, and wiring aids under any list', () => {
    expect(allowedOf([], 'and')).toBe(true);
    for (const aid of ['netlabel', 'vcc', 'gnd', 'pullup', 'split', 'inport', 'probe'])
      expect(allowedOf(['nand'], aid)).toBe(true);
  });

  it('matches kinds and part numbers exactly', () => {
    expect(allowedOf(['nand', '74LS00'], 'nand')).toBe(true);
    expect(allowedOf(['nand', '74LS00'], '74LS00')).toBe(true);
    expect(allowedOf(['nand'], 'not')).toBe(false);
    expect(allowedOf(['nand'], '74LS00')).toBe(false);
  });

  it('allows a student chip by what is inside it', () => {
    expect(chipDefAllowed(['nand'], quadDef, lib)).toBe(true);
    expect(chipDefAllowed(['and'], quadDef, lib)).toBe(false);
    expect(chipDefAllowed(['74LS00'], lib.get('74LS00')!, lib)).toBe(true);
    expect(chipDefAllowed(['nand'], lib.get('74LS00')!, lib)).toBe(false);
    expect(chipDefAllowed(['nand'], loopDef, lib)).toBe(false);
  });
});

describe('partsReport, allowed list', () => {
  const nandOnly = challenge({ allowed: ['nand'] });

  it('flags an inverter under NAND only and passes a NAND with tied inputs', () => {
    const b = board({
      components: [
        comp('a', 'toggle', undefined, 'A'),
        comp('g1', 'nand', undefined, 'G1'),
        comp('g2', 'not', undefined, 'G2'),
        comp('y', 'led', undefined, 'Y'),
        comp('lbl', 'netlabel', undefined, 'N'),
      ],
      wires: [wire('w1', ['a', 'y'], ['g1', 'a']), wire('w2', ['a', 'y'], ['g1', 'b'])],
    });
    const allowed = rowOf(partsReport(b, lib, nandOnly), 'allowed');
    expect(allowed.met).toBe(false);
    expect(allowed.uses.map((u) => [u.name, u.part])).toEqual([['G2', 'not']]);
    const fixed = board({ ...b, components: b.components.filter((c) => c.id !== 'g2') });
    expect(rowOf(partsReport(fixed, lib, nandOnly), 'allowed').met).toBe(true);
  });

  it('never flags board I/O and still flags a clock, a display or a 555', () => {
    const b = board({
      components: [
        comp('a', 'toggle'),
        comp('b', 'button'),
        comp('s', 'spdt'),
        comp('y', 'led'),
        comp('k', 'clock'),
        comp('d', 'sevenseg'),
        comp('t', 'timer555'),
      ],
    });
    for (const part of ['toggle', 'button', 'spdt', 'led'])
      expect(allowedOf(['nand'], part)).toBe(true);
    const row = rowOf(partsReport(b, lib, nandOnly), 'allowed');
    expect(row.uses.map((u) => u.part)).toEqual(['clock', 'sevenseg', 'timer555']);
    expect(partsOnBoard(b, lib)).toEqual(['clock', 'sevenseg', 'timer555']);
  });

  it('has no allowed row under an empty list', () => {
    const b = board({ components: [comp('g', 'and')] });
    expect(partsReport(b, lib, challenge({})).map((r) => r.id)).toEqual([]);
  });

  it('flags a chip by part number, allows it once listed', () => {
    const b = board({ components: [chipComp('u1', '74LS161', 'U7')] });
    const row = rowOf(partsReport(b, lib, challenge({ allowed: ['74LS74'] })), 'allowed');
    expect(row.uses.map((u) => `${u.name} ${u.part}`)).toEqual(['U7 74LS161']);
    expect(rowOf(partsReport(b, lib, challenge({ allowed: ['74LS161'] })), 'allowed').met).toBe(
      true,
    );
  });

  it('flags a part inside a student chip, naming the path and the outer instance', () => {
    const b = board({ components: [chipComp('q', 'quad', 'Q1')] });
    const row = rowOf(partsReport(b, lib, challenge({ allowed: ['and'] })), 'allowed');
    expect(row.uses.map((u) => u.name)).toEqual(['Q1/P1/n1', 'Q1/P1/n2', 'Q1/P2/n1', 'Q1/P2/n2']);
    expect(new Set(row.uses.map((u) => u.component))).toEqual(new Set(['q']));
  });

  it('names a grouped part with its group', () => {
    const b = board({
      groups: [{ id: 'g', name: 'alu' }],
      components: [{ ...comp('x', 'xor', undefined, 'X1'), group: 'g' }],
    });
    const row = rowOf(partsReport(b, lib, challenge({ allowed: ['nand'] })), 'allowed');
    expect(row.uses[0]!.name).toBe('alu/X1');
  });
});

describe('partsReport, counts', () => {
  it('counts ICs: each 74LS part and 555 is one, a student chip counts what it holds', () => {
    const studentWithIc = chipDef({
      id: 'wrap',
      name: 'wrap',
      pins: [],
      components: [chipComp('u', '74LS00', 'U'), comp('g', 'and')],
    });
    const l = new Map(lib).set('wrap', studentWithIc);
    const b = board({
      components: [
        chipComp('u1', '74LS00', 'U1'),
        chipComp('u2', '74LS74', 'U2'),
        comp('t', 'timer555', undefined, 'U3'),
        chipComp('w', 'wrap', 'W'),
        comp('g', 'and'),
      ],
    });
    const census = partsCensus(b, l);
    expect(census.ics.map((u) => u.name)).toEqual(['U1', 'U2', 'U3', 'W/U']);
    const ics = (min?: number, max?: number) =>
      rowOf(
        partsReport(
          b,
          l,
          challenge({
            ics: { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) },
          }),
        ),
        'ics',
      );
    expect(ics(4, 4).met).toBe(true);
    expect(ics(5).met).toBe(false);
    expect(ics(undefined, 3).met).toBe(false);
    expect(ics(2, 10).count).toBe(4);
  });

  it('counts gates by bit width, never fan-in, and never inside a 74LS part', () => {
    const b = board({
      components: [
        comp('a4', 'and', { width: 4 }),
        comp('n3', 'nand', { inputs: 3 }),
        comp('inv', 'not'),
        chipComp('u1', '74LS00', 'U1'),
      ],
    });
    expect(partsCensus(b, lib).gateCount).toBe(6);
    expect(rowOf(partsReport(b, lib, challenge({ maxGates: 6 })), 'gates').met).toBe(true);
    expect(rowOf(partsReport(b, lib, challenge({ maxGates: 5 })), 'gates').met).toBe(false);
  });

  it('counts a student chip placed three times, nested twice, by its contents', () => {
    const b = board({
      components: [
        chipComp('a', 'quad', 'A'),
        chipComp('b', 'quad', 'B'),
        chipComp('c', 'quad', 'C'),
      ],
    });
    expect(partsCensus(b, lib).gateCount).toBe(12);
    expect(partsCensus(b, lib).ics).toEqual([]);
  });

  it('needs N of any part in a required entry', () => {
    const b = board({
      components: [chipComp('u8', '74LS47', 'U8'), comp('t', 'timer555', undefined, 'U9')],
    });
    const rows = partsReport(
      b,
      lib,
      challenge({
        required: [
          { anyOf: ['timer555'], count: 1 },
          { anyOf: ['74LS47', '74LS48'], count: 1 },
          { anyOf: ['74LS74'], count: 2 },
        ],
      }),
    );
    expect(rows.map((r) => [r.id, r.met, r.count])).toEqual([
      ['required-0', true, 1],
      ['required-1', true, 1],
      ['required-2', false, 0],
    ]);
  });

  it('sums parts across groups', () => {
    const b = board({
      groups: [
        { id: 'g1', name: 'one' },
        { id: 'g2', name: 'two' },
      ],
      components: [
        { ...chipComp('u1', '74LS00', 'U1'), group: 'g1' },
        { ...chipComp('u2', '74LS00', 'U1'), group: 'g2' },
      ],
    });
    expect(rowOf(partsReport(b, lib, challenge({ ics: { min: 2 } })), 'ics').met).toBe(true);
  });
});

describe('partsReport, odd boards', () => {
  it('reports a missing or self-containing def, and never throws', () => {
    const b = board({ components: [chipComp('m', 'gone', 'M'), chipComp('l', 'loop', 'L')] });
    const rows = partsReport(b, lib, challenge({ allowed: ['nand'] }));
    expect(rowOf(rows, 'library').problems.map((p) => [p.name, p.kind])).toEqual([
      ['M', 'missing'],
      ['L/S', 'recursive'],
    ]);
  });

  it('reports on a board that does not compile', () => {
    // Two outputs drive one net: compile refuses, the census does not care.
    const b = board({
      components: [comp('g1', 'and'), comp('g2', 'and')],
      wires: [wire('w', ['g1', 'y'], ['g2', 'y'])],
    });
    expect(rowOf(partsReport(b, lib, challenge({ maxGates: 1 })), 'gates').count).toBe(2);
  });

  it('lists the parts on a board, ICs first, aids left out', () => {
    const b = board({
      components: [
        comp('a', 'toggle'),
        chipComp('u', '74LS00', 'U'),
        comp('v', 'vcc'),
        comp('g', 'nand'),
        comp('g2', 'nand'),
      ],
    });
    expect(partsOnBoard(b, lib)).toEqual(['74LS00', 'nand']);
  });
});
