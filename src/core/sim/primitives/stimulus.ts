import * as bv from '../../value/busValue';
import { expandPin, parsePinView, pinViewOf, reindexPins, splitBus } from './busPins';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { intParam, widthParam } from './types';

// Lane expand for a primitive's single wide pin: only changes where the wire
// attaches (one wide stub, or one stub per bit) -- io.ts's bank glyphs still
// assume one pin and aren't wired to this yet.
function onePinLane(name: string, dir: 'in' | 'out', params: Params): PrimitivePin[] {
  const w = widthParam(params);
  const view = parsePinView(params);
  const base: PrimitivePin = { name, dir, width: w, role: 'data', order: 0 };
  const expanded = w > 1 && pinViewOf(view, name, 'collapsed') === 'expanded';
  return reindexPins(expanded ? expandPin(base, w) : [base]);
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
    const period = intParam(ctx.params, 'periodPs', 10_000);
    const duty = intParam(ctx.params, 'dutyPercent', 50);
    const phase = intParam(ctx.params, 'phasePs', 0);
    if (period < 2 || duty < 1 || duty > 99) throw new RangeError('bad clock params');
    const highLen = Math.max(1, Math.round((period * duty) / 100));
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

interface ButtonState {
  on: boolean;
}

/** Momentary push button; pressed state comes from setControl, released by default. Width 1. */
export const pushButton: PrimitiveSpec = {
  kind: 'button',
  pins: () => [{ name: 'y', dir: 'out', width: 1, role: 'data', order: 0 }],
  init: () => ({ on: false }) satisfies ButtonState,
  evaluate: (ctx) => ({ outputs: [bv.known((ctx.state as ButtonState).on ? 1 : 0, 1)] }),
};

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
