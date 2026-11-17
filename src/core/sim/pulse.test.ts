import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import { board, comp, wire } from '../model/testFixtures';
import { toString } from '../value/busValue';
import { idealDelay } from './delay';
import { Simulator } from './kernel';
import { pulseClock } from './pulse';

const PERIOD = 10_000;

function divider(clockParams: Record<string, number> = { periodPs: PERIOD }) {
  return board({
    components: [
      comp('clk', 'clock', clockParams, 'CLK'),
      comp('rst', 'toggle', { initial: true }, 'RSTN'),
      comp('ff', 'dff', { asyncClear: true }, 'FF'),
      comp('p1', 'probe', undefined, 'Q'),
    ],
    wires: [
      wire('w1', ['clk', 'y'], ['ff', 'clk']),
      wire('w2', ['rst', 'y'], ['ff', 'clr']),
      wire('w3', ['ff', 'qn'], ['ff', 'd']),
      wire('w4', ['ff', 'q'], ['p1', 'a']),
    ],
  });
}

function cleared(params?: Record<string, number>) {
  const sim = new Simulator(compile(divider(params), new Map()), idealDelay);
  sim.powerOn();
  sim.setToggle('main/RSTN', false);
  sim.settle();
  sim.setToggle('main/RSTN', true);
  sim.settle();
  return sim;
}

const q = (sim: Simulator) => toString(sim.netValueByPath('main/Q'), 1);
const outOf = (sim: Simulator, kind: string) =>
  sim.circuit.primitives.find((p) => p.kind === kind)!.outputs[0]!;
const clk = (sim: Simulator) => outOf(sim, 'clock');
// The fall reaches the net a unit delay after the clock's own edge.
const expectJustAfter = (sim: Simulator, fallPs: number) => {
  expect(sim.time).toBeGreaterThanOrEqual(fallPs);
  expect(sim.time).toBeLessThan(fallPs + PERIOD / 2);
};

describe('pulseClock', () => {
  it('starting high, waits for the fall, then clocks once and stops on the next fall', () => {
    const sim = cleared();
    expect(toString(sim.netValue(clk(sim)), 1)).toBe('1');
    const report = pulseClock(sim, clk(sim));
    expect(report?.settled).toBe(true);
    expect(q(sim)).toBe('1');
    expectJustAfter(sim, PERIOD + PERIOD / 2);
    expect(toString(sim.netValue(clk(sim)), 1)).toBe('0');
  });

  it('one pulse per call, each a whole period on', () => {
    const sim = cleared();
    pulseClock(sim, clk(sim));
    pulseClock(sim, clk(sim));
    expect(q(sim)).toBe('0');
    expectJustAfter(sim, 2 * PERIOD + PERIOD / 2);
    pulseClock(sim, clk(sim));
    expect(q(sim)).toBe('1');
  });

  it('starting low, the next rise counts', () => {
    const sim = cleared({ periodPs: PERIOD, phasePs: 3_000 });
    expect(toString(sim.netValue(clk(sim)), 1)).toBe('0');
    pulseClock(sim, clk(sim));
    expect(q(sim)).toBe('1');
    expectJustAfter(sim, 3_000 + PERIOD / 2);
  });

  it('leaves the clock parked: nothing queued', () => {
    const sim = cleared();
    pulseClock(sim, clk(sim));
    expect(sim.settled).toBe(true);
  });

  it('is null on a net that never moves', () => {
    const sim = cleared();
    expect(pulseClock(sim, outOf(sim, 'toggle'), 200)).toBeNull();
  });
});
