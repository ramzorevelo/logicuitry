import { describe, expect, it } from 'vitest';
import { compile } from '../../model/compile';
import { board, comp, wire } from '../../model/testFixtures';
import type { Board } from '../../model/types';
import { toString } from '../../value/busValue';
import { datasheetDelay, idealDelay } from '../delay';
import { Simulator } from '../kernel';
import { BOUNCE_EDGES_PS, contactAt, SETTLED } from './bounce';
import { pushButton } from './stimulus';

const US = 1_000_000;

describe('contactAt', () => {
  it('a clean make is closed at once and needs no wake', () => {
    expect(contactAt(500, 500, false)).toEqual({ closed: true });
  });

  it('a bouncing make follows the pattern and holds after its last edge', () => {
    const at = (us: number) => contactAt(0, us * US, true);
    expect(at(0)).toEqual({ closed: true, nextWake: 14 * US });
    expect(at(14)).toEqual({ closed: false, nextWake: 64 * US });
    expect(at(63)).toEqual({ closed: false, nextWake: 64 * US });
    expect(at(498)).toEqual({ closed: false, nextWake: 499 * US });
    expect(at(499)).toEqual({ closed: true });
  });

  it('a settled make is closed with nothing left to wake for', () => {
    expect(contactAt(SETTLED, 0, true)).toEqual({ closed: true });
  });

  it('has an odd edge count, so every bounce ends closed', () => {
    expect(BOUNCE_EDGES_PS.length % 2).toBe(1);
  });
});

/** The rising and falling edges of a net after `from`, in us from `from`. */
function edgesUs(sim: Simulator, path: string, from: number): string[] {
  const net = sim.circuit.pathToNet.get(path)!;
  return sim
    .traceRecords()
    .filter((r) => r.net === net && r.time > from)
    .map((r) => `${(r.time - from) / US}:${toString(r.value, 1)}`);
}

function buttonBoard(bounce: boolean): Board {
  return board({
    components: [
      comp('b1', 'button', bounce ? { bounce: true } : undefined, 'BTN'),
      comp('p1', 'probe', undefined, 'Y'),
    ],
    wires: [wire('w1', ['b1', 'y'], ['p1', 'a'])],
  });
}

function press(sim: Simulator, on: boolean): void {
  sim.setPrimitiveState('main/BTN', { on });
  sim.settle();
}

describe('push button bounce', () => {
  it('without bounce a press is one clean edge', () => {
    const sim = new Simulator(compile(buttonBoard(false), new Map()), idealDelay);
    sim.powerOn();
    const t0 = sim.time;
    press(sim, true);
    expect(edgesUs(sim, 'main/Y', t0)).toHaveLength(1);
    expect(sim.canStep).toBe(false);
  });

  it('a paused press plays the whole bounce on settle, then nothing is left to step', () => {
    const sim = new Simulator(compile(buttonBoard(true), new Map()), idealDelay);
    sim.powerOn();
    const t0 = sim.time;
    press(sim, true);
    const delay = 1e-6; // the button's own 1 ps output delay, in us
    const expected = BOUNCE_EDGES_PS.map((ps, i) => `${ps / US + delay}:${i % 2 ? 0 : 1}`);
    expect(edgesUs(sim, 'main/Y', t0)).toEqual(expected);
    expect(sim.canStep).toBe(false);
  });

  it('a release mid-bounce is clean and leaves no stale bounce behind', () => {
    const sim = new Simulator(compile(buttonBoard(true), new Map()), idealDelay);
    sim.powerOn();
    sim.setPrimitiveState('main/BTN', { on: true });
    sim.runUntil(sim.time + 100 * US);
    const releasedAt = sim.time;
    sim.setPrimitiveState('main/BTN', { on: false });
    sim.settle();
    const released = sim.time;
    expect(released - releasedAt, 'the old bounce wakes are dropped').toBeLessThan(10);
    expect(sim.canStep).toBe(false);
    expect(toString(sim.netValueByPath('main/Y'), 1)).toBe('0');
    sim.runUntil(sim.time + 1000 * US);
    expect(edgesUs(sim, 'main/Y', released + 1)).toEqual([]);
  });

  it('a release mid-bounce while running leaves nothing to step once paused', () => {
    const sim = new Simulator(compile(buttonBoard(true), new Map()), idealDelay);
    sim.powerOn();
    sim.start();
    sim.setPrimitiveState('main/BTN', { on: true });
    sim.runUntil(sim.time + 5 * US);
    sim.setPrimitiveState('main/BTN', { on: false });
    sim.runUntil(sim.time + 1000);
    sim.stop();
    expect(sim.canStep).toBe(false);
    expect(sim.pendingEvents).toBe(0);
  });

  it('a press while running bounces on the free-run as well', () => {
    const sim = new Simulator(compile(buttonBoard(true), new Map()), idealDelay);
    sim.powerOn();
    sim.start();
    const t0 = sim.time;
    sim.setPrimitiveState('main/BTN', { on: true });
    sim.runUntil(t0 + 1000 * US);
    expect(edgesUs(sim, 'main/Y', t0)).toHaveLength(BOUNCE_EDGES_PS.length);
  });
});

describe('push button contact to GND', () => {
  function groundedBoard(params: Record<string, boolean>, pullUp: boolean): Board {
    return board({
      components: [
        comp('b1', 'button', { toGround: true, ...params }, 'BTN'),
        comp('p1', 'probe', undefined, 'Y'),
        ...(pullUp ? [comp('u1', 'pullup')] : []),
      ],
      wires: [
        wire('w1', ['b1', 'y'], ['p1', 'a']),
        ...(pullUp ? [wire('w2', ['u1', 'p'], ['p1', 'a'])] : []),
      ],
    });
  }
  const level = (sim: Simulator) => toString(sim.netValueByPath('main/Y'), 1);

  it('floats when released and pulls LOW when pressed', () => {
    const sim = new Simulator(compile(groundedBoard({}, false), new Map()), idealDelay);
    sim.powerOn();
    expect(level(sim)).toBe('Z');
    press(sim, true);
    expect(level(sim)).toBe('0');
    press(sim, false);
    expect(level(sim)).toBe('Z');
  });

  it('reads HIGH through a pull-up and bounces between LOW and the pull-up', () => {
    const sim = new Simulator(
      compile(groundedBoard({ bounce: true }, true), new Map()),
      idealDelay,
    );
    sim.powerOn();
    expect(level(sim)).toBe('1');
    const t0 = sim.time;
    press(sim, true);
    const delay = 1e-6;
    const expected = BOUNCE_EDGES_PS.map((ps, i) => `${ps / US + delay}:${i % 2 ? 1 : 0}`);
    expect(edgesUs(sim, 'main/Y', t0)).toEqual(expected);
    expect(level(sim)).toBe('0');
  });

  it('marks the pin three-state only with the option on', () => {
    expect(pushButton.pins({ toGround: true })[0]!.threeState).toBe(true);
    expect(pushButton.pins({})[0]!.threeState).toBeUndefined();
  });
});

function spdtBoard(bounce: boolean): Board {
  return board({
    components: [
      comp('s1', 'spdt', { position: 'b', ...(bounce ? { bounce: true } : {}) }, 'SW'),
      comp('g1', 'gnd'),
      comp('ua', 'pullup'),
      comp('ub', 'pullup'),
      comp('pa', 'probe', undefined, 'A'),
      comp('pb', 'probe', undefined, 'B'),
    ],
    wires: [
      wire('w1', ['g1', 'p'], ['s1', 'c']),
      wire('w2', ['s1', 'a'], ['pa', 'a']),
      wire('w3', ['s1', 'b'], ['pb', 'a']),
      wire('w4', ['ua', 'p'], ['pa', 'a']),
      wire('w5', ['ub', 'p'], ['pb', 'a']),
    ],
  });
}

describe('SPDT switch', () => {
  const level = (sim: Simulator, path: string) => toString(sim.netValueByPath(path), 1);

  it('powers up on its starting throw with no bounce', () => {
    const sim = new Simulator(compile(spdtBoard(true), new Map()), idealDelay);
    sim.powerOn();
    expect([level(sim, 'main/A'), level(sim, 'main/B')]).toEqual(['1', '0']);
    expect(sim.canStep).toBe(false);
  });

  it('a flip opens the left throw at once and bounces the throw reached', () => {
    const sim = new Simulator(compile(spdtBoard(true), new Map()), datasheetDelay('typ'));
    sim.powerOn();
    const t0 = sim.time;
    sim.setPrimitiveState('main/SW', { position: 'a' });
    sim.settle();
    expect(edgesUs(sim, 'main/B', t0)).toHaveLength(1);
    expect(edgesUs(sim, 'main/A', t0)).toHaveLength(BOUNCE_EDGES_PS.length);
    expect([level(sim, 'main/A'), level(sim, 'main/B')]).toEqual(['0', '1']);
  });

  it('without bounce a flip moves each throw once', () => {
    const sim = new Simulator(compile(spdtBoard(false), new Map()), idealDelay);
    sim.powerOn();
    const t0 = sim.time;
    sim.setPrimitiveState('main/SW', { position: 'a' });
    sim.settle();
    expect(edgesUs(sim, 'main/A', t0)).toHaveLength(1);
    expect(edgesUs(sim, 'main/B', t0)).toHaveLength(1);
  });

  it('passes a floating common through as Z', () => {
    const floating = board({
      components: [comp('s1', 'spdt', undefined, 'SW'), comp('pa', 'probe', undefined, 'A')],
      wires: [wire('w1', ['s1', 'a'], ['pa', 'a'])],
    });
    const sim = new Simulator(compile(floating, new Map()), idealDelay);
    sim.powerOn();
    expect(level(sim, 'main/A')).toMatch(/[XZ]/);
  });
});

describe('runUntil on a spent budget', () => {
  it('stops at the last event processed instead of jumping past the rest', () => {
    const clocked = board({
      components: [comp('c1', 'clock', { periodPs: 10 }), comp('p1', 'probe', undefined, 'C')],
      wires: [wire('w1', ['c1', 'y'], ['p1', 'a'])],
    });
    const sim = new Simulator(compile(clocked, new Map()), idealDelay);
    sim.powerOn();
    sim.start();
    const target = 1_000_000_000;
    sim.runUntil(target, 100);
    expect(sim.time).toBeLessThan(target);
    expect(sim.isBehind(target)).toBe(true);
    const before = sim.time;
    sim.runUntil(target, 100);
    expect(sim.time).toBeGreaterThan(before);
  });
});
