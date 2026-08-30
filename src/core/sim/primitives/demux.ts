import * as bv from '../../value/busValue';
import {
  assembleBus,
  expandPin,
  packIndexed,
  parsePinView,
  pinViewOf,
  reindexPins,
  splitBus,
  unpackIndexed,
} from './busPins';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, intParam, widthParam } from './types';

export function demuxSelectBits(params: Params): number {
  const k = intParam(params, 'selectBits', 2);
  if (k < 1 || k > 4) throw new RangeError(`demux selectBits ${k} outside 1..4`);
  return k;
}

/** Output-line count, derived from `selectBits` (2^k) -- the select width is
 *  the primary param, mirroring mux. */
export function demuxOutputs(params: Params): number {
  return 1 << demuxSelectBits(params);
}

// Real chip per size: 2/4-out -> 74LS139 (dual 2-to-4 decoder/demux, one
// section), 8-out -> the existing 74LS138 decoder part (a decoder's strobe
// input is a demux's data input electrically), 16-out -> 74LS154.
function demuxDefaultPart(params: Params): string | undefined {
  switch (demuxOutputs(params)) {
    case 2:
    case 4:
      return '74LS139';
    case 8:
      return '74LS138';
    case 16:
      return '74LS154';
    default:
      return undefined;
  }
}

/**
 * Individual-1-bit-select-line demultiplexer: `selectBits` (1..4) is the
 * primary param. One `width`-bit data input `d` routes to exactly one of
 * `2^selectBits` output lines `y0..y(n-1)` (each `width` bits), selected by
 * `selectBits` select lines `s0..s(k-1)` (role 'select', routed like mux's
 * per `selSide`), optional active-high `en`. Unselected outputs drive known-0.
 * SPEC: ideal H&H-style, not pin-for-pin faithful (real chips demux through
 * an active-low strobe, not a data pin).
 *
 * `pinView` mirrors mux's data-group rule onto the output side: `y0..y(n-1)`
 * collapse into one n-wide `y` pin only when width === 1, otherwise each
 * `yi` can lane-expand; `d` lane-expands like a gate input; `s` collapses
 * like mux's select group.
 */
export const demux: PrimitiveSpec = {
  kind: 'demux',
  pins: (params) => {
    const k = demuxSelectBits(params);
    const n = 1 << k;
    const w = widthParam(params);
    const hasEnable = boolParam(params, 'hasEnable', false);
    const view = parsePinView(params);
    const pins: PrimitivePin[] = [];

    const dBase: PrimitivePin = { name: 'd', dir: 'in', width: w, role: 'data', order: 0 };
    const dExpanded = w > 1 && pinViewOf(view, 'd', 'collapsed') === 'expanded';
    pins.push(...(dExpanded ? expandPin(dBase, w) : [dBase]));

    if (pinViewOf(view, 's', 'expanded') === 'collapsed') {
      pins.push({ name: 's', dir: 'in', width: k, role: 'select', order: 0 });
    } else {
      for (let i = 0; i < k; i++)
        pins.push({ name: `s${i}`, dir: 'in', width: 1, role: 'select', order: 0 });
    }

    if (hasEnable) pins.push({ name: 'en', dir: 'in', width: 1, role: 'enable', order: 0 });

    if (w === 1 && pinViewOf(view, 'y', 'expanded') === 'collapsed') {
      pins.push({ name: 'y', dir: 'out', width: n, role: 'data', order: 0 });
    } else {
      for (let i = 0; i < n; i++) {
        const base: PrimitivePin = { name: `y${i}`, dir: 'out', width: w, role: 'data', order: i };
        const expanded = w > 1 && pinViewOf(view, `y${i}`, 'collapsed') === 'expanded';
        pins.push(...(expanded ? expandPin(base, w) : [base]));
      }
    }

    return reindexPins(pins);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const k = demuxSelectBits(ctx.params);
    const n = 1 << k;
    const w = widthParam(ctx.params);
    const hasEnable = boolParam(ctx.params, 'hasEnable', false);
    const view = parsePinView(ctx.params);
    let cursor = 0;

    const dExpanded = w > 1 && pinViewOf(view, 'd', 'collapsed') === 'expanded';
    const dSpan = dExpanded ? w : 1;
    const dRaw = ctx.inputs.slice(cursor, cursor + dSpan);
    cursor += dSpan;
    const d = dExpanded ? assembleBus(dRaw) : dRaw[0]!;

    let sel: bv.BusValue[];
    if (pinViewOf(view, 's', 'expanded') === 'collapsed') {
      sel = unpackIndexed(ctx.inputs[cursor]!, k);
      cursor += 1;
    } else {
      sel = ctx.inputs.slice(cursor, cursor + k);
      cursor += k;
    }

    const en = hasEnable ? ctx.inputs[cursor] : undefined;

    const yCollapsed = w === 1 && pinViewOf(view, 'y', 'expanded') === 'collapsed';
    const withOutputs = (values: bv.BusValue[]): EvalResult => {
      if (yCollapsed) return { outputs: [packIndexed(values)] };
      const out: bv.BusValue[] = [];
      for (let i = 0; i < n; i++) {
        const expanded = w > 1 && pinViewOf(view, `y${i}`, 'collapsed') === 'expanded';
        out.push(...(expanded ? splitBus(values[i]!, w) : [values[i]!]));
      }
      return { outputs: out };
    };

    if (en) {
      if (bv.isFullyKnown(en, 1) && (en.v & 1) === 0) {
        return withOutputs(Array.from({ length: n }, () => bv.known(0, w)));
      }
      if (!bv.isFullyKnown(en, 1)) {
        return withOutputs(Array.from({ length: n }, () => bv.allX(w)));
      }
    }
    if (sel.some((s) => !bv.isFullyKnown(s, 1))) {
      return withOutputs(Array.from({ length: n }, () => bv.allX(w)));
    }
    let idx = 0;
    for (let i = 0; i < k; i++) idx |= (sel[i]!.v & 1) << i;
    return withOutputs(
      Array.from({ length: n }, (_, i) => (i === idx ? bv.buf(d, w) : bv.known(0, w))),
    );
  },
  defaultPart: demuxDefaultPart,
};
