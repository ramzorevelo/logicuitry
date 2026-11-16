import { describe, expect, it } from 'vitest';
import { validateDocument } from './validate';

const chip = {
  format: 'lcir.chip',
  formatVersion: 8,
  id: 'and-gate',
  name: 'AND gate',
  version: 1,
  pins: [],
  components: [],
  wires: [],
  junctions: [],
};

const board = {
  format: 'lcir.board',
  formatVersion: 15,
  id: 'b1',
  name: 'demo',
  components: [],
  wires: [],
  junctions: [],
  probes: [{ path: 'main/Q', label: 'Q' }],
  view: { x: 0, y: 0, zoom: 1 },
  timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
  runSpeed: 25_000,
};

const lesson = {
  format: 'lcir.lesson',
  formatVersion: 4,
  id: 'l1',
  title: 'Noise margins',
  workbench: 'devicelab',
  steps: [{ kind: 'narrate', prose: 'Hello', actions: [] }],
};

describe('validateDocument', () => {
  it('accepts well-formed chip, board, and lesson docs', () => {
    expect(validateDocument(chip)).toEqual({ valid: true });
    expect(validateDocument(board)).toEqual({ valid: true });
    expect(validateDocument(lesson)).toEqual({ valid: true });
  });

  it('accepts a chip with a real component and a chip instance', () => {
    const doc = {
      ...chip,
      components: [
        { id: 'g1', kind: 'and2', pos: { x: 0, y: 0 } },
        { id: 'u1', kind: 'chip', defId: 'other', pos: { x: 1, y: 1 } },
      ],
    };
    expect(validateDocument(doc)).toEqual({ valid: true });
  });

  it('rejects a chip instance missing its defId', () => {
    const doc = { ...chip, components: [{ id: 'u1', kind: 'chip', pos: { x: 0, y: 0 } }] };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
  });

  it('reports the offending path on a bad field', () => {
    const doc = { ...board, timing: { mode: 'nonsense', datasheet: 'typ' } };
    const r = validateDocument(doc);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.join(' ')).toMatch(/timing\/mode/);
  });

  it('rejects unknown top-level properties (additionalProperties: false)', () => {
    const r = validateDocument({ ...lesson, surprise: true });
    expect(r.valid).toBe(false);
  });

  it('loads a RAM preload that fits, and refuses a malformed one naming the component', () => {
    const ram = (preload: string, label?: string) => ({
      id: 'r1',
      kind: 'ram',
      pos: { x: 0, y: 0 },
      params: { width: 8, addressBits: 1, preload },
      ...(label ? { label } : {}),
    });
    expect(validateDocument({ ...board, components: [ram('0A X')] })).toEqual({ valid: true });
    expect(validateDocument({ ...board, components: [ram('0A 1G', 'MEM')] })).toEqual({
      valid: false,
      errors: ["/components/0/params/preload RAM MEM: address 1: '1G' is not a hex value or X"],
    });
    expect(validateDocument({ ...chip, components: [ram('1 2 3')] })).toEqual({
      valid: false,
      errors: ['/components/0/params/preload RAM r1: 3 cells for 2 addresses'],
    });
  });

  it('loads chip instance contents, and refuses a malformed entry naming the component', () => {
    const inst = (contents: Record<string, string>) => ({
      id: 'u1',
      kind: 'chip',
      defId: 'mem',
      label: 'U1',
      pos: { x: 0, y: 0 },
      contents,
    });
    expect(validateDocument({ ...board, components: [inst({ u1: '0A X', 'U4/u1': '' })] })).toEqual(
      { valid: true },
    );
    expect(validateDocument({ ...board, components: [inst({ 'U4/u1': '0A 1G' })] })).toEqual({
      valid: false,
      errors: [
        "/components/0/contents/U4~1u1 chip U1, RAM U4/u1: address 1: '1G' is not a hex value or X",
      ],
    });
    expect(validateDocument({ ...chip, components: [inst({ u1: '123456789' })] })).toEqual({
      valid: false,
      errors: [
        "/components/0/contents/u1 chip U1, RAM u1: address 0: '123456789' has more than 8 hex digits",
      ],
    });
    expect(validateDocument({ ...board, components: [inst({ u1: 7 } as never)] }).valid).toBe(
      false,
    );
    expect(validateDocument({ ...board, components: [inst({ '': '1' })] }).valid).toBe(false);
  });

  it('refuses contents on anything but a chip instance', () => {
    const ram = { id: 'r1', kind: 'ram', pos: { x: 0, y: 0 }, contents: { r1: '1' } };
    expect(validateDocument({ ...board, components: [ram] }).valid).toBe(false);
  });

  it('rejects an unknown or missing format', () => {
    expect(validateDocument({ format: 'lcir.mystery' }).valid).toBe(false);
    expect(validateDocument({}).valid).toBe(false);
    expect(validateDocument(null).valid).toBe(false);
  });
});

describe('lesson v2 validation', () => {
  const predict = {
    kind: 'predict',
    prose: 'Which flags light?',
    actions: [
      { kind: 'power', on: true },
      { kind: 'timing', mode: 'datasheet' },
      { kind: 'row', index: 1, set: [7, 1, 0, 0], when: 'reveal' },
      { kind: 'highlight', components: ['n', 'vf'] },
      { kind: 'tab', tab: 'sequence' },
    ],
    choices: [{ text: 'N' }, { text: 'N and V', right: true }],
    answer: 'N and V.',
  };
  const full = { ...lesson, workbench: 'circuit', board: 'four-operation-alu', steps: [predict] };

  it('accepts every action kind, choices, an answer and a widget step', () => {
    expect(validateDocument(full)).toEqual({ valid: true });
    const widget = { kind: 'widget', prose: '', actions: [], widget: { id: 'meta', params: {} } };
    expect(validateDocument({ ...full, steps: [widget] })).toEqual({ valid: true });
  });

  it('accepts a lesson with no board', () => {
    expect(validateDocument(lesson)).toEqual({ valid: true });
  });

  it('accepts an empty highlight: that is a warning, not an error', () => {
    const step = { ...predict, actions: [{ kind: 'highlight', components: [] }] };
    expect(validateDocument({ ...full, steps: [step] })).toEqual({ valid: true });
  });

  it('rejects two right choices on one step, naming the step', () => {
    const step = {
      ...predict,
      choices: [
        { text: 'a', right: true },
        { text: 'b', right: true },
      ],
    };
    const r = validateDocument({ ...full, steps: [predict, step] });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.join(' ')).toMatch(/\/steps\/1\/choices/);
  });

  it('rejects a negative or fractional row index', () => {
    for (const index of [-1, 1.5]) {
      const step = { ...predict, actions: [{ kind: 'row', index, when: 'open' }] };
      expect(validateDocument({ ...full, steps: [step] }).valid).toBe(false);
    }
  });

  it('rejects an unknown action, tab, kind, or a step without actions', () => {
    const bad = [
      { ...predict, actions: [{ kind: 'explode' }] },
      { ...predict, actions: [{ kind: 'tab', tab: 'memory' }] },
      { ...predict, kind: 'configure' },
      { kind: 'narrate', prose: 'x' },
      { ...predict, actions: [{ kind: 'highlight', components: [3] }] },
    ];
    for (const step of bad) expect(validateDocument({ ...full, steps: [step] }).valid).toBe(false);
  });

  it('rejects a lesson with no steps', () => {
    expect(validateDocument({ ...full, steps: [] }).valid).toBe(false);
  });
});

describe('lesson v3 validation', () => {
  const step = {
    kind: 'predict',
    prose: '7 + 1?',
    actions: [],
    choices: [{ text: 'N and V', right: true }],
    answer: 'N and V.',
    notes: 'Count hands.',
    headline: '7 + 1 = -8',
    narr: { at: 'callout', part: 'flags' },
    revealFreely: true,
    annots: [
      { kind: 'callout', id: 'n1', part: 'y', text: '0101', offset: { x: 0, y: -3 }, until: 1 },
      { kind: 'text', id: 'n2', at: { x: 4, y: 5 }, text: 'no carry' },
      { kind: 'arrow', id: 'n3', from: { x: 1, y: 1 }, to: { x: 2, y: 3 } },
    ],
  };
  const full = { ...lesson, workbench: 'circuit', steps: [step, { ...step, annots: [] }] };

  it('accepts notes, a headline, narration placement, revealFreely and every annotation', () => {
    expect(validateDocument(full)).toEqual({ valid: true });
  });

  it('rejects an annotation id used twice in the lesson, naming the second', () => {
    const r = validateDocument({ ...full, steps: [step, step] });
    expect(r.valid).toBe(false);
    if (!r.valid)
      expect(r.errors.join(' ')).toMatch(/\/steps\/1\/annots\/0 reuses annotation id 'n1'/);
  });

  it('rejects a bad placement, an unknown annotation, a callout without a part or a negative until', () => {
    const bad = [
      { ...step, narr: { at: 'tooltip' } },
      { ...step, annots: [{ kind: 'sticker', id: 'x' }] },
      { ...step, annots: [{ kind: 'callout', id: 'x', text: 't', offset: { x: 0, y: 0 } }] },
      { ...step, annots: [{ kind: 'text', id: 'x', at: { x: 0, y: 0 }, text: 't', until: -1 }] },
      { ...step, annots: [{ kind: 'arrow', id: 'x', from: { x: 0 }, to: { x: 1, y: 1 } }] },
    ];
    for (const s of bad) expect(validateDocument({ ...full, steps: [s] }).valid).toBe(false);
  });
});
