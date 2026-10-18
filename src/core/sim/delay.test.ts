import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { Board } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { builtinChipLibrary } from '../parts/packages';
import { toString } from '../value/busValue';
import { datasheetDelay, IDEAL_DELAY_PS } from './delay';
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
