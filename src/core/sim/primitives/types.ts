// PrimitiveSpec: the contract every simulated primitive implements.
// LOCKED INTERFACE: all primitive implementations build against this exactly.

import type { BusValue } from '../../value/busValue';
import type { ParamValue, PinDir, PinRole } from '../../model/types';

export interface PrimitivePin {
  name: string;
  dir: PinDir;
  width: number;
  role: PinRole;
  /** Top-to-bottom order on the symbol (smart-connect + renderer). */
  order: number;
  /** Display text for the glyph label, when it should differ from `name`
   *  (e.g. a lane-expanded bit uses bracket notation, `d0[3]`, while `name`
   *  stays the plain concatenated wiring identifier, `d03`). Falls back to
   *  `name` when unset. */
  label?: string;
}

export type Params = Readonly<Record<string, ParamValue>>;

export interface EvalContext {
  params: Params;
  /** Per-instance state from init(); undefined for stateless primitives. */
  state: unknown;
  /** Current input values, in pins() 'in' order. */
  inputs: readonly BusValue[];
  /** Inputs as of the previous evaluation; edge detection (DFF) reads these. */
  prevInputs: readonly BusValue[];
  /** Simulation time in integer picoseconds. */
  time: number;
}

export interface EvalResult {
  /** New driven value per 'out' pin; null = keep the previously driven value. */
  outputs: (BusValue | null)[];
  /** Replacement state; omit to keep. */
  state?: unknown;
  /** Absolute ps at which to re-evaluate with no input change (clock sources). */
  nextWake?: number;
}

export interface PrimitiveSpec {
  kind: string;
  /** Pin layout may depend on params (gate arity, bus widths, FF variants). */
  pins(params: Params): PrimitivePin[];
  /** Create per-instance mutable state; omit for stateless primitives. */
  init?(params: Params): unknown;
  /**
   * Pure given (params, state, inputs): same inputs must yield same result.
   * State changes go through the returned state, never shared mutables.
   */
  evaluate(ctx: EvalContext): EvalResult;
  /** 74LS part number for datasheet-mode delays, when one exists. A function
   *  form is for a primitive whose real chip varies by param (mux's `inputs`
   *  size maps to a genuinely different part per size). */
  defaultPart?: string | ((params: Params) => string | undefined);
}

export function widthParam(params: Params, fallback = 1): number {
  const w = params['width'];
  return typeof w === 'number' ? w : fallback;
}

export function intParam(params: Params, name: string, fallback: number): number {
  const v = params[name];
  return typeof v === 'number' ? Math.trunc(v) : fallback;
}

export function boolParam(params: Params, name: string, fallback = false): boolean {
  const v = params[name];
  return typeof v === 'boolean' ? v : fallback;
}
