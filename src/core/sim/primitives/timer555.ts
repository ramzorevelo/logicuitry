import * as bv from '../../value/busValue';
import type { BusValue } from '../../value/busValue';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';

export type TimerMode = 'astable' | 'monostable' | 'bistable';

export const TIMER_MODES: readonly TimerMode[] = ['astable', 'monostable', 'bistable'];

/** TI SLFS022K's constants: a charge between 1/3 and 2/3 VCC (ln 2), and one
 *  from an empty capacitor to 2/3 VCC (ln 3), as the sheet rounds them. */
const BETWEEN_THRESHOLDS = 0.693;
const FROM_EMPTY = 1.1;
const PS_PER_S = 1e12;

export const TIMER_DEFAULTS = { r1: 1_000, r2: 1_000_000, c: 1e-6 } as const;
export const TIMER_R_MAX = 10e6;
export const TIMER_C_MIN = 1e-12;
/** Keeps the longest interval, 1.1 x 20 Mohm x 100 uF = 2.2e15 ps, a safe
 *  integer with room for the sim time it is added to. */
export const TIMER_C_MAX = 100e-6;

/** NE555 package pin per pin name, printed on the glyph's stubs. */
export const TIMER_PIN_NUMBERS: Readonly<Record<string, number>> = {
  trig: 2,
  out: 3,
  reset: 4,
  thres: 6,
};

export function timerMode(params: Params): TimerMode {
  const mode = params['mode'];
  return mode === 'monostable' || mode === 'bistable' ? mode : 'astable';
}

function clampParam(params: Params, key: string, fallback: number, min: number, max: number) {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export interface TimerValues {
  r1: number;
  r2: number;
  c: number;
}

export function timerValues(params: Params): TimerValues {
  return {
    r1: clampParam(params, 'r1', TIMER_DEFAULTS.r1, 0, TIMER_R_MAX),
    r2: clampParam(params, 'r2', TIMER_DEFAULTS.r2, 0, TIMER_R_MAX),
    c: clampParam(params, 'c', TIMER_DEFAULTS.c, TIMER_C_MIN, TIMER_C_MAX),
  };
}

export interface TimerIntervals {
  /** Astable HIGH from an empty capacitor: power-on or a RESET release. */
  firstHighPs: number;
  highPs: number;
  lowPs: number;
  /** Monostable output pulse. */
  pulsePs: number;
}

const toPs = (seconds: number) => Math.max(1, Math.round(seconds * PS_PER_S));

/** The one place the datasheet formulas run, so the glyph, the overlay and
 *  static timing all quote the intervals the sim actually uses. */
export function timerIntervals(params: Params): TimerIntervals {
  const { r1, r2, c } = timerValues(params);
  return {
    firstHighPs: toPs(FROM_EMPTY * (r1 + r2) * c),
    highPs: toPs(BETWEEN_THRESHOLDS * (r1 + r2) * c),
    lowPs: toPs(BETWEEN_THRESHOLDS * r2 * c),
    pulsePs: toPs(FROM_EMPTY * r1 * c),
  };
}

export interface TimerState {
  /** `empty` is OUT LOW with the capacitor discharged; `held` is a monostable
   *  whose pulse is over while TRIG still holds OUT HIGH; `maybe` is an idle
   *  monostable whose TRIG went X, so a pulse may be running until `end`. */
  phase: 'unknown' | 'empty' | 'high' | 'low' | 'held' | 'maybe';
  /** When the timed phase ends, in ps. */
  end: number;
  /** The RC product timing the phase under way, in seconds, so a live R or C
   *  edit can rescale what is left of it. */
  rc?: number;
}

const UNKNOWN: TimerState = { phase: 'unknown', end: 0 };
const EMPTY: TimerState = { phase: 'empty', end: 0 };

function level(b: BusValue): 0 | 1 | undefined {
  if ((b.x | b.z) & 1) return undefined;
  return (b.v & 1) as 0 | 1;
}

function out(value: 0 | 1 | undefined, state: TimerState, nextWake?: number): EvalResult {
  return {
    outputs: [value === undefined ? bv.allX(1) : bv.known(value, 1)],
    state,
    ...(nextWake === undefined ? {} : { nextWake }),
  };
}

/** RESET LOW overrides every mode and empties the capacitor. An unknown RESET
 *  reads LOW only where running on would read LOW too, and keeps the state
 *  only where both would leave the capacitor empty. */
function withReset(reset: 0 | 1 | undefined, run: () => EvalResult): EvalResult {
  if (reset === 1) return run();
  if (reset === 0) return out(0, EMPTY);
  const running = run();
  const low = bv.equal(running.outputs[0]!, bv.known(0, 1));
  const empty = low && (running.state as TimerState).phase === 'empty';
  return out(low ? 0 : undefined, empty ? EMPTY : UNKNOWN);
}

/** Phase at `time`, whenever the kernel happens to wake the part: a wake can
 *  come early, twice, or after paused time moved on, and each must agree. */
function astable(ctx: EvalContext): EvalResult {
  return withReset(level(ctx.inputs[0]!), () => astableRunning(ctx));
}

/** A charge toward a threshold takes time in proportion to RC, so a live R or
 *  C edit stretches or shrinks the time left in a phase the same way. */
function retimed(end: number, time: number, oldRc: number | undefined, rc: number): number {
  if (oldRc === undefined || oldRc === 0 || oldRc === rc || time >= end) return end;
  return time + Math.max(1, Math.round(((end - time) * rc) / oldRc));
}

function astableRunning(ctx: EvalContext): EvalResult {
  const iv = timerIntervals(ctx.params);
  const { r1, r2, c } = timerValues(ctx.params);
  const rcOf = (phase: 'high' | 'low') => (phase === 'high' ? (r1 + r2) * c : r2 * c);
  const state = ctx.state as TimerState;
  let { phase, end } = state;
  if (phase !== 'high' && phase !== 'low') {
    phase = 'high';
    end = ctx.time + iv.firstHighPs;
  } else end = retimed(end, ctx.time, state.rc, rcOf(phase));
  const period = iv.highPs + iv.lowPs;
  if (ctx.time - end >= period) end += Math.floor((ctx.time - end) / period) * period;
  while (ctx.time >= end) {
    phase = phase === 'high' ? 'low' : 'high';
    end += phase === 'high' ? iv.highPs : iv.lowPs;
  }
  return out(phase === 'high' ? 1 : 0, { phase, end, rc: rcOf(phase) }, end);
}

function monostable(ctx: EvalContext): EvalResult {
  return withReset(level(ctx.inputs[1]!), () => monostableRunning(ctx));
}

function monostableRunning(ctx: EvalContext): EvalResult {
  const trig = level(ctx.inputs[0]!);
  const state = ctx.state as TimerState;
  const { r1, c } = timerValues(ctx.params);
  let { phase, end } = state;
  const pulseEnd = ctx.time + timerIntervals(ctx.params).pulsePs;
  if (phase === 'high') end = retimed(end, ctx.time, state.rc, r1 * c);
  if (phase === 'high' && ctx.time >= end) phase = 'held';
  if (phase === 'high') return out(1, { phase, end, rc: r1 * c }, end);
  if (phase === 'held') {
    if (trig === 1) phase = 'empty';
    else return out(trig === 0 ? 1 : undefined, { phase, end });
  }
  // An X TRIG on a known idle timer may have been LOW at any moment of it,
  // starting a pulse that could run until tw after the X last held. Not at
  // power-on: every net starts X there, and nothing has triggered yet.
  if (trig === undefined && phase === 'unknown') return out(undefined, UNKNOWN);
  if (trig === undefined) {
    const maybeEnd = phase === 'maybe' ? Math.max(end, pulseEnd) : pulseEnd;
    return out(undefined, { phase: 'maybe', end: maybeEnd }, maybeEnd);
  }
  if (phase === 'maybe' && trig === 1) {
    // The X held right up to this edge, so a pulse could have started just now.
    const until = level(ctx.prevInputs[0]!) === undefined ? Math.max(end, pulseEnd) : end;
    if (ctx.time < until) return out(undefined, { phase, end: until }, until);
  }
  if (trig === 1) return out(0, EMPTY);
  return out(1, { phase: 'high', end: pulseEnd, rc: r1 * c }, pulseEnd);
}

const either = (b: 0 | 1 | undefined): (0 | 1)[] => (b === undefined ? [0, 1] : [b]);

/** The function table: TRIG LOW sets, else THRES HIGH resets, else hold. An
 *  unknown input gives X only when its two values would disagree. */
function bistable(ctx: EvalContext): EvalResult {
  return withReset(level(ctx.inputs[2]!), () => bistableRunning(ctx));
}

function bistableRunning(ctx: EvalContext): EvalResult {
  const [trigIn, thresIn] = ctx.inputs;
  const { phase } = ctx.state as TimerState;
  const held = phase === 'high' ? 1 : phase === 'empty' ? 0 : undefined;
  const outcomes = new Set<0 | 1 | undefined>();
  for (const trig of either(level(trigIn!)))
    for (const thres of either(level(thresIn!)))
      outcomes.add(trig === 0 ? 1 : thres === 1 ? 0 : held);
  const [value] = outcomes;
  if (outcomes.size > 1 || value === undefined) return out(undefined, UNKNOWN);
  return out(value, value === 1 ? { phase: 'high', end: 0 } : EMPTY);
}

function inPin(name: string, label: string, order: number, activeLow = false): PrimitivePin {
  return {
    name,
    label,
    dir: 'in',
    width: 1,
    role: 'data',
    order,
    ...(activeLow ? { activeLow } : {}),
  };
}

/**
 * NE555 timer, timed from the datasheet's RC formulas with R and C as params.
 * The astable runs from Run like a clock; a monostable pulse is self-timed too,
 * so a trigger while paused does not jump sim time by the pulse.
 */
export const timer555: PrimitiveSpec = {
  kind: 'timer555',
  pins: (params) => {
    const mode = timerMode(params);
    const ins =
      mode === 'astable'
        ? [inPin('reset', 'RESET', 0, true)]
        : mode === 'monostable'
          ? [inPin('trig', 'TRIG', 0, true), inPin('reset', 'RESET', 1, true)]
          : [
              inPin('trig', 'TRIG', 0, true),
              inPin('thres', 'THRES', 1),
              inPin('reset', 'RESET', 2, true),
            ];
    return [
      ...ins,
      {
        name: 'out',
        label: 'OUT',
        dir: 'out',
        width: 1,
        role: mode === 'astable' ? 'clock' : 'data',
        order: 0,
      },
    ];
  },
  init: () => UNKNOWN,
  evaluate: (ctx) => {
    const mode = timerMode(ctx.params);
    if (mode === 'monostable') return monostable(ctx);
    if (mode === 'bistable') return bistable(ctx);
    return astable(ctx);
  },
};
