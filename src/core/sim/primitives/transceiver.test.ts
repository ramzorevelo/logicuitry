import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import { compile } from '../../model/compile';
import type { Board, ChipLibrary, Wire } from '../../model/types';
import { board, comp, tapWire, wire } from '../../model/testFixtures';
import { BIDIR } from '../../model/bidirFixture';
import { Simulator } from '../kernel';
import { datasheetDelay, idealDelay, type DelayModel } from '../delay';
import { transceiver } from './transceiver';

const noLib: ChipLibrary = new Map();
const W = 4;
const known = (v: number) => bv.known(v, W);
const ONE = bv.known(1, 1);
const ZERO = bv.known(0, 1);
const X1 = bv.allX(1);
const Z1 = bv.allZ(1);

const evalAt = (a: bv.BusValue, b: bv.BusValue, dir: bv.BusValue, oe: bv.BusValue, width = W) => {
  const inputs = [a, b, dir, oe];
  return transceiver.evaluate({
    params: { width },
    state: undefined,
    inputs,
    prevInputs: inputs,
    time: 0,
  }).outputs;
};

describe('transceiver truth', () => {
  it('dir 1 drives b from a and floats a; dir 0 drives a from b and floats b', () => {
    expect(evalAt(known(5), known(3), ONE, ONE)).toEqual([bv.allZ(W), known(5)]);
    expect(evalAt(known(5), known(3), ZERO, ONE)).toEqual([known(3), bv.allZ(W)]);
  });

  it('oe 0 floats both sides whatever dir reads', () => {
    for (const dir of [ZERO, ONE, X1, Z1])
      expect(evalAt(known(5), known(3), dir, ZERO)).toEqual([bv.allZ(W), bv.allZ(W)]);
  });

  it('oe X gives X on the side that could be driving and floats the other', () => {
    for (const oe of [X1, Z1]) {
      expect(evalAt(known(5), known(3), ONE, oe)).toEqual([bv.allZ(W), bv.allX(W)]);
      expect(evalAt(known(5), known(3), ZERO, oe)).toEqual([bv.allX(W), bv.allZ(W)]);
      expect(evalAt(known(5), known(3), X1, oe)).toEqual([bv.allX(W), bv.allX(W)]);
    }
  });

  it('dir X with oe 1 gives X on both sides', () => {
    expect(evalAt(known(5), known(3), X1, ONE)).toEqual([bv.allX(W), bv.allX(W)]);
    expect(evalAt(known(5), known(3), Z1, ONE)).toEqual([bv.allX(W), bv.allX(W)]);
  });

  it('a floating source gives X, bit by bit', () => {
    expect(evalAt(bv.allZ(W), known(0), ONE, ONE)[1]).toEqual(bv.allX(W));
    const partly = { v: 0b0001, x: 0, z: 0b0100 };
    expect(evalAt(known(0), partly, ZERO, ONE)[0]).toEqual({ v: 0b0001, x: 0b0100, z: 0 });
  });

  it('works at widths 1 and 32', () => {
    expect(evalAt(ONE, Z1, ONE, ONE, 1)).toEqual([Z1, ONE]);
    const wide = bv.known(0xdeadbeef, 32);
    expect(evalAt(bv.allZ(32), wide, ZERO, ONE, 32)).toEqual([wide, bv.allZ(32)]);
  });
});

/** A width-W three-state source driving `pin` of `target` with `value`. */
function source(id: string, value: number, target: [string, string]) {
  return {
    components: [
      comp(`${id}d`, 'constant', { width: W, value }),
      comp(`${id}e`, 'constant', { value: 1 }),
      comp(id, BIDIR, { width: W }),
    ],
    wires: [
      wire(`${id}w1`, [`${id}d`, 'y'], [id, 'd']),
      wire(`${id}w2`, [`${id}e`, 'y'], [id, 'en']),
      wire(`${id}w3`, [id, 'p'], target),
    ],
  };
}

function controls(id: string, dir: number, oe = 1) {
  return {
    components: [
      comp(`${id}dir`, 'constant', { value: dir }),
      comp(`${id}oe`, 'constant', { value: oe }),
    ],
    wires: [
      wire(`${id}wd`, [`${id}dir`, 'y'], [id, 'dir']),
      wire(`${id}wo`, [`${id}oe`, 'y'], [id, 'oe']),
    ],
  };
}

function merge(parts: { components: Board['components']; wires: Wire[] }[]): Board {
  return board({
    components: parts.flatMap((p) => p.components),
    wires: parts.flatMap((p) => p.wires),
  });
}

const settle = (b: Board, delay: DelayModel = idealDelay) => {
  const sim = new Simulator(compile(b, noLib), delay);
  return { sim, report: sim.powerOn() };
};

describe('transceivers on a shared bus', () => {
  /** T1 and T2 both drive their b onto BUS, from sources on their a sides. */
  const facingOnBus = (v1: number, v2: number) =>
    merge([
      { components: [comp('T1', 'transceiver', { width: W }, 'T1')], wires: [] },
      { components: [comp('T2', 'transceiver', { width: W }, 'T2')], wires: [] },
      source('S1', v1, ['T1', 'a']),
      source('S2', v2, ['T2', 'a']),
      controls('T1', 1),
      controls('T2', 1),
      {
        components: [comp('pb', 'probe', { width: W }, 'BUS')],
        wires: [wire('wb', ['T1', 'b'], ['T2', 'b']), wire('wp', ['T1', 'b'], ['pb', 'a'])],
      },
    ]);

  it('read X when both drive different values and the value when they agree', () => {
    const fight = settle(facingOnBus(5, 10));
    expect(fight.report.settled).toBe(true);
    expect(fight.sim.netValueByPath('main/BUS')).toEqual(bv.allX(W));
    const agree = settle(facingOnBus(5, 5));
    expect(agree.sim.netValueByPath('main/BUS')).toEqual(known(5));
  });

  it('share a bus with a tristate: X on a conflict, the value when they agree', () => {
    const shared = (tri: number) =>
      board({
        components: [
          comp('T1', 'transceiver', { width: 1 }, 'T1'),
          comp('sd', 'constant', { value: 1 }),
          comp('se', 'constant', { value: 1 }),
          comp('S', BIDIR),
          comp('ta', 'constant', { value: tri }),
          comp('te', 'constant', { value: 1 }),
          comp('U', 'tristate'),
          comp('one', 'constant', { value: 1 }),
          comp('pb', 'probe', undefined, 'BUS'),
        ],
        wires: [
          wire('w1', ['sd', 'y'], ['S', 'd']),
          wire('w2', ['se', 'y'], ['S', 'en']),
          wire('w3', ['S', 'p'], ['T1', 'a']),
          wire('w4', ['one', 'y'], ['T1', 'dir']),
          wire('w5', ['one', 'y'], ['T1', 'oe']),
          wire('w6', ['ta', 'y'], ['U', 'a']),
          wire('w7', ['te', 'y'], ['U', 'en']),
          wire('w8', ['U', 'y'], ['T1', 'b']),
          wire('w9', ['T1', 'b'], ['pb', 'a']),
        ],
      });
    expect(settle(shared(0)).sim.netValueByPath('main/BUS')).toEqual(X1);
    expect(settle(shared(1)).sim.netValueByPath('main/BUS')).toEqual(ONE);
  });

  it('settle at X when they face each other, both enabled, and never oscillate', () => {
    // T1 drives MID from LEFT; T2 drives MID from RIGHT, the opposite way round.
    const b = merge([
      { components: [comp('T1', 'transceiver', { width: W }, 'T1')], wires: [] },
      { components: [comp('T2', 'transceiver', { width: W }, 'T2')], wires: [] },
      source('S1', 5, ['T1', 'a']),
      source('S2', 10, ['T2', 'b']),
      controls('T1', 1),
      controls('T2', 0),
      {
        components: [comp('pm', 'probe', { width: W }, 'MID')],
        wires: [wire('wm', ['T1', 'b'], ['T2', 'a']), wire('wp', ['T1', 'b'], ['pm', 'a'])],
      },
    ]);
    for (const delay of [idealDelay, datasheetDelay('typ')]) {
      const { sim, report } = settle(b, delay);
      expect(report.settled).toBe(true);
      expect(sim.netValueByPath('main/MID')).toEqual(bv.allX(W));
    }
  });

  it('settle at X in a ring of two, each driving the other, with no oscillation', () => {
    const b = merge([
      { components: [comp('T1', 'transceiver', { width: W }, 'T1')], wires: [] },
      { components: [comp('T2', 'transceiver', { width: W }, 'T2')], wires: [] },
      source('S1', 5, ['T1', 'a']),
      controls('T1', 1),
      controls('T2', 1),
      {
        components: [comp('pl', 'probe', { width: W }, 'LEFT')],
        wires: [
          wire('wr', ['T1', 'b'], ['T2', 'a']),
          wire('wl', ['T2', 'b'], ['T1', 'a']),
          wire('wp', ['T1', 'a'], ['pl', 'a']),
        ],
      },
    ]);
    const { sim, report } = settle(b);
    expect(report.settled).toBe(true);
    expect(sim.netValueByPath('main/LEFT')).toEqual(bv.allX(W));
  });

  it('let a tap read a bus driven by its b side', () => {
    const freeBus: Wire = {
      id: 'wbus',
      a: { kind: 'pin', component: 'T1', pin: 'b' },
      b: { kind: 'free', pos: { x: 9, y: 0 } },
      points: [],
    };
    const b = merge([
      { components: [comp('T1', 'transceiver', { width: W }, 'T1')], wires: [freeBus] },
      source('S1', 0b0110, ['T1', 'a']),
      controls('T1', 1),
      {
        components: [comp('p', 'probe', { width: 2 }, 'MID')],
        wires: [tapWire('wt', ['p', 'a'], 'wbus', { hi: 2, lo: 1 })],
      },
    ]);
    expect(settle(b).sim.netValueByPath('main/MID')).toEqual(bv.known(0b11, 2));
  });
});

describe('transceiver in both timing models', () => {
  /** A switch on DIR flips which side the transceiver drives. */
  const flipBoard = () =>
    merge([
      { components: [comp('T1', 'transceiver', { width: W }, 'T1')], wires: [] },
      source('SA', 5, ['T1', 'a']),
      {
        components: [
          comp('sw', 'toggle', undefined, 'DIR'),
          comp('oe', 'constant', { value: 1 }),
          comp('pb', 'probe', { width: W }, 'B'),
        ],
        wires: [
          wire('wd', ['sw', 'y'], ['T1', 'dir']),
          wire('wo', ['oe', 'y'], ['T1', 'oe']),
          wire('wp', ['T1', 'b'], ['pb', 'a']),
        ],
      },
    ]);

  /** Every net change after power-on, as (time, net, value) strings. */
  const run = (delay: DelayModel): { trace: string[]; b: bv.BusValue; steps: number } => {
    const sim = new Simulator(compile(flipBoard(), noLib), delay);
    sim.powerOn();
    sim.setToggle('main/DIR', true);
    let steps = 0;
    while (sim.stepToNextEvent()) steps++;
    const b = sim.netValueByPath('main/B');
    sim.setToggle('main/DIR', false);
    sim.settle();
    const trace = sim
      .traceRecords()
      .map((r) => `${r.time} ${r.net} ${bv.toString(r.value, sim.circuit.nets[r.net]!.width)}`);
    return { trace, b, steps };
  };

  it('settles and single-steps in ideal and datasheet modes, replaying identically', () => {
    for (const delay of [idealDelay, datasheetDelay('typ'), datasheetDelay('max')]) {
      const first = run(delay);
      expect(first.b).toEqual(known(5));
      expect(first.steps).toBeGreaterThan(0);
      expect(run(delay).trace).toEqual(first.trace);
    }
  });
});
