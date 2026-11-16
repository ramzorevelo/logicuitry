/** A value written to an input: a switch's number, an SPDT throw, a button 0/1. */
export type InputValue = number | 'a' | 'b';

/** An expected reading: a digit or bit string as printed, or a number for a bit pattern. */
export type ExpectedValue = number | string;

/**
 * One stimulus step. Actions apply first, then the advance (`ticks` clock
 * edges or a `wait` in sim time), then `expect` is checked against the last
 * reading.
 */
export interface StimulusStep {
  press: string[];
  release: string[];
  set: Record<string, InputValue>;
  ticks: number;
  waitMs: number;
  expect: Record<string, ExpectedValue>;
  note?: string;
}

export interface Stimulus {
  /** Net label, or a clock or 555 part; absent means the board's only one. */
  clock?: string;
  watch: string[];
  steps: StimulusStep[];
}

/** A step as written in a file: every field optional, `wait` in ms. */
export interface StimulusStepJson {
  press?: string | string[];
  release?: string | string[];
  set?: Record<string, InputValue>;
  ticks?: number;
  wait?: { ms: number };
  expect?: Record<string, ExpectedValue>;
  note?: string;
}

/** A stimulus as written in a file, the shape `parseStimulus` reads. */
export interface StimulusJson {
  clock?: string;
  watch?: string[];
  steps: StimulusStepJson[];
}

export class StimulusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StimulusError';
  }
}

const STEP_KEYS = new Set(['press', 'release', 'set', 'ticks', 'wait', 'expect', 'note']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function names(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || !list.every((n) => typeof n === 'string' && n.length > 0))
    throw new StimulusError(`${where}: expected a name or a list of names`);
  return list as string[];
}

function inputValue(v: unknown, where: string): InputValue {
  if (v === 'a' || v === 'b') return v;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw new StimulusError(`${where}: expected a non-negative integer, "a" or "b"`);
}

function expectedValue(v: unknown, where: string): ExpectedValue {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw new StimulusError(`${where}: expected a digit or bit string, or a non-negative integer`);
}

function parseStep(raw: unknown, i: number): StimulusStep {
  const where = `steps[${i}]`;
  if (!isRecord(raw)) throw new StimulusError(`${where}: expected an object`);
  const unknownKey = Object.keys(raw).find((k) => !STEP_KEYS.has(k));
  if (unknownKey !== undefined) throw new StimulusError(`${where}: unknown key "${unknownKey}"`);

  const set: Record<string, InputValue> = {};
  if (raw['set'] !== undefined) {
    if (!isRecord(raw['set'])) throw new StimulusError(`${where}.set: expected an object`);
    for (const [k, v] of Object.entries(raw['set'])) set[k] = inputValue(v, `${where}.set.${k}`);
  }
  const expect: Record<string, ExpectedValue> = {};
  if (raw['expect'] !== undefined) {
    if (!isRecord(raw['expect'])) throw new StimulusError(`${where}.expect: expected an object`);
    for (const [k, v] of Object.entries(raw['expect']))
      expect[k] = expectedValue(v, `${where}.expect.${k}`);
  }

  const ticks = raw['ticks'] ?? 0;
  if (typeof ticks !== 'number' || !Number.isInteger(ticks) || ticks < 0)
    throw new StimulusError(`${where}.ticks: expected a non-negative integer`);
  let waitMs = 0;
  if (raw['wait'] !== undefined) {
    const wait = raw['wait'];
    if (!isRecord(wait) || typeof wait['ms'] !== 'number' || !(wait['ms'] > 0))
      throw new StimulusError(`${where}.wait: expected {"ms": <positive number>}`);
    waitMs = wait['ms'];
  }
  if (ticks > 0 && waitMs > 0)
    throw new StimulusError(`${where}: use ticks or wait, not both, in one step`);

  const press = names(raw['press'], `${where}.press`);
  const release = names(raw['release'], `${where}.release`);
  // A press bounces on timed wakes the logic settle does not run, so the read would land mid-bounce.
  if (
    press.length + release.length > 0 &&
    Object.keys(expect).length > 0 &&
    ticks === 0 &&
    waitMs === 0
  )
    throw new StimulusError(
      `${where}: an expect after press/release needs ticks or wait in the same step`,
    );
  const note = raw['note'];
  if (note !== undefined && typeof note !== 'string')
    throw new StimulusError(`${where}.note: expected a string`);
  return { press, release, set, ticks, waitMs, expect, ...(note === undefined ? {} : { note }) };
}

/** JSON-parsed stimulus -> validated form. Throws StimulusError naming the bad field. */
export function parseStimulus(raw: unknown): Stimulus {
  if (!isRecord(raw)) throw new StimulusError('stimulus: expected a JSON object');
  const unknownKey = Object.keys(raw).find((k) => !['clock', 'watch', 'steps'].includes(k));
  if (unknownKey !== undefined) throw new StimulusError(`stimulus: unknown key "${unknownKey}"`);
  const clock = raw['clock'];
  if (clock !== undefined && (typeof clock !== 'string' || clock.length === 0))
    throw new StimulusError('clock: expected a name');
  if (!Array.isArray(raw['steps'])) throw new StimulusError('steps: expected a list');
  return {
    ...(clock === undefined ? {} : { clock }),
    watch: names(raw['watch'], 'watch'),
    steps: raw['steps'].map(parseStep),
  };
}
