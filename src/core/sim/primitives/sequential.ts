import * as bv from '../../value/busValue';
import type { EvalContext, EvalResult, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, widthParam } from './types';

interface DffState {
  q: bv.BusValue;
}

// Clock edge from single-bit prev/cur: rising only when known 0 -> known 1.
// Any X/Z involvement is 'unknown', which poisons stored state.
type Edge = 'rising' | 'none' | 'unknown';
export function clockEdge(prev: bv.BusValue, cur: bv.BusValue): Edge {
  if ((prev.x | prev.z | cur.x | cur.z) & 1) return 'unknown';
  return !(prev.v & 1) && cur.v & 1 ? 'rising' : 'none';
}

/**
 * D flip-flop, optional active-low async preset/clear (74LS74 convention).
 * params: width (default 1), asyncSet, asyncClear (booleans adding pins).
 * SPEC: both async pins asserted -> q and qn both 1, matching the 74LS74
 * datasheet's (unstable) truth-table row; releasing both leaves X.
 */
export const dff: PrimitiveSpec = {
  kind: 'dff',
  defaultPart: '74LS74',
  pins: (params) => {
    const width = widthParam(params);
    const pins: PrimitivePin[] = [
      { name: 'd', dir: 'in', width, role: 'data', order: 0 },
      { name: 'clk', dir: 'in', width: 1, role: 'clock', order: 1 },
    ];
    if (boolParam(params, 'asyncSet'))
      pins.push({ name: 'pre', dir: 'in', width: 1, role: 'asyncSet', order: 2 });
    if (boolParam(params, 'asyncClear'))
      pins.push({ name: 'clr', dir: 'in', width: 1, role: 'asyncClear', order: 3 });
    pins.push(
      { name: 'q', dir: 'out', width, role: 'data', order: 0 },
      { name: 'qn', dir: 'out', width, role: 'data', order: 1 },
    );
    return pins;
  },
  init: (params) => ({ q: bv.allX(widthParam(params)) }) satisfies DffState,
  evaluate(ctx: EvalContext): EvalResult {
    const width = widthParam(ctx.params);
    const state = ctx.state as DffState;
    const hasPre = boolParam(ctx.params, 'asyncSet');
    const hasClr = boolParam(ctx.params, 'asyncClear');
    const pre = hasPre ? ctx.inputs[2]! : bv.known(1, 1);
    const clr = hasClr ? ctx.inputs[hasPre ? 3 : 2]! : bv.known(1, 1);

    const preLow = bv.isFullyKnown(pre, 1) && !(pre.v & 1);
    const clrLow = bv.isFullyKnown(clr, 1) && !(clr.v & 1);
    const preUnknown = !bv.isFullyKnown(pre, 1);
    const clrUnknown = !bv.isFullyKnown(clr, 1);

    let q = state.q;
    let qn: bv.BusValue | null = null;
    if (preLow && clrLow) {
      q = bv.known(bv.widthMask(width), width);
      qn = q; // both outputs forced high while both asserted
    } else if (preUnknown || clrUnknown) {
      q = bv.allX(width);
    } else if (preLow) {
      q = bv.known(bv.widthMask(width), width);
    } else if (clrLow) {
      q = bv.known(0, width);
    } else {
      const edge = clockEdge(ctx.prevInputs[1] ?? bv.allX(1), ctx.inputs[1]!);
      // Sample d as of just before this delta: a same-delta d change must not
      // race through (pre-edge data capture, matching real FF semantics).
      if (edge === 'rising') q = bv.buf(ctx.prevInputs[0] ?? bv.allX(width), width);
      else if (edge === 'unknown') q = bv.allX(width);
    }
    return { outputs: [q, qn ?? bv.not(q, width)], state: { q } satisfies DffState };
  },
};

interface LatchState {
  q: bv.BusValue;
}

/**
 * Level-sensitive D latch: transparent while en is known 1, holds while known 0.
 * SPEC: an X/Z enable leaves the latch state indeterminate, so q goes all-X.
 */
export const dlatch: PrimitiveSpec = {
  kind: 'dlatch',
  pins: (params) => {
    const width = widthParam(params);
    return [
      { name: 'd', dir: 'in', width, role: 'data', order: 0 },
      { name: 'en', dir: 'in', width: 1, role: 'enable', order: 1 },
      { name: 'q', dir: 'out', width, role: 'data', order: 0 },
      { name: 'qn', dir: 'out', width, role: 'data', order: 1 },
    ];
  },
  init: (params) => ({ q: bv.allX(widthParam(params)) }) satisfies LatchState,
  evaluate(ctx: EvalContext): EvalResult {
    const width = widthParam(ctx.params);
    const state = ctx.state as LatchState;
    const en = ctx.inputs[1]!;
    let q = state.q;
    if (!bv.isFullyKnown(en, 1)) q = bv.allX(width);
    else if (en.v & 1) q = bv.buf(ctx.inputs[0]!, width);
    return { outputs: [q, bv.not(q, width)], state: { q } satisfies LatchState };
  },
};

interface RegState {
  q: bv.BusValue;
}

/**
 * Enabled register: clocked load of d when en was known 1 at the edge.
 * SPEC: an X/Z enable at the edge, or an unknown edge, drives q all-X.
 */
export const register: PrimitiveSpec = {
  kind: 'register',
  pins: (params) => {
    const width = widthParam(params);
    return [
      { name: 'd', dir: 'in', width, role: 'data', order: 0 },
      { name: 'clk', dir: 'in', width: 1, role: 'clock', order: 1 },
      { name: 'en', dir: 'in', width: 1, role: 'enable', order: 2 },
      { name: 'q', dir: 'out', width, role: 'data', order: 0 },
    ];
  },
  init: (params) => ({ q: bv.allX(widthParam(params)) }) satisfies RegState,
  evaluate(ctx: EvalContext): EvalResult {
    const width = widthParam(ctx.params);
    const state = ctx.state as RegState;
    let q = state.q;
    const edge = clockEdge(ctx.prevInputs[1] ?? bv.allX(1), ctx.inputs[1]!);
    if (edge === 'unknown') q = bv.allX(width);
    else if (edge === 'rising') {
      // Sample enable and data as of just before this delta (pre-edge capture).
      const en = ctx.prevInputs[2] ?? bv.allX(1);
      if (!bv.isFullyKnown(en, 1)) q = bv.allX(width);
      else if (en.v & 1) q = bv.buf(ctx.prevInputs[0] ?? bv.allX(width), width);
    }
    return { outputs: [q], state: { q } satisfies RegState };
  },
};
