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

  it('retires an amber LED to yellow, leaving other colours alone', () => {
    const out = migrate({
      ...structuredClone(boardV1),
      formatVersion: 5,
      components: [
        { id: 'd1', kind: 'led', pos: { x: 0, y: 0 }, params: { color: 'amber', shape: 'round' } },
        { id: 'd2', kind: 'led', pos: { x: 8, y: 0 }, params: { color: 'green' } },
        { id: 'd3', kind: 'led', pos: { x: 16, y: 0 } },
      ],
    });
    const colours = (out['components'] as { params?: { color?: string } }[]).map(
      (c) => c.params?.color,
    );
    expect(colours).toEqual(['yellow', 'green', undefined]);
    // The rest of the params ride through untouched.
    expect((out['components'] as { params?: { shape?: string } }[])[0]!.params?.shape).toBe(
      'round',
    );
    expect(validateDocument(out)).toEqual({ valid: true });
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
    expect(doc['formatVersion']).toBe(CURRENT_VERSION['lcir.board']);
  });

  it('loads a file written under the ldw token too', () => {
    // The project has been renamed twice; both older prefixes map forward, so
    // a semester of saved work keeps opening whatever it was written under.
    const doc = migrate({ format: 'ldw.board', formatVersion: 4, components: [], wires: [] });
    expect(doc['format']).toBe('lcir.board');
    expect(doc['formatVersion']).toBe(CURRENT_VERSION['lcir.board']);
  });

  it('rewrites the token before running the version migrations', () => {
    const doc = migrate({
      format: 'logiclab.chip',
      formatVersion: 1,
      components: [{ id: 'i1', kind: 'input', pos: { x: 0, y: 0 } }],
    });
    expect(doc['format']).toBe('lcir.chip');
    expect(doc['formatVersion']).toBe(CURRENT_VERSION['lcir.chip']);
    // The v1 -> v2 port rename still ran, so the token rewrite did not skip it.
    expect((doc['components'] as { kind: string }[])[0]!.kind).toBe('inport');
  });

  it('still rejects a format it has never heard of', () => {
    expect(() => migrate({ format: 'logiclab.mystery', formatVersion: 1 })).toThrow();
  });
});

describe('board v7 -> v8, chip v5 -> v6 (instance contents, inout pins)', () => {
  const chipV5 = {
    format: 'lcir.chip',
    formatVersion: 5,
    id: 'buf',
    name: 'buf',
    version: 1,
    pins: [
      { id: 'p1', name: 'a', dir: 'in', width: 1, role: 'data', order: 0, boundComponent: 'in1' },
    ],
    components: [{ id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } }],
    wires: [],
    junctions: [],
  };
  const boardV7 = {
    ...structuredClone(boardV1),
    formatVersion: 7,
    components: [{ id: 'u1', kind: 'chip', defId: 'buf', label: 'U1', pos: { x: 0, y: 0 } }],
    wires: [],
    junctions: [],
  };

  it('carries a v7 board and a v5 chip through unchanged except the version', () => {
    const board = migrate(structuredClone(boardV7));
    expect(board).toEqual({
      ...boardV7,
      formatVersion: CURRENT_VERSION['lcir.board'],
      timing: { ...boardV7.timing, vendor: 'ti' },
      runSpeed: 25_000,
    });
    expect(validateDocument(board)).toEqual({ valid: true });
    const chip = migrate(structuredClone(chipV5));
    expect(chip).toEqual({ ...chipV5, formatVersion: CURRENT_VERSION['lcir.chip'] });
    expect(validateDocument(chip)).toEqual({ valid: true });
  });

  it('loads a v8 board whose instance carries contents', () => {
    const v8 = {
      ...structuredClone(boardV7),
      formatVersion: 8,
      components: [{ ...boardV7.components[0]!, contents: { u1: '0A 1B', 'U4/u1': '' } }],
    };
    expect(validateDocument(migrate(v8))).toEqual({ valid: true });
  });

  it('refuses a file newer than this app, before any validation', () => {
    expect(() => migrate({ ...structuredClone(boardV7), formatVersion: 13 })).toThrow(
      'file is version 13, app supports up to 12',
    );
    expect(() => migrate({ ...structuredClone(chipV5), formatVersion: 9 })).toThrow(
      'file is version 9, app supports up to 8',
    );
  });
});

describe('board v8 -> v9, chip v6 -> v7 (group and wire colours)', () => {
  const boardV8 = {
    ...structuredClone(boardV1),
    formatVersion: 8,
    components: [{ id: 's', kind: 'toggle', pos: { x: 0, y: 0 }, group: 'g' }],
    groups: [{ id: 'g', name: 'G' }],
    wires: [],
    junctions: [],
  };

  it('carries a v8 board through unchanged except the version', () => {
    const out = migrate(structuredClone(boardV8));
    expect(out).toEqual({
      ...boardV8,
      formatVersion: CURRENT_VERSION['lcir.board'],
      timing: { ...boardV8.timing, vendor: 'ti' },
      runSpeed: 25_000,
    });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts colours on groups and wires, in a board and in a chip', () => {
    const wire = {
      id: 'w',
      a: { kind: 'free', pos: { x: 0, y: 0 } },
      b: { kind: 'free', pos: { x: 8, y: 0 } },
      points: [],
      color: 'g5',
    };
    const groups = [{ id: 'g', name: 'G', color: 'g2', tab: true }];
    const board = migrate({ ...structuredClone(boardV8), groups, wires: [wire] });
    expect(validateDocument(board)).toEqual({ valid: true });
    const chip = migrate({
      format: 'lcir.chip',
      formatVersion: 6,
      id: 'c',
      name: 'c',
      version: 1,
      pins: [],
      components: [{ id: 's', kind: 'toggle', pos: { x: 0, y: 0 }, group: 'g' }],
      groups,
      wires: [wire],
      junctions: [],
    });
    expect(validateDocument(chip)).toEqual({ valid: true });
  });

  it('refuses a colour outside the palette', () => {
    const bad = migrate({
      ...structuredClone(boardV8),
      groups: [{ id: 'g', name: 'G', color: '#f00' }],
    });
    expect(validateDocument(bad).valid).toBe(false);
  });
});

describe('board v9 -> v10 (timing vendor)', () => {
  const boardV9 = {
    ...structuredClone(boardV1),
    formatVersion: 9,
    components: [],
    wires: [],
    junctions: [],
    timing: { mode: 'datasheet', datasheet: 'max' },
  };

  it('times every older board from TI, keeping its mode and column', () => {
    const out = migrate(structuredClone(boardV9));
    expect(out).toEqual({
      ...boardV9,
      formatVersion: 12,
      timing: { mode: 'datasheet', datasheet: 'max', vendor: 'ti' },
      runSpeed: 25_000,
    });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts the min column and the Fairchild vendor, and no other vendor', () => {
    const v10 = { ...boardV9, formatVersion: 12, runSpeed: 25_000 };
    const fairchild = {
      ...v10,
      timing: { mode: 'datasheet', datasheet: 'min', vendor: 'fairchild' },
    };
    expect(validateDocument(fairchild)).toEqual({ valid: true });
    const motorola = {
      ...v10,
      timing: { mode: 'datasheet', datasheet: 'min', vendor: 'motorola' },
    };
    expect(validateDocument(motorola)).not.toEqual({ valid: true });
  });
});

describe('board v10 -> v11 (run speed)', () => {
  const boardV10 = {
    ...structuredClone(boardV1),
    formatVersion: 10,
    components: [],
    wires: [],
    junctions: [],
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
  };

  it('runs every older board at the first preset, 25 ns of sim time a second', () => {
    const out = migrate(structuredClone(boardV10));
    expect(out).toEqual({ ...boardV10, formatVersion: 12, runSpeed: 25_000 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('refuses a run speed that is not a whole, positive ps count up to real time', () => {
    const at = (runSpeed: unknown) => ({ ...boardV10, formatVersion: 12, runSpeed });
    expect(validateDocument(at(1_000_000_000_000))).toEqual({ valid: true });
    for (const bad of [0, 2.5, 2_000_000_000_000, 'fast'])
      expect(validateDocument(at(bad)).valid).toBe(false);
  });
});

describe('board v11 -> v12, chip v7 -> v8 (silenced checks)', () => {
  const boardV11 = {
    ...structuredClone(boardV1),
    formatVersion: 11,
    components: [],
    wires: [],
    junctions: [],
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
    runSpeed: 25_000,
  };

  it('carries an older board through with no silenced checks', () => {
    const out = migrate(structuredClone(boardV11));
    expect(out).toEqual({ ...boardV11, formatVersion: 12 });
    expect(out['hiddenChecks']).toBeUndefined();
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts a list of check keys on a board and a chip, and nothing else there', () => {
    const board = { ...boardV11, formatVersion: 12, hiddenChecks: ['unwired:u1.a'] };
    expect(validateDocument(board)).toEqual({ valid: true });
    expect(validateDocument({ ...board, hiddenChecks: [3] }).valid).toBe(false);
    expect(validateDocument({ ...board, hiddenChecks: [''] }).valid).toBe(false);
    const chip = {
      format: 'lcir.chip',
      formatVersion: 7,
      id: 'c',
      name: 'c',
      version: 1,
      pins: [],
      components: [],
      wires: [],
      junctions: [],
    };
    const migrated = migrate(structuredClone(chip));
    expect(migrated).toEqual({ ...chip, formatVersion: 8 });
    expect(validateDocument({ ...migrated, hiddenChecks: ['unused:x.y'] })).toEqual({
      valid: true,
    });
  });
});
