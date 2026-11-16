import type { Board, ChipLibrary } from '../model/types';
import { compile, type CompiledCircuit, type CompiledPrimitive } from '../model/compile';
import { resolveOutputNet } from '../boolean/truthTable';
import { Simulator } from '../sim/kernel';
import type { DelayModel } from '../sim/delay';
import { getPrimitive } from '../sim/primitives/registry';
import { segmentLit, sevenSegCommon } from '../sim/primitives/display';
import { ledLitValue } from '../sim/primitives/stimulus';
import { timerMode } from '../sim/primitives/timer555';
import { widthParam } from '../sim/primitives/types';
import * as bv from '../value/busValue';
import type { ExpectedValue, InputValue, Stimulus, StimulusStep } from './stimulus';

/** One reading of every output, taken at the end of a tick or a wait. */
export interface RunRow {
  /** Rising clock edges since the first low after power on, those inside waits included. */
  tick: number;
  timeMs: number;
  /** Index into the stimulus steps of the step that took this reading. */
  step: number;
  values: Record<string, string>;
  note?: string;
}

export interface RunFailure {
  step: number;
  tick: number;
  name: string;
  /** Absent on an X failure: nothing was expected, the output went unknown. */
  expected?: string;
  actual: string;
}

export interface RunResult {
  ok: boolean;
  /** Board-level LEDs and displays, then the stimulus watch list, in print order. */
  columns: string[];
  rows: RunRow[];
  failures: RunFailure[];
  /** Why the run stopped early; the rows up to that point stand. */
  error?: string;
}

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}

export const PS_PER_MS = 1_000_000_000;
/** A 555 at its slowest course setting is well under this per period. */
export const MAX_TICK_PS = 60_000 * PS_PER_MS;
/** Events one tick may take before it counts as an oscillation, not a busy board. */
export const TICK_EVENT_BUDGET = 2_000_000;

export const BLANK = 'blank';
const DIGIT_OF_SEGMENTS = new Map<string, string>([
  ['abcdef', '0'],
  ['bc', '1'],
  ['abdeg', '2'],
  ['abcdg', '3'],
  ['bcfg', '4'],
  ['acdfg', '5'],
  ['acdefg', '6'],
  // The '47 and '48 draw 6 without its top bar and 9 without its tail.
  ['cdefg', '6'],
  ['abc', '7'],
  ['abcf', '7'],
  ['abcdefg', '8'],
  ['abcdfg', '9'],
  ['abcfg', '9'],
]);

/** Lit segment letters, in `abcdefg` order, as the digit a reader sees. */
export function digitOf(litSegments: string): string {
  if (litSegments === '') return BLANK;
  return DIGIT_OF_SEGMENTS.get(litSegments) ?? '?';
}

const isBoardLevel = (p: CompiledPrimitive) => !p.path.includes(':');
const nameOf = (p: CompiledPrimitive) => p.path.slice(p.path.indexOf('/') + 1);
const isClockSource = (p: CompiledPrimitive) =>
  p.kind === 'clock' || (p.kind === 'timer555' && timerMode(p.params) === 'astable');

function netReading(sim: Simulator, net: number): string {
  return bv.toString(sim.netValue(net), sim.circuit.nets[net]!.width);
}

type Reader = () => string;

/** A seven-segment display's digit, or X while any segment or its common is unknown. */
function displayReader(sim: Simulator, prim: CompiledPrimitive): Reader {
  const pinNames = getPrimitive('sevenseg')
    .pins(prim.params)
    .map((p) => p.name);
  const netOf = (pin: string) => prim.inputs[pinNames.indexOf(pin)]!;
  const common = sevenSegCommon(prim.params);
  const segments = [...'abcdefg'];
  return () => {
    const level = (pin: string) => netReading(sim, netOf(pin));
    const com = level('com1');
    if (com === 'X' || segments.some((s) => level(s) === 'X')) return 'X';
    return digitOf(segments.filter((s) => segmentLit(level(s), common, com)).join(''));
  };
}

/** Lit or dark, not the net: an active-low LED's `1` is a driven 0 on its pin. */
function ledReader(sim: Simulator, prim: CompiledPrimitive): Reader {
  const lit = (net: number) => {
    const width = sim.circuit.nets[net]!.width;
    return bv.toString(ledLitValue(sim.netValue(net), width, prim.params), width);
  };
  // An expanded LED's lanes come MSB first, so joining them reads as one bus.
  return () => prim.inputs.map(lit).join('');
}

/** `U1.5` names a DIP pin by number; a package def names pin n `pin-<n>`. */
function pinNumberPath(board: Board, library: ChipLibrary, name: string): string | undefined {
  const m = /^(.*)\.(\d+)$/.exec(name);
  if (!m) return undefined;
  const [, instance, pin] = m as unknown as [string, string, string];
  // Labels are unique per group only, so the group name is part of the match.
  const groupPrefix = (group: string | undefined) =>
    group ? `${board.groups?.find((g) => g.id === group)?.name ?? group}/` : '';
  const chips = board.components.filter(
    (c) => c.kind === 'chip' && `${groupPrefix(c.group)}${c.label ?? c.id}` === instance,
  );
  if (chips.length !== 1) return undefined;
  const def = library.get(chips[0]!.defId ?? '');
  const pinDef = def?.pins.find((p) => p.id === `pin-${pin}`);
  return pinDef ? `main/${instance}.${pinDef.name}` : undefined;
}

function watchReader(
  sim: Simulator,
  board: Board,
  library: ChipLibrary,
  name: string,
): Reader | undefined {
  for (const path of [`main/${name}`, pinNumberPath(board, library, name)]) {
    if (path === undefined) continue;
    try {
      const net = resolveOutputNet(sim.circuit, path);
      return () => netReading(sim, net);
    } catch {
      // Not this spelling; try the next one.
    }
  }
  return undefined;
}

class BoardInputs {
  private readonly byName = new Map<string, number[]>();

  constructor(private readonly circuit: CompiledCircuit) {
    circuit.primitives.forEach((p, pi) => {
      if (!isBoardLevel(p) || !['button', 'toggle', 'spdt'].includes(p.kind)) return;
      const list = this.byName.get(nameOf(p)) ?? [];
      list.push(pi);
      this.byName.set(nameOf(p), list);
    });
  }

  find(name: string): { pi: number; prim: CompiledPrimitive } {
    const found = this.byName.get(name) ?? [];
    if (found.length === 0) throw new RunError(`no button or switch named "${name}"`);
    if (found.length > 1) throw new RunError(`"${name}" names ${found.length} inputs`);
    return { pi: found[0]!, prim: this.circuit.primitives[found[0]!]! };
  }

  stateFor(name: string, value: InputValue): { pi: number; state: unknown } {
    const { pi, prim } = this.find(name);
    if (prim.kind === 'spdt') {
      if (value !== 'a' && value !== 'b')
        throw new RunError(`"${name}" is an SPDT switch: set it to "a" or "b"`);
      return { pi, state: { position: value } };
    }
    if (typeof value !== 'number') throw new RunError(`"${name}" takes a number, not "${value}"`);
    if (prim.kind === 'button') {
      if (value > 1) throw new RunError(`"${name}" is a button: 0 or 1`);
      return { pi, state: { on: value === 1 } };
    }
    const width = widthParam(prim.params);
    if (value >= 2 ** width)
      throw new RunError(`"${name}" is ${width} bit(s): ${value} is too big`);
    return { pi, state: { value } };
  }

  pressState(name: string, on: boolean): { pi: number; state: unknown } {
    const { pi, prim } = this.find(name);
    if (prim.kind !== 'button') throw new RunError(`"${name}" is not a push button: use set`);
    // A bare {on} makes the contact at the evaluating time, bounce included.
    return { pi, state: { on } };
  }
}

/** Undefined on a board with no clock at all: it runs on waits alone. */
function resolveClockNet(circuit: CompiledCircuit, name: string | undefined): number | undefined {
  const sources = circuit.primitives.filter((p) => isBoardLevel(p) && isClockSource(p));
  if (name === undefined) {
    if (sources.length > 1)
      throw new RunError(`the board has ${sources.length} clock sources: name one with "clock"`);
    return sources[0]?.outputs[0];
  }
  const source = sources.find((p) => nameOf(p) === name);
  if (source) return source.outputs[0]!;
  const net = circuit.pathToNet.get(`main/${name}`);
  if (net === undefined) throw new RunError(`no clock source or net named "${name}"`);
  return net;
}

function sameInput(current: unknown, next: unknown): boolean {
  if (typeof current !== 'object' || current === null) return false;
  const now = current as Record<string, unknown>;
  return Object.entries(next as Record<string, unknown>).every(([k, v]) => now[k] === v);
}

function normalizeExpected(expected: ExpectedValue, actual: string): string {
  if (typeof expected === 'string') return expected === '' ? BLANK : expected;
  // A number is a digit on a display and a bit pattern on a net as wide as the reading.
  if (/^[0-9?]$|^blank$/.test(actual) || actual === 'X') return String(expected);
  return expected.toString(2).padStart(actual.length, '0');
}

/**
 * Runs a board against a stimulus on the app's compile and kernel. The clock
 * is the board's own, counted edge by edge: a 555 is self-timed and has no
 * clock-mode stand-in, and substituting one would test a different circuit.
 * A tick runs to the next falling edge, so inputs land mid-period and every
 * reading is taken half a period after the active rising edge.
 */
export function runBoard(
  board: Board,
  library: ChipLibrary,
  stimulus: Stimulus,
  delay: DelayModel,
): RunResult {
  const circuit = compile(board, library);
  const sim = new Simulator(circuit, delay);
  const inputs = new BoardInputs(circuit);
  const clockNet = resolveClockNet(circuit, stimulus.clock);

  const outputs: [string, Reader][] = [];
  for (const p of circuit.primitives) {
    if (!isBoardLevel(p)) continue;
    if (p.kind === 'led') outputs.push([nameOf(p), ledReader(sim, p)]);
    if (p.kind === 'sevenseg') outputs.push([nameOf(p), displayReader(sim, p)]);
  }
  const readers = new Map<string, Reader>(outputs);
  // A watch on an output keeps the output's reader: an active-low LED's net is its complement.
  for (const name of stimulus.watch) {
    if (readers.has(name)) continue;
    const reader = watchReader(sim, board, library, name);
    if (!reader) throw new RunError(`watch: no net, pin or part named "${name}"`);
    readers.set(name, reader);
  }
  const readerFor = (name: string): Reader => {
    const known = readers.get(name);
    if (known) return known;
    const reader = watchReader(sim, board, library, name);
    if (!reader) throw new RunError(`expect: no output, net or pin named "${name}"`);
    readers.set(name, reader);
    return reader;
  };

  const clock = () => (clockNet === undefined ? '' : netReading(sim, clockNet));
  // Counted as they happen, so the edges a wait crosses count too.
  let rises = 0;
  let lastLevel = '';
  sim.onNetChange((net, value) => {
    if (net !== clockNet) return;
    const level = bv.toString(value, 1);
    if (level === '1' && lastLevel === '0') rises++;
    lastLevel = level;
  });
  const step = () => {
    const report = sim.deltaStep();
    if (!report) throw new RunError('the clock stopped: nothing left to simulate');
    return report.changedNets.length + report.evaluated.length;
  };
  const overBudget = () =>
    new RunError(
      `over ${TICK_EVENT_BUDGET} events in one tick or wait: the board oscillates, or the wait is too long for its clock`,
    );

  /** Steps to a low clock that `afterRise` (a rise count) has been passed since. */
  const runToLow = (afterRise: number) => {
    if (clockNet === undefined)
      throw new RunError(
        'the board has no clock or astable 555: use wait, or name one with "clock"',
      );
    const deadline = sim.time + MAX_TICK_PS;
    let events = 0;
    for (;;) {
      const level = clock();
      if (level === '0' && rises > afterRise) return;
      if (sim.time > deadline)
        throw new RunError(
          `the clock made no falling edge in ${MAX_TICK_PS / PS_PER_MS} ms (stuck at ${level})`,
        );
      events += step();
      if (events > TICK_EVENT_BUDGET) throw overBudget();
    }
  };
  // Read at the edge itself, gates fed by the clock still show the old level. A wait
  // may end anywhere in the period, so only a tick's reading insists the clock holds.
  const settleLogic = (clockMustHold: boolean) => {
    const level = clock();
    let events = 0;
    while (!sim.logicSettled) {
      events += step();
      if (events > TICK_EVENT_BUDGET) throw overBudget();
      if (clockMustHold && clock() !== level)
        throw new RunError('the clock moved before the logic settled: it is too fast to read');
    }
  };

  const rows: RunRow[] = [];
  const failures: RunFailure[] = [];
  let firstRise = 0;
  let checkX = false;
  const read = (stepIndex: number, note: string | undefined, onTick: boolean) => {
    settleLogic(onTick);
    const tick = rises - firstRise;
    const values: Record<string, string> = {};
    for (const [name, reader] of readers) values[name] = reader();
    rows.push({
      tick,
      timeMs: sim.time / PS_PER_MS,
      step: stepIndex,
      values,
      ...(note ? { note } : {}),
    });
    if (!checkX) return;
    for (const [name] of outputs)
      if (values[name]!.includes('X'))
        failures.push({ step: stepIndex, tick, name, actual: values[name]! });
  };

  const runStep = (s: StimulusStep, stepIndex: number) => {
    const writes = [
      ...Object.entries(s.set).map(([name, v]) => inputs.stateFor(name, v)),
      ...s.press.map((name) => inputs.pressState(name, true)),
      ...s.release.map((name) => inputs.pressState(name, false)),
    ];
    // Rewriting a held button or a thrown switch would restart its contact and replay bounce.
    for (const { pi, state } of writes)
      if (!sameInput(sim.primitiveStateAt(pi), state)) sim.setPrimitiveStateAt(pi, state);
    const expects = Object.keys(s.expect).length > 0;
    if (expects) checkX = true;

    for (let i = 0; i < s.ticks; i++) {
      // From a high clock (a wait ended mid-pulse) the tick finishes that pulse.
      runToLow(clock() === '1' ? rises - 1 : rises);
      read(stepIndex, i === 0 ? s.note : undefined, true);
    }
    if (s.waitMs > 0) {
      const target = sim.time + s.waitMs * PS_PER_MS;
      let events = sim.runUntil(target);
      while (sim.isBehind(target)) {
        if (events > TICK_EVENT_BUDGET) throw overBudget();
        events += sim.runUntil(target);
      }
      read(stepIndex, s.note, false);
    }
    // Untimed, a write still lands before the next step can overwrite it; an expect also reads,
    // X check included.
    if (s.ticks === 0 && s.waitMs === 0) {
      if (expects) read(stepIndex, s.note, false);
      else if (writes.length > 0) settleLogic(false);
    }

    for (const [name, expected] of Object.entries(s.expect)) {
      const actual = readerFor(name)();
      const want = normalizeExpected(expected, actual);
      if (want !== actual)
        failures.push({ step: stepIndex, tick: rises - firstRise, name, expected: want, actual });
    }
  };

  let error: string | undefined;
  let at = -1;
  try {
    sim.powerOn();
    sim.start();
    lastLevel = clock();
    if (clockNet !== undefined) runToLow(-1);
    settleLogic(true);
    firstRise = rises;
    for (at = 0; at < stimulus.steps.length; at++) runStep(stimulus.steps[at]!, at);
  } catch (e) {
    if (!(e instanceof RunError)) throw e;
    error = at < 0 ? `power on: ${e.message}` : `step ${at}: ${e.message}`;
  }
  return {
    ok: failures.length === 0 && error === undefined,
    columns: [...readers.keys()],
    rows,
    failures,
    ...(error === undefined ? {} : { error }),
  };
}
