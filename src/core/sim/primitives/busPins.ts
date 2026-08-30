// The two conventions differ on purpose, because they describe different
// things.
//
// LANE (expandPin/assembleBus/splitBus) splits one wide signal into its bits,
// so it reads like a written binary number: array index 0 is the MSB and
// renders as the topmost row (gates.ts/chip.ts lay out pin rows in array
// order). A bank of switches then lines up with a mux's MSB-leftmost select
// row without its wires crossing.
//
// INDEXED (packIndexed/unpackIndexed) addresses individually numbered lines
// (mux/demux data + select, decoder/encoder one-hot), where array index IS
// the line number by construction (idx |= sel[i].v << i) and H&H draws d0/y0
// at the top. So these stay index-0-first, and assembleBus/splitBus reverse
// on the way in and out.

import * as bv from '../../value/busValue';
import type { BusValue } from '../../value/busValue';
import type { Params, PrimitivePin } from './types';

export type PinViewState = 'expanded' | 'collapsed';
export type PinViewMap = Readonly<Record<string, PinViewState>>;

/** Compact `name=state;name=state` string -- keeps ParamValue string|number|boolean. */
export function parsePinView(params: Params): PinViewMap {
  const raw = params['pinView'];
  if (typeof raw !== 'string' || raw.length === 0) return {};
  const out: Record<string, PinViewState> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    const state = part.slice(eq + 1);
    if (name && (state === 'expanded' || state === 'collapsed')) out[name] = state;
  }
  return out;
}

export function serializePinView(map: PinViewMap): string {
  return Object.entries(map)
    .filter(([, v]) => v === 'expanded' || v === 'collapsed')
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
}

export function pinViewOf(map: PinViewMap, name: string, fallback: PinViewState): PinViewState {
  return map[name] ?? fallback;
}

/** Split one width-w pin into w 1-bit pins, MSB first (top row). `name`
 *  stays the plain concatenated wiring identifier (`d03`); `label` is the
 *  bracket-notation display text (`d0[3]`) glyphs render instead, unless
 *  `bracketLabels` is false (individually-addressed lines like decoder/
 *  encoder's coded side, where a bracket would be wrong). `order` is left at
 *  0; callers reindex the flattened pin list afterward. */
export function expandPin(base: PrimitivePin, width: number, bracketLabels = true): PrimitivePin[] {
  const pins: PrimitivePin[] = [];
  for (let bit = width - 1; bit >= 0; bit--) {
    pins.push({
      ...base,
      name: `${base.name}${bit}`,
      label: bracketLabels ? `${base.name}[${bit}]` : `${base.name}${bit}`,
      width: 1,
      order: 0,
    });
  }
  return pins;
}

/** Renumber `order` 0..n-1 in array order. */
export function reindexPins(pins: PrimitivePin[]): PrimitivePin[] {
  return pins.map((p, i) => ({ ...p, order: i }));
}

/** Assemble w 1-bit values (MSB first, matching expandPin's row order) into
 *  one width-w BusValue. */
export function assembleBus(bitsMsbFirst: readonly BusValue[]): BusValue {
  return packIndexed([...bitsMsbFirst].reverse());
}

/** Inverse of assembleBus: split into w 1-bit values, MSB first. */
export function splitBus(value: BusValue, width: number): BusValue[] {
  return unpackIndexed(value, width).reverse();
}

/** Pack n independently-indexed 1-bit values (index 0 = bit 0, i.e. LSB) into
 *  one n-wide BusValue. */
export function packIndexed(bitsLsbFirst: readonly BusValue[]): BusValue {
  return bv.concat(bitsLsbFirst.map((value) => ({ value, width: 1 })));
}

/** Inverse of packIndexed: n 1-bit values, index 0 = bit 0. */
export function unpackIndexed(value: BusValue, width: number): BusValue[] {
  const out: BusValue[] = [];
  for (let i = 0; i < width; i++) out.push(bv.slice(value, i, 1));
  return out;
}
