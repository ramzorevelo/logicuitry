import * as bv from '../../value/busValue';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, intParam, widthParam } from './types';

export const PATTERN_DEFAULT_VALUES = '0 1';
export const PATTERN_DEFAULT_STEP_PS = 100_000;

/** Hex values separated by spaces or commas, at least one; null when any token is not hex. */
export function parsePatternValues(text: string): number[] | null {
  const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const values: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-fA-F]{1,8}$/.test(token)) return null;
    values.push(parseInt(token, 16) >>> 0);
  }
  return values;
}

export function patternParamError(params: Params): string | null {
  const values = params['values'];
  if (values !== undefined && (typeof values !== 'string' || !parsePatternValues(values)))
    return 'values must be hex numbers separated by spaces';
  if (intParam(params, 'stepPs', PATTERN_DEFAULT_STEP_PS) < 2) return 'step must be at least 2 ps';
  const after = params['after'];
  if (after !== undefined && after !== 'repeat' && after !== 'hold')
    return "after must be 'repeat' or 'hold'";
  return null;
}

interface PatternShape {
  width: number;
  values: number[];
  stepPs: number;
  hold: boolean;
  clocked: boolean;
}

function shapeOf(params: Params): PatternShape {
  const error = patternParamError(params);
  if (error) throw new RangeError(`bad pattern params: ${error}`);
  const raw = params['values'];
  return {
    width: widthParam(params),
    values: parsePatternValues(typeof raw === 'string' ? raw : PATTERN_DEFAULT_VALUES)!,
    stepPs: intParam(params, 'stepPs', PATTERN_DEFAULT_STEP_PS),
    hold: params['after'] === 'hold',
    clocked: boolParam(params, 'clocked'),
  };
}

function valueAt(sh: PatternShape, index: number): bv.BusValue {
  const n = sh.values.length;
  const i = sh.hold ? Math.min(index, n - 1) : index % n;
  return bv.known(sh.values[i]! & bv.widthMask(sh.width), sh.width);
}

interface PatternState {
  steps: number;
}

/**
 * A programmed source. Time mode is a pure function of sim time, like the
 * clock; clocked mode steps once per rising edge of its `clk` pin.
 */
export const pattern: PrimitiveSpec = {
  kind: 'pattern',
  pins: (params) => {
    const out: PrimitivePin = {
      name: 'y',
      dir: 'out',
      width: widthParam(params),
      role: 'data',
      order: 1,
    };
    if (!boolParam(params, 'clocked')) return [{ ...out, order: 0 }];
    return [{ name: 'clk', dir: 'in', width: 1, role: 'clock', order: 0 }, out];
  },
  init: () => ({ steps: 0 }) satisfies PatternState,
  evaluate(ctx: EvalContext): EvalResult {
    const sh = shapeOf(ctx.params);
    if (sh.clocked) return clockedStep(ctx, sh);
    const index = Math.floor(ctx.time / sh.stepPs);
    const done = sh.hold && index >= sh.values.length - 1;
    return {
      outputs: [valueAt(sh, index)],
      ...(done ? {} : { nextWake: (index + 1) * sh.stepPs }),
    };
  },
};

// SPEC: only a known 0 -> 1 steps. An unknown clock shows X while it lasts but
// leaves the count alone, so an undriven clk at power-on does not poison the run.
function clockedStep(ctx: EvalContext, sh: PatternShape): EvalResult {
  const { steps } = ctx.state as PatternState;
  const prev = ctx.prevInputs[0] ?? bv.allX(1);
  const cur = ctx.inputs[0] ?? bv.allX(1);
  if (!bv.isFullyKnown(cur, 1)) return { outputs: [bv.allX(sh.width)] };
  const rose = bv.isFullyKnown(prev, 1) && (prev.v & 1) === 0 && (cur.v & 1) === 1;
  const next = rose ? steps + 1 : steps;
  return {
    outputs: [valueAt(sh, next)],
    ...(rose ? { state: { steps: next } satisfies PatternState } : {}),
  };
}
