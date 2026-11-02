import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { Board, ChipDef, ChipLibrary, Component, Wire } from '../model/types';
import { board, chipComp, comp, wire } from '../model/testFixtures';
import { Simulator } from '../sim/kernel';
import { idealDelay } from '../sim/delay';
import type { RamState } from '../sim/primitives/ram';
import { printPreload } from '../sim/primitives/ramPreload';
import { toString } from '../value/busValue';
import { builtinChipLibrary } from './packages';

const INPUTS = ['VCC', 'GND', 'A0', 'A1', 'A2', 'A3', '/CS', '/WE', 'D1', 'D2', 'D3', 'D4'];
const OUTPUTS = ['/O1', '/O2', '/O3', '/O4'];

/** '189 DIPs U1, U2, ... sharing one switch per input pin, each output on its own probe. */
function dips(contents: (Record<string, string> | undefined)[]): Board {
  const components: Component[] = INPUTS.map((p) => comp(`s${p}`, 'toggle', undefined, `S${p}`));
  const wires: Wire[] = [];
  contents.forEach((c, i) => {
    const u = `u${i + 1}`;
    components.push(chipComp(u, '74LS189', `U${i + 1}`, c));
    for (const p of INPUTS) wires.push(wire(`w${u}${p}`, [`s${p}`, 'y'], [u, p]));
    for (const p of OUTPUTS) {
      const probe = `${u}${p.slice(1)}`;
      components.push(comp(probe, 'probe', undefined, probe.toUpperCase()));
      wires.push(wire(`w${probe}`, [u, p], [probe, 'a']));
    }
  });
  return board({ components, wires });
}

type Levels = Record<string, boolean>;

function powered(b: Board, lib: ChipLibrary) {
  const sim = new Simulator(compile(b, lib), idealDelay);
  sim.powerOn();
  const set = (levels: Levels) => {
    for (const [pin, level] of Object.entries(levels)) sim.setToggle(`main/S${pin}`, level);
    sim.settle();
  };
  // A read of address 0 on powered parts: /CS low, /WE high.
  set({ VCC: true, GND: false, '/CS': false, '/WE': true });
  // /O4 first, so the string reads MSB leftmost.
  const pins = (u: string) =>
    [4, 3, 2, 1].map((n) => toString(sim.netValueByPath(`main/${u}O${n}`), 1)).join('');
  return { sim, set, pins };
}

const lib189 = builtinChipLibrary();

describe("'189 DIP contents", () => {
  it('gives two placed DIPs their own programs on the inverted pins', () => {
    const { set, pins } = powered(dips([{ u1: '1 2' }, { u1: '9' }]), lib189);
    expect(pins('U1')).toBe('1110');
    expect(pins('U2')).toBe('0110');
    set({ A0: true });
    expect(pins('U1')).toBe('1101');
    expect(pins('U2')).toBe('XXXX');
  });

  it('floats an unpowered DIP that holds contents, then reads them once powered', () => {
    const { set, pins } = powered(dips([{ u1: 'F' }]), lib189);
    set({ VCC: false });
    expect(pins('U1')).toBe('ZZZZ');
    set({ VCC: true });
    expect(pins('U1')).toBe('0000');
  });

  it('writes over a contents cell through the pins and shows Z while writing', () => {
    const b = dips([{ u1: '1' }]);
    const compiled = compile(b, lib189);
    const { sim, set, pins } = powered(b, lib189);
    set({ D1: true, D3: true, '/WE': false });
    expect(pins('U1')).toBe('ZZZZ');
    set({ '/WE': true });
    expect(pins('U1')).toBe('1010');
    const ram = compiled.primitives.findIndex((p) => p.kind === 'ram');
    expect(printPreload((sim.primitiveStateAt(ram) as RamState).cells, 4)).toBe('5');
  });
});

/** A user chip around a '189 labelled M that always reads address A0, the rest tied off. */
function wrap189(inner?: Record<string, string>): ChipDef {
  const ties: [string, string][] = [
    ['one', 'VCC'],
    ['zero', 'GND'],
    ['zero', 'A1'],
    ['zero', 'A2'],
    ['zero', 'A3'],
    ['zero', '/CS'],
    ['one', '/WE'],
    ['zero', 'D1'],
    ['zero', 'D2'],
    ['zero', 'D3'],
    ['zero', 'D4'],
  ];
  return {
    format: 'lcir.chip',
    formatVersion: 8,
    id: 'rom',
    name: 'rom',
    version: 1,
    pins: [
      { id: 'pA', name: 'A', dir: 'in', width: 1, role: 'data', order: 0, boundComponent: 'inA' },
    ],
    components: [
      comp('inA', 'inport', undefined, 'A'),
      comp('one', 'constant', { value: 1 }),
      comp('zero', 'constant', { value: 0 }),
      chipComp('m1', '74LS189', 'M', inner),
    ],
    wires: [
      wire('wa', ['inA', 'y'], ['m1', 'A0']),
      ...ties.map(([from, to], i) => wire(`t${i}`, [from, 'y'], ['m1', to])),
    ],
    junctions: [],
  };
}

describe("'189 inside a user chip", () => {
  const lib = (inner?: Record<string, string>): ChipLibrary =>
    new Map([...lib189, ['rom', wrap189(inner)]]);
  const outer = (contents?: Record<string, string>) =>
    board({
      components: [comp('a', 'toggle', undefined, 'A'), chipComp('w1', 'rom', 'W1', contents)],
    });

  function cells(b: Board, l: ChipLibrary): string {
    const compiled = compile(b, l);
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    const ram = compiled.primitives.findIndex((p) => p.kind === 'ram');
    return printPreload((sim.primitiveStateAt(ram) as RamState).cells, 4);
  }

  it('lets the outer instance win over the inner DIP instance', () => {
    expect(cells(outer({ 'M/u1': '4' }), lib({ u1: '3' }))).toBe('4');
    expect(cells(outer(), lib({ u1: '3' }))).toBe('3');
    expect(cells(outer(), lib())).toBe('');
  });

  it('reports an outer key that misses the generated core as stale', () => {
    const compiled = compile(outer({ 'M/ram0': '4' }), lib());
    expect(compiled.staleContents).toEqual([
      { instance: 'main/W1', instanceId: 'main/w1', key: 'M/ram0', reason: 'missing' },
    ]);
  });
});
