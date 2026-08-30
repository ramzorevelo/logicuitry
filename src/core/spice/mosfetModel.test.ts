import { describe, expect, it } from 'vitest';
import { inverterVtc } from './mosfetModel';
import type { InverterParams } from './types';

const base: InverterParams = { vdd: 5, wpwn: 2, temperature: 25, points: 201 };

describe('mosfetModel: inverter VTC', () => {
  it('rails: near VDD at Vin=0 and near 0 at Vin=VDD', () => {
    const s = inverterVtc(base);
    expect(s.vout[0]!).toBeGreaterThan(4.9);
    expect(s.vout.at(-1)!).toBeLessThan(0.1);
  });

  it('is monotonically non-increasing (an inverter)', () => {
    const s = inverterVtc(base);
    for (let i = 1; i < s.vout.length; i++) {
      expect(s.vout[i]!).toBeLessThanOrEqual(s.vout[i - 1]! + 1e-6);
    }
  });

  it('matched drive (Wp/Wn = 2) switches near VDD/2', () => {
    const s = inverterVtc(base);
    let vm = 0;
    for (let i = 1; i < s.vin.length; i++) {
      if (s.vout[i - 1]! - s.vin[i - 1]! >= 0 && s.vout[i]! - s.vin[i]! < 0) {
        vm = s.vin[i]!;
        break;
      }
    }
    expect(vm).toBeGreaterThan(2.0);
    expect(vm).toBeLessThan(3.0);
  });

  it('weakening the PMOS moves the switching threshold lower', () => {
    const vmOf = (wpwn: number) => {
      const s = inverterVtc({ ...base, wpwn });
      for (let i = 1; i < s.vin.length; i++)
        if (s.vout[i - 1]! - s.vin[i - 1]! >= 0 && s.vout[i]! - s.vin[i]! < 0) return s.vin[i]!;
      return 0;
    };
    expect(vmOf(1)).toBeLessThan(vmOf(3));
  });

  it('annotates operating regions across the sweep', () => {
    const s = inverterVtc(base);
    expect(s.regionN[0]).toBe('cutoff'); // NMOS off at Vin=0
    expect(s.regionP.at(-1)).toBe('cutoff'); // PMOS off at Vin=VDD
    expect(new Set(s.regionN).has('saturation')).toBe(true);
  });

  it('is deterministic', () => {
    expect(inverterVtc(base)).toEqual(inverterVtc(base));
  });
});
