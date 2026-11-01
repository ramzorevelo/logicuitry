import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import { CompileError, compile } from '../../model/compile';
import type { Board, ChipLibrary, ParamValue } from '../../model/types';
import { board, comp, wire } from '../../model/testFixtures';
import { analysisTablesOf, boardDiffRows } from '../../gates/verify';
import { analyzeTiming } from '../../timing/sta';
import { Simulator } from '../kernel';
import { datasheetDelay, idealDelay, type DelayModel } from '../delay';
import type { Params } from './types';
import { ram, ramPreloadError, withResizedPreload, type RamState } from './ram';
import './registry';

const noLib: ChipLibrary = new Map();

/** One RAM driven the way the kernel drives it: inputs persist, each set() is one evaluation. */
class RamBench {
  private readonly ins: { name: string; width: number }[];
  private readonly outs: { name: string; width: number }[];
  private cur: bv.BusValue[];
  private state: RamState;
  private driven: bv.BusValue[] = [];

  constructor(private readonly params: Params) {
    const pins = ram.pins(params);
    this.ins = pins.filter((p) => p.dir === 'in');
    this.outs = pins.filter((p) => p.dir === 'out');
    this.cur = this.ins.map((p) => bv.allX(p.width));
    this.state = ram.init!(params) as RamState;
  }

  set(values: Record<string, string>): this {
    const prev = this.cur;
    this.cur = [...prev];
    for (const [name, lit] of Object.entries(values)) {
      const i = this.ins.findIndex((p) => p.name === name);
      if (i < 0) throw new Error(`no input ${name}`);
      this.cur[i] = bv.fromString(lit);
    }
    const result = ram.evaluate({
      params: this.params,
      state: this.state,
      inputs: this.cur,
      prevInputs: prev,
      time: 0,
    });
    if ('state' in result) this.state = result.state as RamState;
    this.driven = result.outputs as bv.BusValue[];
    return this;
  }

  q(name = 'q'): string {
    const i = this.outs.findIndex((p) => p.name === name);
    return bv.toString(this.driven[i]!, this.outs[i]!.width);
  }

  cell(address: number): string {
    return bv.toString(this.state.cells[address]!, Number(this.params['width']));
  }

  cells(): string[] {
    return this.state.cells.map((c) => bv.toString(c, Number(this.params['width'])));
  }
}

/** A 4 x 4 RAM with known controls, so writes count from the first evaluation. */
function small(extra: Record<string, ParamValue> = {}): RamBench {
  return new RamBench({ width: 4, addressBits: 2, ...extra }).set({ cs: '0', we: '0' });
}

describe('ram function table', () => {
  it('deselected: q floats and nothing is written', () => {
    const r = small().set({ a: '01', d: '1010', we: '1', cs: '0' });
    expect(r.q()).toBe('ZZZZ');
    expect(r.cell(1)).toBe('XXXX');
  });

  it('write: the addressed cell takes d and q floats, as the 189 table says', () => {
    const r = small().set({ a: '01', d: '1010', we: '1', cs: '1' });
    expect(r.q()).toBe('ZZZZ');
    expect(r.cells()).toEqual(['XXXX', '1010', 'XXXX', 'XXXX']);
  });

  it('read: q is the addressed cell, and an unwritten cell reads X at power-on', () => {
    const r = small().set({ a: '01', d: '1010', we: '1', cs: '1' }).set({ we: '0' });
    expect(r.q()).toBe('1010');
    r.set({ a: '10' });
    expect(r.q()).toBe('XXXX');
  });

  it('a Z on d writes X: a floating input reads unknown', () => {
    const r = small().set({ a: '00', d: 'ZZ10', we: '1', cs: '1' });
    expect(r.cell(0)).toBe('XX10');
  });

  it('writes are level-sensitive: an address moving mid-write writes every cell it passes', () => {
    const r = small().set({ a: '00', d: '0101', we: '1', cs: '1' });
    r.set({ a: '01' }).set({ a: '11' });
    expect(r.cells()).toEqual(['0101', '0101', 'XXXX', '0101']);
    r.set({ d: '1111' });
    expect(r.cell(3)).toBe('1111');
    expect(r.cell(0)).toBe('0101');
  });

  it('re-evaluating an unchanged write is idempotent', () => {
    const r = small().set({ a: '10', d: '0110', we: '1', cs: '1' });
    r.set({}).set({});
    expect(r.cells()).toEqual(['XXXX', 'XXXX', '0110', 'XXXX']);
  });
});

describe('ram X rules', () => {
  /** Cells 0..3 = 1100, 1010, 0000, 1111, then a read of cell 0. */
  function filled(): RamBench {
    const r = small();
    for (const [a, d] of [
      ['00', '1100'],
      ['01', '1010'],
      ['10', '0000'],
      ['11', '1111'],
    ] as const)
      r.set({ a, d, we: '1', cs: '1' });
    return r.set({ a: '00', we: '0' });
  }

  it('an X address on a read gives the bits every candidate cell agrees on', () => {
    const r = filled().set({ a: '0X' });
    expect(r.q()).toBe('1XX0');
    r.set({ a: 'XX' });
    expect(r.q()).toBe('XXXX');
    r.set({ a: 'X0' });
    expect(r.q()).toBe('XX00');
  });

  it('an X address during a write sets each candidate to what its old value and d agree on', () => {
    const r = filled().set({ a: '0X', d: '1111', we: '1' });
    expect(r.cells()).toEqual(['11XX', '1X1X', '0000', '1111']);
  });

  it('an X we during a possible write corrupts only the addressed cell', () => {
    const r = filled().set({ a: '10', d: '0011', we: 'X' });
    expect(r.cells()).toEqual(['1100', '1010', '00XX', '1111']);
    expect(r.q()).toBe('XXXX');
  });

  it('an X cs during a possible write corrupts the addressed cell; a cell equal to d survives', () => {
    const r = filled().set({ a: '11', d: '1111', we: '1', cs: 'X' });
    expect(r.cells()).toEqual(['1100', '1010', '0000', '1111']);
    expect(r.q()).toBe('ZZZZ');
    r.set({ d: '0101' });
    expect(r.cell(3)).toBe('X1X1');
  });

  it('an X cs or we that cannot write leaves every cell alone', () => {
    const r = filled().set({ cs: '0', we: 'X', a: 'XX', d: '0000' });
    expect(r.cells()).toEqual(['1100', '1010', '0000', '1111']);
    expect(r.q()).toBe('ZZZZ');
    r.set({ cs: 'X', we: '0' });
    expect(r.cells()).toEqual(['1100', '1010', '0000', '1111']);
    expect(r.q()).toBe('XXXX');
  });

  it('SPEC: a control still X from power-on does not write, so the preload survives settling', () => {
    const r = new RamBench({ width: 4, addressBits: 2, preload: '1 2 3 4' });
    r.set({ a: 'XX', d: 'XXXX', we: 'X', cs: 'X' });
    expect(r.cells()).toEqual(['0001', '0010', '0011', '0100']);
    r.set({ cs: '1' });
    expect(r.cells()).toEqual(['0001', '0010', '0011', '0100']);
    // Once we has read 0 or 1, a later X on it counts as a possible write.
    r.set({ we: '0', a: '01', d: '0000' }).set({ we: 'X' });
    expect(r.cells()).toEqual(['0001', '00X0', '0011', '0100']);
  });

  it('is deterministic: the same stimulus gives the same cells', () => {
    const run = () =>
      filled().set({ a: 'X1', d: '0110', we: 'X' }).set({ a: '1X', cs: 'X' }).cells();
    expect(run()).toEqual(run());
  });
});

describe('ram params', () => {
  it('loads the preload at init; cells past it are X', () => {
    const r = new RamBench({ width: 4, addressBits: 2, preload: 'A 5' });
    expect(r.cells()).toEqual(['1010', '0101', 'XXXX', 'XXXX']);
    r.set({ cs: '1', we: '0', a: '01' });
    expect(r.q()).toBe('0101');
  });

  it('csLow, weLow and invertedOut make the 189 core', () => {
    const r = new RamBench({
      width: 4,
      addressBits: 4,
      csLow: true,
      weLow: true,
      invertedOut: true,
    }).set({ cs: '1', we: '1' });
    expect(r.q()).toBe('ZZZZ');
    r.set({ a: '0011', d: '1001', cs: '0', we: '0' });
    expect(r.q()).toBe('ZZZZ');
    expect(r.cell(3)).toBe('1001');
    r.set({ we: '1' });
    expect(r.q()).toBe('0110');
    const pins = ram.pins({ csLow: true, weLow: true });
    expect(pins.filter((p) => p.activeLow).map((p) => p.name)).toEqual(['we', 'cs']);
  });

  it('pins: a, d, we, cs in; q a three-state out; lanes expand by pinView', () => {
    const pins = ram.pins({ width: 8, addressBits: 4 });
    expect(pins.map((p) => `${p.name}:${p.dir}:${p.width}`)).toEqual([
      'a:in:4',
      'd:in:8',
      'we:in:1',
      'cs:in:1',
      'q:out:8',
    ]);
    expect(pins.find((p) => p.name === 'q')!.threeState).toBe(true);
    const lanes = ram.pins({
      width: 2,
      addressBits: 2,
      pinView: 'a=expanded;d=expanded;q=expanded',
    });
    expect(lanes.map((p) => p.name)).toEqual(['a1', 'a0', 'd1', 'd0', 'we', 'cs', 'q1', 'q0']);
    expect(lanes.filter((p) => p.dir === 'out').every((p) => p.threeState)).toBe(true);
  });

  it('reads and writes through lane-expanded pins', () => {
    const r = new RamBench({
      width: 2,
      addressBits: 2,
      pinView: 'a=expanded;d=expanded;q=expanded',
    }).set({ cs: '1', we: '1', a1: '1', a0: '0', d1: '0', d0: '1' });
    expect(r.cell(2)).toBe('01');
    r.set({ we: '0' });
    expect([r.q('q1'), r.q('q0')]).toEqual(['0', '1']);
  });

  it('width 1 and width 32', () => {
    const one = new RamBench({ width: 1, addressBits: 1 }).set({
      cs: '1',
      we: '1',
      a: '1',
      d: '1',
    });
    expect(one.cells()).toEqual(['X', '1']);
    one.set({ we: '0' });
    expect(one.q()).toBe('1');

    const wide = new RamBench({ width: 32, addressBits: 1, preload: 'DEADBEEF' });
    expect(wide.cell(0)).toBe(bv.toString(bv.known(0xdeadbeef, 32), 32));
    wide.set({ cs: '1', we: '1', a: '1', d: bv.toString(bv.known(0xffffffff, 32), 32) });
    wide.set({ we: '0', a: '0' });
    expect(wide.q()).toBe(bv.toString(bv.known(0xdeadbeef, 32), 32));
    expect(wide.cell(1)).toBe('1'.repeat(32));
  });

  it('addressBits 1 and 8; addressBits caps at 8', () => {
    expect(new RamBench({ width: 4, addressBits: 1 }).cells()).toHaveLength(2);
    const big = new RamBench({ width: 8, addressBits: 8 });
    expect(big.cells()).toHaveLength(256);
    big.set({ cs: '1', we: '1', a: '11111111', d: '10100101' }).set({ we: '0' });
    expect(big.q()).toBe('10100101');
    expect(big.cell(255)).toBe('10100101');
    expect(ram.pins({ addressBits: 12 })[0]!.width).toBe(8);
  });
});

describe('ramPreloadError and withResizedPreload', () => {
  it('checks the preload against the RAM size', () => {
    expect(ramPreloadError({ width: 8, addressBits: 1, preload: '1 2' })).toBeNull();
    expect(ramPreloadError({ width: 8, addressBits: 1, preload: '1 2 3' })).toBe(
      '3 cells for 2 addresses',
    );
    expect(ramPreloadError({ preload: 7 })).toBe('preload must be a string');
    expect(ramPreloadError({})).toBeNull();
  });

  it('rewrites the preload only when the size changes', () => {
    const prev = { width: 8, addressBits: 2, preload: '0A FF 3C' };
    expect(withResizedPreload(prev, { ...prev, addressBits: 1 })['preload']).toBe('0A FF');
    expect(withResizedPreload(prev, { ...prev, width: 4 })['preload']).toBe('A F C');
    const renamed = { ...prev, pinView: 'a=expanded' };
    expect(withResizedPreload(prev, renamed)).toBe(renamed);
    expect(withResizedPreload(prev, { width: 4 })).toEqual({ width: 4 });
  });
});

/** Switches A (address), D, WE and CS into a RAM whose q is probed as Q. */
function ramBoard(params: Record<string, ParamValue>, preset: { we?: number; cs?: number } = {}) {
  const addressBits = Number(params['addressBits'] ?? 4);
  const width = Number(params['width'] ?? 8);
  return board({
    components: [
      comp('sa', 'toggle', { width: addressBits }, 'A'),
      comp('sd', 'toggle', { width }, 'D'),
      comp('sw', 'toggle', { initial: preset.we ?? 0 }, 'WE'),
      comp('sc', 'toggle', { initial: preset.cs ?? 1 }, 'CS'),
      comp('U1', 'ram', params, 'U1'),
      comp('pq', 'probe', { width }, 'Q'),
    ],
    wires: [
      wire('w1', ['sa', 'y'], ['U1', 'a']),
      wire('w2', ['sd', 'y'], ['U1', 'd']),
      wire('w3', ['sw', 'y'], ['U1', 'we']),
      wire('w4', ['sc', 'y'], ['U1', 'cs']),
      wire('w5', ['U1', 'q'], ['pq', 'a']),
    ],
  });
}

const q = (sim: Simulator, width = 8) => bv.toString(sim.netValueByPath('main/Q'), width);

describe('ram in the kernel', () => {
  for (const [mode, delay] of [
    ['ideal', idealDelay],
    ['datasheet', datasheetDelay('typ')],
  ] as [string, DelayModel][]) {
    it(`${mode}: power-on loads the preload, a write lands and reads back`, () => {
      const sim = new Simulator(compile(ramBoard({ preload: '11 22 33' }), noLib), delay);
      expect(sim.powerOn().settled).toBe(true);
      expect(q(sim)).toBe('00010001');
      sim.setToggleValue('main/A', 2);
      sim.settle();
      expect(q(sim)).toBe('00110011');
      sim.setToggleValue('main/A', 9);
      sim.settle();
      expect(q(sim)).toBe('XXXXXXXX');

      sim.setToggleValue('main/D', 0x5a);
      sim.setToggleValue('main/WE', 1);
      sim.settle();
      expect(q(sim)).toBe('ZZZZZZZZ');
      sim.setToggleValue('main/WE', 0);
      sim.settle();
      expect(q(sim)).toBe('01011010');
      const cells = (sim.getPrimitiveState('main/U1') as RamState).cells;
      expect(bv.toString(cells[9]!, 8)).toBe('01011010');
      expect(bv.toString(cells[0]!, 8)).toBe('00010001');
    });

    it(`${mode}: single-steps a read to completion`, () => {
      const sim = new Simulator(compile(ramBoard({ preload: '11 22' }), noLib), delay);
      sim.powerOn();
      sim.setToggleValue('main/A', 1);
      let steps = 0;
      while (sim.pendingEvents > 0 && steps < 100) {
        sim.stepToNextEvent();
        steps++;
      }
      expect(steps).toBeGreaterThan(0);
      expect(steps).toBeLessThan(100);
      expect(q(sim)).toBe('00100010');
    });

    it(`${mode}: the same stimulus replays identically`, () => {
      const run = () => {
        const sim = new Simulator(compile(ramBoard({ preload: '11 22' }), noLib), delay);
        sim.powerOn();
        for (const [path, v] of [
          ['main/D', 0x77],
          ['main/WE', 1],
          ['main/A', 3],
          ['main/A', 5],
          ['main/WE', 0],
          ['main/A', 4],
        ] as const) {
          sim.setToggleValue(path, v);
          sim.settle();
        }
        return {
          trace: sim.traceRecords().map((r) => [r.time, r.net, bv.toString(r.value, 8)]),
          cells: (sim.getPrimitiveState('main/U1') as RamState).cells,
        };
      };
      expect(run()).toEqual(run());
    });
  }

  it('power-on with no preload reads X', () => {
    const sim = new Simulator(compile(ramBoard({}), noLib), idealDelay);
    sim.powerOn();
    expect(q(sim)).toBe('XXXXXXXX');
  });

  it('power-off discards the run: a fresh power-on starts from the preload again', () => {
    const compiled = compile(ramBoard({ preload: '11' }), noLib);
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    sim.setToggleValue('main/D', 0x99);
    sim.setToggleValue('main/WE', 1);
    sim.settle();
    sim.setToggleValue('main/WE', 0);
    sim.settle();
    expect(q(sim)).toBe('10011001');
    const again = new Simulator(compiled, idealDelay);
    again.powerOn();
    expect(q(again)).toBe('00010001');
  });
});

/** Two RAMs reading onto one bus, each holding its own preload at address 0. */
function sharedBus(first: string, second: string, cs2 = 1): Board {
  const ramParams = (preload: string) => ({ width: 4, addressBits: 1, preload });
  return board({
    components: [
      comp('a', 'constant', { value: 0 }),
      comp('we', 'constant', { value: 0 }),
      comp('cs', 'constant', { value: 1 }),
      comp('cs2', 'constant', { value: cs2 }),
      comp('r1', 'ram', ramParams(first)),
      comp('r2', 'ram', ramParams(second)),
      comp('pb', 'probe', { width: 4 }, 'BUS'),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['r1', 'a']),
      wire('w2', ['a', 'y'], ['r2', 'a']),
      wire('w3', ['we', 'y'], ['r1', 'we']),
      wire('w4', ['we', 'y'], ['r2', 'we']),
      wire('w5', ['cs', 'y'], ['r1', 'cs']),
      wire('w6', ['cs2', 'y'], ['r2', 'cs']),
      wire('w7', ['r1', 'q'], ['r2', 'q']),
      wire('w8', ['r1', 'q'], ['pb', 'a']),
    ],
  });
}

describe('two RAMs on one bus', () => {
  const bus = (b: Board) => {
    const sim = new Simulator(compile(b, noLib), idealDelay);
    sim.powerOn();
    return bv.toString(sim.netValueByPath('main/BUS'), 4);
  };

  it('compile: three-state q pins may share a net', () => {
    expect(() => compile(sharedBus('1', '2'), noLib)).not.toThrow();
  });

  it('both enabled with different values read X; with the same value, that value', () => {
    expect(bus(sharedBus('5', 'A'))).toBe('XXXX');
    expect(bus(sharedBus('6', '6'))).toBe('0110');
    expect(bus(sharedBus('5', 'A', 0))).toBe('0101');
  });
});

describe('a malformed preload', () => {
  it('is a compile error naming the component', () => {
    const b = ramBoard({ preload: '11 G2' });
    expect(() => compile(b, noLib)).toThrow(CompileError);
    expect(() => compile(b, noLib)).toThrow(
      "main/U1: RAM preload: address 1: 'G2' is not a hex value or X",
    );
  });
});

describe('ram in analysis', () => {
  const b = board({
    components: [
      comp('a', 'toggle', undefined, 'A'),
      comp('c', 'toggle', undefined, 'C'),
      comp('u', 'ram', { width: 1, addressBits: 1 }),
      comp('l', 'led', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['u', 'a']),
      wire('w2', ['c', 'y'], ['u', 'cs']),
      wire('w3', ['u', 'q'], ['l', 'a']),
    ],
  });

  it('Analyze refuses an output a RAM feeds, naming stored state', () => {
    const [table] = analysisTablesOf(b, noLib);
    expect(table!.table).toBeNull();
    expect(table!.error).toBe('Y depends on a RAM, so it has no truth table');
  });

  it('bubble verify refuses the board', () => {
    expect(() => boardDiffRows(b, b, noLib)).toThrow(/stores state/);
  });
});

describe('ram in static timing', () => {
  /** MAR -> RAM address; RAM q -> IR d, both registers on one clock. */
  const computer = board({
    components: [
      comp('ck', 'clock'),
      comp('en', 'constant', { value: 1 }),
      comp('mar', 'register', { width: 4 }),
      comp('ram', 'ram', { width: 8, addressBits: 4 }),
      comp('we', 'constant', { value: 0 }),
      comp('cs', 'constant', { value: 1 }),
      comp('ir', 'register', { width: 8 }),
      comp('src', 'toggle', { width: 4 }),
    ],
    wires: [
      wire('w1', ['ck', 'y'], ['mar', 'clk']),
      wire('w2', ['ck', 'y'], ['ir', 'clk']),
      wire('w3', ['en', 'y'], ['mar', 'en']),
      wire('w4', ['en', 'y'], ['ir', 'en']),
      wire('w5', ['src', 'y'], ['mar', 'd']),
      wire('w6', ['mar', 'q'], ['ram', 'a']),
      wire('w7', ['we', 'y'], ['ram', 'we']),
      wire('w8', ['cs', 'y'], ['ram', 'cs']),
      wire('w9', ['ram', 'q'], ['ir', 'd']),
    ],
  });

  it('times MAR -> a -> q -> IR d as one combinational read path', () => {
    const r = analyzeTiming(compile(computer, noLib), { column: 'typ' });
    const d = r.endpoints.find((e) => e.endpoint === 'main/ir.d')!;
    expect(d.startpoint).toBe('main/mar');
    expect(d.critical.map((h) => h.path)).toEqual(['main/ram']);
    // The generic block binds the '189, so the read takes its access time from address.
    expect(d.critical[0]!.tpdPs).toBe(50_000);
    const row = r.sequential!.paths.find(
      (p) => p.launch === 'main/mar' && p.capture === 'main/ir',
    )!;
    expect(row.tpdCombPs).toBe(50_000);
    const max = analyzeTiming(compile(computer, noLib), { column: 'max' });
    expect(max.endpoints.find((e) => e.endpoint === 'main/ir.d')!.critical[0]!.tpdPs).toBe(80_000);
  });

  it('reports we and d as arrival only, and a and cs as no endpoint', () => {
    const r = analyzeTiming(compile(computer, noLib), { column: 'typ' });
    const ramEnds = r.endpoints.map((e) => e.endpoint).filter((e) => e.startsWith('main/ram.'));
    expect(ramEnds.sort()).toEqual(['main/ram.d', 'main/ram.we']);
    expect(r.sequential!.paths.some((p) => p.capture === 'main/ram')).toBe(false);
  });

  it('a RAM whose q feeds its own d is not a combinational cycle', () => {
    const loop = board({
      components: [comp('ram', 'ram', { width: 4, addressBits: 4 }), comp('cs', 'constant')],
      wires: [wire('w1', ['ram', 'q'], ['ram', 'd']), wire('w2', ['cs', 'y'], ['ram', 'cs'])],
    });
    expect(() => analyzeTiming(compile(loop, noLib), { column: 'typ' })).not.toThrow();
  });
});
