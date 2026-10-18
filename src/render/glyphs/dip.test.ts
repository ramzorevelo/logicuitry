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

/** A bare package of the right pin count; no shipped part is needed to lay one out. */
function packageInput(pkg: string, pinName = 'P'): GeometryInput {
  const count = dipPinCount(pkg);
  return {
    kind: 'chip',
    params: {},
    pins: Array.from({ length: count }, (_, i) => ({
      name: `${pinName}${i + 1}`,
      dir: 'in' as const,
      width: 1,
      role: 'data' as const,
      order: i,
    })),
    name: 'WIDE',
    package: pkg,
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
    expect(dipPinCount('DIP24W')).toBe(24);
  });

  it('accepts the wide suffix and nothing else after the count', () => {
    expect(isDipPackage('DIP24W')).toBe(true);
    expect(isDipPackage('DIP24N')).toBe(false);
    expect(isDipPackage('DIP23W')).toBe(false);
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

  it('is one width per row spacing: 13G for 300 mil, 19G for 600 mil', () => {
    const g = theme.gridSchematic;
    const dips = [...lib.values()].filter((d) => isDipPackage(d.appearance?.package));
    expect(dips.length).toBeGreaterThan(6);
    for (const d of dips) {
      const wide = d.appearance?.package?.endsWith('W');
      expect(dipLayout(inputFor(d.id), theme).width, d.id).toBe((wide ? 19 : 13) * g);
    }
    expect(dipLayout(packageInput('DIP20'), theme).width).toBe(13 * g);
    const wide = dipLayout(packageInput('DIP24W'), theme);
    expect(wide.width).toBe(19 * g);
    expect(wide.boxRight - wide.boxLeft).toBe(15 * g);
  });

  it('keeps a wide package on the grid, twelve rows a side', () => {
    const g = theme.gridSchematic;
    const wide = dipLayout(packageInput('DIP24W'), theme);
    expect(wide.left.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(wide.right[0]!.number).toBe(24);
    for (const [name, p] of wide.pins) {
      expect(p.x % g, name).toBe(0);
      expect(p.y % g, name).toBe(0);
    }
    expect(dipLayout(packageInput('DIP24'), theme).height).toBe(wide.height);
  });

  it('gives a wide body its extra width as room for pin names', () => {
    const narrow = dipLayout(packageInput('DIP24', 'LONGNAME'), theme);
    const wide = dipLayout(packageInput('DIP24W', 'LONGNAME'), theme);
    expect(wide.left[0]!.fontPx).toBeGreaterThan(narrow.left[0]!.fontPx);
  });

  it("keeps every pin name out of the part number's lane", () => {
    for (const part of ['74LS00', '74LS47']) {
      const l = dipLayout(inputFor(part), theme);
      const lane = (0.8 * l.nameFontPx) / 2;
      for (const r of [...l.left, ...l.right]) {
        const w = r.text.length * r.fontPx * 0.6;
        const inner = l.left.includes(r)
          ? l.boxLeft + 0.6 * l.g + w
          : l.width - (l.boxLeft + 0.6 * l.g + w);
        const clear = l.left.includes(r)
          ? inner <= l.bodyCenter.x - lane + 1e-9
          : inner >= l.bodyCenter.x + lane - 1e-9;
        expect(clear, `${part} ${r.text}`).toBe(true);
      }
    }
  });

  it('prints an active-low pin under a bar, not behind a slash', () => {
    const l = dipLayout(inputFor('74LS47'), theme);
    const bi = l.left.find((r) => r.pin.name === '/BI_RBO')!;
    expect(bi).toMatchObject({ text: 'BI/RBO', bar: true });
    expect(bi.fontPx).toBeLessThan(theme.glyphText);
    expect(l.left.find((r) => r.pin.name === 'A1')).toMatchObject({
      text: 'A1',
      bar: false,
      fontPx: theme.glyphText,
    });
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
