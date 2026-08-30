// Map an ngspice DC-sweep result into the SweepResult the Device Lab consumes.
// ngspice reports node voltages but not device operating regions, so regionN/P
// are derived from Vgs/Vds vs the model threshold, mirroring mosfetModel.ts.
// Pure: takes a parsed SpiceResult, does no I/O.

import { VTH0N, VTH0P } from '../models/cmos-bsim3';
import type { Region, SweepResult } from '../types';
import type { SpiceResult } from './protocol';

function column(result: SpiceResult, name: string): number[] | undefined {
  return result.columns.find((c) => c.name.toLowerCase() === name)?.values;
}

// NMOS: Vgs = Vin, Vds = Vout, source at ground.
function regionN(vin: number, vout: number): Region {
  const vov = vin - VTH0N;
  if (vov <= 0) return 'cutoff';
  return vout < vov ? 'linear' : 'saturation';
}

// PMOS: |Vgs| = VDD - Vin, |Vds| = VDD - Vout, source at VDD.
function regionP(vin: number, vout: number, vdd: number): Region {
  const vov = vdd - vin - VTH0P;
  if (vov <= 0) return 'cutoff';
  return vdd - vout < vov ? 'linear' : 'saturation';
}

export function resultToSweep(result: SpiceResult, vdd: number): SweepResult {
  const vin = column(result, 'v(vin)') ?? column(result, 'v(v-sweep)');
  const vout = column(result, 'v(vout)');
  if (!vin || !vout) {
    throw new Error(`sweep missing vin/vout (vars: ${result.variableNames.join(', ')})`);
  }
  const n = Math.min(vin.length, vout.length);
  const regN: Region[] = [];
  const regP: Region[] = [];
  for (let i = 0; i < n; i++) {
    regN.push(regionN(vin[i]!, vout[i]!));
    regP.push(regionP(vin[i]!, vout[i]!, vdd));
  }
  return {
    vin: vin.slice(0, n),
    vout: vout.slice(0, n),
    regionN: regN,
    regionP: regP,
    engine: 'eecircuit',
  };
}
