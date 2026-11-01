import { describe, expect, it } from 'vitest';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';
import { primitivePins, symbolBounds, transformGeometry, type GeometryInput } from './symbol';
import './power';
import '../../core/sim/primitives/registry';

const G = 8;
const theme: Theme = makeTestTheme();

const input = (kind: 'pullup' | 'pulldown', width: number): GeometryInput => ({
  kind,
  params: { width },
  pins: primitivePins(kind, { width }),
});

describe('pull-up and pull-down glyphs', () => {
  it('put the pin below the resistor on a pull-up and above it on a pull-down', () => {
    const up = symbolBounds({ id: 'r', kind: 'pullup', pos: { x: 0, y: 0 } }, theme);
    const down = symbolBounds({ id: 'r', kind: 'pulldown', pos: { x: 0, y: 0 } }, theme);
    expect(up.pins.get('p')!.y).toBe(up.bounds.y + up.bounds.h);
    expect(down.pins.get('p')!.y).toBe(down.bounds.y);
  });

  it('keep the pin on the grid through all four quarter-turns, mirrored or not', () => {
    for (const kind of ['pullup', 'pulldown'] as const)
      for (const width of [1, 8]) {
        const b = symbolBounds({ id: 'r', kind, pos: { x: 0, y: 0 }, params: { width } }, theme);
        const geo = { bounds: b.bounds, pins: b.pins };
        for (const rot of [0, 90, 180, 270] as const)
          for (const mirror of [false, true]) {
            const { pins } = transformGeometry(geo, { pos: { x: 5 * G, y: 2 * G }, rot, mirror });
            const p = pins.get('p')!;
            expect(p.x % G, `${kind} rot ${rot}`).toBeCloseTo(0, 6);
            expect(p.y % G, `${kind} rot ${rot}`).toBeCloseTo(0, 6);
          }
      }
  });

  it('take a bus width from the width param', () => {
    expect(input('pulldown', 8).pins[0]!.width).toBe(8);
  });
});
