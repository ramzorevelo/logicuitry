// The parts of the file layer that do not need a browser: what counts as a
// board, and what a Save As is pre-filled with.

import { describe, expect, it } from 'vitest';
import {
  boardFileName,
  BoardFileError,
  lessonFileName,
  parseBoard,
  parseDocumentFile,
} from './boardFile';
import { serializeDocument } from './library';
import type { Board, ChipDef, Lesson } from '../core/model/types';

const board = (name: string): Board => ({
  format: 'lcir.board',
  formatVersion: 15,
  id: 'b1',
  name,
  components: [],
  wires: [],
  junctions: [],
  probes: [],
  view: { x: 0, y: 0, zoom: 1 },
  timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
  runSpeed: 25_000,
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
    expect(out.formatVersion).toBe(15);
    expect(out.components[0]!.kind).toBe('inport');
  });

  it('round-trips a 555 with exact R and C, with no format change', () => {
    const params = { mode: 'monostable', r1: 8200, r2: 1e6, c: 4.7e-6 };
    const b = {
      ...board('timer'),
      components: [{ id: 'u', kind: 'timer555' as const, pos: { x: 0, y: 0 }, params }],
    };
    const out = parseBoard(serializeDocument(b));
    expect(out.formatVersion).toBe(15);
    expect(out.components[0]!.params).toEqual(params);
  });

  it('rejects a chip file by format rather than loading it as a board', () => {
    const chip: ChipDef = {
      format: 'lcir.chip',
      formatVersion: 8,
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

const lesson = (title: string): Lesson => ({
  format: 'lcir.lesson',
  formatVersion: 5,
  id: 'l1',
  title,
  workbench: 'circuit',
  board: 'b1',
  steps: [{ kind: 'narrate', prose: 'Hello', actions: [] }],
});

describe('lessonFileName', () => {
  it('slugs the lesson title like a board name', () => {
    expect(lessonFileName(lesson('ALU flags: when is V set?'))).toBe(
      'alu-flags-when-is-v-set.lcirl',
    );
  });

  it('falls back when the title has nothing usable in it', () => {
    expect(lessonFileName(lesson('?!'))).toBe('lesson.lcirl');
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
      formatVersion: 8,
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

  it('reports a lesson as a lesson', () => {
    const out = parseDocumentFile(serializeDocument(lesson('Flags')));
    expect(out).toEqual({ kind: 'lesson', lesson: lesson('Flags') });
  });

  it('still refuses a malformed lesson loudly', () => {
    const bad = { format: 'lcir.lesson', formatVersion: 1, id: 'l', name: 'l', steps: [] };
    expect(() => parseDocumentFile(JSON.stringify(bad))).toThrow();
  });
});
