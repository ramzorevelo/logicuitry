import * as bv from '../../value/busValue';
import {
  assembleBus,
  expandPin,
  parsePinView,
  pinViewOf,
  reindexPins,
  splitBus,
  unpackIndexed,
} from './busPins';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, intParam, widthParam } from './types';

export function muxSelectBits(params: Params): number {
  const k = intParam(params, 'selectBits', 2);
  if (k < 1 || k > 4) throw new RangeError(`mux selectBits ${k} outside 1..4`);
  return k;
}

/** Data-line count, derived from `selectBits` (2^k) -- the select width is
 *  the primary param (matches decoder/encoder's `addressBits`; a chosen
 *  select width determines the data-line count, not the other way around). */
export function muxInputs(params: Params): number {
  return 1 << muxSelectBits(params);
}

// Real chip per size: 2:1 -> 74LS157, 4:1 -> 74LS153, 8:1 -> 74LS151. No LS-family
// 16:1 exists (TI never made one); 74150 (non-LS TTL, different electrical family)
// is used as the 16:1 part anyway.
function muxDefaultPart(params: Params): string | undefined {
  switch (muxInputs(params)) {
    case 2:
      return '74LS157';
    case 4:
      return '74LS153';
    case 8:
      return '74LS151';
    case 16:
      return '74150';
    default:
      return undefined;
  }
}

/**
 * Individual-1-bit-select-line multiplexer: `selectBits` (1..4) is the
 * primary param. `2^selectBits` data lines `d0..d(n-1)`, each `width` bits
 * wide; `selectBits` select lines `s0..s(k-1)` (s0 = LSB of the selected
 * index, `role: 'select'` so the renderer routes them to the bottom/top edge
 * per `selSide`); optional active-high `en`. SPEC: ideal H&H-style, not
 * pin-for-pin faithful (real chips use an active-low strobe).
 *
 * `pinView` controls per-pin bus expand/collapse: select collapses into one
 * k-wide `s` pin (bit i = si); data collapses into one n-wide `d` pin only
 * when width === 1, otherwise each `di` stays its own lane and can itself
 * lane-expand into `di_0..di_(w-1)`; `y` lane-expands like a gate output.
 */
export const mux: PrimitiveSpec = {
  kind: 'mux',
  pins: (params) => {
    const k = muxSelectBits(params);
    const n = 1 << k;
    const w = widthParam(params);
    const hasEnable = boolParam(params, 'hasEnable', false);
    const view = parsePinView(params);
    const pins: PrimitivePin[] = [];

    if (w === 1 && pinViewOf(view, 'd', 'expanded') === 'collapsed') {
      pins.push({ name: 'd', dir: 'in', width: n, role: 'data', order: 0 });
    } else {
      for (let i = 0; i < n; i++) {
        const base: PrimitivePin = { name: `d${i}`, dir: 'in', width: w, role: 'data', order: 0 };
        const expanded = w > 1 && pinViewOf(view, `d${i}`, 'collapsed') === 'expanded';
        pins.push(...(expanded ? expandPin(base, w) : [base]));
      }
    }

    if (pinViewOf(view, 's', 'expanded') === 'collapsed') {
      pins.push({ name: 's', dir: 'in', width: k, role: 'select', order: 0 });
    } else {
      for (let i = 0; i < k; i++)
        pins.push({ name: `s${i}`, dir: 'in', width: 1, role: 'select', order: 0 });
    }

    if (hasEnable) pins.push({ name: 'en', dir: 'in', width: 1, role: 'enable', order: 0 });

    const yBase: PrimitivePin = { name: 'y', dir: 'out', width: w, role: 'data', order: 0 };
    const yExpanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
    pins.push(...(yExpanded ? expandPin(yBase, w) : [yBase]));

    return reindexPins(pins);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const k = muxSelectBits(ctx.params);
    const n = 1 << k;
    const w = widthParam(ctx.params);
    const hasEnable = boolParam(ctx.params, 'hasEnable', false);
    const view = parsePinView(ctx.params);
    let cursor = 0;

    let data: bv.BusValue[];
    if (w === 1 && pinViewOf(view, 'd', 'expanded') === 'collapsed') {
      data = unpackIndexed(ctx.inputs[cursor]!, n);
      cursor += 1;
    } else {
      data = [];
      for (let i = 0; i < n; i++) {
        const expanded = w > 1 && pinViewOf(view, `d${i}`, 'collapsed') === 'expanded';
        const span = expanded ? w : 1;
        const raw = ctx.inputs.slice(cursor, cursor + span);
        cursor += span;
        data.push(expanded ? assembleBus(raw) : raw[0]!);
      }
    }

    let sel: bv.BusValue[];
    if (pinViewOf(view, 's', 'expanded') === 'collapsed') {
      sel = unpackIndexed(ctx.inputs[cursor]!, k);
      cursor += 1;
    } else {
      sel = ctx.inputs.slice(cursor, cursor + k);
      cursor += k;
    }

    const en = hasEnable ? ctx.inputs[cursor] : undefined;

    const yExpanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
    const withY = (y: bv.BusValue): EvalResult => ({
      outputs: yExpanded ? splitBus(y, w) : [y],
    });

    if (en) {
      if (bv.isFullyKnown(en, 1) && (en.v & 1) === 0) return withY(bv.known(0, w));
      if (!bv.isFullyKnown(en, 1)) return withY(bv.allX(w));
    }
    if (sel.some((s) => !bv.isFullyKnown(s, 1))) return withY(bv.allX(w));
    let idx = 0;
    for (let i = 0; i < k; i++) idx |= (sel[i]!.v & 1) << i;
    return withY(bv.buf(data[idx]!, w));
  },
  defaultPart: muxDefaultPart,
};
