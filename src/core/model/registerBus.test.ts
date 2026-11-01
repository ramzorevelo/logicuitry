import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import { compile } from './compile';
import type { ChipLibrary, ParamValue } from './types';
import { board, comp, wire } from './testFixtures';
import { Simulator } from '../sim/kernel';
import { datasheetDelay, idealDelay, type DelayModel } from '../sim/delay';

const noLib: ChipLibrary = new Map();

interface Side {
  d: number;
  oe: number;
  params?: Record<string, ParamValue>;
}

/** Two 4-bit registers on one net probed as BUS; each loads its constant d on the first edge. */
function twoRegisters(a: Side, b: Side) {
  const side = (n: 'a' | 'b', s: Side) => ({
    components: [
      comp(`${n}d`, 'constant', { value: s.d, width: 4 }),
      comp(`${n}e`, 'constant', { value: 1 }),
      comp(`${n}o`, 'constant', { value: s.oe }),
      comp(`${n}r`, 'register', { width: 4, ...s.params }),
    ],
    wires: [
      wire(`${n}1`, [`${n}d`, 'y'], [`${n}r`, 'd']),
      wire(`${n}2`, ['clk', 'y'], [`${n}r`, 'clk']),
      wire(`${n}3`, [`${n}e`, 'y'], [`${n}r`, 'en']),
      ...(s.params?.['outputEnable'] ? [wire(`${n}4`, [`${n}o`, 'y'], [`${n}r`, 'oe'])] : []),
    ],
  });
  const sa = side('a', a);
  const sb = side('b', b);
  return board({
    components: [
      comp('clk', 'toggle', undefined, 'CLK'),
      ...sa.components,
      ...sb.components,
      comp('pb', 'probe', { width: 4 }, 'BUS'),
    ],
    wires: [
      ...sa.wires,
      ...sb.wires,
      wire('s1', ['ar', 'q'], ['br', 'q']),
      wire('s2', ['ar', 'q'], ['pb', 'a']),
    ],
  });
}

const oe = { outputEnable: true };

function busAfterEdge(b: ReturnType<typeof board>, model: DelayModel = idealDelay): bv.BusValue {
  const sim = new Simulator(compile(b, noLib), model);
  sim.powerOn();
  sim.setToggle('main/CLK', true);
  sim.settle();
  return sim.netValueByPath('main/BUS');
}

describe('registers sharing a bus', () => {
  it('two plain registers wired output to output fail compile', () => {
    expect(() => compile(twoRegisters({ d: 1, oe: 1 }, { d: 2, oe: 1 }), noLib)).toThrow(
      /drive the same wire/,
    );
  });

  it('a plain register shares with one that has outputEnable; contention reads X', () => {
    const b = twoRegisters({ d: 1, oe: 0, params: oe }, { d: 2, oe: 1 });
    expect(busAfterEdge(b)).toEqual(bv.known(2, 4));
    expect(busAfterEdge(twoRegisters({ d: 1, oe: 1, params: oe }, { d: 2, oe: 1 }))).toEqual(
      bv.fromString('00XX'),
    );
  });

  it('two with outputEnable share: one enabled wins, both floating is Z', () => {
    expect(
      busAfterEdge(twoRegisters({ d: 5, oe: 1, params: oe }, { d: 9, oe: 0, params: oe })),
    ).toEqual(bv.known(5, 4));
    expect(
      busAfterEdge(twoRegisters({ d: 5, oe: 0, params: oe }, { d: 9, oe: 1, params: oe })),
    ).toEqual(bv.known(9, 4));
    const floating = busAfterEdge(
      twoRegisters({ d: 5, oe: 0, params: oe }, { d: 9, oe: 0, params: oe }),
    );
    expect(bv.toString(floating, 4)).toMatch(/^[ZX]{4}$/);
  });

  it('both enabled: different words read X, the same word reads that word', () => {
    const diff = busAfterEdge(
      twoRegisters({ d: 0b0101, oe: 1, params: oe }, { d: 0b0110, oe: 1, params: oe }),
    );
    expect(bv.toString(diff, 4)).toBe('01XX');
    const same = busAfterEdge(
      twoRegisters({ d: 5, oe: 1, params: oe }, { d: 5, oe: 1, params: oe }),
    );
    expect(same).toEqual(bv.known(5, 4));
  });

  it('settles and replays identically in ideal and datasheet modes', () => {
    const b = twoRegisters({ d: 5, oe: 1, params: oe }, { d: 9, oe: 0, params: oe });
    for (const model of [idealDelay, datasheetDelay('typ'), datasheetDelay('max')]) {
      const first = busAfterEdge(b, model);
      expect(first).toEqual(bv.known(5, 4));
      expect(busAfterEdge(b, model)).toEqual(first);
    }
  });

  it('single-steps with delta steps to the same settled value', () => {
    const sim = new Simulator(
      compile(twoRegisters({ d: 5, oe: 1, params: oe }, { d: 9, oe: 0, params: oe }), noLib),
      datasheetDelay('typ'),
    );
    sim.powerOn();
    sim.setToggle('main/CLK', true);
    for (let i = 0; i < 1000 && sim.canStep; i++) sim.deltaStep();
    expect(sim.netValueByPath('main/BUS')).toEqual(bv.known(5, 4));
  });
});
