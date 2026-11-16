import * as bv from '../../value/busValue';
import { bounceOn, contactAt, SETTLED } from './bounce';
import { onePinLane, parsePinView, pinViewOf, splitBus } from './busPins';
import type { EvalContext, EvalResult, Params, PrimitiveSpec } from './types';
import { intParam, widthParam } from './types';

export interface ClockShape {
  period: number;
  highLen: number;
  phase: number;
}

/** A clock's waveform in ps; the one place its HIGH length is rounded. */
export function clockShape(params: Params): ClockShape {
  const period = intParam(params, 'periodPs', 10_000);
  const duty = intParam(params, 'dutyPercent', 50);
  const phase = intParam(params, 'phasePs', 0);
  if (period < 2 || duty < 1 || duty > 99) throw new RangeError('bad clock params');
  return { period, highLen: Math.max(1, Math.round((period * duty) / 100)), phase };
}

/** The first falling edge strictly after `afterPs`. */
export function nextClockFall(shape: ClockShape, afterPs: number): number {
  const first = shape.phase + shape.highLen;
  if (afterPs < first) return first;
  return first + (Math.floor((afterPs - first) / shape.period) + 1) * shape.period;
}

/**
 * Deterministic clock source, a pure function of sim time.
 * params: periodPs (default 10000), dutyPercent (default 50), phasePs (default 0).
 * phasePs shifts the whole waveform right; output is 0 before the phase offset.
 */
export const clock: PrimitiveSpec = {
  kind: 'clock',
  pins: () => [{ name: 'y', dir: 'out', width: 1, role: 'clock', order: 0 }],
  evaluate(ctx: EvalContext): EvalResult {
    const { period, highLen, phase } = clockShape(ctx.params);
    const t = ctx.time - phase;
    if (t < 0) return { outputs: [bv.known(0, 1)], nextWake: phase };
    const pos = t % period;
    const high = pos < highLen;
    return {
      outputs: [bv.known(high ? 1 : 0, 1)],
      nextWake: ctx.time + (high ? highLen - pos : period - pos),
    };
  },
};

interface ToggleState {
  value: number;
}

// Boolean `initial` is old-board back-compat; maps to 0/1.
function toggleInitial(params: Params): number {
  const raw = params['initial'];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  return 0;
}

/** Manual switch, width-N; the kernel's setToggleValue replaces state and re-evaluates. */
export const toggleSwitch: PrimitiveSpec = {
  kind: 'toggle',
  pins: (params) => onePinLane('y', 'out', params),
  init: (params) => ({ value: toggleInitial(params) }) satisfies ToggleState,
  evaluate: (ctx) => {
    const w = widthParam(ctx.params);
    const value = bv.known((ctx.state as ToggleState).value, w);
    const view = parsePinView(ctx.params);
    const expanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
    return { outputs: expanded ? splitBus(value, w) : [value] };
  },
};

export interface ButtonState {
  on: boolean;
  /** When the current press made contact; absent on a press not yet evaluated. */
  since?: number;
}

export function contactToGround(params: Params): boolean {
  return params['toGround'] === true;
}

/**
 * Momentary push button, released by default. Width 1. A press written as a
 * bare `{on: true}` starts its contact at the evaluating time; with `bounce`
 * the make chatters before it holds, and a release is clean. With `toGround`
 * it is a bare contact to GND, as wired on a breadboard: a closed contact
 * drives LOW and an open one floats, so a pull-up supplies the HIGH.
 */
export const pushButton: PrimitiveSpec = {
  kind: 'button',
  pins: (params) => [
    {
      name: 'y',
      dir: 'out',
      width: 1,
      role: 'data',
      order: 0,
      ...(contactToGround(params) ? { threeState: true } : {}),
    },
  ],
  init: () => ({ on: false }) satisfies ButtonState,
  evaluate: (ctx) => {
    const state = ctx.state as ButtonState;
    const toGround = contactToGround(ctx.params);
    const open = toGround ? bv.allZ(1) : bv.known(0, 1);
    const closed = bv.known(toGround ? 0 : 1, 1);
    if (!state.on) return { outputs: [open] };
    const since = state.since ?? ctx.time;
    const contact = contactAt(since, ctx.time, bounceOn(ctx.params));
    return {
      outputs: [contact.closed ? closed : open],
      ...(state.since === undefined ? { state: { on: true, since } satisfies ButtonState } : {}),
      ...(contact.nextWake === undefined ? {} : { nextWake: contact.nextWake, finite: true }),
    };
  },
};

export type Throw = 'a' | 'b';

/**
 * An input's position with any bounce already over, for carrying it into a
 * fresh sim: a contact time from the old run would replay or cut its bounce.
 */
export function settledState(kind: string, state: unknown): unknown {
  if (kind === 'button') return { on: (state as ButtonState).on, since: SETTLED };
  if (kind === 'spdt') return { position: (state as SpdtState).position, since: SETTLED };
  return state;
}

export interface SpdtState {
  position: Throw;
  /** When the lever reached `position`; absent on a flip not yet evaluated. */
  since?: number;
}

export function spdtPosition(params: Params): Throw {
  return params['position'] === 'b' ? 'b' : 'a';
}

/**
 * Single-pole double-throw switch: the throw the lever touches carries the
 * common's value, the other floats. Break before make, so the throw left
 * opens at once; with `bounce` the throw reached chatters before it holds.
 */
export const spdtSwitch: PrimitiveSpec = {
  kind: 'spdt',
  pins: () => [
    { name: 'c', dir: 'in', width: 1, role: 'data', order: 0 },
    { name: 'a', dir: 'out', width: 1, role: 'data', order: 0, threeState: true },
    { name: 'b', dir: 'out', width: 1, role: 'data', order: 1, threeState: true },
  ],
  init: (params) => ({ position: spdtPosition(params), since: SETTLED }) satisfies SpdtState,
  evaluate: (ctx) => {
    const state = ctx.state as SpdtState;
    const since = state.since ?? ctx.time;
    const contact = contactAt(since, ctx.time, bounceOn(ctx.params));
    const touched = contact.closed ? ctx.inputs[0]! : bv.allZ(1);
    const open = bv.allZ(1);
    return {
      outputs: state.position === 'a' ? [touched, open] : [open, touched],
      ...(state.since === undefined
        ? { state: { position: state.position, since } satisfies SpdtState }
        : {}),
      ...(contact.nextWake === undefined ? {} : { nextWake: contact.nextWake, finite: true }),
    };
  },
};

/** Anode to VCC through its resistor, cathode on the pin: the LED a 74LS output sinks. */
export function ledActiveLow(params: Params): boolean {
  return params['activeLow'] === true;
}

/**
 * Lit (1) or dark (0) per bit, from the pin's value. X and Z pass through as
 * they are, so a reader still sees an unknown or floating pin as such.
 */
export function ledLitValue(pin: bv.BusValue, width: number, params: Params): bv.BusValue {
  if (!ledActiveLow(params)) return pin;
  const m = bv.widthMask(width);
  const unknown = (pin.x | pin.z) & m;
  return { v: (~pin.v & ~unknown & m) >>> 0, x: pin.x & m, z: pin.z & m };
}

/** Observer only, width-N; render layer reads the connected net's value. */
export const led: PrimitiveSpec = {
  kind: 'led',
  pins: (params) => onePinLane('a', 'in', params),
  evaluate: () => ({ outputs: [] }),
};

/** Names a signal for the waveform view; compile aliases the net path to the label. */
export const probe: PrimitiveSpec = {
  kind: 'probe',
  pins: (params) => onePinLane('a', 'in', params),
  evaluate: () => ({ outputs: [] }),
};
