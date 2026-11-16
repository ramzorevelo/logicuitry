import { beforeEach, describe, expect, it } from 'vitest';
import { compile } from '../../core/model/compile';
import { board, comp, srLatchDef, wire } from '../../core/model/testFixtures';
import type { Board } from '../../core/model/types';
import { idealDelay } from '../../core/sim/delay';
import { Simulator } from '../../core/sim/kernel';
import { formatTimePs } from '../../render/waveform';
import { useCircuitStore } from './circuitStore';
import { gateOverlay, gateStatusText, nextGateRun, pressGateStep, SETTLED_TEXT } from './gateStep';

const st = () => useCircuitStore.getState();

/** CLK -> n1 -> n2 -> LED; a paused clocked board, so a press has an edge to go to. */
function clockedChain(): Board {
  return board({
    components: [
      comp('ck', 'clock', { periodPs: 1000, dutyPercent: 50 }, 'CLK'),
      comp('n1', 'not'),
      comp('n2', 'not'),
      comp('led', 'led', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['ck', 'y'], ['n1', 'a']),
      wire('w2', ['n1', 'y'], ['n2', 'a']),
      wire('w3', ['n2', 'y'], ['led', 'a']),
    ],
  });
}

/** A -> NOT -> zero-delay buffer -> probe: the buffer is wiring, like a package's output stage. */
function hopChain(): Board {
  return board({
    components: [
      comp('t', 'toggle', undefined, 'A'),
      comp('n', 'not'),
      comp('h', 'buf', { delay: 'none' }),
      comp('p', 'probe', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['t', 'y'], ['n', 'a']),
      wire('w2', ['n', 'y'], ['h', 'a']),
      wire('w3', ['h', 'y'], ['p', 'a']),
    ],
  });
}

const outNet = (compiled: ReturnType<typeof compile>, path: string) =>
  compiled.primitives[compiled.pathToPrimitive.get(path)!]!.outputs[0]!;

describe('pressGateStep', () => {
  it('folds a wiring hop into the press that lands the gate output, in ideal timing', () => {
    const compiled = compile(hopChain(), new Map());
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    sim.setToggle('main/A', true);
    const presses = [];
    for (let i = 0; i < 10; i++) {
      const r = pressGateStep(sim, compiled, true);
      if (!r) break;
      presses.push(r.changedNets);
    }
    expect(presses).toEqual([
      [outNet(compiled, 'main/A')],
      [outNet(compiled, 'main/n'), outNet(compiled, 'main/h')].sort((a, b) => a - b),
    ]);
  });

  it('leaves the hop its own press when not asked to fold it', () => {
    const compiled = compile(hopChain(), new Map());
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    sim.setToggle('main/A', true);
    let presses = 0;
    while (pressGateStep(sim, compiled, false) && presses < 10) presses++;
    expect(presses).toBe(3);
  });

  it('is null when nothing can move', () => {
    const compiled = compile(hopChain(), new Map());
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    expect(pressGateStep(sim, compiled, true)).toBeNull();
  });
});

describe('nextGateRun', () => {
  const compiled = compile(hopChain(), new Map());
  const report = (nets: number[], time: number) => ({
    time,
    changedNets: nets,
    evaluated: [],
    pendingPrimitives: [],
    settled: false,
  });

  it('starts at 0 on an edge only sources made, and counts on from there', () => {
    const edge = nextGateRun(null, report([outNet(compiled, 'main/A')], 5), compiled, 4, false);
    expect(edge).toMatchObject({ count: 0, originPs: 5 });
    const next = nextGateRun(edge, report([outNet(compiled, 'main/n')], 6), compiled, 5, false);
    expect(next).toMatchObject({ count: 1, originPs: 5, timePs: 6 });
  });

  it('counts from the press itself when the run has no edge', () => {
    const run = nextGateRun(null, report([outNet(compiled, 'main/n')], 9), compiled, 8, false);
    expect(run).toMatchObject({ count: 1, originPs: 8 });
  });

  it('starts at 0 on a press from a settled sim, whatever drove the edge', () => {
    const prev = { count: 4, originPs: 0, timePs: 7, changedNets: [], pendingPrimitives: [] };
    const run = nextGateRun(prev, report([outNet(compiled, 'main/n')], 50), compiled, 7, true);
    expect(run).toMatchObject({ count: 0, originPs: 50 });
  });
});

describe('gateStatusText', () => {
  const run = {
    count: 2,
    originPs: 1_000,
    timePs: 19_000,
    changedNets: [3, 4],
    pendingPrimitives: [],
  };
  const base = { run, ideal: true, boardNets: 2, settled: false, canStep: true };

  it('reads gate delays in ideal timing', () => {
    expect(gateStatusText(base)).toBe('t = 2 gate delays, 2 nets changed');
    expect(gateStatusText({ ...base, run: { ...run, count: 1 }, boardNets: 1 })).toBe(
      't = 1 gate delay, 1 net changed',
    );
  });

  it('reads the sim time since the edge in datasheet timing', () => {
    expect(gateStatusText({ ...base, ideal: false })).toBe(
      't = +18 ns, 2 gate steps, 2 nets changed',
    );
    const edge = { ...run, count: 0, timePs: run.originPs };
    expect(gateStatusText({ ...base, ideal: false, run: edge, boardNets: 1 })).toBe(
      't = 0, 1 net changed',
    );
  });

  it('says when only nets inside parts changed', () => {
    expect(gateStatusText({ ...base, boardNets: 0 })).toBe(
      't = 2 gate delays, changes inside parts only',
    );
  });

  it('says settled when nothing can move, with the run when there was one', () => {
    const settled = { ...base, settled: true, canStep: false };
    expect(gateStatusText(settled)).toBe(`${SETTLED_TEXT} (t = 2 gate delays)`);
    expect(gateStatusText({ ...settled, run: null })).toBe(SETTLED_TEXT);
  });

  it('says a settled clocked board waits for a clock edge', () => {
    const clocked = { ...base, settled: true };
    expect(gateStatusText(clocked)).toBe('Settled (t = 2 gate delays), next: clock edge');
    expect(gateStatusText({ ...clocked, run: null })).toBe('settled, paused');
  });

  it('says something is pending when no run is being followed', () => {
    expect(gateStatusText({ ...base, run: null })).toBe('Paused: gate steps pending');
  });
});

describe('gateOverlay', () => {
  it('rings every wire on a changed net and outlines the pending parts', () => {
    const b = clockedChain();
    const compiled = compile(b, new Map());
    const net = outNet(compiled, 'main/n1');
    const run = {
      count: 1,
      originPs: 0,
      timePs: 0,
      changedNets: [net],
      pendingPrimitives: [compiled.pathToPrimitive.get('main/n2')!],
    };
    const overlay = gateOverlay(b, compiled, 'main/', run);
    expect([...overlay.wires]).toEqual(['w2']);
    expect([...overlay.parts]).toEqual(['n2']);
    expect(overlay.boardNets).toBe(1);
  });
});

describe('gateOverlay on a chip instance', () => {
  it('outlines the instance for a pending primitive inside it', () => {
    const def = srLatchDef();
    const b = board({
      components: [
        comp('t1', 'toggle', undefined, 'SN'),
        { ...comp('u1', 'chip', undefined, 'U1'), defId: def.id },
      ],
      wires: [wire('w1', ['t1', 'y'], ['u1', 'sn'])],
    });
    const compiled = compile(b, new Map([[def.id, def]]));
    const inner = compiled.primitives.findIndex((p) => p.path.startsWith('main/U1:'));
    expect(inner).toBeGreaterThanOrEqual(0);
    const run = { count: 1, originPs: 0, timePs: 0, changedNets: [], pendingPrimitives: [inner] };
    expect([...gateOverlay(b, compiled, 'main/', run).parts]).toEqual(['u1']);
  });
});

describe('store: gate step and settle', () => {
  beforeEach(() => {
    useCircuitStore.setState({ selection: new Set(), powered: false, running: false });
    st().setTiming({ mode: 'ideal' });
  });

  it('says settled with nothing to step on a combinational board, and Gate step does nothing', () => {
    st().loadBoard(hopChain());
    st().power();
    expect(st().canStep()).toBe(false);
    expect(st().canSettle()).toBe(false);
    expect(st().gateStatus()).toBe(SETTLED_TEXT);
    const before = st().simTimePs();
    st().gateStep();
    expect(st().simTimePs()).toBe(before);
  });

  it('goes to the clock edge, then one gate delay per press, ringing and outlining', () => {
    st().loadBoard(clockedChain());
    st().power();
    expect(st().gateStatus()).toBe('settled, paused');
    st().gateStep();
    expect(st().gateStatus()).toBe('t = 0 gate delays, 1 net changed');
    expect([...st().gateOverlay()!.wires]).toEqual(['w1']);
    expect([...st().gateOverlay()!.parts]).toEqual(['n1']);
    st().gateStep();
    expect(st().gateStatus()).toBe('t = 1 gate delay, 1 net changed');
    expect([...st().gateOverlay()!.wires]).toEqual(['w2']);
    expect([...st().gateOverlay()!.parts]).toEqual(['n2']);
    st().gateStep();
    expect(st().gateStatus()).toBe('Settled (t = 2 gate delays), next: clock edge');
    expect(st().replayTimePs).toBe(st().simTimePs());
  });

  it('hides the rings while the waveform is scrubbed to another time', () => {
    st().loadBoard(clockedChain());
    st().power();
    st().gateStep();
    st().gateStep();
    expect(st().gateOverlay()).toBeDefined();
    useCircuitStore.setState({ replayTimePs: 0 });
    expect(st().gateOverlay()).toBeUndefined();
    useCircuitStore.setState({ replayTimePs: st().simTimePs() });
    expect(st().gateOverlay()).toBeDefined();
  });

  it('drops the readout once anything else moves the sim', () => {
    st().loadBoard(clockedChain());
    st().power();
    st().gateStep();
    st().toggleRun();
    expect(st().gateStatus()).toBeNull();
    expect(st().gateOverlay()).toBeUndefined();
    st().pump(300);
    st().toggleRun();
    expect(st().gateOverlay()).toBeUndefined();
  });

  it('refuses a gate step while running', () => {
    st().loadBoard(clockedChain());
    st().power();
    st().toggleRun();
    const before = st().simTimePs();
    st().gateStep();
    expect(st().simTimePs()).toBe(before);
    st().toggleRun();
  });

  it('settles a pending ripple and counts the gate delays it took', () => {
    st().loadBoard(clockedChain());
    st().power();
    st().gateStep();
    expect(st().canSettle()).toBe(true);
    st().settle();
    expect(st().canSettle()).toBe(false);
    expect(st().gateStatus()).toBe('Settled (t = 2 gate delays), next: clock edge');
    expect(st().pinSignal('led', 'a')).toBe(st().pinSignal('ck', 'y'));
  });

  it('steps through a ring oscillator and keeps the loop it was found in', () => {
    st().loadBoard(
      board({
        components: [
          comp('a', 'toggle', undefined, 'A'),
          comp('g', 'nand'),
          comp('n2', 'not'),
          comp('n3', 'not'),
        ],
        wires: [
          wire('w1', ['a', 'y'], ['g', 'a']),
          wire('w2', ['g', 'y'], ['n2', 'a']),
          wire('w3', ['n2', 'y'], ['n3', 'a']),
          wire('w4', ['n3', 'y'], ['g', 'b']),
        ],
      }),
    );
    st().power();
    st().toggleInput('a');
    expect(st().oscillation).not.toBeNull();
    st().gateStep();
    expect(st().oscillation).not.toBeNull();
    expect(st().gateStatus()).toMatch(/^t = \d+ gate delays?, 1 net changed$/);
    st().settle();
    expect(st().oscillation).not.toBeNull();
    expect(st().gateOverlay()).toBeUndefined();
  });

  it('reads real sim time in datasheet timing', () => {
    st().setTiming({ mode: 'datasheet' });
    st().loadBoard(clockedChain());
    st().setTiming({ mode: 'datasheet' });
    st().power();
    st().gateStep();
    const edge = st().simTimePs()!;
    st().gateStep();
    const elapsed = st().simTimePs()! - edge;
    expect(elapsed).toBeGreaterThan(1);
    expect(st().gateStatus()).toBe(`t = +${formatTimePs(elapsed)}, 1 gate step, 1 net changed`);
  });
});
