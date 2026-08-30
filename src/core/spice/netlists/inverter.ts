// SPICE netlist for the CMOS inverter DC sweep. eecircuit-engine runs exactly
// this text; the Device Lab "show netlist" drawer displays it as a teaching beat
// (real BSIM3 device models included). The numeric fallback ignores it and
// solves its own square-law model.

import type { InverterParams } from '../types';
import {
  CHANNEL_L_UM,
  NMOS_CARD,
  NMOS_MODEL,
  PMOS_CARD,
  PMOS_MODEL,
  WN_UM,
} from '../models/cmos-bsim3';

// step over [0, VDD] that yields exactly `points` samples in ngspice `.dc`.
export function sweepStep(p: InverterParams): number {
  const n = Math.max(2, p.points ?? 201);
  return p.vdd / (n - 1);
}

export function inverterNetlist(p: InverterParams): string {
  const step = sweepStep(p).toFixed(6);
  const wp = (WN_UM * p.wpwn).toFixed(4);
  return [
    'CMOS inverter VTC (TSMC 180nm BSIM3, ngspice level 49)',
    `.temp ${p.temperature}`,
    `VDD vdd 0 ${p.vdd}`,
    'VIN vin 0 0',
    '* PMOS source at VDD, NMOS source at GND; Wp scales with the Wp/Wn slider',
    `MP vout vin vdd vdd ${PMOS_MODEL} W=${wp}u L=${CHANNEL_L_UM}u`,
    `MN vout vin 0 0 ${NMOS_MODEL} W=${WN_UM}u L=${CHANNEL_L_UM}u`,
    NMOS_CARD,
    PMOS_CARD,
    `.dc VIN 0 ${p.vdd} ${step}`,
    '.end',
  ].join('\n');
}
