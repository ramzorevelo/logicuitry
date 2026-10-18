import * as bv from '../../value/busValue';
import { listedPart } from '../../parts/partsDb';
import { InputCursor, isPinExpanded, lanePins, reindexPins, splitBus } from './busPins';
import {
  assertedLevel,
  clearParam,
  clockEdge,
  resolveOver,
  type ClearMode,
  type Level,
} from './sequential';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, widthParam } from './types';

export const COUNTER_DEFAULT_WIDTH = 4;

type Enables = 'none' | 'single' | 'dual';

interface CounterShape {
  width: number;
  clear: ClearMode;
  hasLoad: boolean;
  enables: Enables;
  /** Clear and load asserted at 0 (the '161/'163 /CLR and /LOAD). */
  activeLow: boolean;
  dLanes: boolean;
  qLanes: boolean;
}

function shapeOf(params: Params): CounterShape {
  const width = widthParam(params, COUNTER_DEFAULT_WIDTH);
  return {
    width,
    clear: clearParam(params, 'sync'),
    hasLoad: boolParam(params, 'hasLoad'),
    enables: boolParam(params, 'dualEnable')
      ? 'dual'
      : boolParam(params, 'hasEnable')
        ? 'single'
        : 'none',
    activeLow: boolParam(params, 'activeLow'),
    dLanes: width > 1 && isPinExpanded(params, 'd'),
    qLanes: width > 1 && isPinExpanded(params, 'q'),
  };
}

interface CounterInputs {
  clk: bv.BusValue;
  clr?: bv.BusValue;
  load?: bv.BusValue;
  d?: bv.BusValue;
  en?: bv.BusValue;
  enp?: bv.BusValue;
  ent?: bv.BusValue;
}

function readInputs(values: readonly bv.BusValue[], sh: CounterShape): CounterInputs {
  const at = new InputCursor(values);
  const read: CounterInputs = { clk: at.one() };
  if (sh.clear !== 'none') read.clr = at.one();
  if (sh.hasLoad) {
    read.load = at.one();
    read.d = at.bus(sh.width, sh.dLanes);
  }
  if (sh.enables === 'single') read.en = at.one();
  if (sh.enables === 'dual') {
    read.enp = at.one();
    read.ent = at.one();
  }
  return read;
}

const and3 = (a: Level, b: Level): Level =>
  a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : null;

/** Count enable sampled at the edge: both of ENP and ENT under `dualEnable`. */
function countLevel(read: CounterInputs, sh: CounterShape): Level {
  if (sh.enables === 'single') return assertedLevel(read.en, false);
  if (sh.enables === 'dual')
    return and3(assertedLevel(read.enp, false), assertedLevel(read.ent, false));
  return 1;
}

/** The enable that gates the terminal count: ENT only, never ENP. */
function tcEnable(read: CounterInputs, sh: CounterShape): Level {
  if (sh.enables === 'single') return assertedLevel(read.en, false);
  if (sh.enables === 'dual') return assertedLevel(read.ent, false);
  return 1;
}

function increment(q: bv.BusValue, width: number): bv.BusValue {
  return bv.isFullyKnown(q, width) ? bv.known(q.v + 1, width) : bv.allX(width);
}

/** 1 when q is all ones, 0 once any known bit is 0, else unknown. */
function allOnes(q: bv.BusValue, width: number): Level {
  const mask = bv.widthMask(width);
  if ((~q.v & ~q.x & ~q.z & mask) >>> 0) return 0;
  return bv.isFullyKnown(q, width) ? 1 : null;
}

interface CounterState {
  q: bv.BusValue;
}

/**
 * Up counter, the '161/'163 core. At a rising edge, in priority order:
 * synchronous clear, load, count, hold. An async clear overrides all of that
 * while asserted, and an edge in the same evaluation as its release is
 * ignored. An unknown control that could change the outcome gives all-X.
 * `tc` is combinational: q all ones, gated by the enable when there is one.
 */
export const counter: PrimitiveSpec = {
  kind: 'counter',
  pins: (params) => {
    const sh = shapeOf(params);
    const low: Pick<PrimitivePin, 'activeLow'> = sh.activeLow ? { activeLow: true } : {};
    const one = (name: string, role: PrimitivePin['role'], extra = {}): PrimitivePin => ({
      name,
      dir: 'in',
      width: 1,
      role,
      order: 0,
      ...extra,
    });
    const pins: PrimitivePin[] = [one('clk', 'clock')];
    if (sh.clear !== 'none')
      pins.push(one('clr', sh.clear === 'async' ? 'asyncClear' : 'enable', low));
    if (sh.hasLoad)
      pins.push(
        one('load', 'enable', low),
        ...lanePins({ name: 'd', dir: 'in', width: sh.width, role: 'data', order: 0 }, params),
      );
    if (sh.enables === 'single') pins.push(one('en', 'enable'));
    if (sh.enables === 'dual') pins.push(one('enp', 'enable'), one('ent', 'enable'));
    pins.push(
      ...lanePins({ name: 'q', dir: 'out', width: sh.width, role: 'data', order: 0 }, params),
      { name: 'tc', dir: 'out', width: 1, role: 'data', order: 0 },
    );
    return reindexPins(pins);
  },
  init: (params) => ({ q: bv.allX(shapeOf(params).width) }) satisfies CounterState,
  evaluate(ctx: EvalContext): EvalResult {
    const sh = shapeOf(ctx.params);
    const w = sh.width;
    const state = ctx.state as CounterState;
    const cur = readInputs(ctx.inputs, sh);
    const prev = readInputs(ctx.prevInputs, sh);
    const isAsync = sh.clear === 'async';
    const zero = bv.known(0, w);

    const clocked = (): bv.BusValue => {
      const edge = clockEdge(prev.clk, cur.clk);
      if (edge === 'none') return state.q;
      // An async clear still held just before the edge blocks it.
      const held = isAsync ? assertedLevel(prev.clr, sh.activeLow) : 0;
      if (held === 1) return state.q;
      const rose: Level = edge === 'rising' ? 1 : null;
      const clear = sh.clear === 'sync' ? assertedLevel(prev.clr, sh.activeLow) : 0;
      const load = sh.hasLoad ? assertedLevel(prev.load, sh.activeLow) : 0;
      const levels = [rose, held, clear, load, countLevel(prev, sh)];
      return resolveOver(levels, w, ([r, h, c, l, e]) => {
        if (!r || h) return state.q;
        if (c) return zero;
        if (l) return bv.buf(prev.d!, w);
        return e ? increment(state.q, w) : state.q;
      });
    };
    const asyncClear = isAsync ? assertedLevel(cur.clr, sh.activeLow) : 0;
    const q = resolveOver([asyncClear], w, ([c]) => (c ? zero : clocked()));

    const tc = and3(allOnes(q, w), tcEnable(cur, sh));
    const tcBus = tc === null ? bv.allX(1) : bv.known(tc, 1);
    return {
      outputs: [...(sh.qLanes ? splitBus(q, w) : [q]), tcBus],
      state: { q } satisfies CounterState,
    };
  },
  defaultPart: (params) =>
    listedPart(clearParam(params, 'sync') === 'async' ? '74LS161' : '74LS163'),
};
