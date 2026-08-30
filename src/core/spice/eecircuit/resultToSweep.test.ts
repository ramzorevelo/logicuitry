import { describe, expect, it } from 'vitest';
import { resultToSweep } from './resultToSweep';
import { VTH0N, VTH0P } from '../models/cmos-bsim3';
import type { SpiceResult } from './protocol';

// Minimal 3-sample inverter sweep at VDD=5: input low / mid / high.
function fixture(): SpiceResult {
  return {
    variableNames: ['v(v-sweep)', 'v(vin)', 'v(vout)'],
    columns: [
      { name: 'v(v-sweep)', values: [0, 2.5, 5] },
      { name: 'v(vin)', values: [0, 2.5, 5] },
      { name: 'v(vout)', values: [5, 2.5, 0] },
    ],
  };
}

describe('resultToSweep', () => {
  it('maps vin/vout columns and marks the eecircuit engine', () => {
    const s = resultToSweep(fixture(), 5);
    expect(s.vin).toEqual([0, 2.5, 5]);
    expect(s.vout).toEqual([5, 2.5, 0]);
    expect(s.engine).toBe('eecircuit');
  });

  it('derives operating regions from Vgs/Vds vs VTH0', () => {
    const s = resultToSweep(fixture(), 5);
    // Vin=0: NMOS gate below VTH0N -> cutoff; PMOS fully on (|Vgs|=5) -> linear (Vds~0).
    expect(s.regionN[0]).toBe('cutoff');
    expect(s.regionP[0]).toBe('linear');
    // Vin=5: NMOS on hard (Vds~0) -> linear; PMOS gate off -> cutoff.
    expect(s.regionN[2]).toBe('linear');
    expect(s.regionP[2]).toBe('cutoff');
    // Mid: both conducting in saturation near the switching threshold.
    expect(s.regionN[1]).toBe('saturation');
    expect(s.regionP[1]).toBe('saturation');
  });

  it('reflects the real thresholds in the boundary math', () => {
    // Just above NMOS threshold with small Vds -> linear, not cutoff.
    const r: SpiceResult = {
      variableNames: ['v(vin)', 'v(vout)'],
      columns: [
        { name: 'v(vin)', values: [VTH0N + 0.1] },
        { name: 'v(vout)', values: [0.01] },
      ],
    };
    const s = resultToSweep(r, 5);
    expect(s.regionN[0]).toBe('linear');
    expect(VTH0P).toBeGreaterThan(0); // magnitude convention
  });

  it('falls back to v(v-sweep) when v(vin) is absent', () => {
    const r: SpiceResult = {
      variableNames: ['v(v-sweep)', 'v(vout)'],
      columns: [
        { name: 'v(v-sweep)', values: [0, 5] },
        { name: 'v(vout)', values: [5, 0] },
      ],
    };
    expect(resultToSweep(r, 5).vin).toEqual([0, 5]);
  });

  it('throws when vout is missing', () => {
    const r: SpiceResult = {
      variableNames: ['v(vin)'],
      columns: [{ name: 'v(vin)', values: [0, 5] }],
    };
    expect(() => resultToSweep(r, 5)).toThrow(/vout/);
  });
});
