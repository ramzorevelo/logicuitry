// The parts of the file layer that do not need a browser: what counts as a
// board, and what a Save As is pre-filled with.

import { describe, expect, it } from 'vitest';
import { boardFileName, BoardFileError, parseBoard, parseDocumentFile } from './boardFile';
import { serializeDocument } from './library';
import type { Board, ChipDef } from '../core/model/types';

const board = (name: string): Board => ({
  format: 'lcir.board',
  formatVersion: 5,
  id: 'b1',
  name,
  components: [],
  wires: [],
  junctions: [],
  probes: [],
  view: { x: 0, y: 0, zoom: 1 },
  timing: { mode: 'ideal', datasheet: 'typ' },
});

describe('parseBoard', () => {
  it('accepts a board document', () => {
    expect(parseBoard(serializeDocument(board('demo'))).name).toBe('demo');
  });

  it('migrates an older board on the way in', () => {
    const v2 = {
      ...board('old'),
      formatVersion: 2,
      components: [{ id: 'i', kind: 'input', pos: { x: 0, y: 0 } }],
    };
    const out = parseBoard(JSON.stringify(v2));
    expect(out.formatVersion).toBe(5);
    expect(out.components[0]!.kind).toBe('inport');
  });

  it('rejects a chip file by format rather than loading it as a board', () => {
    const chip: ChipDef = {
      format: 'lcir.chip',
      formatVersion: 3,
      id: 'c',
      name: 'c',
      version: 1,
      pins: [],
      components: [],
      wires: [],
      junctions: [],
    };
    expect(() => parseBoard(serializeDocument(chip))).toThrow(BoardFileError);
    expect(() => parseBoard(serializeDocument(chip))).toThrow(/chip, not a board/);
  });
});

describe('boardFileName', () => {
  it('slugs the board name', () => {
    expect(boardFileName(board('4-bit Ripple Adder'))).toBe('4-bit-ripple-adder.lcirb');
  });

  it('falls back when the name has nothing usable in it', () => {
    expect(boardFileName(board('  ***  '))).toBe('board.lcirb');
  });
});

describe('parseDocumentFile', () => {
  it('reports a board as a board', () => {
    const out = parseDocumentFile(serializeDocument(board('demo')));
    expect(out.kind).toBe('board');
    if (out.kind === 'board') expect(out.board.name).toBe('demo');
  });

  it('accepts a chip instead of refusing it -- its internals are a circuit', () => {
    const chip: ChipDef = {
      format: 'lcir.chip',
      formatVersion: 3,
      id: 'c1',
      name: 'buf1',
      version: 1,
      pins: [],
      components: [],
      wires: [],
      junctions: [],
    };
    const out = parseDocumentFile(serializeDocument(chip));
    expect(out.kind).toBe('chip');
    if (out.kind === 'chip') expect(out.def.name).toBe('buf1');
  });

  it('still refuses a document that is neither', () => {
    // parseDocument validates first, so a lesson is rejected either by the
    // schema or by the format check -- both are a loud, correct refusal.
    const lesson = { format: 'lcir.lesson', formatVersion: 1, id: 'l', name: 'l', steps: [] };
    expect(() => parseDocumentFile(JSON.stringify(lesson))).toThrow();
  });
});
