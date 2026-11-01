import { describe, expect, it } from 'vitest';
import { compile } from '../../core/model/compile';
import { board, comp, wire } from '../../core/model/testFixtures';
import { BIDIR } from '../../core/model/bidirFixture';
import { pinNamesOf } from '../../core/sim/delay';
import { pinNet } from './circuitStore';

describe('pinNet', () => {
  it('resolves an inout pin to the slot compile gave it', () => {
    const U1 = comp('U1', BIDIR, undefined, 'U1');
    const b = board({
      components: [U1, comp('pb', 'probe', undefined, 'BUS')],
      wires: [wire('w1', ['U1', 'p'], ['pb', 'a'])],
    });
    const c = compile(b, new Map());
    const prim = c.primitives[c.componentToPrimitive.get('main/U1')!]!;
    const { ins, outs } = pinNamesOf(prim);
    expect(pinNet(c, U1, 'p')).toBe(c.pathToNet.get('main/BUS'));
    expect(pinNet(c, U1, 'p')).toBe(prim.outputs[outs.indexOf('p')]);
    expect(pinNet(c, U1, 'en')).toBe(prim.inputs[ins.indexOf('en')]);
    expect(pinNet(c, U1, 'r')).toBe(prim.outputs[outs.indexOf('r')]);
  });
});
