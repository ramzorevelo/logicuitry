import { describe, expect, it } from 'vitest';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';
import { boxLayout } from './chip';
import { glyphBodyName, primitivePins, symbolBounds } from './symbol';
import '../../core/sim/primitives/registry';

const G = 8;
const theme: Theme = makeTestTheme();

const shapes: Record<string, string | number | boolean>[] = [
  { width: 8, addressBits: 4 },
  { width: 1, addressBits: 1 },
  { width: 32, addressBits: 8 },
  { width: 4, addressBits: 4, pinView: 'a=expanded;d=expanded;q=expanded' },
  { width: 4, addressBits: 4, csLow: true, weLow: true, invertedOut: true },
];

describe('RAM block glyph', () => {
  it('draws a, d, we, cs on the left and q on the right, named ram', () => {
    const params = { width: 8, addressBits: 4 };
    const layout = boxLayout(
      {
        kind: 'ram',
        params,
        pins: primitivePins('ram', params),
        name: glyphBodyName('ram', 'U1', undefined),
      },
      theme,
    );
    expect(layout.name).toBe('ram');
    expect(layout.left.map((p) => p.name)).toEqual(['a', 'd', 'we', 'cs']);
    expect(layout.right.map((p) => p.name)).toEqual(['q']);
  });

  it('puts a bubble only on the active-low controls', () => {
    const params = { csLow: true, weLow: true };
    const pins = primitivePins('ram', params);
    expect(pins.filter((p) => p.activeLow).map((p) => p.name)).toEqual(['we', 'cs']);
  });

  it('keeps every pin on grid through all four rotations, mirrored or not', () => {
    for (const params of shapes)
      for (const rot of [0, 90, 180, 270] as const)
        for (const mirror of [false, true]) {
          const { pins } = symbolBounds(
            { id: 'U1', kind: 'ram', pos: { x: 5 * G, y: 3 * G }, rot, mirror, params },
            theme,
          );
          expect(pins.size).toBe(primitivePins('ram', params).length);
          for (const [name, p] of pins) {
            const at = `${JSON.stringify(params)} rot ${rot}${mirror ? ' mirrored' : ''} ${name}`;
            expect(Math.abs(p.x % G), at).toBeCloseTo(0, 6);
            expect(Math.abs(p.y % G), at).toBeCloseTo(0, 6);
          }
        }
  });
});
