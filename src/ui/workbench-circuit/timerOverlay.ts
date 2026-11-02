// The 555 overlay's fields: text as typed, the checks a commit runs, and the
// E12 steps the slider walks. DOM-free so the rules are testable.

import type { ParamValue } from '../../core/model/types';
import {
  TIMER_C_MAX,
  TIMER_C_MIN,
  TIMER_R_MAX,
  timerMode,
  timerValues,
  type TimerMode,
} from '../../core/sim/primitives/timer555';
import type { Params } from '../../core/sim/primitives/types';
import { formatEngineering, parseEngineering } from '../../core/value/engineering';

export interface TimerFieldText {
  mode: TimerMode;
  r1: string;
  r2: string;
  c: string;
}

export type TimerValueKey = 'r1' | 'r2' | 'c';

/** Digits enough that a value typed or loaded reads back unchanged, so a
 *  commit with nothing edited writes nothing new. */
const FIELD_DIGITS = 12;

/** `4.7k`, `1M`, `1µ`: what a person types. */
export function engineeringText(v: number): string {
  return formatEngineering(v, '', -12, FIELD_DIGITS).replace(' ', '');
}

export function timerFieldText(params: Params): TimerFieldText {
  const { r1, r2, c } = timerValues(params);
  return {
    mode: timerMode(params),
    r1: engineeringText(r1),
    r2: engineeringText(r2),
    c: engineeringText(c),
  };
}

/** One field's value when it parses and is in range, else null. */
export function parseTimerValue(key: TimerValueKey, text: string): number | null {
  const v = parseEngineering(text);
  if (!Number.isFinite(v)) return null;
  if (key === 'c') return v >= TIMER_C_MIN && v <= TIMER_C_MAX ? v : null;
  return v >= 0 && v <= TIMER_R_MAX ? v : null;
}

/** The params a commit writes, or null when any field would flash. */
export function parseTimerFields(t: TimerFieldText): Record<string, ParamValue> | null {
  const r1 = parseTimerValue('r1', t.r1);
  const r2 = parseTimerValue('r2', t.r2);
  const c = parseTimerValue('c', t.c);
  if (r1 === null || r2 === null || c === null) return null;
  return { mode: t.mode, r1, r2, c };
}

/** The resistor the slider sweeps: Ben's pot is R2 in the astable. */
export function sliderKey(mode: TimerMode): 'r1' | 'r2' | null {
  if (mode === 'astable') return 'r2';
  if (mode === 'monostable') return 'r1';
  return null;
}

const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];

/** E12 resistor values from 100 ohm to 10 Mohm, all exact integers. */
export const SLIDER_OHMS: readonly number[] = [
  ...[1, 10, 100, 1_000, 10_000, 100_000].flatMap((scale) => E12.map((m) => m * 10 * scale)),
  10_000_000,
];

/** The step closest to `ohms` on the slider's log scale. */
export function nearestSliderIndex(ohms: number): number {
  if (!(ohms > 0)) return 0;
  let best = 0;
  SLIDER_OHMS.forEach((step, i) => {
    if (Math.abs(Math.log(step / ohms)) < Math.abs(Math.log(SLIDER_OHMS[best]! / ohms))) best = i;
  });
  return best;
}
