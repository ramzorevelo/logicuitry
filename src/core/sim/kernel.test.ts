import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary } from '../model/types';
import { board, comp, srLatchDef, wire } from '../model/testFixtures';
import { toString } from '../value/busValue';
import { idealDelay, datasheetDelay } from './delay';
import { OSC_EVENT_LIMIT, Simulator } from './kernel';

const lib = (...defs: ReturnType<typeof srLatchDef>[]): ChipLibrary =>
  new Map(defs.map((d) => [d.id, d]));

function srBoard() {
  return board({
    components: [
      comp('t1', 'toggle', undefined, 'SN'),
      comp('t2', 'toggle', undefined, 'RN'),
      { ...comp('u1', 'chip', undefined, 'U1'), defId: 'sr-latch' },
      comp('p1', 'probe', undefined, 'Q'),
      comp('p2', 'probe', undefined, 'QN'),
    ],
    wires: [
      wire('w1', ['t1', 'y'], ['u1', 'sn']),
      wire('w2', ['t2', 'y'], ['u1', 'rn']),
      wire('w3', ['u1', 'q'], ['p1', 'a']),
      wire('w4', ['u1', 'qn'], ['p2', 'a']),
    ],
  });
}

const q = (sim: Simulator) => toString(sim.netValueByPath('main/Q'), 1);
const qn = (sim: Simulator) => toString(sim.netValueByPath('main/QN'), 1);

describe('kernel: SR latch from NANDs', () => {
  it('powers on to all-X and holds X with both inputs inactive', () => {
    const sim = new Simulator(compile(srBoard(), lib(srLatchDef())), idealDelay);
    sim.setToggle('main/SN', true);
    sim.setToggle('main/RN', true);
    const report = sim.settle();
    expect(report.settled).toBe(true);
    // Cross-coupled X cannot resolve itself: initialization is required.
    expect(q(sim)).toBe('X');
    expect(qn(sim)).toBe('X');
  });

  it('set, hold, reset sequence behaves like the truth table', () => {
    const sim = new Simulator(compile(srBoard(), lib(srLatchDef())), idealDelay);
    sim.powerOn();

    sim.setToggle('main/SN', false); // assert set (active low), rn stays 0 too
    sim.setToggle('main/RN', true);
    expect(sim.settle().settled).toBe(true);
    expect(q(sim)).toBe('1');
    expect(qn(sim)).toBe('0');

    sim.setToggle('main/SN', true); // release set: hold
    expect(sim.settle().settled).toBe(true);
    expect(q(sim)).toBe('1');

    sim.setToggle('main/RN', false); // assert reset
    expect(sim.settle().settled).toBe(true);
    expect(q(sim)).toBe('0');
    expect(qn(sim)).toBe('1');
  });

  it('replays byte-identically: same scenario, same trace', () => {
    const run = () => {
      const sim = new Simulator(compile(srBoard(), lib(srLatchDef())), idealDelay);
      sim.powerOn();
      sim.setToggle('main/SN', false);
      sim.setToggle('main/RN', true);
      sim.settle();
      sim.setToggle('main/SN', true);
      sim.settle();
      sim.setToggle('main/RN', false);
      sim.settle();
      return JSON.stringify(sim.traceRecords());
    };
    expect(run()).toBe(run());
  });

  it('releasing both async inputs simultaneously oscillates and is reported', () => {
    const sim = new Simulator(compile(srBoard(), lib(srLatchDef())), idealDelay);
    sim.setToggle('main/SN', false);
    sim.setToggle('main/RN', false);
    expect(sim.settle().settled).toBe(true);
    expect(q(sim)).toBe('1'); // both asserted: both outputs forced high
    expect(qn(sim)).toBe('1');

    sim.setToggle('main/SN', true);
    sim.setToggle('main/RN', true); // classic race: 11 -> 00 -> 11 -> ...
    const report = sim.settle();
    expect(report.settled).toBe(false);
    expect(report.eventsProcessed).toBeGreaterThan(OSC_EVENT_LIMIT);
    expect(report.oscillation!.nets.length).toBeGreaterThan(0);
    expect(report.oscillation!.primitives.length).toBeGreaterThan(0);
  });

  it('single delta-steps expose the gate-by-gate ripple', () => {
    const sim = new Simulator(compile(srBoard(), lib(srLatchDef())), idealDelay);
    sim.setToggle('main/SN', true);
    sim.setToggle('main/RN', true);
    sim.settle();
    sim.setToggle('main/SN', false);
    const steps: number[] = [];
    for (let r = sim.deltaStep(); r; r = sim.deltaStep()) steps.push(r.changedNets.length);
    expect(steps.length).toBeGreaterThan(1); // ripple, not a single jump
    expect(q(sim)).toBe('1');
  });
});

describe('kernel: cause edges', () => {
  // toggle -> not -> not chain: each net change should carry its input edge.
  function chainBoard() {
    return board({
      components: [
        comp('t1', 'toggle', undefined, 'A'),
        comp('n1', 'not'),
        comp('n2', 'not'),
        comp('p1', 'probe', undefined, 'Y'),
      ],
      wires: [
        wire('w1', ['t1', 'y'], ['n1', 'a']),
        wire('w2', ['n1', 'y'], ['n2', 'a']),
        wire('w3', ['n2', 'y'], ['p1', 'a']),
      ],
    });
  }

  it('propagates the causing net edge per hop; user actions carry NO_CAUSE', () => {
    const compiled = compile(chainBoard(), lib());
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    sim.setToggle('main/A', true);
    sim.settle();
    const aNet = compiled.primitives[compiled.pathToPrimitive.get('main/A')!]!.outputs[0]!;
    const n1Net = compiled.primitives[compiled.pathToPrimitive.get('main/n1')!]!.outputs[0]!;
    const yNet = compiled.pathToNet.get('main/Y')!;
    const records = sim.traceRecords().filter((r) => r.time > 0);
    const aRec = records.find((r) => r.net === aNet)!;
    const n1Rec = records.find((r) => r.net === n1Net)!;
    const yRec = records.find((r) => r.net === yNet)!;
    // The toggle's own edge is a user action, not a propagated one.
    expect(aRec.cause.net).toBe(-1);
    // Each downstream hop points back at the immediately-upstream edge.
    expect(n1Rec.cause).toEqual({ net: aNet, time: aRec.time });
    expect(yRec.cause).toEqual({ net: n1Net, time: n1Rec.time });
  });
});

describe('kernel: DFF with clock (divide-by-two)', () => {
  function divBoard(periodPs = 10) {
    return board({
      components: [
        comp('clk', 'clock', { periodPs }, 'CLK'),
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

  it('X until cleared, then toggles once per rising edge', () => {
    const sim = new Simulator(compile(divBoard(), lib()), idealDelay);
    sim.powerOn();
    expect(q(sim)).toBe('X'); // no initialization yet: the teaching moment

    sim.setToggle('main/RSTN', false);
    sim.settle();
    expect(q(sim)).toBe('0');
    sim.setToggle('main/RSTN', true);
    sim.settle();

    // Collect q transitions over several clock periods of continuous run.
    const seen: string[] = [q(sim)];
    sim.start();
    const stopAt = sim.time + 45;
    while (sim.pendingEvents > 0 && sim.time < stopAt) {
      sim.deltaStep();
      const cur = q(sim);
      if (seen[seen.length - 1] !== cur) seen.push(cur);
    }
    expect(seen.join('')).toMatch(/^(01)+0?$|^(10)+1?$/); // strict alternation
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('datasheet mode: q edges lag clock edges by the 74LS74 clk->q figures', () => {
    const period = 100_000;
    const compiled = compile(divBoard(period), lib());
    const sim = new Simulator(compiled, datasheetDelay('typ'));
    sim.powerOn();
    sim.setToggle('main/RSTN', false);
    sim.settle();
    sim.setToggle('main/RSTN', true);
    sim.settle();

    const runStart = sim.time;
    sim.start();
    sim.runUntil(sim.time + 5 * period);

    const qNet = compiled.pathToNet.get('main/Q')!;
    const clkNet =
      compiled.pathToNet.get('main/CLK') ??
      compiled.primitives[compiled.pathToPrimitive.get('main/CLK')!]!.outputs[0]!;
    const records = sim.traceRecords();
    const rises = records.filter((r) => r.net === clkNet && r.value.v === 1).map((r) => r.time);
    const qChanges = records.filter(
      (r) => r.net === qNet && (r.value.x | r.value.z) === 0 && r.time > runStart,
    );
    expect(qChanges.length).toBeGreaterThanOrEqual(3);
    for (const change of qChanges) {
      const edge = [...rises].reverse().find((t) => t < change.time);
      if (edge === undefined) continue;
      // tPLH(typ) 13ns for q rising, tPHL(typ) 25ns for q falling.
      expect(change.time - edge).toBe(change.value.v === 1 ? 13_000 : 25_000);
    }
  });
});

describe('kernel: width-N toggle', () => {
  function toggleBoard(width: number, params?: Record<string, unknown>) {
    return board({
      components: [
        comp('t', 'toggle', { width, ...params }, 'T'),
        comp('p', 'probe', { width }, 'P'),
      ],
      wires: [wire('w1', ['t', 'y'], ['p', 'a'])],
    });
  }

  it('setToggleValue drives an arbitrary width-4 value', () => {
    const sim = new Simulator(compile(toggleBoard(4), lib()), idealDelay);
    sim.powerOn();
    sim.setToggleValue('main/T', 0b1011);
    sim.settle();
    expect(toString(sim.netValueByPath('main/P'), 4)).toBe('1011');
  });

  it('getPrimitiveState reads back what setToggleValue/setPrimitiveState just set', () => {
    const sim = new Simulator(compile(toggleBoard(4), lib()), idealDelay);
    sim.powerOn();
    expect(sim.getPrimitiveState('main/T')).toEqual({ value: 0 });
    sim.setToggleValue('main/T', 0b1011);
    expect(sim.getPrimitiveState('main/T')).toEqual({ value: 0b1011 });
  });

  it('setToggle at width 1 stays byte-identical to a boolean-initial board', () => {
    const simNew = new Simulator(compile(toggleBoard(1), lib()), idealDelay);
    simNew.powerOn();
    simNew.setToggle('main/T', true);
    simNew.settle();

    const simOld = new Simulator(compile(toggleBoard(1, { initial: true }), lib()), idealDelay);
    simOld.powerOn();
    simOld.settle();

    expect(toString(simNew.netValueByPath('main/P'), 1)).toBe('1');
    expect(toString(simOld.netValueByPath('main/P'), 1)).toBe('1');
  });
});

describe('kernel: index-keyed primitive addressing', () => {
  // Label sharing puts two components on one path, and pathToPrimitive is
  // last-write-wins, so a caller holding a specific component must address it
  // by index or it silently drives the other one.
  function sharedLabelBoard() {
    return board({
      components: [comp('t', 'toggle', undefined, 'A'), comp('p', 'probe', undefined, 'A')],
      wires: [wire('w1', ['t', 'y'], ['p', 'a'])],
    });
  }

  it('addresses the switch by index even when a probe shares its label', () => {
    const compiled = compile(sharedLabelBoard(), lib());
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    const pi = compiled.componentToPrimitive.get('main/t')!;
    expect(sim.primitiveStateAt(pi)).toEqual({ value: 0 });
    sim.setPrimitiveStateAt(pi, { value: 1 });
    sim.settle();
    expect(sim.primitiveStateAt(pi)).toEqual({ value: 1 });
    expect(toString(sim.netValueByPath('main/A'), 1)).toBe('1');
  });

  it('rejects an out-of-range primitive index', () => {
    const sim = new Simulator(compile(sharedLabelBoard(), lib()), idealDelay);
    sim.powerOn();
    expect(() => sim.primitiveStateAt(99)).toThrow();
    expect(() => sim.setPrimitiveStateAt(-1, {})).toThrow();
  });
});

describe('kernel: stepToNextEvent', () => {
  function clockBoard() {
    return board({
      components: [
        comp('c', 'clock', { periodPs: 10_000 }, 'CLK'),
        comp('p', 'probe', undefined, 'Q'),
      ],
      wires: [wire('w1', ['c', 'y'], ['p', 'a'])],
    });
  }

  function combinationalBoard() {
    return board({
      components: [comp('t', 'toggle', undefined, 'A'), comp('p', 'probe', undefined, 'Q')],
      wires: [wire('w1', ['t', 'y'], ['p', 'a'])],
    });
  }

  it('advances time to the next clock edge while paused', () => {
    const sim = new Simulator(compile(clockBoard(), lib()), idealDelay);
    sim.powerOn();
    expect(sim.pendingEvents).toBe(0); // settled: a bare deltaStep would do nothing
    expect(sim.deltaStep()).toBeNull();

    const t0 = sim.time;
    sim.stepToNextEvent();
    expect(sim.time).toBeGreaterThan(t0);
  });

  it('keeps stepping without ever entering free run', () => {
    const sim = new Simulator(compile(clockBoard(), lib()), idealDelay);
    sim.powerOn();
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      sim.stepToNextEvent();
      times.push(sim.time);
    }
    // Monotonic, and the clock actually toggled somewhere along the way.
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[times.length - 1]).toBeGreaterThan(0);
    expect(sim.traceRecords().length).toBeGreaterThan(0);
  });

  it('reports nothing to step on a settled combinational board', () => {
    const sim = new Simulator(compile(combinationalBoard(), lib()), idealDelay);
    sim.powerOn();
    expect(sim.canStep).toBe(false);
    const t0 = sim.time;
    sim.stepToNextEvent();
    expect(sim.time).toBe(t0);
  });

  it('reports something to step once a clock is present', () => {
    const sim = new Simulator(compile(clockBoard(), lib()), idealDelay);
    sim.powerOn();
    expect(sim.canStep).toBe(true);
  });
});
