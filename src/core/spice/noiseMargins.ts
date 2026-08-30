// Logic-level noise margins from datasheet parameters, no SPICE. TTL (74LS) is
// computed exactly as the course and the exam pose it (SPICE
// is CMOS-only). The interoperability check flags a driver whose guaranteed
// output levels fail the receiver's input thresholds (e.g. 74LS -> 5V CMOS).

import { partsDb } from '../parts/partsDb';
import hc from '../parts/74hc.json';
import hct from '../parts/74hct.json';

export interface LevelSet {
  vohMin: number;
  volMax: number;
  vihMin: number;
  vilMax: number;
}

export interface FamilyMargins {
  nmh: number; // driver VOH(min) - receiver VIH(min)
  nml: number; // receiver VIL(max) - driver VOL(max)
  violations: string[];
}

interface FamilyFile {
  levels: { vohMin: number; volMax: number; vihMin: number; vilMax: number };
}

function pickLevels(f: FamilyFile): LevelSet {
  const l = f.levels;
  return { vohMin: l.vohMin, volMax: l.volMax, vihMin: l.vihMin, vilMax: l.vilMax };
}

// Ideal 5V CMOS reference: thresholds at 0.3/0.7 VDD, outputs swing rail-to-rail
// at light load (Harris & Harris 1.7). Kept as the theoretical CMOS baseline;
// 74HC/74HCT carry real datasheet limits from their parts files.
const CMOS_5V: LevelSet = { vohMin: 4.4, volMax: 0.1, vihMin: 3.5, vilMax: 1.5 };

/** Standard input/output levels per logic family, from the parts DB. */
export function familyLevels(): Record<string, LevelSet> {
  const ttl = partsDb().levels;
  return {
    '74LS': {
      vohMin: ttl.vohMin,
      volMax: ttl.volMax,
      vihMin: ttl.vihMin,
      vilMax: ttl.vilMax,
    },
    '74HC': pickLevels(hc as FamilyFile),
    '74HCT': pickLevels(hct as FamilyFile),
    'CMOS-5V': CMOS_5V,
  };
}

/** High and low noise margins for a driver feeding a receiver, plus violations. */
export function interopMargins(driver: LevelSet, receiver: LevelSet): FamilyMargins {
  const nmh = driver.vohMin - receiver.vihMin;
  const nml = receiver.vilMax - driver.volMax;
  const violations: string[] = [];
  if (nmh < 0) violations.push(`VOH(min) ${driver.vohMin} V below VIH(min) ${receiver.vihMin} V`);
  if (nml < 0) violations.push(`VOL(max) ${driver.volMax} V above VIL(max) ${receiver.vilMax} V`);
  return { nmh, nml, violations };
}

/** Single-family margins (driver and receiver are the same family). */
export function selfMargins(levels: LevelSet): FamilyMargins {
  return interopMargins(levels, levels);
}

/** One line of the worked margin calculation, as the exam poses it. */
export interface MarginStep {
  label: string;
  formula: string;
  substitution: string;
  result: string;
  ok: boolean;
}

/**
 * The NMH/NML derivations written out term by term, so the board work and the
 * readout come from one computation rather than two that can drift.
 */
export function marginSteps(driver: LevelSet, receiver: LevelSet): MarginStep[] {
  const m = interopMargins(driver, receiver);
  const v = (x: number) => `${x.toFixed(2)} V`;
  return [
    {
      label: 'NMH',
      formula: 'NMH = VOH(min) − VIH(min)',
      substitution: `${v(driver.vohMin)} − ${v(receiver.vihMin)}`,
      result: v(m.nmh),
      ok: m.nmh >= 0,
    },
    {
      label: 'NML',
      formula: 'NML = VIL(max) − VOL(max)',
      substitution: `${v(receiver.vilMax)} − ${v(driver.volMax)}`,
      result: v(m.nml),
      ok: m.nml >= 0,
    },
  ];
}
