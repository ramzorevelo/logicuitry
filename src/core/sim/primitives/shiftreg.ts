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

export const SHIFTREG_DEFAULT_WIDTH = 8;

interface ShiftShape {
  width: number;
  clear: ClearMode;
  hasLoad: boolean;
  parallelOut: boolean;
  /** Two serial inputs ANDed (the '164's A and B). */
  serialAnd: boolean;
  /** Load follows d while asserted, ignoring the clock (the '165's SH/LD). */
  asyncLoad: boolean;
  /** Adds `inh`; the register clocks on `clk OR inh` (the '165's CLK INH). */
  clockInhibit: boolean;
  /** Adds `son`, the complement of the serial output. */
  invertedOut: boolean;
  activeLow: boolean;
  dLanes: boolean;
  qLanes: boolean;
}

function shapeOf(params: Params): ShiftShape {
  const width = widthParam(params, SHIFTREG_DEFAULT_WIDTH);
  return {
    width,
    clear: clearParam(params, 'none'),
    hasLoad: boolParam(params, 'hasLoad'),
    parallelOut: boolParam(params, 'parallelOut', true),
    serialAnd: boolParam(params, 'serialAnd'),
    asyncLoad: boolParam(params, 'asyncLoad'),
    clockInhibit: boolParam(params, 'clockInhibit'),
    invertedOut: boolParam(params, 'invertedOut'),
    activeLow: boolParam(params, 'activeLow'),
    dLanes: width > 1 && isPinExpanded(params, 'd'),
    qLanes: width > 1 && isPinExpanded(params, 'q'),
  };
}

interface ShiftInputs {
  /** The clock the register actually sees: `clk OR inh` under clockInhibit. */
  clk: bv.BusValue;
  serial: bv.BusValue;
  clr?: bv.BusValue;
  load?: bv.BusValue;
  d?: bv.BusValue;
}

function readInputs(values: readonly bv.BusValue[], sh: ShiftShape): ShiftInputs {
  const at = new InputCursor(values);
  let clk = at.one();
  const serial = sh.serialAnd ? bv.and([at.one(), at.one()], 1) : bv.buf(at.one(), 1);
  if (sh.clockInhibit) clk = bv.or([clk, at.one()], 1);
  const read: ShiftInputs = { clk, serial };
  if (sh.clear !== 'none') read.clr = at.one();
  if (sh.hasLoad) {
    read.load = at.one();
    read.d = at.bus(sh.width, sh.dLanes);
  }
  return read;
}

/** Stage i moves to stage i + 1 and stage 0 takes the serial bit; an
 *  unknown stage or serial bit moves along as X without touching the rest. */
function shift(q: bv.BusValue, serial: bv.BusValue, width: number): bv.BusValue {
  const unknown = (q.x | q.z) << 1;
  const serialUnknown = (serial.x | serial.z) & 1;
  return bv.norm({ v: (q.v << 1) | (serial.v & 1), x: unknown | serialUnknown, z: 0 }, width);
}

interface ShiftState {
  q: bv.BusValue;
}

/**
 * Shift register, the '164/'165 core. Stage 0 takes the serial input and `so`
 * is the last stage. Priority: async clear, async load ('165), then at an
 * edge sync clear, sync load, shift. An unknown control that could change the
 * outcome gives all-X; an unknown serial bit only fills its own stage.
 */
export const shiftreg: PrimitiveSpec = {
  kind: 'shiftreg',
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
    pins.push(...(sh.serialAnd ? [one('si0', 'data'), one('si1', 'data')] : [one('si', 'data')]));
    if (sh.clockInhibit) pins.push(one('inh', 'enable'));
    if (sh.clear !== 'none')
      pins.push(one('clr', sh.clear === 'async' ? 'asyncClear' : 'enable', low));
    if (sh.hasLoad)
      pins.push(
        one('load', 'enable', low),
        ...lanePins({ name: 'd', dir: 'in', width: sh.width, role: 'data', order: 0 }, params),
      );
    if (sh.parallelOut)
      pins.push(
        ...lanePins({ name: 'q', dir: 'out', width: sh.width, role: 'data', order: 0 }, params),
      );
    pins.push({ name: 'so', dir: 'out', width: 1, role: 'data', order: 0 });
    if (sh.invertedOut) pins.push({ name: 'son', dir: 'out', width: 1, role: 'data', order: 0 });
    return reindexPins(pins);
  },
  init: (params) => ({ q: bv.allX(shapeOf(params).width) }) satisfies ShiftState,
  evaluate(ctx: EvalContext): EvalResult {
    const sh = shapeOf(ctx.params);
    const w = sh.width;
    const state = ctx.state as ShiftState;
    const cur = readInputs(ctx.inputs, sh);
    const prev = readInputs(ctx.prevInputs, sh);
    const asyncClear = sh.clear === 'async';
    const asyncLoad = sh.hasLoad && sh.asyncLoad;
    const zero = bv.known(0, w);

    const clocked = (): bv.BusValue => {
      const edge = clockEdge(prev.clk, cur.clk);
      if (edge === 'none') return state.q;
      // An async clear or load still held just before the edge blocks it.
      const heldClear = asyncClear ? assertedLevel(prev.clr, sh.activeLow) : 0;
      const heldLoad = asyncLoad ? assertedLevel(prev.load, sh.activeLow) : 0;
      if (heldClear === 1 || heldLoad === 1) return state.q;
      const rose: Level = edge === 'rising' ? 1 : null;
      const clear = sh.clear === 'sync' ? assertedLevel(prev.clr, sh.activeLow) : 0;
      const load = sh.hasLoad && !sh.asyncLoad ? assertedLevel(prev.load, sh.activeLow) : 0;
      return resolveOver([rose, heldClear, heldLoad, clear, load], w, ([r, hc, hl, c, l]) => {
        if (!r || hc || hl) return state.q;
        if (c) return zero;
        return l ? bv.buf(prev.d!, w) : shift(state.q, prev.serial, w);
      });
    };
    const clearNow = asyncClear ? assertedLevel(cur.clr, sh.activeLow) : 0;
    const loadNow = asyncLoad ? assertedLevel(cur.load, sh.activeLow) : 0;
    const q = resolveOver([clearNow, loadNow], w, ([c, l]) => {
      if (c) return zero;
      return l ? bv.buf(cur.d!, w) : clocked();
    });

    const so = bv.slice(q, w - 1, 1);
    const outputs: bv.BusValue[] = [];
    if (sh.parallelOut) outputs.push(...(sh.qLanes ? splitBus(q, w) : [q]));
    outputs.push(so);
    if (sh.invertedOut) outputs.push(bv.not(so, 1));
    return { outputs, state: { q } satisfies ShiftState };
  },
  defaultPart: () => listedPart('74LS164'),
};
