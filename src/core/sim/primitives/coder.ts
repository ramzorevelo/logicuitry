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
import { boolParam, intParam } from './types';

export function decoderAddressBits(params: Params): number {
  const w = intParam(params, 'addressBits', 2);
  if (w < 1 || w > 4) throw new RangeError(`decoder addressBits ${w} outside 1..4`);
  return w;
}

export function encoderAddressBits(params: Params): number {
  const w = intParam(params, 'addressBits', 2);
  if (w < 1 || w > 4) throw new RangeError(`encoder addressBits ${w} outside 1..4`);
  return w;
}

interface DecoderEnables {
  /** Pin names in pins() order, active-high ones first. */
  names: string[];
  high: number;
}

/** A real part's enables (`enablesHigh`, `enablesLow`) replace the block's single `en`. */
function decoderEnables(params: Params): DecoderEnables {
  const high = intParam(params, 'enablesHigh', 0);
  const low = intParam(params, 'enablesLow', 0);
  if (high < 0 || high > 1) throw new RangeError(`decoder enablesHigh ${high} outside 0..1`);
  if (low < 0 || low > 2) throw new RangeError(`decoder enablesLow ${low} outside 0..2`);
  if (high + low === 0)
    return { names: boolParam(params, 'hasEnable', false) ? ['en'] : [], high: 1 };
  return {
    names: [
      ...Array.from({ length: high }, (_, i) => `enh${i}`),
      ...Array.from({ length: low }, (_, i) => `enl${i}`),
    ],
    high,
  };
}

type EnableState = 'on' | 'off' | 'unknown';

/** Off as soon as one enable is known inactive: that alone decides the outputs. */
function enableState(values: readonly bv.BusValue[], high: number): EnableState {
  let state: EnableState = 'on';
  for (const [i, value] of values.entries()) {
    if (!bv.isFullyKnown(value, 1)) state = 'unknown';
    else if ((value.v & 1) !== (i < high ? 1 : 0)) return 'off';
  }
  return state;
}

/**
 * Ideal H&H-style decoder: active high, one optional enable. The hidden
 * params `activeLowOut`, `enablesHigh` and `enablesLow` make it the core of a
 * real part ('138, '139, '154). A known-inactive enable dominates to every
 * output inactive; otherwise an unknown sel or enable -> all-X.
 */
export const decoder: PrimitiveSpec = {
  kind: 'decoder',
  pins: (params) => {
    const selWidth = decoderAddressBits(params);
    const enables = decoderEnables(params);
    const activeLowOut = boolParam(params, 'activeLowOut', false);
    const n = 1 << selWidth;
    const view = parsePinView(params);
    const pins: PrimitivePin[] = [];

    const selBase: PrimitivePin = {
      name: 'a',
      dir: 'in',
      width: selWidth,
      role: 'data',
      order: 0,
    };
    const selExpanded = selWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    pins.push(...(selExpanded ? expandPin(selBase, selWidth, false) : [selBase]));

    for (const [i, name] of enables.names.entries())
      pins.push({
        name,
        dir: 'in',
        width: 1,
        role: 'enable',
        order: 0,
        ...(i >= enables.high ? { activeLow: true } : {}),
      });

    const low = activeLowOut ? { activeLow: true } : {};
    if (pinViewOf(view, 'y', 'expanded') === 'collapsed') {
      pins.push({ name: 'y', dir: 'out', width: n, role: 'data', order: 0, ...low });
    } else {
      for (let i = 0; i < n; i++)
        pins.push({ name: `y${i}`, dir: 'out', width: 1, role: 'data', order: i, ...low });
    }
    return reindexPins(pins);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const selWidth = decoderAddressBits(ctx.params);
    const enables = decoderEnables(ctx.params);
    const inactive = boolParam(ctx.params, 'activeLowOut', false) ? 1 : 0;
    const n = 1 << selWidth;
    const view = parsePinView(ctx.params);
    let cursor = 0;

    const selExpanded = selWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    const selSpan = selExpanded ? selWidth : 1;
    const selRaw = ctx.inputs.slice(cursor, cursor + selSpan);
    cursor += selSpan;
    const sel = selExpanded ? assembleBus(selRaw) : selRaw[0]!;

    const enabled = enableState(
      ctx.inputs.slice(cursor, cursor + enables.names.length),
      enables.high,
    );

    const yCollapsed = pinViewOf(view, 'y', 'expanded') === 'collapsed';
    const withOutputs = (values: bv.BusValue[]): EvalResult => ({
      outputs: yCollapsed ? [packIndexed(values)] : values,
    });

    if (enabled === 'off')
      return withOutputs(Array.from({ length: n }, () => bv.known(inactive, 1)));
    // An output no reading of the unknown select bits can pick stays inactive.
    const knownSel = ~(sel.x | sel.z) & bv.widthMask(selWidth);
    const certain = enabled === 'on' && knownSel === bv.widthMask(selWidth);
    return withOutputs(
      Array.from({ length: n }, (_, i) => {
        if (((i ^ sel.v) & knownSel) !== 0) return bv.known(inactive, 1);
        return certain ? bv.known(1 - inactive, 1) : bv.allX(1);
      }),
    );
  },
  defaultPart: '74LS138',
};

/**
 * Priority encoder, highest index wins. Output defined iff every input above
 * the winner is known-0; unknowns below the winner don't matter. `valid` is 0
 * only when every input is known-0, else X when no winner and not all-0.
 *
 * Hidden params make it the core of a '148: `activeLow` asserts the inputs
 * and the code at 0, `cascade` trades `valid` for `ei` in and `gs`, `eo` out.
 * The logic below runs on asserted/deasserted; only the pins see the levels.
 */
export const encoder: PrimitiveSpec = {
  kind: 'encoder',
  pins: (params) => {
    const outWidth = encoderAddressBits(params);
    const n = 1 << outWidth;
    const view = parsePinView(params);
    const low = boolParam(params, 'activeLow', false) ? { activeLow: true } : {};
    const cascade = boolParam(params, 'cascade', false);
    const pins: PrimitivePin[] = [];

    if (pinViewOf(view, 'i', 'expanded') === 'collapsed') {
      pins.push({ name: 'i', dir: 'in', width: n, role: 'data', order: 0, ...low });
    } else {
      for (let i = 0; i < n; i++)
        pins.push({ name: `i${i}`, dir: 'in', width: 1, role: 'data', order: i, ...low });
    }
    if (cascade) pins.push({ name: 'ei', dir: 'in', width: 1, role: 'enable', order: 0, ...low });

    const yBase: PrimitivePin = {
      name: 'a',
      dir: 'out',
      width: outWidth,
      role: 'data',
      order: 0,
      ...low,
    };
    const yExpanded = outWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    pins.push(...(yExpanded ? expandPin(yBase, outWidth, false) : [yBase]));
    if (cascade) {
      pins.push({ name: 'gs', dir: 'out', width: 1, role: 'data', order: 1, ...low });
      pins.push({ name: 'eo', dir: 'out', width: 1, role: 'data', order: 2, ...low });
    } else {
      pins.push({ name: 'valid', dir: 'out', width: 1, role: 'data', order: 1 });
    }
    return reindexPins(pins);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const outWidth = encoderAddressBits(ctx.params);
    const n = 1 << outWidth;
    const view = parsePinView(ctx.params);
    const activeLow = boolParam(ctx.params, 'activeLow', false);
    const cascade = boolParam(ctx.params, 'cascade', false);
    const asserted = activeLow ? 0 : 1;
    let cursor = 0;

    let inputs: bv.BusValue[];
    if (pinViewOf(view, 'i', 'expanded') === 'collapsed') {
      inputs = unpackIndexed(ctx.inputs[cursor]!, n);
      cursor += 1;
    } else {
      inputs = ctx.inputs.slice(cursor, cursor + n);
      cursor += n;
    }

    const knownAt = (value: bv.BusValue, level: number) =>
      bv.isFullyKnown(value, 1) && (value.v & 1) === level;
    const isKnownOne = (i: number) => knownAt(inputs[i]!, asserted);
    const isKnownZero = (i: number) => knownAt(inputs[i]!, 1 - asserted);
    const ei = cascade ? ctx.inputs[cursor]! : undefined;
    let winner = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (isKnownOne(i)) {
        winner = i;
        break;
      }
    }

    const yExpanded = outWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    // `found` is valid/gs, `none` is eo, all three in asserted terms (1 = asserted).
    const level = (v: bv.BusValue, width: number) => (activeLow ? bv.not(v, width) : v);
    const withY = (y: bv.BusValue, found: bv.BusValue, none = bv.allX(1)): EvalResult => ({
      outputs: [
        ...(yExpanded ? splitBus(level(y, outWidth), outWidth) : [level(y, outWidth)]),
        ...(cascade ? [level(found, 1), level(none, 1)] : [found]),
      ],
    });

    const zero = bv.known(0, 1);
    const one = bv.known(1, 1);
    const disabled = [bv.known(0, outWidth), zero, zero] as const;
    // Enabled: the code is what every input that may be the top asserted one agrees on.
    const enabledOutputs = (): readonly [bv.BusValue, bv.BusValue, bv.BusValue] => {
      const unknownAbove = (from: number) =>
        Array.from({ length: n - from }, (_, k) => from + k).filter((i) => !isKnownZero(i));
      const codes = (indices: number[]) =>
        bv.agree(
          indices.map((i) => bv.known(i, outWidth)),
          outWidth,
        );
      if (winner !== -1) return [codes([winner, ...unknownAbove(winner + 1)]), one, zero];
      const maybe = unknownAbove(0);
      if (maybe.length === 0) return [bv.known(0, outWidth), zero, one];
      return [codes([0, ...maybe]), bv.allX(1), bv.allX(1)];
    };

    if (ei && knownAt(ei, 1 - asserted)) return withY(...disabled);
    const enabled = enabledOutputs();
    if (!ei || knownAt(ei, asserted)) return withY(...enabled);
    return withY(
      bv.agree([enabled[0], disabled[0]], outWidth),
      bv.agree([enabled[1], disabled[1]], 1),
      bv.agree([enabled[2], disabled[2]], 1),
    );
  },
  defaultPart: '74LS148',
};
