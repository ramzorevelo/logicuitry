import { describe, expect, it } from 'vitest';
import { comp, wire } from '../../core/model/testFixtures';
import type { ChipDef, Circuit, PinDef } from '../../core/model/types';
import {
  derivePins,
  detachRemovedPins,
  draftChipDef,
  extractSelection,
  findCycle,
  renamePinRefs,
  slugId,
  stripInteractiveComponents,
} from './packaging';

function pin(over: Partial<PinDef> & Pick<PinDef, 'name' | 'dir' | 'boundComponent'>): PinDef {
  return { id: `pin-${over.name}`, width: 1, role: 'data', order: 0, ...over };
}

function chipDef(over: Partial<ChipDef> & Pick<ChipDef, 'id' | 'name' | 'pins'>): ChipDef {
  return {
    format: 'lcir.chip',
    formatVersion: 3,
    version: 1,
    components: [],
    wires: [],
    junctions: [],
    ...over,
  };
}

describe('derivePins', () => {
  it('derives pins fresh from In/Out components, inputs then outputs in order', () => {
    const { pins, removed } = derivePins(
      [],
      [comp('a', 'inport'), comp('b', 'inport'), comp('g', 'and'), comp('y', 'outport')],
    );
    expect(removed).toEqual([]);
    expect(pins.map((p) => [p.name, p.dir, p.order])).toEqual([
      ['a', 'in', 0],
      ['b', 'in', 1],
      ['y', 'out', 0],
    ]);
  });

  it('keeps an existing pin name/order (label still matches) and reports one removed by boundComponent', () => {
    const existing = [pin({ name: 'sum', dir: 'out', boundComponent: 'y', order: 0 })];
    const { pins, removed, renamed } = derivePins(existing, [
      comp('y', 'outport', undefined, 'sum'),
    ]);
    expect(pins).toEqual(existing);
    expect(removed).toEqual([]);
    expect(renamed).toEqual([]);

    const { pins: pins2, removed: removed2 } = derivePins(existing, []);
    expect(pins2).toEqual([]);
    expect(removed2).toEqual(['sum']);
  });

  it('appends a newly added pin after the existing max order on its side', () => {
    const existing = [pin({ name: 'a', dir: 'in', boundComponent: 'ca', order: 0 })];
    const { pins } = derivePins(existing, [
      comp('ca', 'inport', undefined, 'a'),
      comp('cb', 'inport'),
    ]);
    expect(pins.map((p) => p.name)).toEqual(['a', 'cb']);
    expect(pins[1]!.order).toBe(1);
  });

  it('re-syncs a kept pin name when its bound In/Out component is renamed', () => {
    const existing = [pin({ name: 'x', dir: 'in', boundComponent: 'a', order: 0 })];
    const { pins, renamed } = derivePins(existing, [comp('a', 'inport', undefined, 'sel')]);
    expect(pins.map((p) => p.name)).toEqual(['sel']);
    expect(renamed).toEqual([{ from: 'x', to: 'sel' }]);
  });

  it('re-syncs a kept pin width when its bound component width changes', () => {
    const existing = [pin({ name: 'a', dir: 'in', boundComponent: 'a', order: 0, width: 1 })];
    const { pins, renamed } = derivePins(existing, [comp('a', 'inport', { width: 4 }, 'a')]);
    expect(pins[0]!.width).toBe(4);
    expect(renamed).toEqual([]);
  });

  it('rejects a rename that collides with another surviving pin, keeping the old name', () => {
    const existing = [
      pin({ name: 'a', dir: 'in', boundComponent: 'c1', order: 0 }),
      pin({ name: 'b', dir: 'in', boundComponent: 'c2', order: 1 }),
    ];
    // c2 is renamed to 'a', which c1 already owns -- c2's pin keeps 'b'.
    const { pins, renamed } = derivePins(existing, [
      comp('c1', 'inport', undefined, 'a'),
      comp('c2', 'inport', undefined, 'a'),
    ]);
    expect(pins.map((p) => p.name)).toEqual(['a', 'b']);
    expect(renamed).toEqual([]);
  });

  it('falls back to the component id when the label is cleared', () => {
    const existing = [pin({ name: 'sum', dir: 'out', boundComponent: 'y', order: 0 })];
    const { pins, renamed } = derivePins(existing, [comp('y', 'outport')]);
    expect(pins.map((p) => p.name)).toEqual(['y']);
    expect(renamed).toEqual([{ from: 'sum', to: 'y' }]);
  });
});

describe('findCycle', () => {
  it('is null for an acyclic library', () => {
    const inner = chipDef({ id: 'inner', name: 'inner', pins: [] });
    const outer = chipDef({
      id: 'outer',
      name: 'outer',
      pins: [],
      components: [{ id: 'u1', kind: 'chip', defId: 'inner', pos: { x: 0, y: 0 } }],
    });
    const lib = new Map([
      ['inner', inner],
      ['outer', outer],
    ]);
    expect(findCycle(lib)).toBeNull();
  });

  it('names the chain when a def would reference itself transitively', () => {
    const a = chipDef({
      id: 'a',
      name: 'a',
      pins: [],
      components: [{ id: 'u1', kind: 'chip', defId: 'b', pos: { x: 0, y: 0 } }],
    });
    const b = chipDef({
      id: 'b',
      name: 'b',
      pins: [],
      components: [{ id: 'u1', kind: 'chip', defId: 'a', pos: { x: 0, y: 0 } }],
    });
    const lib = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(findCycle(lib)).toMatch(/recursive chip reference: a -> b -> a/);
  });
});

describe('detachRemovedPins', () => {
  it('leaves the circuit untouched when the removed pin has no instances', () => {
    const circuit: Circuit = { components: [], wires: [], junctions: [] };
    const result = detachRemovedPins(circuit, 'full-adder', ['cin']);
    expect(result.circuit).toBe(circuit);
    expect(result.staleIds).toEqual([]);
  });

  it('detaches a wire bound to a removed pin, at its last bend point', () => {
    const circuit: Circuit = {
      components: [comp('u1', 'chip'), comp('sw', 'toggle')],
      wires: [
        {
          ...wire('w1', ['sw', 'y'], ['u1', 'cin']),
          points: [{ x: 40, y: 8 }],
        },
      ],
      junctions: [],
    };
    circuit.components[0]!.defId = 'full-adder';
    const { circuit: next, staleIds } = detachRemovedPins(circuit, 'full-adder', ['cin']);
    expect(staleIds).toEqual(['u1']);
    expect(next.wires[0]!.b).toEqual({ kind: 'free', pos: { x: 40, y: 8 } });
    expect(next.wires[0]!.a).toEqual({ kind: 'pin', component: 'sw', pin: 'y' });
  });
});

describe('renamePinRefs', () => {
  it('rewrites a wire end bound to the renamed pin on every instance of the def', () => {
    const circuit: Circuit = {
      components: [comp('u1', 'chip'), comp('sw', 'toggle')],
      wires: [wire('w1', ['sw', 'y'], ['u1', 'x'])],
      junctions: [],
    };
    circuit.components[0]!.defId = 'full-adder';
    const next = renamePinRefs(circuit, 'full-adder', [{ from: 'x', to: 'sel' }]);
    expect(next.wires[0]!.b).toEqual({ kind: 'pin', component: 'u1', pin: 'sel' });
  });

  it('leaves the circuit untouched when there is nothing to rename or no instances', () => {
    const circuit: Circuit = {
      components: [comp('sw', 'toggle')],
      wires: [],
      junctions: [],
    };
    expect(renamePinRefs(circuit, 'full-adder', [])).toBe(circuit);
    expect(renamePinRefs(circuit, 'full-adder', [{ from: 'x', to: 'y' }])).toBe(circuit);
  });
});

describe('extractSelection', () => {
  it('keeps only components in the selection and wires fully inside it', () => {
    const circuit: Circuit = {
      components: [comp('a', 'inport'), comp('g', 'and'), comp('out', 'outport')],
      wires: [wire('w1', ['a', 'y'], ['g', 'a']), wire('w2', ['g', 'y'], ['out', 'a'])],
      junctions: [],
    };
    const sub = extractSelection(circuit, new Set(['a', 'g']));
    expect(sub.components.map((c) => c.id)).toEqual(['a', 'g']);
    expect(sub.wires.map((w) => w.id)).toEqual(['w1']);
  });
});

describe('stripInteractiveComponents', () => {
  it('drops switches/LEDs and any wire touching them, keeping labels and logic', () => {
    const circuit: Circuit = {
      components: [
        comp('sw', 'toggle'),
        comp('in1', 'inport'),
        comp('led1', 'led'),
        comp('g', 'and'),
      ],
      wires: [
        wire('w1', ['sw', 'y'], ['in1', 'y']),
        wire('w2', ['in1', 'y'], ['g', 'a']),
        wire('w3', ['g', 'y'], ['led1', 'a']),
      ],
      junctions: [],
    };
    const stripped = stripInteractiveComponents(circuit);
    expect(stripped.components.map((c) => c.id)).toEqual(['in1', 'g']);
    expect(stripped.wires.map((w) => w.id)).toEqual(['w2']);
  });

  it('leaves a circuit with no interactive components untouched', () => {
    const circuit: Circuit = {
      components: [comp('in1', 'inport'), comp('g', 'and')],
      wires: [wire('w1', ['in1', 'y'], ['g', 'a'])],
      junctions: [],
    };
    expect(stripInteractiveComponents(circuit)).toBe(circuit);
  });

  it('removes junctions the stripped switch/LED left behind', () => {
    // sw -> j (branching to in1 and g); once sw is gone the junction is a
    // plain 2-way pass-through with nothing left to branch.
    const circuit: Circuit = {
      components: [comp('sw', 'toggle'), comp('in1', 'inport'), comp('g', 'and')],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'sw', pin: 'y' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'pin', component: 'in1', pin: 'a' },
          points: [{ x: 0, y: 0 }],
        },
        {
          id: 'w3',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'pin', component: 'g', pin: 'a' },
          points: [{ x: 0, y: 32 }],
        },
      ],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
    };
    const stripped = stripInteractiveComponents(circuit);
    expect(stripped.junctions).toEqual([]);
    // The two surviving legs merged into one wire, so nothing dangles.
    expect(stripped.wires).toHaveLength(1);
    for (const w of stripped.wires)
      for (const end of [w.a, w.b]) expect(end.kind).not.toBe('junction');
  });

  it('drops a junction left with nothing attached at all', () => {
    const circuit: Circuit = {
      components: [comp('sw', 'toggle'), comp('g', 'and')],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'sw', pin: 'y' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
      ],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
    };
    expect(stripInteractiveComponents(circuit).junctions).toEqual([]);
  });

  it('does not mutate the circuit it was given', () => {
    const circuit: Circuit = {
      components: [comp('sw', 'toggle'), comp('g', 'and')],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'sw', pin: 'y' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'pin', component: 'g', pin: 'a' },
          points: [],
        },
      ],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
    };
    stripInteractiveComponents(circuit);
    expect(circuit.junctions).toHaveLength(1);
    expect(circuit.wires[1]!.a.kind).toBe('junction');
  });

  it('draftChipDef never carries a switch/LED into the resulting def', () => {
    const circuit: Circuit = {
      components: [comp('sw', 'toggle'), comp('in1', 'inport'), comp('g', 'buf')],
      wires: [wire('w1', ['sw', 'y'], ['in1', 'y']), wire('w2', ['in1', 'y'], ['g', 'a'])],
      junctions: [],
    };
    const def = draftChipDef('buf1', 'buf1', circuit);
    expect(def.components.some((c) => c.kind === 'toggle')).toBe(false);
  });
});

describe('slugId', () => {
  it('slugifies and disambiguates against existing ids', () => {
    expect(slugId('Full Adder', new Set())).toBe('full-adder');
    expect(slugId('Full Adder', new Set(['full-adder']))).toBe('full-adder-2');
    expect(slugId('  ', new Set())).toBe('chip');
  });
});
