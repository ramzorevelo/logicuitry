import { describe, expect, it } from 'vitest';
import { LibraryLoadError, parseDocument, serializeDocument } from './library';

const chipText = JSON.stringify({
  format: 'lcir.chip',
  formatVersion: 1,
  id: 'and-gate',
  name: 'AND gate',
  version: 1,
  pins: [],
  components: [],
  wires: [],
  junctions: [],
});

describe('library: parseDocument', () => {
  it('parses, validates, and returns a typed document', () => {
    const doc = parseDocument(chipText);
    expect(doc.format).toBe('lcir.chip');
    expect(doc.id).toBe('and-gate');
  });

  it('round-trips through serialize with a trailing newline', () => {
    const doc = parseDocument(chipText);
    const text = serializeDocument(doc);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseDocument(text)).toEqual(doc);
  });

  it('throws on non-JSON', () => {
    expect(() => parseDocument('{ not json')).toThrow(LibraryLoadError);
  });

  it('throws with schema errors on an invalid document', () => {
    const bad = JSON.stringify({ format: 'lcir.chip', formatVersion: 1, id: 'x' });
    try {
      parseDocument(bad);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LibraryLoadError);
      expect((e as LibraryLoadError).errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a version newer than the app supports (migrate guard)', () => {
    const future = JSON.stringify({ format: 'lcir.chip', formatVersion: 99, id: 'x' });
    expect(() => parseDocument(future)).toThrow();
  });
});
