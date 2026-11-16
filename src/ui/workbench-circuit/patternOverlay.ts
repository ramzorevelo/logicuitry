// The pattern overlay's fields: text as typed, and the checks a commit runs.
// DOM-free so the rules are testable.

import type { ParamValue } from '../../core/model/types';
import {
  PATTERN_DEFAULT_STEP_PS,
  PATTERN_DEFAULT_VALUES,
  parsePatternValues,
  patternParamError,
} from '../../core/sim/primitives/pattern';
import { intParam, widthParam, type Params } from '../../core/sim/primitives/types';
import { MAX_WIDTH } from '../../core/value/busValue';

export type PatternAfter = 'repeat' | 'hold';

export interface PatternFieldText {
  width: string;
  values: string;
  stepNs: string;
  after: PatternAfter;
  clocked: boolean;
}

export type PatternTextField = 'width' | 'values' | 'stepNs';

const PS_PER_NS = 1000;

export function patternFieldText(params: Params): PatternFieldText {
  const values = params['values'];
  return {
    width: String(widthParam(params)),
    values: typeof values === 'string' ? values : PATTERN_DEFAULT_VALUES,
    stepNs: String(intParam(params, 'stepPs', PATTERN_DEFAULT_STEP_PS) / PS_PER_NS),
    after: params['after'] === 'hold' ? 'hold' : 'repeat',
    clocked: params['clocked'] === true,
  };
}

export type PatternCommit =
  | { ok: true; params: Record<string, ParamValue> }
  | { ok: false; field: PatternTextField };

/** The params a commit writes, or the first field that would flash. */
export function parsePatternFields(t: PatternFieldText): PatternCommit {
  const width = Number(t.width.trim());
  if (t.width.trim() === '' || !Number.isInteger(width) || width < 1 || width > MAX_WIDTH)
    return { ok: false, field: 'width' };
  if (!parsePatternValues(t.values)) return { ok: false, field: 'values' };
  const ns = Number(t.stepNs.trim());
  if (t.stepNs.trim() === '' || !Number.isFinite(ns)) return { ok: false, field: 'stepNs' };
  const params: Record<string, ParamValue> = {
    width,
    values: t.values
      .trim()
      .split(/[\s,]+/)
      .join(' ')
      .toUpperCase(),
    stepPs: Math.round(ns * PS_PER_NS),
    after: t.after,
    clocked: t.clocked,
  };
  const error = patternParamError(params as Params);
  if (error) return { ok: false, field: error.startsWith('values') ? 'values' : 'stepNs' };
  return { ok: true, params };
}
