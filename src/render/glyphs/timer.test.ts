import { describe, expect, it } from 'vitest';
import type { Params } from '../../core/sim/primitives/types';
import { primitivePins } from './symbol';
import { timerBodyLines, timerLayout } from './timer';
import { makeTestTheme } from '../theme.fixture';

const theme = makeTestTheme();
const G = theme.gridSchematic;

const layoutOf = (params: Params) =>
  timerLayout({ kind: 'timer555', params, pins: primitivePins('timer555', params) }, theme);

describe('timerLayout', () => {
  it.each(['astable', 'monostable', 'bistable'])('puts every %s pin on the grid', (mode) => {
    const l = layoutOf({ mode });
    for (const p of l.pins.values()) {
      expect(p.x % G).toBeCloseTo(0, 6);
      expect(p.y % G).toBeCloseTo(0, 6);
    }
  });

  it('lists the pins top to bottom in datasheet order, OUT level with the first', () => {
    const l = layoutOf({ mode: 'bistable' });
    expect(l.left.map((p) => p.name)).toEqual(['trig', 'thres', 'reset']);
    expect(l.pins.get('out')!.y).toBe(l.pins.get('trig')!.y);
  });

  it('never moves a pin when R or C changes, so a live retime reroutes nothing', () => {
    const a = layoutOf({ mode: 'astable', r1: 1, r2: 1, c: 1e-12 });
    const b = layoutOf({ mode: 'astable', r1: 820_000, r2: 9_990_000, c: 999e-6 });
    expect([...b.pins]).toEqual([...a.pins]);
    expect(b.bounds).toEqual(a.bounds);
  });
});

describe('timerBodyLines', () => {
  it('prints the values and the timing the sim will use', () => {
    expect(timerBodyLines({ mode: 'astable', r1: 1000, r2: 1e6, c: 1e-6 })).toEqual([
      'astable',
      'R1 1 kΩ  R2 1 MΩ',
      'C 1 µF  f 0.721 Hz',
    ]);
    expect(timerBodyLines({ mode: 'monostable', r1: 1e6, r2: 0, c: 1e-6 })).toEqual([
      'monostable',
      'R 1 MΩ  C 1 µF',
      'tw 1.1 s',
    ]);
    expect(timerBodyLines({ mode: 'bistable' })).toEqual(['bistable']);
  });
});
