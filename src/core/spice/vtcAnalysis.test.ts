import { describe, expect, it } from 'vitest';
import { inverterVtc } from './mosfetModel';
import { analyzeVtc } from './vtcAnalysis';
import type { SweepResult } from './types';

describe('analyzeVtc', () => {
  it('extracts ordered thresholds and margins from a real VTC', () => {
    const m = analyzeVtc(inverterVtc({ vdd: 5, wpwn: 2, temperature: 25, points: 401 }));
    // Threshold ordering: 0 < VOL < VIL < VM < VIH < VOH < VDD.
    expect(m.vol).toBeLessThan(m.vil);
    expect(m.vil).toBeLessThan(m.vm);
    expect(m.vm).toBeLessThan(m.vih);
    expect(m.vih).toBeLessThan(m.voh);
    expect(m.voh).toBeLessThan(5.001);
    // Both noise margins positive for a working inverter.
    expect(m.nmh).toBeGreaterThan(0);
    expect(m.nml).toBeGreaterThan(0);
    expect(m.nmh).toBeCloseTo(m.voh - m.vih, 10);
    expect(m.nml).toBeCloseTo(m.vil - m.vol, 10);
  });

  it('reads an ideal step VTC (gain -> infinity) at the mid point', () => {
    // Synthetic sharp inverter: high until 2.5V, low after.
    const vin: number[] = [];
    const vout: number[] = [];
    for (let k = 0; k <= 100; k++) {
      const v = (5 * k) / 100;
      vin.push(v);
      vout.push(v < 2.5 ? 5 : 0);
    }
    const sweep: SweepResult = {
      vin,
      vout,
      regionN: vin.map(() => 'saturation'),
      regionP: vin.map(() => 'saturation'),
    };
    const m = analyzeVtc(sweep);
    expect(m.vm).toBeCloseTo(2.5, 1);
    expect(m.voh).toBe(5);
    expect(m.vol).toBe(0);
  });
});
