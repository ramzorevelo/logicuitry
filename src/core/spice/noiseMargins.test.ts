import { describe, expect, it } from 'vitest';
import { familyLevels, interopMargins, marginSteps, selfMargins } from './noiseMargins';

describe('noiseMargins', () => {
  it('computes 74LS self margins from the parts DB levels', () => {
    const ls = familyLevels()['74LS']!;
    // 74LS: VOH 2.7, VOL 0.5, VIH 2.0, VIL 0.8 -> NMH 0.7, NML 0.3.
    const m = selfMargins(ls);
    expect(m.nmh).toBeCloseTo(0.7, 6);
    expect(m.nml).toBeCloseTo(0.3, 6);
    expect(m.violations).toEqual([]);
  });

  it('flags 74LS driving 5V CMOS as a VOH/VIH violation', () => {
    const levels = familyLevels();
    const m = interopMargins(levels['74LS']!, levels['CMOS-5V']!);
    // 74LS VOH(min) 2.7 < CMOS VIH(min) 3.5 -> negative high margin.
    expect(m.nmh).toBeLessThan(0);
    expect(m.violations.length).toBeGreaterThan(0);
  });

  it('CMOS driving 74LS is comfortable', () => {
    const levels = familyLevels();
    const m = interopMargins(levels['CMOS-5V']!, levels['74LS']!);
    expect(m.nmh).toBeGreaterThan(0);
    expect(m.nml).toBeGreaterThan(0);
    expect(m.violations).toEqual([]);
  });

  it('exposes the 74HC and 74HCT datasheet families', () => {
    const levels = familyLevels();
    // 74HC: VOH 3.84, VOL 0.33, VIH 3.15, VIL 1.35 (TI SN74HC00).
    expect(levels['74HC']).toEqual({ vohMin: 3.84, volMax: 0.33, vihMin: 3.15, vilMax: 1.35 });
    // 74HCT: TTL-compatible inputs (VIH 2.0, VIL 0.8) (TI SN74HCT00).
    expect(levels['74HCT']).toEqual({ vohMin: 3.84, volMax: 0.33, vihMin: 2.0, vilMax: 0.8 });
  });

  it('flags 74LS driving 74HC (CMOS inputs) as a high-margin violation', () => {
    const levels = familyLevels();
    // 74LS VOH(min) 2.7 < 74HC VIH(min) 3.15 -> negative NMH, the classic pull-up lesson.
    const m = interopMargins(levels['74LS']!, levels['74HC']!);
    expect(m.nmh).toBeLessThan(0);
    expect(m.violations.length).toBeGreaterThan(0);
  });

  it('74LS drives 74HCT cleanly (TTL-compatible inputs)', () => {
    const levels = familyLevels();
    // 74LS VOH(min) 2.7 >= 74HCT VIH(min) 2.0 -> positive margins, no violation.
    const m = interopMargins(levels['74LS']!, levels['74HCT']!);
    // NMH = 2.7 - 2.0 = 0.7; NML = 0.8 - 0.5 = 0.3 (74LS driver VOL 0.5).
    expect(m.nmh).toBeCloseTo(0.7, 6);
    expect(m.nml).toBeCloseTo(0.3, 6);
    expect(m.violations).toEqual([]);
  });

  it('74HC self-margins are the wide CMOS margins', () => {
    const m = selfMargins(familyLevels()['74HC']!);
    // NMH = 3.84 - 3.15 = 0.69; NML = 1.35 - 0.33 = 1.02.
    expect(m.nmh).toBeCloseTo(0.69, 6);
    expect(m.nml).toBeCloseTo(1.02, 6);
    expect(m.violations).toEqual([]);
  });
});

describe('marginSteps', () => {
  const f = familyLevels();

  it('writes NMH and NML out term by term from the same numbers as interopMargins', () => {
    const ls = f['74LS']!;
    const steps = marginSteps(ls, ls);
    const m = interopMargins(ls, ls);
    expect(steps.map((s) => s.label)).toEqual(['NMH', 'NML']);
    expect(steps[0]!.result).toBe(`${m.nmh.toFixed(2)} V`);
    expect(steps[1]!.result).toBe(`${m.nml.toFixed(2)} V`);
    expect(steps[0]!.substitution).toContain(ls.vohMin.toFixed(2));
    expect(steps[0]!.substitution).toContain(ls.vihMin.toFixed(2));
  });

  it('marks the failing term when 74LS drives 74HC, and passes into 74HCT', () => {
    expect(marginSteps(f['74LS']!, f['74HC']!).find((s) => s.label === 'NMH')!.ok).toBe(false);
    expect(marginSteps(f['74LS']!, f['74HCT']!).every((s) => s.ok)).toBe(true);
  });
});
