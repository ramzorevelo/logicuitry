// Delay models the kernel schedules output changes through. Ideal mode uses a
// unit delay (1 ps) so causality is preserved and single-stepping ripples
// gate-by-gate; datasheet mode maps primitives to real 74LS figures.

import { widthMask, type BusValue } from '../value/busValue';
import type { CompiledPrimitive } from '../model/compile';
import { arcPropagationNs, outputPropagationNs } from '../parts/arcs';
import {
  column as columnOf,
  getPart,
  type DatasheetColumn,
  type EnableRow,
  type OutputEdge,
  type TypMax,
} from '../parts/partsDb';
import { getPrimitive } from './primitives/registry';
import { inputSlotPins, outputSlotPins } from '../model/pinSlots';

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
 * The enable rows an edge may follow: a moved input with a row of its own takes
 * that one, any other the part's `enable`. Several candidates time as the slowest.
 */
function enableRows(part: unknown, moved?: readonly string[]): EnableRow[] {
  const entry = typeof part === 'string' ? getPart(part) : undefined;
  if (!entry) return [];
  const own = entry.enable_from ?? {};
  const rows = (moved ?? []).flatMap((pin) => (own[pin] ? [own[pin]] : []));
  const needsShared = !moved?.length || moved.some((pin) => !own[pin]);
  if (needsShared && entry.enable) rows.push(entry.enable);
  return rows;
}

/**
 * An output going to or from Z takes the enable or disable time of the given
 * rows, the slowest when there are several. Undefined when the change is not
 * an enable edge or no row applies.
 */
function enableEdgeNs(
  rows: readonly EnableRow[],
  oldValue: BusValue,
  newValue: BusValue,
  col: DatasheetColumn,
  width = 1,
): number | undefined {
  if (rows.length === 0 || !(oldValue.z | newValue.z)) return undefined;
  const mask = widthMask(width);
  // A bus with mixed levels takes the slower figure, as an unknown one does.
  const level = (value: BusValue) => {
    if (value.x) return undefined;
    const ones = (value.v & mask) >>> 0;
    return ones === mask ? 'h' : ones === 0 ? 'l' : undefined;
  };
  const figure = (high: TypMax, low: TypMax, value: BusValue) => {
    const l = level(value);
    const [h, lo] = [columnOf(high, col), columnOf(low, col)];
    return l === 'h' ? h : l === 'l' ? lo : Math.max(h, lo);
  };
  const slowest = (pick: (row: EnableRow) => number) => Math.max(...rows.map(pick));
  if (newValue.z && !oldValue.z) return slowest((row) => figure(row.tphz, row.tplz, oldValue));
  if (oldValue.z && !newValue.z) return slowest((row) => figure(row.tpzh, row.tpzl, newValue));
  return undefined;
}

export interface PinNames {
  ins: string[];
  outs: string[];
}

export function pinNamesOf(prim: CompiledPrimitive): PinNames {
  const pins = getPrimitive(prim.kind).pins(prim.params);
  return {
    ins: inputSlotPins(pins).map((x) => x.name),
    outs: outputSlotPins(pins).map((x) => x.name),
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
        const rows = enableRows(prim.params['enableTiming']);
        const enableNs = enableEdgeNs(rows, oldValue, newValue, column);
        return enableNs === undefined ? IDEAL_DELAY_PS : Math.round(enableNs * NS_TO_PS);
      }
      if (!prim.part) return FALLBACK_NS * NS_TO_PS;
      const part = prim.part;
      const { ins, outs } = pinsOf(prim);
      const moved = changedInputs?.flatMap((i) => (ins[i] === undefined ? [] : [ins[i]]));
      if (oldValue.z | newValue.z) {
        const width = outputSlotPins(getPrimitive(prim.kind).pins(prim.params))[out]?.width;
        const enableNs = enableEdgeNs(enableRows(part, moved), oldValue, newValue, column, width);
        if (enableNs !== undefined) return Math.round(enableNs * NS_TO_PS);
      }
      const outPin = outs[out]!;
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
