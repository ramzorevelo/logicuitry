// Hand-written long-channel MOSFET model (square-law + channel-length
// modulation), the documented SPICE fallback. For each Vin
// it balances NMOS and PMOS drain currents at the output node and solves Vout by
// bisection: deterministic, monotone-bracketed, adequate for the VTC this course
// needs. The VTC shape depends only on threshold voltages, the strength ratio,
// and lambda; absolute currents cancel at the KCL balance, so they are omitted.

import type { InverterParams, Region, SweepResult } from './types';

interface DeviceParams {
  vthn: number;
  vthp: number; // magnitude
  lambda: number; // 1/V, channel-length modulation -> finite gain
  betaN: number;
  betaP: number;
}

const VTHN0 = 0.7;
const VTHP0 = 0.7;
const LAMBDA0 = 0.05;
// PMOS carrier mobility ~half of NMOS; Wp/Wn ratio compensates. Matched drive
// (VM ~ VDD/2) falls at wpwn = 2.
const MOBILITY_RATIO = 0.5;

function deviceParams(p: InverterParams): DeviceParams {
  const dT = p.temperature - 25;
  const vth = (v0: number) => Math.max(0.1, v0 - 2e-3 * dT); // ~ -2 mV/degC
  return {
    vthn: vth(VTHN0),
    vthp: vth(VTHP0),
    lambda: LAMBDA0,
    betaN: 1,
    betaP: MOBILITY_RATIO * p.wpwn,
  };
}

interface Branch {
  current: number;
  region: Region;
}

// NMOS: source at 0, gate at Vin, drain at Vout.
function nmos(vin: number, vout: number, p: DeviceParams): Branch {
  const vov = vin - p.vthn;
  if (vov <= 0) return { current: 0, region: 'cutoff' };
  const vds = vout;
  if (vds < vov) {
    const i = p.betaN * (vov * vds - (vds * vds) / 2) * (1 + p.lambda * vds);
    return { current: i, region: 'linear' };
  }
  const i = 0.5 * p.betaN * vov * vov * (1 + p.lambda * vds);
  return { current: i, region: 'saturation' };
}

// PMOS: source at VDD, gate at Vin, drain at Vout. Currents expressed as source->drain.
function pmos(vin: number, vout: number, vdd: number, p: DeviceParams): Branch {
  const vsg = vdd - vin;
  const vov = vsg - p.vthp;
  if (vov <= 0) return { current: 0, region: 'cutoff' };
  const vsd = vdd - vout;
  if (vsd < vov) {
    const i = p.betaP * (vov * vsd - (vsd * vsd) / 2) * (1 + p.lambda * vsd);
    return { current: i, region: 'linear' };
  }
  const i = 0.5 * p.betaP * vov * vov * (1 + p.lambda * vsd);
  return { current: i, region: 'saturation' };
}

/** Solve the output node voltage for one Vin. In(Vout) rises, Ip(Vout) falls. */
function solveVout(vin: number, vdd: number, p: DeviceParams): number {
  let lo = 0;
  let hi = vdd;
  const f = (vout: number) => nmos(vin, vout, p).current - pmos(vin, vout, vdd, p).current;
  // f(0) <= 0, f(vdd) >= 0; bisection converges monotonically.
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export function inverterVtc(params: InverterParams): SweepResult {
  const p = deviceParams(params);
  const n = Math.max(2, params.points ?? 201);
  const vin: number[] = [];
  const vout: number[] = [];
  const regionN: Region[] = [];
  const regionP: Region[] = [];
  for (let k = 0; k < n; k++) {
    const vi = (params.vdd * k) / (n - 1);
    const vo = solveVout(vi, params.vdd, p);
    vin.push(vi);
    vout.push(vo);
    regionN.push(nmos(vi, vo, p).region);
    regionP.push(pmos(vi, vo, params.vdd, p).region);
  }
  return { vin, vout, regionN, regionP };
}
