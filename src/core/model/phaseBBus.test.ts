import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import { toString } from '../value/busValue';
import { compile } from './compile';
import type { ChipLibrary } from './types';
import { board, comp, wire } from './testFixtures';
import { BIDIR } from './bidirFixture';
import { Simulator } from '../sim/kernel';
import { datasheetDelay, idealDelay, pinNamesOf } from '../sim/delay';

const noLib: ChipLibrary = new Map();
const W = 4;

interface Enables {
  reg: boolean;
  ram: boolean;
  xcvr: boolean;
}

/** A register holding 3, a RAM reading cell 0 (0xA) and a transceiver passing 5, all on one bus. */
function sharedBus(): ReturnType<typeof board> {
  return board({
    components: [
      comp('clk', 'toggle', undefined, 'CLK'),
      comp('rd', 'constant', { value: 3, width: W }),
      comp('one', 'constant', { value: 1 }),
      comp('zero', 'constant', { value: 0 }),
      comp('R', 'register', { width: W, outputEnable: true }, 'R'),
      comp('roe', 'toggle', undefined, 'ROE'),
      comp('M', 'ram', { width: W, addressBits: 1, preload: 'A 5' }, 'M'),
      comp('mcs', 'toggle', undefined, 'MCS'),
      comp('sd', 'constant', { value: 5, width: W }),
      comp('S', BIDIR, { width: W }),
      comp('T', 'transceiver', { width: W }, 'T'),
      comp('toe', 'toggle', undefined, 'TOE'),
      comp('pb', 'probe', { width: W }, 'BUS'),
    ],
    wires: [
      wire('r1', ['rd', 'y'], ['R', 'd']),
      wire('r2', ['clk', 'y'], ['R', 'clk']),
      wire('r3', ['one', 'y'], ['R', 'en']),
      wire('r4', ['roe', 'y'], ['R', 'oe']),
      wire('m1', ['zero', 'y'], ['M', 'a']),
      wire('m2', ['zero', 'y'], ['M', 'we']),
      wire('m3', ['mcs', 'y'], ['M', 'cs']),
      wire('t1', ['sd', 'y'], ['S', 'd']),
      wire('t2', ['one', 'y'], ['S', 'en']),
      wire('t3', ['S', 'p'], ['T', 'a']),
      wire('t4', ['one', 'y'], ['T', 'dir']),
      wire('t5', ['toe', 'y'], ['T', 'oe']),
      wire('b1', ['R', 'q'], ['M', 'q']),
      wire('b2', ['R', 'q'], ['T', 'b']),
      wire('b3', ['R', 'q'], ['pb', 'a']),
    ],
  });
}

function busWith(on: Enables): string {
  const sim = new Simulator(compile(sharedBus(), noLib), idealDelay);
  sim.powerOn();
  sim.setToggle('main/CLK', true);
  sim.setToggle('main/ROE', on.reg);
  sim.setToggle('main/MCS', on.ram);
  sim.setToggle('main/TOE', on.xcvr);
  sim.settle();
  return toString(sim.netValueByPath('main/BUS'), W);
}

describe('register, RAM and transceiver on one bus', () => {
  it('reads whichever single driver is enabled', () => {
    expect(busWith({ reg: true, ram: false, xcvr: false })).toBe('0011');
    expect(busWith({ reg: false, ram: true, xcvr: false })).toBe('1010');
    expect(busWith({ reg: false, ram: false, xcvr: true })).toBe('0101');
  });

  it('floats with none enabled and reads X where two disagree', () => {
    expect(busWith({ reg: false, ram: false, xcvr: false })).toBe('ZZZZ');
    expect(busWith({ reg: true, ram: true, xcvr: false })).toBe('X01X');
    expect(busWith({ reg: false, ram: true, xcvr: true })).toBe('XXXX');
  });
});

describe('enable timing on a register oe and a RAM cs', () => {
  const model = datasheetDelay('typ');

  function primOf(kind: 'register' | 'ram', params: Record<string, number | string | boolean>) {
    const compiled = compile(
      board({ components: [comp('P', kind, { width: W, ...params }, 'P')], wires: [] }),
      noLib,
    );
    return compiled.primitives[compiled.pathToPrimitive.get('main/P')!]!;
  }

  it("a register binds the '173 with output enable on, the '377 without", () => {
    expect(primOf('register', { outputEnable: true }).part).toBe('74LS173');
    expect(primOf('register', {}).part).toBe('74LS377');
  });

  it("an oe edge to or from Z takes the '173 enable and disable times", () => {
    const prim = primOf('register', { outputEnable: true });
    const moved = [pinNamesOf(prim).ins.indexOf('oe')];
    expect(model.delayPs(prim, 0, bv.known(0b1111, W), bv.allZ(W), moved)).toBe(11_000);
    expect(model.delayPs(prim, 0, bv.allZ(W), bv.known(0b1111, W), moved)).toBe(15_000);
    expect(model.delayPs(prim, 0, bv.known(0, W), bv.allZ(W), moved)).toBe(11_000);
    expect(model.delayPs(prim, 0, bv.allZ(W), bv.known(0, W), moved)).toBe(18_000);
  });

  it("a RAM binds the '189: cs takes the /S times, we the R/W times", () => {
    const prim = primOf('ram', { addressBits: 1 });
    expect(prim.part).toBe('74LS189');
    const { ins } = pinNamesOf(prim);
    const timesFor = (pins: string[]) => {
      const moved = pins.map((p) => ins.indexOf(p));
      return [
        model.delayPs(prim, 0, bv.known(0b1111, W), bv.allZ(W), moved),
        model.delayPs(prim, 0, bv.allZ(W), bv.known(0, W), moved),
      ];
    };
    expect(timesFor(['cs'])).toEqual([30_000, 35_000]);
    expect(timesFor(['we'])).toEqual([40_000, 55_000]);
    expect(timesFor(['cs', 'we'])).toEqual([40_000, 55_000]);
    expect(timesFor(['a'])).toEqual([30_000, 35_000]);
    expect(timesFor([])).toEqual([30_000, 35_000]);
  });

  it("the '189 enable rows read their max column in max mode", () => {
    const prim = primOf('ram', { addressBits: 1 });
    const max = datasheetDelay('max');
    const { ins } = pinNamesOf(prim);
    const timesFor = (pin: string) => {
      const moved = [ins.indexOf(pin)];
      return [
        max.delayPs(prim, 0, bv.known(0b1111, W), bv.allZ(W), moved),
        max.delayPs(prim, 0, bv.allZ(W), bv.known(0, W), moved),
      ];
    };
    expect(timesFor('cs')).toEqual([50_000, 60_000]);
    expect(timesFor('we')).toEqual([60_000, 90_000]);
  });

  it("a cs edge between levels times the '189 cs-to-Q arc", () => {
    const prim = primOf('ram', { addressBits: 1 });
    const moved = [pinNamesOf(prim).ins.indexOf('cs')];
    const edge = (col: 'typ' | 'max') =>
      datasheetDelay(col).delayPs(prim, 0, bv.known(0, W), bv.known(0b1111, W), moved);
    expect([edge('typ'), edge('max')]).toEqual([35_000, 60_000]);
  });

  it("a '173 core times CLK to Q and CLR to Q from its own rows", () => {
    const prim = primOf('register', { outputEnable: true, clear: 'async' });
    const { ins } = pinNamesOf(prim);
    const clk = [ins.indexOf('clk')];
    const clr = [ins.indexOf('clr')];
    expect(model.delayPs(prim, 0, bv.known(0, W), bv.known(0b1111, W), clk)).toBe(17_000);
    expect(model.delayPs(prim, 0, bv.known(0b1111, W), bv.known(0, W), clk)).toBe(22_000);
    expect(datasheetDelay('max').delayPs(prim, 0, bv.known(0b1111, W), bv.known(0, W), clk)).toBe(
      30_000,
    );
    expect(model.delayPs(prim, 0, bv.known(0b1111, W), bv.known(0, W), clr)).toBe(26_000);
  });

  it("a RAM read times A to Q at the '189 access time", () => {
    const prim = primOf('ram', { addressBits: 1 });
    const moved = [pinNamesOf(prim).ins.indexOf('a')];
    expect(model.delayPs(prim, 0, bv.known(0b1010, W), bv.known(0b0101, W), moved)).toBe(50_000);
    expect(datasheetDelay('max').delayPs(prim, 0, bv.known(0, W), bv.known(1, W), moved)).toBe(
      80_000,
    );
  });
});
