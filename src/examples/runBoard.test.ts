import { describe, expect, it } from 'vitest';
import { migrate } from '../io/migrations';
import stopwatch from '../core/runner/fixtures/stopwatch.lcirb';
import { EXAMPLES } from './index';
import { builtinChipLibrary } from '../core/parts/packages';
import { datasheetDelay, idealDelay, type DelayModel } from '../core/sim/delay';
import type { Board, ChipDef, ChipLibrary } from '../core/model/types';
import { board, comp, wire } from '../core/model/testFixtures';
import { parseStimulus } from '../core/runner/stimulus';
import { BLANK, PS_PER_MS, RunError, runBoard, type RunResult } from '../core/runner/runBoard';

const TIMINGS: [string, DelayModel][] = [
  ['ideal', idealDelay],
  ['datasheet typ', datasheetDelay('typ')],
];

function exampleOf(id: string): { board: Board; lib: ChipLibrary } {
  const e = EXAMPLES.find((x) => x.id === id)!;
  const lib = new Map<string, ChipDef>([
    ...builtinChipLibrary(),
    ...(e.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
  ]);
  return { board: e.board, lib };
}

function run(id: string, stimulus: unknown, delay: DelayModel = idealDelay): RunResult {
  const { board: b, lib } = exampleOf(id);
  return runBoard(b, lib, parseStimulus(stimulus), delay);
}

const column = (result: RunResult, name: string) => result.rows.map((r) => r.values[name]);

describe.each(TIMINGS)('runBoard on the three-bit counter, %s', (_, delay) => {
  const id = 'three-bit-counter-on-two-74ls74s';
  const count = (r: RunResult) =>
    r.rows.map((row) => parseInt(`${row.values['Q2']}${row.values['Q1']}${row.values['Q0']}`, 2));

  it('counts one per clock edge once /CLR is released, wrapping at 8', () => {
    const r = run(id, { steps: [{ set: { '/CLR': 1 }, ticks: 10 }] }, delay);
    expect(r.ok).toBe(true);
    expect(count(r)).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1, 2]);
    expect(r.rows.map((row) => row.tick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reads flip-flop pins by name and by DIP pin number', () => {
    const r = run(
      id,
      { watch: ['u1.1Q', 'u1.5', 'u1.6'], steps: [{ set: { '/CLR': 1 }, ticks: 2 }] },
      delay,
    );
    expect(column(r, 'u1.1Q')).toEqual(column(r, 'Q0'));
    expect(column(r, 'u1.5')).toEqual(column(r, 'Q0'));
    expect(column(r, 'u1.6')).toEqual(['0', '1']);
  });

  it('passes a held expect and fails a wrong one with exit-worthy detail', () => {
    const r = run(
      id,
      {
        steps: [
          { set: { '/CLR': 1 }, ticks: 3, expect: { Q2: 0, Q1: 1, Q0: 1 } },
          { ticks: 1, expect: { Q2: 0 } },
        ],
      },
      delay,
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ step: 1, tick: 4, name: 'Q2', expected: '0', actual: '1' }]);
  });
});

describe.each(TIMINGS)('runBoard on the counter module, %s', (_, delay) => {
  const count = (r: RunResult) =>
    r.rows.map((row) => parseInt(['C3', 'C2', 'C1', 'C0'].map((n) => row.values[n]).join(''), 2));

  it('clears, counts up and down, holds, loads 1001 and resets from the switches', () => {
    const r = run(
      'logic-project-module',
      {
        watch: ['C3', 'C2', 'C1', 'C0'],
        steps: [
          { set: { CLEAR: 1 }, ticks: 1 },
          { set: { CLEAR: 0, UP: 1 }, ticks: 3 },
          { set: { UP: 0 }, ticks: 2 },
          { set: { DN: 1 }, ticks: 5 },
          { set: { UP: 1 }, ticks: 1 },
          { set: { UP: 0, DN: 0, LOAD: 1 }, ticks: 1, expect: { DISPLAY: '9' } },
          { set: { LOAD: 0, UP: 1 }, ticks: 7 },
          { set: { CLEAR: 1 }, ticks: 1, expect: { DISPLAY: '0' } },
          { set: { CLEAR: 0 }, ticks: 2 },
          { press: 'RESET', wait: { ms: 50 } },
          { release: 'RESET', wait: { ms: 50 } },
        ],
      },
      delay,
    );
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(count(r)).toEqual([
      0, 1, 2, 3, 3, 3, 2, 1, 0, 15, 14, 14, 9, 10, 11, 12, 13, 14, 15, 0, 0, 1, 2, 0, 0,
    ]);
  });
});

describe('runBoard active-low LED', () => {
  // Two LEDs on one toggle: the plain one shows the net, the active-low one lights on its 0.
  const lamps = () =>
    board({
      components: [
        comp('c', 'clock', { periodPs: 1000 }, 'CLK'),
        comp('s', 'toggle', undefined, 'S'),
        comp('h', 'led', undefined, 'HIGH'),
        comp('l', 'led', { activeLow: true }, 'LOW'),
        comp('f', 'led', { activeLow: true }, 'FLOAT'),
      ],
      wires: [wire('w1', ['s', 'y'], ['h', 'a']), wire('w2', ['s', 'y'], ['l', 'a'])],
    });

  it('reads lit, not the net, and leaves a floating pin as Z', () => {
    const r = runBoard(
      lamps(),
      builtinChipLibrary(),
      parseStimulus({
        steps: [
          { set: { S: 0 }, ticks: 1 },
          { set: { S: 1 }, ticks: 1 },
        ],
      }),
      idealDelay,
    );
    expect(column(r, 'HIGH')).toEqual(['0', '1']);
    expect(column(r, 'LOW')).toEqual(['1', '0']);
    expect(column(r, 'FLOAT')).toEqual(['Z', 'Z']);
  });

  it('keeps the lit reading when a watch or an expect names the LED', () => {
    const r = runBoard(
      lamps(),
      builtinChipLibrary(),
      parseStimulus({
        watch: ['LOW'],
        steps: [
          { set: { S: 0 }, ticks: 1, expect: { LOW: 1 } },
          { set: { S: 1 }, ticks: 1, expect: { LOW: 0 } },
        ],
      }),
      idealDelay,
    );
    expect(column(r, 'LOW')).toEqual(['1', '0']);
    expect(r.failures).toEqual([]);
  });
});

describe('runBoard X check', () => {
  // A gate with its input unwired reads X: the stand-in for a flip-flop not yet reset.
  const floating = () =>
    board({
      components: [
        comp('c', 'clock', { periodPs: 1000 }, 'CLK'),
        comp('n', 'not'),
        comp('l', 'led', undefined, 'Y'),
        comp('k', 'led', undefined, 'K'),
      ],
      wires: [wire('w1', ['n', 'y'], ['l', 'a']), wire('w2', ['c', 'y'], ['k', 'a'])],
    });
  const go = (steps: unknown[]) =>
    runBoard(floating(), builtinChipLibrary(), parseStimulus({ steps }), idealDelay);

  it('allows X before the first expect', () => {
    const r = go([{ ticks: 3 }]);
    expect(r.ok).toBe(true);
    expect(column(r, 'Y')).toEqual(['X', 'X', 'X']);
  });

  it('fails every X reading from the first expect on, that step included', () => {
    const r = go([{ ticks: 1 }, { ticks: 2, expect: { K: 0 } }]);
    expect(r.failures).toEqual([
      { step: 1, tick: 2, name: 'Y', actual: 'X' },
      { step: 1, tick: 3, name: 'Y', actual: 'X' },
    ]);
  });
});

describe.each(TIMINGS)('runBoard on the 555 clock module, %s', (_, delay) => {
  const id = 'clock-module';

  it('counts the astable edges, each tick one full period', () => {
    const r = run(id, { steps: [{ ticks: 3 }] }, delay);
    expect(r.ok).toBe(true);
    const periods = r.rows.slice(1).map((row, i) => row.timeMs - r.rows[i]!.timeMs);
    // 0.693 (RA + 2 RB) C with RA = 1 k, RB = 1 M, C = 1 uF.
    for (const p of periods) expect(p).toBeCloseTo(1386.7, 0);
  });

  it('reads gates fed by the clock after they settle, not at the edge', () => {
    const r = run(id, { watch: ['CLK', '/CLK'], steps: [{ ticks: 2 }] }, delay);
    expect(column(r, 'CLK')).toEqual(['0', '0']);
    expect(column(r, '/CLK')).toEqual(['1', '1']);
  });

  it('times one bouncing STEP press on MODE A as one 110 ms pulse', () => {
    const r = run(
      id,
      {
        clock: 'CLK',
        steps: [
          { set: { MODE: 'a' }, wait: { ms: 20 } },
          { press: 'STEP', wait: { ms: 5 } },
          { release: 'STEP', ticks: 1, expect: { CLK: 0 } },
        ],
      },
      delay,
    );
    expect(r.ok).toBe(true);
    const [, pressed, fell] = r.rows;
    expect(fell!.timeMs - (pressed!.timeMs - 5)).toBeCloseTo(110, 0);
  });

  it('stops with an error, keeping its rows, when the clock never falls', () => {
    const r = run(id, {
      clock: 'CLK',
      steps: [{ ticks: 1 }, { set: { MODE: 'a' }, press: 'STEP', ticks: 1 }],
    });
    expect(r.ok).toBe(false);
    expect(r.rows).toHaveLength(1);
    expect(r.error).toMatch(/^step 1: the clock made no falling edge .*stuck at 1/);
  });
});

describe.each(['74ls47', '74ls48'])('runBoard on the %s display', (part) => {
  const id = `seven-segment-display-on-a-${part}`;

  it('reads all sixteen codes back as the digit shown', () => {
    const steps = Array.from({ length: 16 }, (_, n) => ({
      set: { D: (n >> 3) & 1, C: (n >> 2) & 1, B: (n >> 1) & 1, A: n & 1 },
      wait: { ms: 0.001 },
    }));
    steps[9] = { ...steps[9]!, expect: { ds: 9 } } as (typeof steps)[number];
    const r = run(id, { steps });
    expect(r.ok).toBe(true);
    expect(column(r, 'ds')).toEqual([
      ...'0123456789'.split(''),
      ...Array<string>(5).fill('?'),
      BLANK,
    ]);
  });

  it('refuses ticks on a board with no clock', () => {
    const r = run(id, { steps: [{ ticks: 1 }] });
    expect(r.error).toMatch(/no clock or astable 555/);
  });
});

describe('runBoard setup errors', () => {
  const id = 'three-bit-counter-on-two-74ls74s';

  it.each([
    [{ watch: ['NOPE'], steps: [] }, 'watch: no net, pin or part named "NOPE"'],
    [{ clock: 'NOPE', steps: [] }, 'no clock source or net named "NOPE"'],
  ])('throws on %j', (stimulus, message) => {
    expect(() => run(id, stimulus)).toThrow(RunError);
    expect(() => run(id, stimulus)).toThrow(message);
  });

  it.each([
    [{ steps: [{ press: 'NOPE', ticks: 1 }] }, 'no button or switch named "NOPE"'],
    [{ steps: [{ press: '/CLR', ticks: 1 }] }, 'is not a push button'],
    [{ steps: [{ set: { '/CLR': 2 }, ticks: 1 }] }, 'is 1 bit(s): 2 is too big'],
    [{ steps: [{ set: { '/CLR': 'a' }, ticks: 1 }] }, 'takes a number'],
    [{ steps: [{ ticks: 1 }, { ticks: 1, expect: { NOPE: 1 } }] }, 'expect: no output'],
  ])('stops the run on %j', (stimulus, message) => {
    const r = run(id, stimulus);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });
});

describe('runBoard review cases', () => {
  const counter = 'three-bit-counter-on-two-74ls74s';
  const lib = builtinChipLibrary();
  const go = (b: Board, stimulus: unknown) => runBoard(b, lib, parseStimulus(stimulus), idealDelay);

  it('settles and reads an expect-only step, so an earlier action has landed', () => {
    const r = run(counter, {
      steps: [{ set: { '/CLR': 1 }, ticks: 1 }, { set: { '/CLR': 0 } }, { expect: { Q0: 0 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.rows.at(-1)!.values['Q0']).toBe('0');
  });

  it('reads a set plus expect step once the logic settles, the clock not moved', () => {
    const r = run(counter, {
      steps: [
        { set: { '/CLR': 1 }, ticks: 2 },
        { set: { '/CLR': 0 }, expect: { Q1: 0, Q0: 0 } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.tick)).toEqual([1, 2, 2]);
    expect(r.rows.at(-1)!.values['Q1']).toBe('0');
  });

  it('lands an untimed write before the next step overwrites it', () => {
    const r = run(counter, {
      steps: [
        { set: { '/CLR': 1 }, ticks: 2 },
        { set: { '/CLR': 0 } },
        { set: { '/CLR': 1 }, expect: { Q1: 0, Q0: 0 } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.rows.map((row) => row.tick)).toEqual([1, 2, 2]);
  });

  it('counts the edges a wait crosses, and a tick from a high clock finishes that pulse', () => {
    const r = run(counter, {
      steps: [
        { set: { '/CLR': 1 }, ticks: 1 },
        { wait: { ms: 0.0009 } },
        { ticks: 1 },
        { wait: { ms: 0.0003 } },
        { ticks: 1 },
      ],
    });
    const counts = r.rows.map((row) =>
      parseInt(`${row.values['Q2']}${row.values['Q1']}${row.values['Q0']}`, 2),
    );
    expect(r.rows.map((row) => row.tick)).toEqual(counts);
  });

  it('finds a DIP pin by number inside its own group when another group reuses the label', () => {
    const chip = (id: string, group: string) => ({
      ...comp(id, 'chip', undefined, 'U3'),
      defId: '74LS74',
      group,
    });
    const b = board({
      groups: [
        { id: 'g1', name: 'G1' },
        { id: 'g2', name: 'G2' },
      ],
      components: [chip('a', 'g1'), chip('b', 'g2')],
    });
    const r = go(b, { watch: ['G1/U3.5', 'G2/U3.9'], steps: [{ wait: { ms: 0.001 } }] });
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.rows[0]!.values)).toEqual(['G1/U3.5', 'G2/U3.9']);
  });

  it('wants a named clock when a board has two, and takes one by part name', () => {
    const b = board({
      components: [
        comp('c1', 'clock', { periodPs: 1000 }, 'FAST'),
        comp('c2', 'clock', { periodPs: 4000 }, 'SLOW'),
        comp('l', 'led', undefined, 'L'),
      ],
      wires: [wire('w', ['c2', 'y'], ['l', 'a'])],
    });
    expect(() => go(b, { steps: [] })).toThrow('2 clock sources');
    const r = go(b, { clock: 'SLOW', steps: [{ ticks: 2 }] });
    const [t1, t2] = r.rows.map((row) => Math.round(row.timeMs * PS_PER_MS));
    expect(t2! - t1!).toBe(4000);
  });

  it('prints a multi-bit LED MSB first', () => {
    const b = board({
      components: [comp('t', 'toggle', { width: 4 }, 'N'), comp('l', 'led', { width: 4 }, 'L')],
      wires: [wire('w', ['t', 'y'], ['l', 'a'])],
    });
    const r = go(b, { steps: [{ set: { N: 5 }, wait: { ms: 0.001 }, expect: { L: 5 } }] });
    expect(r.ok).toBe(true);
    expect(r.rows[0]!.values['L']).toBe('0101');
  });
});

// A project-size board (27 DIPs, two '47 displays, a 555): the scale fixture for the final project.
describe.each(TIMINGS)('runBoard on the project-size stopwatch fixture, %s', (_, delay) => {
  it('resets, starts and carries into the tens digit', () => {
    const doc = migrate(structuredClone(stopwatch) as Record<string, unknown>) as unknown as Board;
    const r = runBoard(
      doc,
      builtinChipLibrary(),
      parseStimulus({
        steps: [
          { press: 'RESET', ticks: 3 },
          { release: 'RESET', ticks: 1, expect: { TENS: 0, ONES: 0, STOPPED: 1 } },
          { press: 'START', ticks: 2 },
          { release: 'START', ticks: 1, expect: { ONES: 1, RUNNING: 1 } },
          { ticks: 9, expect: { TENS: 1, ONES: 0 } },
        ],
      }),
      delay,
    );
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
