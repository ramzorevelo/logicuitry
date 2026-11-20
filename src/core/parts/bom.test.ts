import { describe, expect, it } from 'vitest';
import { partsCensus } from '../challenge/parts';
import { board, chipComp, chipDef, comp } from '../model/testFixtures';
import type { ChipDef, ChipLibrary, Component } from '../model/types';
import { bomOf, bomTable } from './bom';
import { builtinChipLibrary } from './packages';

const leafDef = chipDef({
  id: 'leaf',
  name: 'Leaf',
  pins: [],
  components: [chipComp('a', '74LS00', 'A'), comp('n', 'nand'), comp('i', 'inport')],
});
const pairDef = chipDef({
  id: 'pair',
  name: 'Pair',
  pins: [],
  components: [chipComp('l1', 'leaf', 'L1'), chipComp('l2', 'leaf', 'L2')],
});
const loopDef = chipDef({
  id: 'loop',
  name: 'Loop',
  pins: [],
  components: [chipComp('self', 'loop', 'S')],
});

const lib: ChipLibrary = new Map<string, ChipDef>([
  ...builtinChipLibrary(),
  ['leaf', leafDef],
  ['pair', pairDef],
  ['loop', loopDef],
]);

const ands = (n: number, params?: Record<string, number>): Component[] =>
  Array.from({ length: n }, (_, i) => comp(`g${i}`, 'and', params));

describe('bomOf', () => {
  it('counts packages through nested chips and a chip used twice', () => {
    const b = board({
      components: [chipComp('p', 'pair', 'P'), chipComp('x', '74LS00', 'X')],
    });
    const bom = bomOf(b, lib);
    expect(bom.packages).toEqual([
      { part: '74LS00', caption: expect.any(String), qty: 3, where: ['Board', 'Leaf'] },
    ]);
    expect(bom.looseGates).toMatchObject([{ key: 'nand:2', count: 2 }]);
    expect(bom.icTotal).toBe(3);
  });

  it('lists generic parts and skips probes, ports, clocks and rails', () => {
    const b = board({
      components: [
        comp('t', 'timer555'),
        comp('l1', 'led'),
        comp('l2', 'led'),
        comp('b', 'button'),
        comp('s', 'toggle'),
        comp('d', 'spdt'),
        comp('s1', 'sevenseg', { common: 'anode' }),
        comp('s2', 'sevenseg'),
        comp('bd', 'busdisplay'),
        comp('p', 'probe'),
        comp('c', 'clock'),
        comp('v', 'vcc'),
        comp('o', 'outport'),
      ],
    });
    const bom = bomOf(b, lib);
    expect(bom.generic.map((g) => [g.caption, g.qty])).toEqual([
      ['555 timer', 1],
      ['Seven-segment display, common anode', 1],
      ['Seven-segment display, common cathode', 1],
      ['LED bar display', 1],
      ['LED', 2],
      ['Push button', 1],
      ['Toggle switch', 1],
      ['SPDT switch', 1],
    ]);
    expect(bom.icTotal).toBe(1);
  });

  it('packs 5 two-input ANDs into 2 74LS08 with 3 spare', () => {
    const b = board({ components: ands(5) });
    const plain = bomOf(b, lib);
    expect(plain.looseGates[0]).toMatchObject({
      key: 'and:2',
      count: 5,
      options: [{ part: '74LS08', perPackage: 4 }],
    });
    expect(plain.looseGates[0]!.choice).toBeUndefined();
    expect(plain.icTotal).toBe(0);
    expect(plain.unpackedGates).toBe(5);
    const bom = bomOf(b, lib, { 'and:2': '74LS08' });
    expect(bom.looseGates[0]).toMatchObject({ choice: '74LS08', ics: 2, spare: 3 });
    expect(bom.icTotal).toBe(2);
    expect(bom.unpackedGates).toBe(0);
  });

  it('counts a width-N gate as N gates', () => {
    const bom = bomOf(board({ components: [comp('g', 'and', { width: 4 })] }), lib);
    expect(bom.looseGates[0]!.count).toBe(4);
  });

  it('keys gates by input count, with options only where a package exists', () => {
    const b = board({
      components: [
        comp('a', 'and', { inputs: 3 }),
        comp('b', 'and'),
        comp('n', 'not'),
        comp('x', 'xnor'),
      ],
    });
    const bom = bomOf(b, lib);
    expect(bom.looseGates.map((g) => [g.key, g.options.map((o) => o.part)])).toEqual([
      ['and:2', ['74LS08']],
      ['and:3', []],
      ['xnor:2', []],
      ['not:1', ['74LS04']],
    ]);
    const chosen = bomOf(b, lib, { 'and:3': '74LS08', 'not:1': '74LS04' });
    expect(chosen.looseGates.find((g) => g.key === 'and:3')!.choice).toBeUndefined();
    expect(chosen.looseGates.find((g) => g.key === 'not:1')).toMatchObject({ ics: 1, spare: 5 });
  });

  it('ignores a choice that is not an option', () => {
    const bom = bomOf(board({ components: ands(2) }), lib, { 'and:2': '74LS32' });
    expect(bom.looseGates[0]!.choice).toBeUndefined();
    expect(bom.icTotal).toBe(0);
  });

  it('reports missing and recursive chips as problems', () => {
    const b = board({
      components: [chipComp('m', 'nope', 'M'), chipComp('r', 'loop', 'R')],
    });
    const bom = bomOf(b, lib);
    expect(bom.problems.map((p) => [p.kind, p.defId]).sort()).toEqual([
      ['missing', 'nope'],
      ['recursive', 'loop'],
    ]);
  });

  it('is deterministic whatever the component order', () => {
    const comps = [
      chipComp('a', '74LS08', 'A'),
      chipComp('b', '74LS00', 'B'),
      comp('l', 'led'),
      comp('t', 'timer555'),
      comp('o', 'or'),
      comp('n', 'nand'),
    ];
    const one = bomOf(board({ components: comps }), lib);
    const two = bomOf(board({ components: [...comps].reverse() }), lib);
    expect(two).toEqual(one);
    expect(one.packages.map((p) => p.part)).toEqual(['74LS00', '74LS08']);
  });

  it('leaves the challenge census unchanged', () => {
    const b = board({
      components: [chipComp('p', 'pair', 'P'), comp('t', 'timer555'), comp('l', 'led')],
    });
    const before = JSON.stringify(partsCensus(b, lib));
    bomOf(b, lib);
    expect(JSON.stringify(partsCensus(b, lib))).toBe(before);
    const census = partsCensus(b, lib);
    expect(census.ics.map((u) => u.part).sort()).toEqual(['74LS00', '74LS00', 'timer555']);
    expect(census.gateCount).toBe(2);
  });
});

describe('bomTable', () => {
  it('lays rows out for copy and CSV', () => {
    const b = board({ components: [...ands(5), chipComp('x', '74LS00', 'X'), comp('l', 'led')] });
    const t = bomTable(bomOf(b, lib, { 'and:2': '74LS08' }));
    expect(t.headings).toEqual(['Part', 'Description', 'Qty', 'Notes']);
    expect(t.rows.map((r) => r[2])).toEqual(['1', '1', '2']);
    expect(t.rows.at(-1)).toEqual(['74LS08', '2-input AND', '2', '5 gates, 3 spare']);
    const open = bomTable(bomOf(board({ components: ands(1) }), lib));
    expect(open.rows).toEqual([['2-input AND', 'No package chosen', '1', '']]);
  });
});
