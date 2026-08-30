// Delay models the kernel schedules output changes through. Ideal mode uses a
// unit delay (1 ps) so causality is preserved and single-stepping ripples
// gate-by-gate; datasheet mode maps primitives to real 74LS figures.

import type { BusValue } from '../value/busValue';
import type { CompiledPrimitive } from '../model/compile';
import { propagationNs, type DatasheetColumn } from '../parts/partsDb';

export interface DelayModel {
  /** Delay in integer ps for prim's output changing from oldValue to newValue. */
  delayPs(prim: CompiledPrimitive, out: number, oldValue: BusValue, newValue: BusValue): number;
}

export const IDEAL_DELAY_PS = 1;

export const idealDelay: DelayModel = {
  delayPs: () => IDEAL_DELAY_PS,
};

const NS_TO_PS = 1000;
/** Unbound primitives in datasheet mode fall back to a generic LS-family 10 ns. */
export const FALLBACK_NS = 10;

export function datasheetDelay(column: DatasheetColumn): DelayModel {
  return {
    delayPs(prim, _out, oldValue, newValue): number {
      if (!prim.part) return FALLBACK_NS * NS_TO_PS;
      // A clean 0->1 output edge takes tPLH, 1->0 takes tPHL; anything
      // involving X/Z or multi-bit mixes takes the slower of the two.
      const lh = propagationNs(prim.part, 'lh', column) ?? FALLBACK_NS;
      const hl = propagationNs(prim.part, 'hl', column) ?? FALLBACK_NS;
      const clean = (oldValue.x | oldValue.z | newValue.x | newValue.z) === 0;
      const rising = clean ? newValue.v & ~oldValue.v : 1;
      const falling = clean ? oldValue.v & ~newValue.v : 1;
      const ns = rising && falling ? Math.max(lh, hl) : rising ? lh : hl;
      return Math.round(ns * NS_TO_PS);
    },
  };
}
