import { describe, expect, it } from 'vitest';
import type { ChipLibrary, Circuit, Component, Wire } from '../../core/model/types';
import {
  deriveOutputLabels,
  labelDirectionConflict,
  labelSync,
  labelSyncForOutput,
  labelUsedElsewhere,
  netTerminals,
  netTouchedPins,
  nextLabel,
} from './labelSync';

const pin = (component: string, pinName: string): Wire['a'] => ({
  kind: 'pin',
  component,
  pin: pinName,
});
let w = 0;
const wire = (a: Wire['a'], b: Wire['b']): Wire => ({ id: `w${w++}`, a, b, points: [] });
const circuit = (components: Component[], wires: Wire[], junctions: Circuit['junctions'] = []) =>
  ({ components, wires, junctions }) as Circuit;

describe('labelSync', () => {
  it('both sides default: nothing happens', () => {
    const c = circuit(
      [
        { id: 'sw1', kind: 'toggle', pos: { x: 0, y: 0 } },
        { id: 'in1', kind: 'inport', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('sw1', 'y'), pin('in1', 'y'))],
    );
    expect(labelSync(c, { component: 'sw1', pin: 'y' })).toEqual({
      inherit: [],
      conflict: null,
    });
  });

  it('one side named: the default side inherits (both directions)', () => {
    const c = circuit(
      [
        { id: 'sw1', kind: 'toggle', pos: { x: 0, y: 0 } },
        { id: 'in1', kind: 'inport', pos: { x: 1, y: 0 }, label: 'A' },
      ],
      [wire(pin('sw1', 'y'), pin('in1', 'y'))],
    );
    const fromSwitch = labelSync(c, { component: 'sw1', pin: 'y' });
    expect(fromSwitch.inherit).toEqual([{ id: 'sw1', label: 'A' }]);
    expect(fromSwitch.conflict).toBeNull();
    const fromPin = labelSync(c, { component: 'in1', pin: 'y' });
    expect(fromPin.inherit).toEqual([{ id: 'sw1', label: 'A' }]);
  });

  it('both user-named with different labels: conflict, no inherits', () => {
    const c = circuit(
      [
        { id: 'sw1', kind: 'toggle', pos: { x: 0, y: 0 }, label: 'S' },
        { id: 'in1', kind: 'inport', pos: { x: 1, y: 0 }, label: 'A' },
      ],
      [wire(pin('sw1', 'y'), pin('in1', 'y'))],
    );
    const r = labelSync(c, { component: 'sw1', pin: 'y' });
    expect(r.inherit).toEqual([]);
    expect(r.conflict!.candidates.slice().sort()).toEqual(['A', 'S']);
    expect(r.conflict!.netComponentIds.sort()).toEqual(['in1', 'sw1']);
  });

  it('reaches multi-terminal nets across a junction fan-out', () => {
    const c = circuit(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
        { id: 'led1', kind: 'led', pos: { x: 2, y: 0 } },
        { id: 'led2', kind: 'led', pos: { x: 2, y: 1 } },
      ],
      [
        wire(pin('in1', 'y'), { kind: 'junction', junction: 'j1' }),
        wire({ kind: 'junction', junction: 'j1' }, pin('led1', 'a')),
        wire({ kind: 'junction', junction: 'j1' }, pin('led2', 'a')),
      ],
      [{ id: 'j1', pos: { x: 1, y: 0 } }],
    );
    const r = labelSync(c, { component: 'in1', pin: 'y' });
    expect(r.inherit.map((i) => i.id).sort()).toEqual(['led1', 'led2']);
    expect(r.inherit.every((i) => i.label === 'A')).toBe(true);
  });

  it('ignores non-terminal components and non-data pins on the net', () => {
    const c = circuit(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
        { id: 'g1', kind: 'and', pos: { x: 1, y: 0 }, label: 'G' },
      ],
      [wire(pin('in1', 'y'), pin('g1', 'a'))],
    );
    const r = labelSync(c, { component: 'in1', pin: 'y' });
    expect(r).toEqual({ inherit: [], conflict: null });
    expect(netTerminals(c, { component: 'in1', pin: 'y' }).map((t) => t.id)).toEqual(['in1']);
  });
});

describe('labelUsedElsewhere', () => {
  it('flags a label on a component outside the net set only', () => {
    const c = circuit(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
        { id: 'sw1', kind: 'toggle', pos: { x: 1, y: 0 }, label: 'A' },
      ],
      [],
    );
    expect(labelUsedElsewhere(c, 'A', new Set(['in1', 'sw1']))).toBe(false);
    expect(labelUsedElsewhere(c, 'A', new Set(['in1']))).toBe(true);
    expect(labelUsedElsewhere(c, 'B', new Set())).toBe(false);
  });
});

describe('nextLabel', () => {
  const used = (...l: string[]) => new Set(l);
  it('advances a single letter alphabetically, skipping used ones', () => {
    expect(nextLabel('A', used())).toBe('B');
    expect(nextLabel('A', used('B', 'C'))).toBe('D');
    expect(nextLabel('b', used())).toBe('c');
  });
  it('continues a trailing number sequentially', () => {
    expect(nextLabel('D3', used())).toBe('D4');
    expect(nextLabel('D3', used('D4'))).toBe('D5');
    expect(nextLabel('9', used())).toBe('10');
  });
  it('appends a number to a multi-char label', () => {
    expect(nextLabel('sel', used())).toBe('sel2');
    expect(nextLabel('sel', used('sel2'))).toBe('sel3');
  });
  it('falls to appended numbers past z', () => {
    expect(nextLabel('z', used())).toBe('z2');
  });
});

describe('labelDirectionConflict', () => {
  const lib: ChipLibrary = new Map();

  it('rejects an In port sharing a net with a gate output', () => {
    const c = circuit(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
        { id: 'g1', kind: 'not', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('in1', 'y'), pin('g1', 'y'))],
    );
    expect(labelDirectionConflict(c, lib, [{ component: 'in1', pin: 'y' }])).toMatch(
      /In port cannot connect to a chip\/gate output/,
    );
  });

  it('rejects an Out port sharing a net with a gate input', () => {
    const c = circuit(
      [
        { id: 'out1', kind: 'outport', pos: { x: 0, y: 0 } },
        { id: 'g1', kind: 'and', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('out1', 'a'), pin('g1', 'a'))],
    );
    expect(labelDirectionConflict(c, lib, [{ component: 'out1', pin: 'a' }])).toMatch(
      /Out port cannot connect to a chip\/gate input/,
    );
  });

  it('allows an In port driving a gate input (the normal case)', () => {
    const c = circuit(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
        { id: 'g1', kind: 'and', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('in1', 'y'), pin('g1', 'a'))],
    );
    expect(labelDirectionConflict(c, lib, [{ component: 'in1', pin: 'y' }])).toBeNull();
  });

  it('allows an Out port reading a gate output (the normal case)', () => {
    const c = circuit(
      [
        { id: 'out1', kind: 'outport', pos: { x: 0, y: 0 } },
        { id: 'g1', kind: 'and', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('out1', 'a'), pin('g1', 'y'))],
    );
    expect(labelDirectionConflict(c, lib, [{ component: 'out1', pin: 'a' }])).toBeNull();
  });

  it('allows two In ports sharing one net (the packaging label-sharing feature)', () => {
    const c = circuit(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
        { id: 'in2', kind: 'inport', pos: { x: 1, y: 0 } },
        { id: 'g1', kind: 'and', pos: { x: 2, y: 0 } },
      ],
      [wire(pin('in1', 'y'), pin('in2', 'y')), wire(pin('in2', 'y'), pin('g1', 'a'))],
    );
    expect(labelDirectionConflict(c, lib, [{ component: 'in1', pin: 'y' }])).toBeNull();
  });

  it('ignores unrelated (non-label) terminals', () => {
    const c = circuit(
      [
        { id: 'sw1', kind: 'toggle', pos: { x: 0, y: 0 } },
        { id: 'g1', kind: 'not', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('sw1', 'y'), pin('g1', 'y'))],
    );
    expect(labelDirectionConflict(c, lib, [{ component: 'sw1', pin: 'y' }])).toBeNull();
  });
});

describe('netTouchedPins', () => {
  it('finds an In port two hops out from a free/junction end, not just literal pin ends', () => {
    // in1 -- wA --> free end -- (trial wire) --> junction j1 -- wg --> g1.y
    // Neither trial-wire end is itself a pin, but the merged net still
    // reaches in1 on one side and g1 on the other.
    const c: Circuit = {
      components: [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
        { id: 'g1', kind: 'not', pos: { x: 1, y: 0 } },
      ],
      wires: [
        wire(pin('in1', 'y'), { kind: 'free', pos: { x: 1, y: 1 } }),
        {
          id: 'trial',
          a: { kind: 'free', pos: { x: 1, y: 1 } },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
        { id: 'wg', a: { kind: 'junction', junction: 'j1' }, b: pin('g1', 'y'), points: [] },
      ],
      junctions: [{ id: 'j1', pos: { x: 2, y: 2 } }],
    };
    const touched = netTouchedPins(c, [
      { kind: 'free', pos: { x: 1, y: 1 } },
      { kind: 'junction', junction: 'j1' },
    ]);
    expect(touched).toEqual(
      expect.arrayContaining([
        { component: 'in1', pin: 'y' },
        { component: 'g1', pin: 'y' },
      ]),
    );
  });

  it('includes a literal pin end itself, not just what it reaches', () => {
    const c: Circuit = {
      components: [{ id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } }],
      wires: [],
      junctions: [],
    };
    expect(netTouchedPins(c, [{ kind: 'pin', component: 'in1', pin: 'y' }])).toEqual([
      { component: 'in1', pin: 'y' },
    ]);
  });
});

describe('deriveOutputLabels (Task 1b)', () => {
  const lib: ChipLibrary = new Map();

  it('a single-output part (a gate) gets one dot-free label on its output pin', () => {
    const c = circuit([{ id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { inputs: 2 } }], []);
    expect(deriveOutputLabels(c, lib, 'g1', 'foo')).toEqual([{ pin: 'y', label: 'foo' }]);
  });

  it('a multi-output part (a decoder) gets <label>.<pinName> per output pin', () => {
    const c = circuit(
      [{ id: 'd1', kind: 'decoder', pos: { x: 0, y: 0 }, params: { addressBits: 1 } }],
      [],
    );
    // addressBits=1 -> 2 one-hot outputs y0/y1, plus its coded input 'a'
    // (in-dir, excluded).
    const derived = deriveOutputLabels(c, lib, 'd1', 'dec1');
    expect(derived.sort((a, b) => a.pin.localeCompare(b.pin))).toEqual([
      { pin: 'y0', label: 'dec1.y0' },
      { pin: 'y1', label: 'dec1.y1' },
    ]);
  });

  it('a part with no output pins (an LED) derives nothing', () => {
    const c = circuit([{ id: 'l1', kind: 'led', pos: { x: 0, y: 0 } }], []);
    expect(deriveOutputLabels(c, lib, 'l1', 'foo')).toEqual([]);
  });

  it('an unknown component id derives nothing', () => {
    const c = circuit([], []);
    expect(deriveOutputLabels(c, lib, 'nope', 'foo')).toEqual([]);
  });
});

describe('labelSyncForOutput (Task 1b)', () => {
  it('a default-labeled IO terminal on the net inherits the proposed name', () => {
    const c = circuit(
      [
        { id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { inputs: 2 } },
        { id: 'led1', kind: 'led', pos: { x: 1, y: 0 } },
      ],
      [wire(pin('g1', 'y'), pin('led1', 'a'))],
    );
    const r = labelSyncForOutput(c, { component: 'g1', pin: 'y' }, 'foo');
    expect(r.inherit).toEqual([{ id: 'led1', label: 'foo' }]);
    expect(r.conflict).toBeNull();
  });

  it('a different existing label on the net conflicts instead of overwriting', () => {
    const c = circuit(
      [
        { id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { inputs: 2 } },
        { id: 'led1', kind: 'led', pos: { x: 1, y: 0 }, label: 'bar' },
      ],
      [wire(pin('g1', 'y'), pin('led1', 'a'))],
    );
    const r = labelSyncForOutput(c, { component: 'g1', pin: 'y' }, 'foo');
    expect(r.inherit).toEqual([]);
    expect(r.conflict).toEqual({ candidates: ['foo', 'bar'], netComponentIds: ['led1'] });
  });

  it('Task 6: 3 distinct labels on one net offer 3 candidates, proposed first', () => {
    const c = circuit(
      [
        { id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { inputs: 2 } },
        { id: 'led1', kind: 'led', pos: { x: 1, y: 0 }, label: 'bar' },
        { id: 'led2', kind: 'led', pos: { x: 2, y: 0 }, label: 'baz' },
      ],
      [wire(pin('g1', 'y'), pin('led1', 'a')), wire(pin('g1', 'y'), pin('led2', 'a'))],
    );
    const r = labelSyncForOutput(c, { component: 'g1', pin: 'y' }, 'foo');
    expect(r.inherit).toEqual([]);
    expect(r.conflict!.candidates).toEqual(['foo', 'bar', 'baz']);
    expect(r.conflict!.netComponentIds.slice().sort()).toEqual(['led1', 'led2']);
  });

  it('the same label already present on the net is a no-op, not a conflict', () => {
    const c = circuit(
      [
        { id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { inputs: 2 } },
        { id: 'led1', kind: 'led', pos: { x: 1, y: 0 }, label: 'foo' },
      ],
      [wire(pin('g1', 'y'), pin('led1', 'a'))],
    );
    const r = labelSyncForOutput(c, { component: 'g1', pin: 'y' }, 'foo');
    expect(r.inherit).toEqual([]);
    expect(r.conflict).toBeNull();
  });
});
