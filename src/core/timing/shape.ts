// How static timing reads a stateful primitive: its clock, the inputs sampled at
// the edge, the ones that only report arrival, and the arcs that stay combinational.

import type { SetupClass } from '../parts/partsDb';
import { getPrimitive } from '../sim/primitives/registry';
import { clearParam } from '../sim/primitives/sequential';
import { boolParam, type Params } from '../sim/primitives/types';

/** `arrival`: an async control or latch input. It ends a path but breaks it: no arc to Q. */
export type PinTiming = 'clock' | 'arrival' | { sampled: SetupClass };

export interface ThroughArc {
  from: string;
  to: string;
}

export interface TimingShape {
  /** The domain's clock pin; absent on a latch and on a clock-inhibited part, which have no domain. */
  clock?: string;
  /** Every input pin by name, lanes included. */
  pins: ReadonlyMap<string, PinTiming>;
  through: readonly ThroughArc[];
}

type Classifier = (pin: string, params: Params) => PinTiming;

const DATA: PinTiming = { sampled: 'data' };
const ENABLE: PinTiming = { sampled: 'enable' };

const clearTiming = (params: Params, fallback: 'sync' | 'none'): PinTiming =>
  clearParam(params, fallback) === 'async' ? 'arrival' : { sampled: 'clear' };

const isDataLane = (pin: string) => /^d\d*$/.test(pin);

const CLASSIFIERS: Record<string, Classifier> = {
  dff: (pin) => (pin === 'clk' ? 'clock' : pin === 'pre' || pin === 'clr' ? 'arrival' : DATA),
  register: (pin) => (pin === 'clk' ? 'clock' : pin === 'en' ? ENABLE : DATA),
  counter: (pin, params) => {
    if (pin === 'clk') return 'clock';
    if (pin === 'clr') return clearTiming(params, 'sync');
    if (pin === 'load') return { sampled: 'load' };
    return isDataLane(pin) ? DATA : ENABLE;
  },
  shiftreg: (pin, params) => {
    if (pin === 'clk') return 'clock';
    if (pin === 'inh') return 'arrival';
    if (pin === 'clr') return clearTiming(params, 'none');
    // An async load copies d while asserted, so neither waits for the clock.
    const asyncLoad = boolParam(params, 'asyncLoad');
    if (pin === 'load') return asyncLoad ? 'arrival' : { sampled: 'load' };
    if (isDataLane(pin) && asyncLoad) return 'arrival';
    return DATA;
  },
  srlatch: () => 'arrival',
};

/** The timing shape of a stateful kind, or null for a combinational one (dlatch included: it stays transparent). */
export function timingShape(kind: string, params: Params): TimingShape | null {
  const classify = CLASSIFIERS[kind];
  if (!classify) return null;
  const ins = getPrimitive(kind)
    .pins(params)
    .filter((p) => p.dir === 'in')
    .map((p) => p.name);
  const pins = new Map(ins.map((pin) => [pin, classify(pin, params)]));
  const hasClock = ins.includes('clk') && !boolParam(params, 'clockInhibit');
  return {
    ...(hasClock ? { clock: 'clk' } : {}),
    pins,
    through: kind === 'counter' ? counterThrough(ins) : [],
  };
}

// tc is gated by the enable combinationally; with two enables only ent gates it.
function counterThrough(ins: readonly string[]): ThroughArc[] {
  if (ins.includes('ent')) return [{ from: 'ent', to: 'tc' }];
  if (ins.includes('en')) return [{ from: 'en', to: 'tc' }];
  return [];
}

/** Lane-expanded data inputs end one path: `d3`..`d0` report as `d`. */
export function endpointPin(pin: string): string {
  return isDataLane(pin) ? 'd' : pin;
}
