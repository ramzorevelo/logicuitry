import { describe, expect, it } from 'vitest';
import { makeTestTheme } from '../theme.fixture';
import { buildLocalGeometry, chipPins, type GeometryInput } from './symbol';
import './chip';
import { dipLayout, dipPinCount, isDipPackage } from './dip';
import { builtinChipLibrary } from '../../core/parts/packages';

const theme = makeTestTheme();
const lib = builtinChipLibrary();

function inputFor(part: string): GeometryInput {
  const def = lib.get(part)!;
  return {
    kind: 'chip',
    params: {},
    pins: chipPins(def),
    name: def.name,
    package: def.appearance?.package,
  };
}

describe('isDipPackage', () => {
  it('accepts even-pin DIP names only', () => {
    expect(isDipPackage('DIP14')).toBe(true);
    expect(isDipPackage('DIP16')).toBe(true);
    expect(isDipPackage('DIP15')).toBe(false);
    expect(isDipPackage('SOIC14')).toBe(false);
    expect(isDipPackage(undefined)).toBe(false);
  });

  it('reads the pin count out of the name', () => {
    expect(dipPinCount('DIP14')).toBe(14);
  });
});

describe('DIP layout', () => {
  it('numbers pins down the left and back up the right', () => {
    const l = dipLayout(inputFor('74LS00'), theme);
    expect(l.left.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(l.right.map((r) => r.number)).toEqual([14, 13, 12, 11, 10, 9, 8]);
  });

  it('puts pin 1 and the last pin on the same row, at opposite edges', () => {
    const l = dipLayout(inputFor('74LS00'), theme);
    expect(l.left[0]!.y).toBe(l.right[0]!.y);
    expect(l.pins.get('1A')!.x).toBe(0);
    expect(l.pins.get('VCC')!.x).toBe(l.width);
  });

  it('lands every pin tip on a grid intersection', () => {
    for (const part of ['74LS00', '74LS47']) {
      const l = dipLayout(inputFor(part), theme);
      for (const [name, p] of l.pins) {
        expect(p.x % theme.gridSchematic, `${part} ${name} x`).toBe(0);
        expect(p.y % theme.gridSchematic, `${part} ${name} y`).toBe(0);
      }
    }
  });

  it('leaves the same gap above pin 1 as below the last pin', () => {
    for (const part of ['74LS00', '74LS47']) {
      const l = dipLayout(inputFor(part), theme);
      const top = l.left[0]!.y;
      const bottom = l.height - l.left[l.left.length - 1]!.y;
      expect(top, part).toBe(bottom);
    }
  });

  it('grows to sixteen rows for a DIP16', () => {
    const l14 = dipLayout(inputFor('74LS00'), theme);
    const l16 = dipLayout(inputFor('74LS47'), theme);
    expect(l16.left).toHaveLength(8);
    expect(l16.height).toBeGreaterThan(l14.height);
  });

  it('names the pins as the datasheet does, not by direction', () => {
    const l = dipLayout(inputFor('74LS02'), theme);
    // The '02 puts gate 1's OUTPUT on pin 1: the whole reason the physical
    // order matters, since wiring it like an '08 is the classic mistake.
    expect(l.left[0]!.pin.name).toBe('1Y');
    expect(l.left[0]!.pin.dir).toBe('out');
  });
});

describe('chip geometry dispatch', () => {
  it('uses the DIP silhouette for a def that names a package', () => {
    const geo = buildLocalGeometry(inputFor('74LS08'), theme);
    const dip = dipLayout(inputFor('74LS08'), theme);
    expect(geo.bounds).toEqual(dip.bounds);
    expect(geo.pins.size).toBe(14);
  });

  it('keeps the generic box for a def with no package', () => {
    const plain = { ...inputFor('74LS08'), package: undefined };
    const geo = buildLocalGeometry(plain, theme);
    expect(geo.bounds).not.toEqual(dipLayout(inputFor('74LS08'), theme).bounds);
  });
});
