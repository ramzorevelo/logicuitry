import { describe, expect, it } from 'vitest';
import type { Component } from '../../core/model/types';
import type { Params } from '../../core/sim/primitives/types';
import { symbolBounds } from '../../render/glyphs/symbol';
import '../../render/glyphs/io'; // registers the led geometry builder
import { makeTestTheme } from '../../render/theme.fixture';
import { ledPolarityReanchor } from './ledReanchor';

const theme = makeTestTheme();
const ROTS = [0, 90, 180, 270] as const;

function led(params: Params, rot: (typeof ROTS)[number], mirror: boolean): Component {
  return { id: 'd1', kind: 'led', pos: { x: 80, y: 40 }, rot, mirror, params };
}

describe('ledPolarityReanchor', () => {
  for (const params of [{}, { width: 4 }, { width: 4, pinView: 'a=expanded' }])
    for (const rot of ROTS)
      for (const mirror of [false, true])
        it(`keeps every pin of ${JSON.stringify(params)} at rot ${rot}${mirror ? ' mirrored' : ''}`, () => {
          for (const [from, to] of <readonly [boolean, boolean][]>[
            [false, true],
            [true, false],
          ]) {
            const before = led({ ...params, activeLow: from }, rot, mirror);
            const after = led({ ...params, activeLow: to }, rot, mirror);
            const pos = ledPolarityReanchor(before, after, theme) ?? after.pos;
            const was = symbolBounds(before, theme).pins;
            const now = symbolBounds({ ...after, pos }, theme).pins;
            expect([...now]).toEqual([...was]);
          }
        });

  it('leaves an LED alone when its polarity did not change', () => {
    const c = led({ activeLow: true }, 180, false);
    expect(
      ledPolarityReanchor(c, { ...c, params: { activeLow: true, color: 'green' } }, theme),
    ).toBe(undefined);
  });

  it('leaves other kinds alone', () => {
    const sw: Component = { id: 's', kind: 'toggle', pos: { x: 0, y: 0 }, rot: 180 };
    expect(ledPolarityReanchor(sw, { ...sw, params: { width: 4 } }, theme)).toBe(undefined);
  });
});
