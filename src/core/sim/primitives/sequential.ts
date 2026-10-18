import * as bv from '../../value/busValue';
import { listedPart } from '../../parts/partsDb';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, widthParam } from './types';

/** Kinds that hold state between evaluations, so no truth table describes them. */
export const STATEFUL_KINDS: ReadonlySet<string> = new Set([
  'dff',
  'dlatch',
  'register',
  'srlatch',
  'counter',
  'shiftreg',
]);

// Clock edge from single-bit prev/cur: rising only when known 0 -> known 1.
// 'unknown' only where a rise is possible but not certain: X -> 0 and 1 -> X
// cannot rise, so they leave stored state alone.
type Edge = 'rising' | 'none' | 'unknown';
export function clockEdge(prev: bv.BusValue, cur: bv.BusValue): Edge {
  const unknown = (b: bv.BusValue) => ((b.x | b.z) & 1) !== 0;
  if (!unknown(prev) && !unknown(cur)) return !(prev.v & 1) && cur.v & 1 ? 'rising' : 'none';
  const couldBeLow = unknown(prev) || !(prev.v & 1);
  const couldBeHigh = unknown(cur) || (cur.v & 1) !== 0;
  return couldBeLow && couldBeHigh ? 'unknown' : 'none';
}

/** A control line read as asserted (1), not asserted (0) or unknown (null). */
export type Level = 0 | 1 | null;

export function assertedLevel(value: bv.BusValue | undefined, activeLow: boolean): Level {
  if (!value || (value.x | value.z) & 1) return null;
  return (value.v & 1) === (activeLow ? 0 : 1) ? 1 : 0;
}

/**
 * Next state with every unknown control tried both ways: each bit stands
 * where every outcome agrees on it, else that bit is X.
 */
export function resolveOver(
  levels: readonly Level[],
  width: number,
  outcome: (asserted: readonly (0 | 1)[]) => bv.BusValue,
): bv.BusValue {
  const results: bv.BusValue[] = [];
  const visit = (i: number, chosen: (0 | 1)[]): void => {
    if (i === levels.length) {
      results.push(outcome(chosen));
      return;
    }
    const level = levels[i]!;
    for (const v of level === null ? ([0, 1] as const) : [level]) visit(i + 1, [...chosen, v]);
  };
  visit(0, []);
  return bv.agree(results, width);
}

export type ClearMode = 'none' | 'sync' | 'async';

export function clearParam(params: Params, fallback: ClearMode): ClearMode {
  const v = params['clear'];
  return v === 'none' || v === 'sync' || v === 'async' ? v : fallback;
}

const lowFlag = (low: boolean): Pick<PrimitivePin, 'activeLow'> => (low ? { activeLow: true } : {});

interface DffState {
  q: bv.BusValue;
  /** PRE and CLR both held low: Q alone cannot tell this from a preset. */
  bothAsserted?: boolean;
}

/**
 * D flip-flop, optional active-low async preset/clear (74LS74 convention).
 * params: width (default 1), asyncSet, asyncClear (booleans adding pins).
 * SPEC: both async pins asserted -> q and qn both 1, the '74 table row;
 * releasing both in one evaluation leaves X ("will not persist"), releasing
 * one first lets the other win. An edge is taken only if neither was
 * asserted just before it, so an edge coinciding with a release is ignored.
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
      pins.push({ name: 'pre', dir: 'in', width: 1, role: 'asyncSet', order: 2, activeLow: true });
    if (boolParam(params, 'asyncClear'))
      pins.push({
        name: 'clr',
        dir: 'in',
        width: 1,
        role: 'asyncClear',
        order: 3,
        activeLow: true,
      });
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
    const preIndex = hasPre ? 2 : -1;
    const clrIndex = hasClr ? (hasPre ? 3 : 2) : -1;
    const async = (inputs: readonly bv.BusValue[], i: number): Level =>
      i < 0 ? 0 : assertedLevel(inputs[i], true);
    const pre = async(ctx.inputs, preIndex);
    const clr = async(ctx.inputs, clrIndex);
    const ones = bv.known(bv.widthMask(width), width);
    const zero = bv.known(0, width);
    interface Next {
      q: bv.BusValue;
      qn: bv.BusValue;
      bothAsserted: boolean;
    }
    const plain = (q: bv.BusValue): Next => ({ q, qn: bv.not(q, width), bothAsserted: false });

    const next = (p: 0 | 1, c: 0 | 1): Next => {
      if (p && c) return { q: ones, qn: ones, bothAsserted: true };
      if (p) return plain(ones);
      if (c) return plain(zero);
      if (state.bothAsserted) return plain(bv.allX(width));
      const prevPre = async(ctx.prevInputs, preIndex);
      const prevClr = async(ctx.prevInputs, clrIndex);
      if (prevPre === 1 || prevClr === 1) return plain(state.q);
      const edge = clockEdge(ctx.prevInputs[1] ?? bv.allX(1), ctx.inputs[1]!);
      if (edge === 'none') return plain(state.q);
      // Sample d as of just before this delta: a same-delta d change must not
      // race through (pre-edge data capture, matching real FF semantics).
      const d = bv.buf(ctx.prevInputs[0] ?? bv.allX(width), width);
      // An edge is uncertain when it may not have risen, or an async line read X
      // just before it and so may have blocked it: keep only what both agree on.
      const certain = edge === 'rising' && prevPre === 0 && prevClr === 0;
      return plain(certain ? d : bv.agree([state.q, d], width));
    };

    // An unknown async line is tried both ways; each output keeps what every try agrees on.
    const tries = (l: Level): (0 | 1)[] => (l === null ? [0, 1] : [l]);
    const results = tries(pre).flatMap((p) => tries(clr).map((c) => next(p, c)));
    const q = bv.agree(
      results.map((r) => r.q),
      width,
    );
    const qn = bv.agree(
      results.map((r) => r.qn),
      width,
    );
    return {
      outputs: [q, qn],
      state: { q, bothAsserted: results.some((r) => r.bothAsserted) } satisfies DffState,
    };
  },
};

interface LatchState {
  q: bv.BusValue;
}

/**
 * Level-sensitive D latch: transparent while en is known 1, holds while known 0.
 * SPEC: an X/Z enable keeps only the bits where d and the held q agree.
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
    const d = bv.buf(ctx.inputs[0]!, width);
    if (!bv.isFullyKnown(en, 1)) q = bv.agree([q, d], width);
    else if (en.v & 1) q = d;
    return { outputs: [q, bv.not(q, width)], state: { q } satisfies LatchState };
  },
  defaultPart: () => listedPart('74LS75'),
};

interface RegState {
  q: bv.BusValue;
}

/**
 * Enabled register: clocked load of d when en was asserted at the edge.
 * `enableLow` (the '377's /E) asserts the enable at 0.
 * SPEC: an X/Z enable at the edge, or an unknown edge, keeps only the bits
 * where d and the held q agree; a known-inactive enable holds q whatever the clock.
 */
export const register: PrimitiveSpec = {
  kind: 'register',
  pins: (params) => {
    const width = widthParam(params);
    return [
      { name: 'd', dir: 'in', width, role: 'data', order: 0 },
      { name: 'clk', dir: 'in', width: 1, role: 'clock', order: 1 },
      {
        name: 'en',
        dir: 'in',
        width: 1,
        role: 'enable',
        order: 2,
        ...lowFlag(boolParam(params, 'enableLow')),
      },
      { name: 'q', dir: 'out', width, role: 'data', order: 0 },
    ];
  },
  init: (params) => ({ q: bv.allX(widthParam(params)) }) satisfies RegState,
  evaluate(ctx: EvalContext): EvalResult {
    const width = widthParam(ctx.params);
    const state = ctx.state as RegState;
    let q = state.q;
    const edge = clockEdge(ctx.prevInputs[1] ?? bv.allX(1), ctx.inputs[1]!);
    if (edge !== 'none') {
      // Sample enable and data as of just before this delta (pre-edge capture).
      const en = assertedLevel(ctx.prevInputs[2], boolParam(ctx.params, 'enableLow'));
      const d = bv.buf(ctx.prevInputs[0] ?? bv.allX(width), width);
      if (edge === 'rising' && en === 1) q = d;
      else if (en !== 0) q = bv.agree([q, d], width);
    }
    return { outputs: [q], state: { q } satisfies RegState };
  },
  defaultPart: () => listedPart('74LS377'),
};

type Bit = 0 | 1 | null;

interface SrState {
  q: Bit;
  qn: Bit;
  /** Both inputs asserted: leaving that row in one evaluation is a race. */
  forbidden: boolean;
}

const isNandForm = (params: Params) => params['form'] === 'nand';

function srNext(set: 0 | 1, reset: 0 | 1, nand: boolean, state: SrState): SrState {
  if (set && reset)
    return nand ? { q: 1, qn: 1, forbidden: true } : { q: 0, qn: 0, forbidden: true };
  if (set) return { q: 1, qn: 0, forbidden: false };
  if (reset) return { q: 0, qn: 1, forbidden: false };
  if (state.forbidden) return { q: null, qn: null, forbidden: false };
  return { ...state, forbidden: false };
}

const agree = (bits: Bit[]): Bit => (bits.every((b) => b === bits[0]) ? bits[0]! : null);
const bitBus = (b: Bit): bv.BusValue => (b === null ? bv.allX(1) : bv.known(b, 1));

/**
 * SR latch as one element. `form: 'nor'` has active-high S and R (both high
 * drives Q = Qn = 0); `form: 'nand'` has active-low inputs (both low drives
 * Q = Qn = 1). An unknown input is tried both ways and an output goes X only
 * where the two disagree.
 */
export const srlatch: PrimitiveSpec = {
  kind: 'srlatch',
  pins: (params) => {
    const low = lowFlag(isNandForm(params));
    return [
      { name: 's', dir: 'in', width: 1, role: 'data', order: 0, ...low },
      { name: 'r', dir: 'in', width: 1, role: 'data', order: 1, ...low },
      { name: 'q', dir: 'out', width: 1, role: 'data', order: 0 },
      { name: 'qn', dir: 'out', width: 1, role: 'data', order: 1 },
    ];
  },
  init: () => ({ q: null, qn: null, forbidden: false }) satisfies SrState,
  evaluate(ctx: EvalContext): EvalResult {
    const nand = isNandForm(ctx.params);
    const state = ctx.state as SrState;
    const set = assertedLevel(ctx.inputs[0], nand);
    const reset = assertedLevel(ctx.inputs[1], nand);
    const tries = (l: Level): (0 | 1)[] => (l === null ? [0, 1] : [l]);
    const results = tries(set).flatMap((s) => tries(reset).map((r) => srNext(s, r, nand, state)));
    const next: SrState = {
      q: agree(results.map((r) => r.q)),
      qn: agree(results.map((r) => r.qn)),
      forbidden: results.some((r) => r.forbidden),
    };
    return { outputs: [bitBus(next.q), bitBus(next.qn)], state: next };
  },
  defaultPart: (params) => (isNandForm(params) ? '74LS00-SR' : '74LS02-SR'),
};
