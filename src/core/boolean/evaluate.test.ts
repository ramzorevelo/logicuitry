import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import * as bv from '../value/busValue';
import { BooleanEvalError, evaluateNets } from './evaluate';

const noLib: ChipLibrary = new Map();

// Ports compile to no primitive; their nets carry a `<path>.<pin>` alias.
const inNetOf = (c: ReturnType<typeof compile>, id: string) => c.pathToNet.get(`main/${id}.y`)!;
const outNetOf = (c: ReturnType<typeof compile>, id: string) => c.pathToNet.get(`main/${id}.a`)!;

describe('evaluateNets', () => {
  it('propagates through a chain of gates to a fixed point', () => {
    // a AND b -> NOT -> out (i.e. NAND via two primitives)
    const b = board({
      components: [
        comp('a', 'inport'),
        comp('b', 'inport'),
        comp('g1', 'and'),
        comp('n1', 'not'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['g1', 'a']),
        wire('w2', ['b', 'y'], ['g1', 'b']),
        wire('w3', ['g1', 'y'], ['n1', 'a']),
        wire('w4', ['n1', 'y'], ['o', 'a']),
      ],
    });
    const c = compile(b, noLib);

    const values = evaluateNets(
      c,
      new Map([
        [inNetOf(c, 'a'), bv.known(1, 1)],
        [inNetOf(c, 'b'), bv.known(1, 1)],
      ]),
    );
    expect(bv.toString(values.get(outNetOf(c, 'o'))!, 1)).toBe('0');
  });

  it('defaults a seeded-but-unassigned source net to X', () => {
    // A toggle seeded as a table input, never driven -- X, not its own state.
    const b = board({
      components: [comp('t', 'toggle'), comp('n1', 'not'), comp('o', 'outport')],
      wires: [wire('w1', ['t', 'y'], ['n1', 'a']), wire('w2', ['n1', 'y'], ['o', 'a'])],
    });
    const c = compile(b, noLib);
    const values = evaluateNets(c, new Map(), new Set([c.pathToPrimitive.get('main/t')!]));
    expect(bv.toString(values.get(outNetOf(c, 'o'))!, 1)).toBe('X');
  });

  it('defaults a truly floating (undriven) net to Z', () => {
    const b = board({ components: [comp('o', 'outport')] });
    const c = compile(b, noLib);
    const values = evaluateNets(c, new Map());
    expect(bv.toString(values.get(outNetOf(c, 'o'))!, 1)).toBe('Z');
  });

  it('throws on a feedback loop that never resolves', () => {
    // NOT feeding its own input directly (no input pin to seed it).
    const b = board({
      components: [comp('n1', 'not')],
      wires: [wire('w1', ['n1', 'y'], ['n1', 'a'])],
    });
    const c = compile(b, noLib);
    expect(() => evaluateNets(c, new Map())).toThrow(BooleanEvalError);
  });
});
