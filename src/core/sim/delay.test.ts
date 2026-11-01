import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { Board } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { builtinChipLibrary } from '../parts/packages';
import * as bv from '../value/busValue';
import { toString } from '../value/busValue';
import { BIDIR } from '../model/bidirFixture';
import { outputPropagationNs } from '../parts/arcs';
import { datasheetDelay, IDEAL_DELAY_PS, pinNamesOf } from './delay';
import { Simulator } from './kernel';

const lib = builtinChipLibrary();

function nandDipBoard(): Board {
  return board({
    components: [
      comp('ta', 'toggle', undefined, 'A'),
      comp('tb', 'toggle', undefined, 'B'),
      comp('tv', 'toggle', undefined, 'VCC'),
      comp('tg', 'toggle', undefined, 'GND'),
      { ...comp('u1', 'chip', undefined, 'U1'), defId: '74LS00' },
      comp('pr', 'probe', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['ta', 'y'], ['u1', '1A']),
      wire('w2', ['tb', 'y'], ['u1', '1B']),
      wire('w3', ['tv', 'y'], ['u1', 'VCC']),
      wire('w4', ['tg', 'y'], ['u1', 'GND']),
      wire('w5', ['u1', '1Y'], ['pr', 'a']),
    ],
  });
}

describe('datasheet delay through a DIP', () => {
  it('a 74LS00 gate measures its own 9 ns and 10 ns, plus the one structural delta', () => {
    const compiled = compile(nandDipBoard(), lib);
    const sim = new Simulator(compiled, datasheetDelay('typ'));
    sim.powerOn();
    sim.setToggle('main/VCC', true);
    sim.setToggle('main/GND', false);
    sim.setToggle('main/A', true);
    sim.setToggle('main/B', true);
    sim.settle();
    const yNet = compiled.pathToNet.get('main/Y')!;
    const bNet = compiled.primitives[compiled.pathToPrimitive.get('main/B')!]!.outputs[0]!;

    const measure = (b: boolean): number => {
      const t0 = sim.time;
      sim.setToggle('main/B', b);
      sim.settle();
      // From the input net's edge: the toggle is unbound and adds its own delay.
      const records = sim.traceRecords().filter((r) => r.time > t0);
      const at = (net: number) => records.find((r) => r.net === net)!.time;
      return at(yNet) - at(bNet);
    };

    expect(measure(false)).toBe(9_000 + IDEAL_DELAY_PS);
    expect(measure(true)).toBe(10_000 + IDEAL_DELAY_PS);
  });

  it('still floats the output when the rail drops', () => {
    const compiled = compile(nandDipBoard(), lib);
    const sim = new Simulator(compiled, datasheetDelay('typ'));
    sim.powerOn();
    sim.setToggle('main/VCC', true);
    sim.setToggle('main/GND', false);
    sim.setToggle('main/A', true);
    sim.setToggle('main/B', true);
    sim.settle();
    expect(toString(sim.netValueByPath('main/Y'), 1)).toBe('0');
    sim.setToggle('main/VCC', false);
    sim.settle();
    expect(toString(sim.netValueByPath('main/Y'), 1)).toBe('Z');
  });
});

describe('74LS374 /OC enable and disable times', () => {
  function oc374Board(): Board {
    return board({
      components: [
        comp('toc', 'toggle', { initial: 0 }, 'OC'),
        comp('td', 'toggle', undefined, 'D'),
        comp('tclk', 'toggle', undefined, 'CLK'),
        comp('tv', 'toggle', undefined, 'VCC'),
        comp('tg', 'toggle', undefined, 'GND'),
        { ...comp('u1', 'chip', undefined, 'U1'), defId: '74LS374' },
        comp('pr', 'probe', undefined, 'Q'),
      ],
      wires: [
        wire('w1', ['toc', 'y'], ['u1', '/OC']),
        wire('w2', ['td', 'y'], ['u1', '1D']),
        wire('w3', ['tclk', 'y'], ['u1', 'CLK']),
        wire('w4', ['tv', 'y'], ['u1', 'VCC']),
        wire('w5', ['tg', 'y'], ['u1', 'GND']),
        wire('w6', ['u1', '1Q'], ['pr', 'a']),
      ],
    });
  }

  /** /OC edge to Q edge, in ps, with Q holding `level` while enabled. */
  function ocToQ(column: 'typ' | 'max', level: boolean) {
    const compiled = compile(oc374Board(), lib);
    const sim = new Simulator(compiled, datasheetDelay(column));
    sim.powerOn();
    sim.setToggle('main/VCC', true);
    sim.setToggle('main/GND', false);
    sim.setToggle('main/OC', false);
    sim.setToggle('main/D', level);
    sim.settle();
    sim.setToggle('main/CLK', true);
    sim.settle();
    const qNet = compiled.pathToNet.get('main/Q')!;
    const ocNet = compiled.primitives[compiled.pathToPrimitive.get('main/OC')!]!.outputs[0]!;
    const measure = (oc: boolean) => {
      const t0 = sim.time;
      sim.setToggle('main/OC', oc);
      sim.settle();
      const records = sim.traceRecords().filter((r) => r.time > t0);
      const q = records.find((r) => r.net === qNet)!;
      return { ps: q.time - records.find((r) => r.net === ocNet)!.time, q: toString(q.value, 1) };
    };
    return { disable: measure(true), enable: measure(false) };
  }

  // Two structural deltas (the /OC inverter and the power AND) sit ahead of the buffer.
  const hops = 2 * IDEAL_DELAY_PS;

  it('a high Q floats in tPHZ and returns in tPZH', () => {
    expect(ocToQ('typ', true)).toEqual({
      disable: { ps: 15_000 + hops, q: 'Z' },
      enable: { ps: 20_000 + hops, q: '1' },
    });
    expect(ocToQ('max', true).enable.ps).toBe(26_000 + hops);
  });

  it('a low Q floats in tPLZ and returns in tPZL', () => {
    expect(ocToQ('typ', false)).toEqual({
      disable: { ps: 12_000 + hops, q: 'Z' },
      enable: { ps: 21_000 + hops, q: '0' },
    });
    expect(ocToQ('max', false).disable.ps).toBe(20_000 + hops);
  });
});

describe('enable and disable times on any to-or-from-Z edge', () => {
  const PART = '74LS245';
  const W = 4;

  /** A transceiver driving B from a held source on A, its OE on a switch. */
  function oeBoard(value: number): Board {
    return board({
      components: [
        comp('sd', 'constant', { width: W, value }),
        comp('se', 'constant', { value: 1 }),
        comp('S', BIDIR, { width: W }),
        comp('T', 'transceiver', { width: W }, 'T'),
        comp('dir', 'constant', { value: 1 }),
        comp('toe', 'toggle', { initial: 1 }, 'OE'),
        comp('pb', 'probe', { width: W }, 'B'),
      ],
      wires: [
        wire('w1', ['sd', 'y'], ['S', 'd']),
        wire('w2', ['se', 'y'], ['S', 'en']),
        wire('w3', ['S', 'p'], ['T', 'a']),
        wire('w4', ['dir', 'y'], ['T', 'dir']),
        wire('w5', ['toe', 'y'], ['T', 'oe']),
        wire('w6', ['T', 'b'], ['pb', 'a']),
      ],
    });
  }

  /** OE edge to B edge, in ps: disable first, then enable. */
  function oeToB(value: number) {
    const compiled = compile(oeBoard(value), lib);
    const sim = new Simulator(compiled, datasheetDelay('typ'));
    sim.powerOn();
    const bNet = compiled.pathToNet.get('main/B')!;
    const oeNet = compiled.primitives[compiled.pathToPrimitive.get('main/OE')!]!.outputs[0]!;
    const measure = (oe: boolean) => {
      const t0 = sim.time;
      sim.setToggle('main/OE', oe);
      sim.settle();
      const records = sim.traceRecords().filter((r) => r.time > t0);
      const b = records.find((r) => r.net === bNet)!;
      return { ps: b.time - records.find((r) => r.net === oeNet)!.time, b: toString(b.value, W) };
    };
    return { disable: measure(false), enable: measure(true) };
  }

  it("an OE edge takes the '245's tPHZ and tPZH on a high bus, tPLZ and tPZL on a low one", () => {
    expect(oeToB(0b1111)).toEqual({
      disable: { ps: 15_000, b: 'ZZZZ' },
      enable: { ps: 25_000, b: '1111' },
    });
    expect(oeToB(0b0000)).toEqual({
      disable: { ps: 15_000, b: 'ZZZZ' },
      enable: { ps: 27_000, b: '0000' },
    });
  });

  it('a bus of mixed levels takes the slower of each pair', () => {
    expect(oeToB(0b0101)).toEqual({
      disable: { ps: 15_000, b: 'ZZZZ' },
      enable: { ps: 27_000, b: '0101' },
    });
  });

  it('a DIR flip disables the old side and enables the new one; a data edge keeps its arc', () => {
    const compiled = compile(oeBoard(0b1111), lib);
    const prim = compiled.primitives[compiled.pathToPrimitive.get('main/T')!]!;
    const { ins } = pinNamesOf(prim);
    const model = datasheetDelay('typ');
    const [sideA, sideB] = [0, 1];
    const dirMoved = [ins.indexOf('dir')];
    expect(model.delayPs(prim, sideB, bv.known(0b1111, W), bv.allZ(W), dirMoved)).toBe(15_000);
    expect(model.delayPs(prim, sideA, bv.allZ(W), bv.known(0, W), dirMoved)).toBe(27_000);
    const aMoved = [ins.indexOf('a')];
    const dataEdge = model.delayPs(prim, sideB, bv.known(0, W), bv.known(0b1111, W), aMoved);
    expect(outputPropagationNs(PART, ins, 'b', 'lh', 'typ')).toBe(8);
    expect(dataEdge).toBe(8_000);
    const maxEdge = datasheetDelay('max').delayPs(
      prim,
      sideB,
      bv.known(0b1111, W),
      bv.known(0, W),
      aMoved,
    );
    expect(maxEdge).toBe(12_000);
  });
});
