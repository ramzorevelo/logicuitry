// Extract the DC transfer metrics from a VTC sweep the way the course teaches:
// VIL/VIH are the unity-gain points (dVout/dVin = -1), VOH/VOL the outputs there,
// VM the Vout = Vin crossing, and the noise margins the gaps between them. Pure.

import type { SweepResult } from './types';

export interface VtcMetrics {
  vil: number;
  vih: number;
  vol: number;
  voh: number;
  vm: number;
  nmh: number; // VOH - VIH
  nml: number; // VIL - VOL
}

function slopeAt(vin: number[], vout: number[], i: number): number {
  const lo = Math.max(0, i - 1);
  const hi = Math.min(vin.length - 1, i + 1);
  const dv = vin[hi]! - vin[lo]!;
  return dv === 0 ? 0 : (vout[hi]! - vout[lo]!) / dv;
}

export function analyzeVtc(sweep: SweepResult): VtcMetrics {
  const { vin, vout } = sweep;
  const n = vin.length;

  // Unity-gain points: first and last sample where the slope is at least as
  // steep as -1. VIL is the low-Vin one (output still high), VIH the high one.
  let vilIdx = 0;
  let vihIdx = n - 1;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (slopeAt(vin, vout, i) <= -1) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first >= 0) {
    vilIdx = first;
    vihIdx = last;
  }

  const vil = vin[vilIdx]!;
  const vih = vin[vihIdx]!;
  const voh = vout[vilIdx]!;
  const vol = vout[vihIdx]!;

  // VM: Vout = Vin crossing, linearly interpolated.
  let vm = vin[0]!;
  for (let i = 1; i < n; i++) {
    const a = vout[i - 1]! - vin[i - 1]!;
    const b = vout[i]! - vin[i]!;
    if (a === 0) {
      vm = vin[i - 1]!;
      break;
    }
    if (a > 0 !== b > 0) {
      const t = a / (a - b);
      vm = vin[i - 1]! + t * (vin[i]! - vin[i - 1]!);
      break;
    }
  }

  return { vil, vih, vol, voh, vm, nmh: voh - vih, nml: vil - vol };
}
