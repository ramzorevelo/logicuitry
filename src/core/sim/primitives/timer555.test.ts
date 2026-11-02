import { describe, expect, it } from 'vitest';
import { compile } from '../../model/compile';
import { board, chipComp, chipDef, comp, pin, wire } from '../../model/testFixtures';
import type { Board } from '../../model/types';
import * as bv from '../../value/busValue';
import { toString } from '../../value/busValue';
import { datasheetDelay, idealDelay, type DelayModel } from '../delay';
import { Simulator } from '../kernel';
import {
  timer555,
  timerIntervals,
  timerMode,
  timerValues,
  TIMER_C_MAX,
  TIMER_R_MAX,
  type TimerState,
} from './timer555';
import type { EvalResult, Params } from './types';

// 1 kohm, 2 kohm, 1 nF: every interval is a whole number of ns.
const SMALL: Params = { r1: 1000, r2: 2000, c: 1e-9 };
const FIRST = 3_300_000; // 1.1 x 3 kohm x 1 nF
const HIGH = 2_079_000; // 0.693 x 3 kohm x 1 nF
const LOW = 1_386_000; // 0.693 x 2 kohm x 1 nF
const PULSE = 1_100_000; // 1.1 x 1 kohm x 1 nF

const ONE = bv.known(1, 1);
const ZERO = bv.known(0, 1);
const X = bv.allX(1);

function evalAt(
  params: Params,
  state: unknown,
  inputs: bv.BusValue[],
  time: number,
): EvalResult & { state: TimerState } {
  const r = timer555.evaluate({ params, state, inputs, prevInputs: inputs, time });
  return r as EvalResult & { state: TimerState };
}

const outOf = (r: EvalResult) => toString(r.outputs[0]!, 1);

describe('timerIntervals', () => {
  it('applies the TI SLFS022K formulas in whole ps', () => {
    expect(timerIntervals(SMALL)).toEqual({
      firstHighPs: FIRST,
      highPs: HIGH,
      lowPs: LOW,
      pulsePs: PULSE,
    });
  });

  it('defaults to 1 kohm, 1 Mohm, 1 uF: about 0.721 Hz', () => {
    const iv = timerIntervals({});
    expect(iv.highPs).toBe(693_693_000_000);
    expect(iv.lowPs).toBe(693_000_000_000);
    expect(1e12 / (iv.highPs + iv.lowPs)).toBeCloseTo(0.7211, 4);
  });

  it('floors a zero interval at 1 ps so time always moves', () => {
    expect(timerIntervals({ r1: 0, r2: 0, c: 1e-12 })).toEqual({
      firstHighPs: 1,
      highPs: 1,
      lowPs: 1,
      pulsePs: 1,
    });
  });

  it('clamps R and C into range and ignores non-numbers', () => {
    expect(timerValues({ r1: -5, r2: 1e12, c: 1 })).toEqual({
      r1: 0,
      r2: TIMER_R_MAX,
      c: TIMER_C_MAX,
    });
    expect(timerValues({ r1: 'x', c: Number.NaN })).toEqual({ r1: 1000, r2: 1e6, c: 1e-6 });
  });

  it('keeps the longest interval a safe integer with room for the sim time', () => {
    const iv = timerIntervals({ r1: TIMER_R_MAX, r2: TIMER_R_MAX, c: TIMER_C_MAX });
    expect(iv.firstHighPs).toBe(2.2e15);
    expect(Number.isSafeInteger(iv.firstHighPs * 4)).toBe(true);
  });
});

describe('timer555 pins', () => {
  const names = (mode: string) => timer555.pins({ mode }).map((p) => p.name);

  it('shows only the pins each mode uses', () => {
    expect(names('astable')).toEqual(['reset', 'out']);
    expect(names('monostable')).toEqual(['trig', 'reset', 'out']);
    expect(names('bistable')).toEqual(['trig', 'thres', 'reset', 'out']);
    expect(timerMode({ mode: 'nonsense' })).toBe('astable');
  });

  it('marks TRIG and RESET active low and the astable output a clock', () => {
    const pins = timer555.pins({ mode: 'bistable' });
    expect(pins.filter((p) => p.activeLow).map((p) => p.name)).toEqual(['trig', 'reset']);
    expect(timer555.pins({}).find((p) => p.name === 'out')!.role).toBe('clock');
    expect(pins.find((p) => p.name === 'out')!.role).toBe('data');
  });
});

describe('timer555 astable, evaluate', () => {
  const p = { ...SMALL, mode: 'astable' };

  it('starts HIGH for the long first interval once RESET is HIGH', () => {
    const r = evalAt(p, timer555.init!(p), [ONE], 500);
    expect(outOf(r)).toBe('1');
    expect(r.nextWake).toBe(500 + FIRST);
  });

  it('an unknown RESET gives X only while running on would be HIGH, and loses the phase', () => {
    expect(outOf(evalAt(p, { phase: 'high', end: 9_999_999 }, [X], 0))).toBe('X');
    const lowPhase = evalAt(p, { phase: 'low', end: 9_999_999 }, [X], 0);
    expect(outOf(lowPhase)).toBe('0');
    expect(lowPhase.state.phase).toBe('unknown');
  });

  it('a LOW RESET gives 0 and empties the capacitor', () => {
    const running = { phase: 'low', end: 9_999_999 };
    const low = evalAt(p, running, [ZERO], 0);
    expect(outOf(low)).toBe('0');
    expect(low.state.phase).toBe('empty');
    expect(low.nextWake).toBeUndefined();
  });

  it('alternates tH and tL after the first HIGH', () => {
    let s: unknown = timer555.init!(p);
    let r = evalAt(p, s, [ONE], 0);
    const edges: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = r.state;
      r = evalAt(p, s, [ONE], r.nextWake!);
      edges.push(`${outOf(r)}@${r.nextWake}`);
    }
    expect(edges).toEqual([
      `0@${FIRST + LOW}`,
      `1@${FIRST + LOW + HIGH}`,
      `0@${FIRST + 2 * LOW + HIGH}`,
      `1@${FIRST + 2 * LOW + 2 * HIGH}`,
    ]);
  });

  it('an early or repeated wake changes nothing', () => {
    const r = evalAt(p, timer555.init!(p), [ONE], 0);
    const again = evalAt(p, r.state, [ONE], 10);
    expect(again.state).toEqual(r.state);
    expect(again.nextWake).toBe(r.nextWake);
  });

  it('catches up across many periods in one wake', () => {
    const r = evalAt(p, timer555.init!(p), [ONE], 0);
    const period = HIGH + LOW;
    const late = evalAt(p, r.state, [ONE], FIRST + 1000 * period + LOW + 5);
    expect(outOf(late)).toBe('1');
    expect(late.nextWake).toBe(FIRST + 1000 * period + LOW + HIGH);
  });

  it('a live R2 change scales the time left in the running phase by the new RC', () => {
    const r = evalAt(p, timer555.init!(p), [ONE], 0);
    const faster = { ...p, r2: 0 };
    const mid = evalAt(faster, r.state, [ONE], 100);
    // (R1 + R2) C falls from 3 to 1 kohm nF: a third of what was left.
    const end = 100 + Math.round((FIRST - 100) / 3);
    expect(mid.nextWake).toBe(end);
    expect(evalAt(faster, mid.state, [ONE], 200).nextWake).toBe(end);
    const low = evalAt(faster, mid.state, [ONE], end);
    expect(low.nextWake).toBe(end + 1);
  });

  it("a live edit that leaves the phase's RC alone keeps its end", () => {
    const r = evalAt(p, timer555.init!(p), [ONE], 0);
    const mid = evalAt({ ...p, r1: 2000, r2: 1000 }, r.state, [ONE], 100);
    expect(mid.nextWake).toBe(FIRST);
  });
});

describe('timer555 monostable, evaluate', () => {
  const p = { ...SMALL, mode: 'monostable' };
  const idle: TimerState = { phase: 'empty', end: 0 };

  it('TRIG LOW starts a pulse of 1.1 R C', () => {
    const r = evalAt(p, idle, [ZERO, ONE], 1000);
    expect(outOf(r)).toBe('1');
    expect(r.nextWake).toBe(1000 + PULSE);
  });

  it('is not retriggerable', () => {
    const r = evalAt(p, idle, [ZERO, ONE], 0);
    const released = evalAt(p, r.state, [ONE, ONE], 10);
    const again = evalAt(p, released.state, [ZERO, ONE], 20);
    expect(again.nextWake).toBe(PULSE);
  });

  it('a TRIG still LOW at the end holds OUT HIGH until it releases', () => {
    const r = evalAt(p, idle, [ZERO, ONE], 0);
    const end = evalAt(p, r.state, [ZERO, ONE], PULSE);
    expect(outOf(end)).toBe('1');
    expect(end.nextWake).toBeUndefined();
    const release = evalAt(p, end.state, [ONE, ONE], PULSE + 50);
    expect(outOf(release)).toBe('0');
    expect(release.state.phase).toBe('empty');
  });

  it('RESET LOW ends a pulse at once', () => {
    const r = evalAt(p, idle, [ZERO, ONE], 0);
    expect(outOf(evalAt(p, r.state, [ONE, ZERO], 10))).toBe('0');
  });

  it('a live R change stretches the pulse under way', () => {
    const r = evalAt(p, idle, [ZERO, ONE], 0);
    const slower = evalAt({ ...p, r1: 2000 }, r.state, [ONE, ONE], 100);
    expect(slower.nextWake).toBe(100 + 2 * (PULSE - 100));
  });

  it('a RESET release while TRIG is LOW starts a pulse', () => {
    const held = evalAt(p, idle, [ZERO, ZERO], 0);
    expect(outOf(held)).toBe('0');
    const r = evalAt(p, held.state, [ZERO, ONE], 40);
    expect(r.nextWake).toBe(40 + PULSE);
  });

  it('an unknown TRIG while idle gives X until a pulse it might have started is over', () => {
    const x = evalAt(p, idle, [X, ONE], 0);
    expect(outOf(x)).toBe('X');
    const at = 300;
    const released = timer555.evaluate({
      params: p,
      state: x.state,
      inputs: [ONE, ONE],
      prevInputs: [X, ONE],
      time: at,
    });
    expect(outOf(released)).toBe('X');
    expect(released.nextWake).toBe(at + PULSE);
    const over = evalAt(p, released.state, [ONE, ONE], at + PULSE);
    expect(outOf(over)).toBe('0');
    expect(over.state.phase).toBe('empty');
  });

  it('the all-X of power-on is no trigger: TRIG settling HIGH gives LOW at once', () => {
    const start = evalAt(p, timer555.init!(p), [X, X], 0);
    expect(outOf(start)).toBe('X');
    expect(start.nextWake).toBeUndefined();
    const settled = timer555.evaluate({
      params: p,
      state: start.state,
      inputs: [ONE, ONE],
      prevInputs: [X, X],
      time: 1,
    });
    expect(outOf(settled)).toBe('0');
  });

  it('an unknown RESET on an idle monostable keeps it LOW and idle', () => {
    const r = evalAt(p, idle, [ONE, X], 0);
    expect(outOf(r)).toBe('0');
    expect(r.state).toEqual(idle);
  });
});

describe('timer555 bistable, evaluate', () => {
  const p = { mode: 'bistable' };
  const unknown = timer555.init!(p);

  it('follows the function table, TRIG over THRES and RESET over both', () => {
    const set = evalAt(p, unknown, [ZERO, ZERO, ONE], 0);
    expect(outOf(set)).toBe('1');
    expect(outOf(evalAt(p, set.state, [ONE, ZERO, ONE], 0))).toBe('1');
    const clear = evalAt(p, set.state, [ONE, ONE, ONE], 0);
    expect(outOf(clear)).toBe('0');
    expect(outOf(evalAt(p, clear.state, [ONE, ZERO, ONE], 0))).toBe('0');
    expect(outOf(evalAt(p, clear.state, [ZERO, ONE, ONE], 0))).toBe('1');
    expect(outOf(evalAt(p, set.state, [ZERO, ONE, ZERO], 0))).toBe('0');
  });

  it('powers up X and holds X until set or reset', () => {
    expect(outOf(evalAt(p, unknown, [ONE, ZERO, ONE], 0))).toBe('X');
  });

  it('holds LOW through an unknown RESET, which would clear it anyway', () => {
    const low = evalAt(p, unknown, [ONE, ONE, ONE], 0).state;
    const r = evalAt(p, low, [ONE, ZERO, X], 0);
    expect(outOf(r)).toBe('0');
    expect(outOf(evalAt(p, r.state, [ONE, ZERO, ONE], 0))).toBe('0');
    const high = evalAt(p, unknown, [ZERO, ZERO, ONE], 0).state;
    expect(outOf(evalAt(p, high, [ONE, ZERO, X], 0))).toBe('X');
  });

  it('gives X for an unknown input only when it could change the output', () => {
    const low = evalAt(p, unknown, [ONE, ONE, ONE], 0).state;
    const keptLow = evalAt(p, low, [ONE, X, ONE], 0);
    expect(outOf(keptLow)).toBe('0');
    expect(outOf(evalAt(p, keptLow.state, [ONE, ZERO, ONE], 0))).toBe('0');
    const high = evalAt(p, unknown, [ZERO, ZERO, ONE], 0).state;
    expect(outOf(evalAt(p, high, [X, ZERO, ONE], 0))).toBe('1');
    expect(outOf(evalAt(p, high, [ONE, X, ONE], 0))).toBe('X');
    expect(outOf(evalAt(p, low, [X, ZERO, ONE], 0))).toBe('X');
  });
});

const NS = 1000;

/** RESET (and TRIG) from switches, OUT on a probe. */
function timerBoard(params: Params): Board {
  const mono = params['mode'] === 'monostable';
  return board({
    components: [
      comp('r', 'toggle', { initial: 1 }, 'RST'),
      ...(mono ? [comp('t', 'toggle', { initial: 1 }, 'TRG')] : []),
      comp('u', 'timer555', params, 'U1'),
      comp('p', 'probe', undefined, 'OUT'),
    ],
    wires: [
      wire('w1', ['r', 'y'], ['u', 'reset']),
      ...(mono ? [wire('w2', ['t', 'y'], ['u', 'trig'])] : []),
      wire('w3', ['u', 'out'], ['p', 'a']),
    ],
  });
}

function edges(sim: Simulator, from = 0): string[] {
  const net = sim.circuit.pathToNet.get('main/OUT')!;
  return sim
    .traceRecords()
    .filter((r) => r.net === net && r.time >= from)
    .map((r) => `${r.time}:${toString(r.value, 1)}`);
}

describe.each<[string, DelayModel]>([
  ['ideal', idealDelay],
  ['datasheet', datasheetDelay('max')],
])('timer555 on a board, %s timing', (_name, delay) => {
  it('an astable lands each edge on its interval, one unit step late', () => {
    const sim = new Simulator(compile(timerBoard(SMALL), new Map()), delay);
    sim.powerOn();
    const t0 = sim.time;
    sim.start();
    sim.runUntil(t0 + FIRST + LOW + HIGH + 10 * NS);
    const rise = edges(sim).find((e) => e.endsWith(':1'))!;
    const at = Number(rise.split(':')[0]);
    expect(edges(sim, at)).toEqual([
      `${at}:1`,
      `${at + FIRST}:0`,
      `${at + FIRST + LOW}:1`,
      `${at + FIRST + LOW + HIGH}:0`,
    ]);
  });

  it('a paused monostable pulse holds until Step, then nothing is left to step', () => {
    const sim = new Simulator(
      compile(timerBoard({ ...SMALL, mode: 'monostable' }), new Map()),
      delay,
    );
    sim.powerOn();
    expect(sim.canStep).toBe(false);
    const t0 = sim.time;
    sim.setToggle('main/TRG', false);
    sim.settle();
    expect(sim.time).toBeLessThan(t0 + PULSE);
    expect(toString(sim.netValueByPath('main/OUT'), 1)).toBe('1');
    expect(sim.canStep).toBe(true);
    sim.setToggle('main/TRG', true);
    sim.settle();
    while (sim.pendingEvents > 0 || toString(sim.netValueByPath('main/OUT'), 1) === '1')
      if (!sim.stepToNextEvent()) break;
    const pulse = edges(sim, t0 + 1);
    expect(pulse).toHaveLength(2);
    const [rise, fall] = pulse.map((e) => Number(e.split(':')[0]));
    expect(fall! - rise!).toBe(PULSE);
    expect(sim.canStep).toBe(false);
  });
});

describe('timer555 paused', () => {
  it('a paused Step leaves no other source armed for the next flip to jump to', () => {
    const b = timerBoard(SMALL);
    b.components.push(comp('k', 'clock', { periodPs: 200 * NS }, 'CLK'));
    const sim = new Simulator(compile(b, new Map()), idealDelay);
    sim.powerOn();
    sim.stepToNextEvent();
    const stepped = sim.time;
    expect(stepped).toBeLessThan(FIRST);
    sim.setToggle('main/RST', true);
    sim.settle();
    expect(sim.time - stepped).toBeLessThan(10);
    expect(sim.canStep).toBe(true);
  });

  it('a switch flip while paused settles in place instead of playing on to the next edge', () => {
    const sim = new Simulator(compile(timerBoard(SMALL), new Map()), idealDelay);
    sim.powerOn();
    sim.start();
    sim.runUntil(sim.time + FIRST + LOW / 2);
    sim.stop();
    const paused = sim.time;
    sim.setToggle('main/RST', true);
    sim.settle();
    expect(sim.time - paused).toBeLessThan(10);
    expect(sim.canStep).toBe(true);
    sim.stepToNextEvent();
    expect(sim.time).toBeGreaterThan(paused);
  });
});

describe('timer555 restart', () => {
  it('a RESET pulse restarts the astable with the long first HIGH', () => {
    const sim = new Simulator(compile(timerBoard(SMALL), new Map()), idealDelay);
    sim.powerOn();
    sim.start();
    sim.runUntil(sim.time + FIRST + LOW / 2);
    sim.setToggle('main/RST', false);
    sim.runUntil(sim.time + 10);
    const t = sim.time;
    sim.setToggle('main/RST', true);
    sim.runUntil(t + FIRST + 10);
    const after = edges(sim, t).map((e) => Number(e.split(':')[0]));
    expect(after[1]! - after[0]!).toBe(FIRST);
  });
});

describe('timer555 inside a chip', () => {
  it('runs from the flattened circuit like any other primitive', () => {
    const def = chipDef({
      id: 'osc',
      name: 'osc',
      pins: [pin('rst', 'in', 'inR', 0), pin('y', 'out', 'outY', 0)],
      components: [comp('inR', 'inport'), comp('u', 'timer555', SMALL), comp('outY', 'outport')],
      wires: [wire('w1', ['inR', 'y'], ['u', 'reset']), wire('w2', ['u', 'out'], ['outY', 'a'])],
    });
    const b = board({
      components: [
        comp('r', 'toggle', { initial: 1 }),
        chipComp('x', 'osc', 'X'),
        comp('p', 'probe', undefined, 'OUT'),
      ],
      wires: [wire('w1', ['r', 'y'], ['x', 'rst']), wire('w2', ['x', 'y'], ['p', 'a'])],
    });
    const sim = new Simulator(compile(b, new Map([['osc', def]])), idealDelay);
    sim.powerOn();
    sim.start();
    sim.runUntil(sim.time + FIRST + LOW + 10);
    expect(edges(sim).map((e) => e.split(':')[1])).toEqual(['X', '1', '0', '1']);
  });
});
