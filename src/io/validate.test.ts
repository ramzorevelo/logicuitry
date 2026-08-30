import { describe, expect, it } from 'vitest';
import { validateDocument } from './validate';

const chip = {
  format: 'lcir.chip',
  formatVersion: 3,
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
  formatVersion: 5,
  id: 'b1',
  name: 'demo',
  components: [],
  wires: [],
  junctions: [],
  probes: [{ path: 'main/Q', label: 'Q' }],
  view: { x: 0, y: 0, zoom: 1 },
  timing: { mode: 'ideal', datasheet: 'typ' },
};

const lesson = {
  format: 'lcir.lesson',
  formatVersion: 1,
  id: 'l1',
  title: 'Noise margins',
  workbench: 'devicelab',
  steps: [{ type: 'narrate', prose: 'Hello' }],
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

  it('rejects an unknown or missing format', () => {
    expect(validateDocument({ format: 'lcir.mystery' }).valid).toBe(false);
    expect(validateDocument({}).valid).toBe(false);
    expect(validateDocument(null).valid).toBe(false);
  });
});
