import { describe, expect, it } from 'vitest';
import type { CompiledCircuit } from '../../core/model/compile';
import { loopNetNames, loopOf } from './oscillation';

const circuitOf = (paths: string[][], drivers: { prim: number; out: number }[][] = []) =>
  ({
    nets: paths.map((p) => ({ width: 1, paths: p })),
    drivers,
    primitives: [{ path: 'main/G2' }, { path: 'main/u2:74LS04/b1' }],
  }) as unknown as CompiledCircuit;

describe('loopNetNames', () => {
  it('prefers a label, then a part pin, and skips chip-internal nets', () => {
    const c = circuitOf([
      ['main/n14', 'main/u2:74LS04/n1', 'main/u2.1Y', 'main/u2.2A'],
      ['main/u2:74LS04/n17'],
      ['main/n12', 'main/OSC', 'main/u1.4B'],
    ]);
    expect(loopNetNames(c, [0, 1, 2])).toEqual(['u2.1Y', 'OSC']);
  });

  it('names a net with only an auto name by the part driving it', () => {
    const c = circuitOf(
      [['main/n0'], ['main/n1'], ['main/n2']],
      [[{ prim: 0, out: 0 }], [{ prim: 1, out: 0 }], []],
    );
    expect(loopNetNames(c, [0, 1, 2])).toEqual(['G2', 'u2']);
  });

  it('names the chip instance when the whole loop is inside it', () => {
    const c = circuitOf([['main/u3:ring/n0'], ['main/u3:ring/n1']]);
    expect(loopNetNames(c, [0, 1])).toEqual(['u3']);
  });

  it('names at most three nets, once each', () => {
    const c = circuitOf([['main/A'], ['main/A'], ['main/B'], ['main/C'], ['main/D']]);
    expect(loopNetNames(c, [0, 1, 2, 3, 4])).toEqual(['A', 'B', 'C']);
  });
});

describe('loopOf', () => {
  it('is null for a settle that went quiet', () => {
    expect(loopOf(circuitOf([]), { settled: true, time: 0, eventsProcessed: 0 })).toBeNull();
  });
});
