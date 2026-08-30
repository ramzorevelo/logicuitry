import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, migrate } from './migrations';
import { validateDocument } from './validate';

const boardV1 = {
  format: 'lcir.board',
  formatVersion: 1,
  id: 'old',
  name: 'pre-free-wire board',
  components: [{ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }],
  wires: [
    {
      id: 'w1',
      a: { kind: 'pin', component: 'g1', pin: 'y' },
      b: { kind: 'junction', junction: 'j1' },
      points: [],
    },
  ],
  junctions: [{ id: 'j1', pos: { x: 80, y: 0 } }],
  probes: [],
  view: { x: 0, y: 0, zoom: 1 },
  timing: { mode: 'ideal', datasheet: 'typ' },
};

describe('board v1 -> v2 migration (free wire ends)', () => {
  it('upgrades a pre-change board unchanged except the version', () => {
    const out = migrate(structuredClone(boardV1));
    expect(out['formatVersion']).toBe(CURRENT_VERSION['lcir.board']);
    expect(out['wires']).toEqual(boardV1.wires);
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('a v2 board with free wire ends migrates and validates', () => {
    const v2 = {
      ...structuredClone(boardV1),
      formatVersion: 2,
      wires: [
        {
          id: 'w2',
          a: { kind: 'free', pos: { x: 8, y: 8 } },
          b: { kind: 'free', pos: { x: 64, y: 8 } },
          points: [],
        },
      ],
    };
    const out = migrate(v2);
    expect(out['formatVersion']).toBe(CURRENT_VERSION['lcir.board']);
    expect(out['wires']).toEqual(v2.wires);
    expect(validateDocument(out)).toEqual({ valid: true });
  });
});

describe('port rename migration (chip v1 -> v2, board v2 -> v3)', () => {
  const chipV1 = {
    format: 'lcir.chip',
    formatVersion: 1,
    id: 'half-adder',
    name: 'half adder',
    version: 1,
    pins: [
      { id: 'p1', name: 'a', dir: 'in', width: 1, role: 'data', order: 0, boundComponent: 'in1' },
    ],
    components: [
      { id: 'in1', kind: 'input', pos: { x: 0, y: 0 } },
      { id: 'g1', kind: 'and', pos: { x: 40, y: 0 } },
      { id: 'out1', kind: 'output', pos: { x: 80, y: 0 } },
    ],
    wires: [],
    junctions: [],
  };

  it('renames input/output components and leaves every other kind alone', () => {
    const out = migrate(structuredClone(chipV1));
    expect(out['formatVersion']).toBe(CURRENT_VERSION['lcir.chip']);
    expect((out['components'] as { id: string; kind: string }[]).map((c) => c.kind)).toEqual([
      'inport',
      'and',
      'outport',
    ]);
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('carries a v1 board through both hops, renaming on the second', () => {
    const out = migrate({
      ...structuredClone(boardV1),
      components: [{ id: 'in1', kind: 'input', pos: { x: 0, y: 0 } }],
    });
    expect(out['formatVersion']).toBe(CURRENT_VERSION['lcir.board']);
    expect((out['components'] as { kind: string }[])[0]!.kind).toBe('inport');
  });
});

describe('board v3 -> v4, chip v2 -> v3 (bus label position)', () => {
  it('carries a v3 board through untouched: the new field is optional', () => {
    const v3 = { ...structuredClone(boardV1), formatVersion: 3 };
    const out = migrate(v3);
    expect(out['formatVersion']).toBe(CURRENT_VERSION['lcir.board']);
    expect(out['wires']).toEqual(v3.wires);
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts a wire that already carries a label position', () => {
    const withLabel = {
      ...structuredClone(boardV1),
      formatVersion: 3,
      wires: [{ ...boardV1.wires[0]!, busLabelT: 0.25 }],
    };
    const out = migrate(withLabel);
    expect(validateDocument(out)).toEqual({ valid: true });
    expect((out['wires'] as { busLabelT: number }[])[0]!.busLabelT).toBe(0.25);
  });

  it('rejects a label position outside the wire', () => {
    const bad = {
      ...structuredClone(boardV1),
      formatVersion: CURRENT_VERSION['lcir.board'],
      wires: [{ ...boardV1.wires[0]!, busLabelT: 1.5 }],
    };
    expect(validateDocument(bad).valid).toBe(false);
  });
});

describe('pre-rename format token', () => {
  it('loads a file written before the app was renamed', () => {
    const doc = migrate({ format: 'logiclab.board', formatVersion: 4, components: [], wires: [] });
    expect(doc['format']).toBe('lcir.board');
    expect(doc['formatVersion']).toBe(5);
  });

  it('loads a file written under the ldw token too', () => {
    // The project has been renamed twice; both older prefixes map forward, so
    // a semester of saved work keeps opening whatever it was written under.
    const doc = migrate({ format: 'ldw.board', formatVersion: 4, components: [], wires: [] });
    expect(doc['format']).toBe('lcir.board');
    expect(doc['formatVersion']).toBe(5);
  });

  it('rewrites the token before running the version migrations', () => {
    const doc = migrate({
      format: 'logiclab.chip',
      formatVersion: 1,
      components: [{ id: 'i1', kind: 'input', pos: { x: 0, y: 0 } }],
    });
    expect(doc['format']).toBe('lcir.chip');
    expect(doc['formatVersion']).toBe(3);
    // The v1 -> v2 port rename still ran, so the token rewrite did not skip it.
    expect((doc['components'] as { kind: string }[])[0]!.kind).toBe('inport');
  });

  it('still rejects a format it has never heard of', () => {
    expect(() => migrate({ format: 'logiclab.mystery', formatVersion: 1 })).toThrow();
  });
});
