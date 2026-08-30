import { describe, expect, it } from 'vitest';
import { compile } from './compile';
import { board } from './testFixtures';

describe('free wire ends', () => {
  it('contribute no connection; the net still forms from the pin end', () => {
    const b = board({
      components: [{ id: 'c1', kind: 'constant', pos: { x: 0, y: 0 }, params: { value: 1 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'c1', pin: 'y' },
          b: { kind: 'free', pos: { x: 96, y: 0 } },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'free', pos: { x: 0, y: 96 } },
          b: { kind: 'free', pos: { x: 96, y: 96 } },
          points: [],
        },
      ],
    });
    const compiled = compile(b, new Map());
    expect(compiled.primitives).toHaveLength(1);
    // Exactly the constant's output net exists; free ends added nothing.
    expect(compiled.nets).toHaveLength(1);
    expect(compiled.primitives[0]!.outputs).toEqual([0]);
  });
});
