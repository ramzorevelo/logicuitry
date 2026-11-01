import { describe, expect, it } from 'vitest';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';
import { boxLayout } from './chip';
import {
  glyphBodyName,
  primitivePins,
  symbolBounds,
  transformGeometry,
  type GeometryInput,
} from './symbol';
import '../../core/sim/primitives/registry';

const G = 8;
const theme: Theme = makeTestTheme();

const input = (width: number): GeometryInput => ({
  kind: 'transceiver',
  params: { width },
  pins: primitivePins('transceiver', { width }),
  name: glyphBodyName('transceiver', 'U7', undefined),
});

describe('bus transceiver glyph', () => {
  it('puts a on the left and b on the right, level with each other, controls under a', () => {
    for (const width of [1, 8, 32]) {
      const layout = boxLayout(input(width), theme);
      expect(layout.left.map((p) => p.name)).toEqual(['a', 'dir', 'oe']);
      expect(layout.right.map((p) => p.name)).toEqual(['b']);
      expect(layout.pins.get('a')).toEqual({ x: 0, y: layout.right[0]!.y });
      expect(layout.pins.get('b')).toEqual({ x: layout.width, y: layout.right[0]!.y });
    }
  });

  it('marks no pin with a clock wedge or a bubble', () => {
    const layout = boxLayout(input(8), theme);
    const drawn = [...layout.left, ...layout.right];
    expect(drawn.some((p) => p.role === 'clock' || p.activeLow)).toBe(false);
  });

  it('keeps every pin on the grid through all four quarter-turns, mirrored or not', () => {
    const layout = boxLayout(input(8), theme);
    const geo = { bounds: layout.bounds, pins: layout.pins };
    for (const rot of [0, 90, 180, 270] as const)
      for (const mirror of [false, true]) {
        const { pins } = transformGeometry(geo, { pos: { x: 5 * G, y: 2 * G }, rot, mirror });
        for (const [name, p] of pins) {
          expect(p.x % G, `${name} rot ${rot}`).toBeCloseTo(0, 6);
          expect(p.y % G, `${name} rot ${rot}`).toBeCloseTo(0, 6);
        }
      }
  });

  it('is a registered box glyph with every pin wireable', () => {
    const placed = { id: 'U7', kind: 'transceiver' as const, pos: { x: 0, y: 0 } };
    expect([...symbolBounds(placed, theme).pins.keys()].sort()).toEqual(['a', 'b', 'dir', 'oe']);
  });
});
