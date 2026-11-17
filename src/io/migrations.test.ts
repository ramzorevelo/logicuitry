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
    expect(() => migrate({ ...structuredClone(boardV7), formatVersion: 16 })).toThrow(
      'file is version 16, app supports up to 15',
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
      formatVersion: 15,
      timing: { mode: 'datasheet', datasheet: 'max', vendor: 'ti' },
      runSpeed: 25_000,
    });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts the min column and the Fairchild vendor, and no other vendor', () => {
    const v10 = { ...boardV9, formatVersion: 15, runSpeed: 25_000 };
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
    expect(out).toEqual({ ...boardV10, formatVersion: 15, runSpeed: 25_000 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('refuses a run speed that is not a whole, positive ps count up to real time', () => {
    const at = (runSpeed: unknown) => ({ ...boardV10, formatVersion: 15, runSpeed });
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
    expect(out).toEqual({ ...boardV11, formatVersion: 15 });
    expect(out['hiddenChecks']).toBeUndefined();
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts a list of check keys on a board and a chip, and nothing else there', () => {
    const board = { ...boardV11, formatVersion: 15, hiddenChecks: ['unwired:u1.a'] };
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

describe('board v12 -> v13 (input sequence)', () => {
  const boardV12 = {
    ...structuredClone(boardV1),
    formatVersion: 12,
    components: [],
    wires: [],
    junctions: [],
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
    runSpeed: 25_000,
  };
  const sequence = {
    inputs: ['a', 'b'],
    expect: ['y'],
    rows: [
      { set: [1, 0], expect: [1], note: 'one' },
      { set: [3, 1], expect: [null] },
    ],
    advance: { mode: 'clock', clock: 'clk' },
    hideExpected: true,
  };

  it('carries an older board through with no sequence', () => {
    const out = migrate(structuredClone(boardV12));
    expect(out).toEqual({ ...boardV12, formatVersion: 15 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts a sequence and refuses rows whose cells miss their columns', () => {
    const board = { ...boardV12, formatVersion: 15, sequence };
    expect(validateDocument(board)).toEqual({ valid: true });
    const short = { ...sequence, rows: [{ set: [1] }] };
    expect(validateDocument({ ...board, sequence: short }).valid).toBe(false);
    const twice = { ...sequence, inputs: ['a', 'a'] };
    expect(validateDocument({ ...board, sequence: twice }).valid).toBe(false);
    const noClock = { ...sequence, advance: { mode: 'clock' } };
    expect(validateDocument({ ...board, sequence: noClock }).valid).toBe(false);
    const negative = { ...sequence, rows: [{ set: [-1, 0] }] };
    expect(validateDocument({ ...board, sequence: negative }).valid).toBe(false);
  });
});

describe('lesson v1 -> v2 (kinds and actions)', () => {
  const lessonV1 = (steps: unknown[]) => ({
    format: 'lcir.lesson',
    formatVersion: 1,
    id: 'l1',
    title: 'Old lesson',
    workbench: 'circuit',
    steps,
  });
  const stepsOf = (steps: unknown[]) => migrate(lessonV1(steps))['steps'];

  it('passes a non-object step through, so the schema names it instead of a crash', () => {
    const migrated = migrate(lessonV1([null]));
    expect((migrated['steps'] as unknown[])[0]).toBeNull();
    expect(validateDocument(migrated).valid).toBe(false);
  });

  it('keeps narrate and predict, and makes configure and highlight narrate steps', () => {
    expect(
      stepsOf([
        { type: 'narrate', prose: 'Hi' },
        { type: 'predict', prose: 'Q?' },
        { type: 'configure' },
        { type: 'highlight', params: { components: ['g1'] } },
      ]),
    ).toEqual([
      { kind: 'narrate', prose: 'Hi', actions: [] },
      { kind: 'predict', prose: 'Q?', actions: [] },
      { kind: 'narrate', prose: '', actions: [] },
      { kind: 'narrate', prose: '', actions: [{ kind: 'highlight', components: ['g1'] }] },
    ]);
  });

  it('maps known params to actions in order: row, power, timing, highlight, tab', () => {
    const params = {
      tab: 'waveform',
      highlight: ['a', 'b'],
      timing: 'datasheet',
      power: true,
      row: 2,
      choices: ['yes', 'no'],
      answer: 'yes',
      stray: 42,
    };
    expect(stepsOf([{ type: 'configure', params }])).toEqual([
      {
        kind: 'narrate',
        prose: '',
        actions: [
          { kind: 'row', index: 2, when: 'open' },
          { kind: 'power', on: true },
          { kind: 'timing', mode: 'datasheet' },
          { kind: 'highlight', components: ['a', 'b'] },
          { kind: 'tab', tab: 'waveform' },
        ],
        choices: [{ text: 'yes' }, { text: 'no' }],
        answer: 'yes',
      },
    ]);
  });

  it('holds a predict row back for the reveal', () => {
    expect(stepsOf([{ type: 'predict', params: { row: 0 } }])).toEqual([
      { kind: 'predict', prose: '', actions: [{ kind: 'row', index: 0, when: 'reveal' }] },
    ]);
  });

  it('drops params it cannot read rather than failing the file', () => {
    const params = { row: -1, power: 'on', timing: 'fast', tab: 'memory', components: [1] };
    expect(stepsOf([{ type: 'narrate', params }])).toEqual([
      { kind: 'narrate', prose: '', actions: [] },
    ]);
  });

  it('keeps a widget step with its params, and an unknown kind as a widget', () => {
    expect(
      stepsOf([
        { type: 'widget', prose: 'Watch', params: { id: 'metastability', seed: 7 } },
        { type: 'widget', params: { seed: 7 } },
        { type: 'kmap-walk', params: { cells: [1, 3] } },
      ]),
    ).toEqual([
      {
        kind: 'widget',
        prose: 'Watch',
        actions: [],
        widget: { id: 'metastability', params: { id: 'metastability', seed: 7 } },
      },
      { kind: 'widget', prose: '', actions: [], widget: { id: 'unknown', params: { seed: 7 } } },
      {
        kind: 'widget',
        prose: '',
        actions: [],
        widget: { id: 'kmap-walk', params: { cells: [1, 3] } },
      },
    ]);
  });

  it('loads a v1 file with no board as a lesson naming none', () => {
    const out = migrate(lessonV1([{ type: 'narrate', prose: 'Hi' }]));
    expect(out['formatVersion']).toBe(CURRENT_VERSION['lcir.lesson']);
    expect('board' in out).toBe(false);
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('takes the board from the params of the first step when one is named', () => {
    const out = migrate(lessonV1([{ type: 'narrate', params: { board: 'full-adder' } }]));
    expect(out['board']).toBe('full-adder');
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('migrates a v2 lesson to the current version with nothing else changed', () => {
    const v2 = {
      ...lessonV1([]),
      formatVersion: 2,
      board: 'b1',
      steps: [
        {
          kind: 'predict',
          prose: 'Q?',
          actions: [{ kind: 'row', index: 1, set: [7, 1], when: 'reveal' }],
          choices: [{ text: 'a', right: true }],
          answer: 'a',
        },
      ],
    };
    const out = migrate(structuredClone(v2));
    expect(out).toEqual({ ...v2, formatVersion: 5 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('round-trips a v3 lesson with notes, narration and annotations unchanged', () => {
    const v3 = {
      ...lessonV1([]),
      formatVersion: 3,
      board: 'b1',
      steps: [
        {
          kind: 'predict',
          prose: 'Q?',
          actions: [],
          choices: [{ text: 'a', right: true }],
          notes: 'Wait.',
          headline: 'Look at Y',
          narr: { at: 'caption' },
          revealFreely: true,
          annots: [
            { kind: 'callout', id: 'n1', part: 'y', text: 't', offset: { x: 1, y: -2 }, until: 1 },
            { kind: 'arrow', id: 'n2', from: { x: 0, y: 0 }, to: { x: 3, y: 4 } },
          ],
        },
        { kind: 'narrate', prose: 'Next', actions: [], narr: { at: 'callout', part: 'y' } },
      ],
    };
    const out = migrate(structuredClone(v3));
    expect(out).toEqual({ ...v3, formatVersion: 5 });
    expect(validateDocument(out)).toEqual({ valid: true });
    expect(JSON.parse(JSON.stringify(out))).toEqual({ ...v3, formatVersion: 5 });
  });

  it('keeps a v4 step autoplay seconds', () => {
    const v4 = {
      ...lessonV1([]),
      formatVersion: 4,
      board: 'b1',
      steps: [{ kind: 'narrate', prose: 'Hi', actions: [], seconds: 12 }],
    };
    const out = migrate(structuredClone(v4));
    expect(out).toEqual({ ...v4, formatVersion: 5 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('rejects autoplay seconds out of range', () => {
    const bad = {
      ...lessonV1([]),
      formatVersion: 4,
      steps: [{ kind: 'narrate', prose: 'Hi', actions: [], seconds: 0 }],
    };
    expect(validateDocument(bad).valid).toBe(false);
  });

  it('carries a v4 lesson to v5 unchanged and accepts a pulse action', () => {
    const v4 = {
      ...lessonV1([]),
      formatVersion: 4,
      board: 'b1',
      steps: [{ kind: 'narrate', prose: 'Hi', actions: [{ kind: 'power', on: true }] }],
    };
    const out = migrate(structuredClone(v4));
    expect(out).toEqual({ ...v4, formatVersion: 5 });
    const pulsed = {
      ...out,
      steps: [
        { kind: 'narrate', prose: 'Hi', actions: [{ kind: 'pulse', clock: 'clk', when: 'open' }] },
      ],
    };
    expect(validateDocument(pulsed)).toEqual({ valid: true });
    const noClock = {
      ...out,
      steps: [{ kind: 'narrate', prose: 'Hi', actions: [{ kind: 'pulse', when: 'open' }] }],
    };
    expect(validateDocument(noClock).valid).toBe(false);
  });
});

describe('board v13 -> v14 (active-low LED)', () => {
  const led = { id: 'l', kind: 'led', pos: { x: 0, y: 0 } };
  const boardV13 = {
    ...structuredClone(boardV1),
    formatVersion: 13,
    components: [led],
    wires: [],
    junctions: [],
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
    runSpeed: 25_000,
  };

  it('carries an older board through with its LEDs active high', () => {
    const out = migrate(structuredClone(boardV13));
    expect(out).toEqual({ ...boardV13, formatVersion: 15 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts an active-low LED', () => {
    const board = {
      ...boardV13,
      formatVersion: 15,
      components: [{ ...led, params: { activeLow: true } }],
    };
    expect(validateDocument(board)).toEqual({ valid: true });
  });
});

describe('board v14 -> v15 (challenge)', () => {
  const boardV14 = {
    ...structuredClone(boardV1),
    formatVersion: 14,
    components: [],
    wires: [],
    junctions: [],
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
    runSpeed: 25_000,
  };
  const challenge = {
    title: 'NAND only',
    brief: 'Build Y = A AND B.',
    allowed: ['nand'],
    ics: { min: 0, max: 2 },
    maxGates: 2,
    required: [{ anyOf: ['nand'], count: 1 }],
    tests: { steps: [{ set: { A: 1, B: 1 }, wait: { ms: 1 }, expect: { Y: 1 } }] },
    truthTable: { inputs: ['A', 'B'], outputs: ['Y'], rows: [[1, 1, 1]] },
    fingerprint: '00abc',
  };

  it('carries an older board through with no challenge', () => {
    const out = migrate(structuredClone(boardV14));
    expect(out).toEqual({ ...boardV14, formatVersion: 15 });
    expect(validateDocument(out)).toEqual({ valid: true });
  });

  it('accepts a challenge and round-trips it', () => {
    const board = { ...boardV14, formatVersion: 15, challenge };
    expect(validateDocument(board)).toEqual({ valid: true });
    expect(JSON.parse(JSON.stringify(migrate(structuredClone(board))))).toEqual(board);
  });

  it('refuses a bad block, naming the field', () => {
    const at = (c: unknown) => validateDocument({ ...boardV14, formatVersion: 15, challenge: c });
    const noTitle = at({ ...challenge, title: undefined });
    expect(noTitle.valid).toBe(false);
    const extra = at({ ...challenge, secret: 1 });
    expect(extra.valid).toBe(false);
    const badStep = at({ ...challenge, tests: { steps: [{ tick: 1 }] } });
    expect(badStep).toEqual({
      valid: false,
      errors: ['/challenge/tests steps[0]: unknown key "tick"'],
    });
    const badCell = at({
      ...challenge,
      truthTable: { ...challenge.truthTable, rows: [[2, 1, 1]] },
    });
    expect(badCell.valid).toBe(false);
    if (!badCell.valid) expect(badCell.errors[0]).toMatch(/^\/challenge\/truthTable\/rows\/0\/0/);
  });
});
