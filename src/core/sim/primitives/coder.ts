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

/**
 * Ideal H&H-style decoder (not 74LS138-faithful: active-high only, no triple
 * enable). en known-0 dominates to all-0; otherwise unknown sel/en -> all-X.
 */
export const decoder: PrimitiveSpec = {
  kind: 'decoder',
  pins: (params) => {
    const selWidth = decoderAddressBits(params);
    const hasEnable = boolParam(params, 'hasEnable', false);
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

    if (hasEnable) pins.push({ name: 'en', dir: 'in', width: 1, role: 'enable', order: 0 });

    if (pinViewOf(view, 'y', 'expanded') === 'collapsed') {
      pins.push({ name: 'y', dir: 'out', width: n, role: 'data', order: 0 });
    } else {
      for (let i = 0; i < n; i++)
        pins.push({ name: `y${i}`, dir: 'out', width: 1, role: 'data', order: i });
    }
    return reindexPins(pins);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const selWidth = decoderAddressBits(ctx.params);
    const hasEnable = boolParam(ctx.params, 'hasEnable', false);
    const n = 1 << selWidth;
    const view = parsePinView(ctx.params);
    let cursor = 0;

    const selExpanded = selWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    const selSpan = selExpanded ? selWidth : 1;
    const selRaw = ctx.inputs.slice(cursor, cursor + selSpan);
    cursor += selSpan;
    const sel = selExpanded ? assembleBus(selRaw) : selRaw[0]!;

    const en = hasEnable ? ctx.inputs[cursor] : undefined;

    const yCollapsed = pinViewOf(view, 'y', 'expanded') === 'collapsed';
    const withOutputs = (values: bv.BusValue[]): EvalResult => ({
      outputs: yCollapsed ? [packIndexed(values)] : values,
    });

    if (en) {
      if (bv.isFullyKnown(en, 1) && (en.v & 1) === 0) {
        return withOutputs(Array.from({ length: n }, () => bv.known(0, 1)));
      }
      if (!bv.isFullyKnown(en, 1)) {
        return withOutputs(Array.from({ length: n }, () => bv.allX(1)));
      }
    }
    if (!bv.isFullyKnown(sel, selWidth)) {
      return withOutputs(Array.from({ length: n }, () => bv.allX(1)));
    }
    const idx = sel.v;
    return withOutputs(Array.from({ length: n }, (_, i) => bv.known(i === idx ? 1 : 0, 1)));
  },
  defaultPart: '74LS138',
};

/**
 * Priority encoder, highest index wins. Output defined iff every input above
 * the winner is known-0; unknowns below the winner don't matter. `valid` is 0
 * only when every input is known-0, else X when no winner and not all-0.
 */
export const encoder: PrimitiveSpec = {
  kind: 'encoder',
  pins: (params) => {
    const outWidth = encoderAddressBits(params);
    const n = 1 << outWidth;
    const view = parsePinView(params);
    const pins: PrimitivePin[] = [];

    if (pinViewOf(view, 'i', 'expanded') === 'collapsed') {
      pins.push({ name: 'i', dir: 'in', width: n, role: 'data', order: 0 });
    } else {
      for (let i = 0; i < n; i++)
        pins.push({ name: `i${i}`, dir: 'in', width: 1, role: 'data', order: i });
    }

    const yBase: PrimitivePin = { name: 'a', dir: 'out', width: outWidth, role: 'data', order: 0 };
    const yExpanded = outWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    pins.push(...(yExpanded ? expandPin(yBase, outWidth, false) : [yBase]));
    pins.push({ name: 'valid', dir: 'out', width: 1, role: 'data', order: 1 });
    return reindexPins(pins);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const outWidth = encoderAddressBits(ctx.params);
    const n = 1 << outWidth;
    const view = parsePinView(ctx.params);
    let cursor = 0;

    let inputs: bv.BusValue[];
    if (pinViewOf(view, 'i', 'expanded') === 'collapsed') {
      inputs = unpackIndexed(ctx.inputs[cursor]!, n);
      cursor += 1;
    } else {
      inputs = ctx.inputs.slice(cursor, cursor + n);
      cursor += n;
    }

    const isKnownOne = (i: number) => bv.isFullyKnown(inputs[i]!, 1) && (inputs[i]!.v & 1) === 1;
    const isKnownZero = (i: number) => bv.isFullyKnown(inputs[i]!, 1) && (inputs[i]!.v & 1) === 0;
    let winner = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (isKnownOne(i)) {
        winner = i;
        break;
      }
    }

    const yExpanded = outWidth > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    const withY = (y: bv.BusValue, valid: bv.BusValue): EvalResult => ({
      outputs: [...(yExpanded ? splitBus(y, outWidth) : [y]), valid],
    });

    if (winner === -1) {
      let allZero = true;
      for (let i = 0; i < n; i++) if (!isKnownZero(i)) allZero = false;
      if (allZero) return withY(bv.known(0, outWidth), bv.known(0, 1));
      return withY(bv.allX(outWidth), bv.allX(1));
    }
    let definedAbove = true;
    for (let i = winner + 1; i < n; i++) if (!isKnownZero(i)) definedAbove = false;
    if (!definedAbove) return withY(bv.allX(outWidth), bv.allX(1));
    return withY(bv.known(winner, outWidth), bv.known(1, 1));
  },
  defaultPart: '74LS148',
};
