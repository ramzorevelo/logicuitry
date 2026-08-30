// Exercises the real ngspice-wasm engine end-to-end (netlist -> sim -> mapper ->
// metrics) in Node, without the Web Worker transport (covered by build + dev
// smoke). Confirms the BSIM3 card solves and yields a sane inverter VTC.

import { Simulation } from 'eecircuit-engine';
import { describe, expect, it } from 'vitest';
import { inverterNetlist } from '../netlists/inverter';
import type { InverterParams, SweepResult } from '../types';
import { analyzeVtc } from '../vtcAnalysis';
import { resultToSweep } from './resultToSweep';
import type { SpiceResult } from './protocol';

async function realSweep(params: InverterParams): Promise<SweepResult> {
  const sim = new Simulation();
  await sim.start();
  sim.setNetList(inverterNetlist(params));
  const raw = await sim.runSim();
  if (raw.dataType !== 'real') throw new Error(`unexpected ${raw.dataType} result`);
  const result: SpiceResult = {
    variableNames: raw.variableNames,
    columns: raw.data.map((d) => ({ name: d.name, values: d.values })),
  };
  return resultToSweep(result, params.vdd);
}

describe('eecircuit real ngspice (integration)', () => {
  it('produces a monotonic rail-to-rail inverter VTC with a sane VM', async () => {
    const s = await realSweep({ vdd: 5, wpwn: 2, temperature: 25, points: 101 });
    expect(s.engine).toBe('eecircuit');
    expect(s.vin.length).toBe(s.vout.length);

    const voh = s.vout[0]!;
    const vol = s.vout[s.vout.length - 1]!;
    expect(voh).toBeGreaterThan(4.5); // output high near rail at Vin=0
    expect(vol).toBeLessThan(0.5); // output low near rail at Vin=VDD

    for (let i = 1; i < s.vout.length; i++) {
      expect(s.vout[i]!).toBeLessThanOrEqual(s.vout[i - 1]! + 1e-6);
    }

    const m = analyzeVtc(s);
    expect(m.vm).toBeGreaterThan(1.5);
    expect(m.vm).toBeLessThan(3.5);
    expect(m.nmh).toBeGreaterThan(0);
    expect(m.nml).toBeGreaterThan(0);
  }, 30000);

  it('shifts VM upward as the PMOS is made stronger', async () => {
    const weak = analyzeVtc(await realSweep({ vdd: 5, wpwn: 1, temperature: 25, points: 81 }));
    const strong = analyzeVtc(await realSweep({ vdd: 5, wpwn: 3, temperature: 25, points: 81 }));
    expect(strong.vm).toBeGreaterThan(weak.vm);
  }, 30000);
});
