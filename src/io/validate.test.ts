import { describe, expect, it } from 'vitest';
import { validateDocument } from './validate';

const chip = {
  format: 'lcir.chip',
  formatVersion: 7,
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
  formatVersion: 9,
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
