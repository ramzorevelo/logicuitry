// Delay models the kernel schedules output changes through. Ideal mode uses a
// unit delay (1 ps) so causality is preserved and single-stepping ripples
// gate-by-gate; datasheet mode maps primitives to real 74LS figures.

import type { BusValue } from '../value/busValue';
import type { CompiledPrimitive } from '../model/compile';
import { arcPropagationNs, outputPropagationNs } from '../parts/arcs';
import {
  column as columnOf,
  getPart,
  type DatasheetColumn,
  type OutputEdge,
  type TypMax,
} from '../parts/partsDb';
import { getPrimitive } from './primitives/registry';

export interface DelayModel {
  /** Delay in integer ps for prim's output changing from oldValue to newValue;
   *  changedInputs are the input slots that moved since the last evaluation. */
  delayPs(
    prim: CompiledPrimitive,
    out: number,
    oldValue: BusValue,
    newValue: BusValue,
    changedInputs?: readonly number[],
  ): number;
}

export const IDEAL_DELAY_PS = 1;

export const idealDelay: DelayModel = {
  delayPs: () => IDEAL_DELAY_PS,
};

const NS_TO_PS = 1000;
/** Unbound primitives in datasheet mode fall back to a generic LS-family 10 ns. */
export const FALLBACK_NS = 10;

/**
 * A generated chip's power gate and output buffers are wiring, not silicon
 * with a datasheet row: they pass a value on in one delta and add no time.
 */
export function isStructuralHop(prim: CompiledPrimitive): boolean {
  return prim.params['delay'] === 'none';
}

/**
 * A 3-state output buffer passes data in one delta like any structural hop,
 * but going to or from Z takes its part's enable or disable time: the '374's
 * /OC. Undefined when the change is not an enable edge or no row is bound.
 */
function enableEdgeNs(
  prim: CompiledPrimitive,
  oldValue: BusValue,
  newValue: BusValue,
  col: DatasheetColumn,
): number | undefined {
  const part = prim.params['enableTiming'];
  const row = typeof part === 'string' ? getPart(part)?.enable : undefined;
  if (!row || !(oldValue.z | newValue.z)) return undefined;
  const level = (value: BusValue) => (value.x ? undefined : value.v ? 'h' : 'l');
  const figure = (high: TypMax, low: TypMax, value: BusValue) => {
    const l = level(value);
    const [h, lo] = [columnOf(high, col), columnOf(low, col)];
    return l === 'h' ? h : l === 'l' ? lo : Math.max(h, lo);
  };
  if (newValue.z && !oldValue.z) return figure(row.tphz, row.tplz, oldValue);
  if (oldValue.z && !newValue.z) return figure(row.tpzh, row.tpzl, newValue);
  return undefined;
}

export interface PinNames {
  ins: string[];
  outs: string[];
}

export function pinNamesOf(prim: CompiledPrimitive): PinNames {
  const pins = getPrimitive(prim.kind).pins(prim.params);
  return {
    ins: pins.filter((x) => x.dir === 'in').map((x) => x.name),
    outs: pins.filter((x) => x.dir === 'out').map((x) => x.name),
  };
}

export function datasheetDelay(column: DatasheetColumn): DelayModel {
  // Checked against params too: a live param edit can change the pin list.
  const names = new WeakMap<CompiledPrimitive, { params: unknown; pins: PinNames }>();
  const pinsOf = (prim: CompiledPrimitive): PinNames => {
    const hit = names.get(prim);
    if (hit && hit.params === prim.params) return hit.pins;
    const pins = pinNamesOf(prim);
    names.set(prim, { params: prim.params, pins });
    return pins;
  };
  return {
    delayPs(prim, out, oldValue, newValue, changedInputs): number {
      if (isStructuralHop(prim)) {
        const enableNs = enableEdgeNs(prim, oldValue, newValue, column);
        return enableNs === undefined ? IDEAL_DELAY_PS : Math.round(enableNs * NS_TO_PS);
      }
      if (!prim.part) return FALLBACK_NS * NS_TO_PS;
      const part = prim.part;
      const { ins, outs } = pinsOf(prim);
      const outPin = outs[out]!;
      const moved = changedInputs?.flatMap((i) => (ins[i] === undefined ? [] : [ins[i]]));
      // The row this edge follows is the arc from the inputs that moved; an
      // edge no moved input times (a state write, a wake) takes the slowest.
      const figure = (edge: OutputEdge): number =>
        (moved?.length ? arcPropagationNs(part, moved, outPin, edge, column) : undefined) ??
        outputPropagationNs(part, ins, outPin, edge, column) ??
        FALLBACK_NS;
      // A clean 0->1 output edge takes tPLH, 1->0 takes tPHL; anything
      // involving X/Z or multi-bit mixes takes the slower of the two.
      const lh = figure('lh');
      const hl = figure('hl');
      const clean = (oldValue.x | oldValue.z | newValue.x | newValue.z) === 0;
      const rising = clean ? newValue.v & ~oldValue.v : 1;
      const falling = clean ? oldValue.v & ~newValue.v : 1;
      const ns = rising && falling ? Math.max(lh, hl) : rising ? lh : hl;
      return Math.round(ns * NS_TO_PS);
    },
  };
}
