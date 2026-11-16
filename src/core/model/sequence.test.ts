import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import {
  addExpectColumn,
  addInputColumn,
  addRow,
  cellPasses,
  deleteRow,
  dropIds,
  emptySequence,
  pruneSequence,
  rowPasses,
  setExpectCell,
  setInputCell,
  setRowNote,
} from './sequence';
import type { BoardSequence, Component } from './types';

const comp = (id: string, kind: Component['kind'], width?: number): Component => ({
  id,
  kind,
  pos: { x: 0, y: 0 },
  ...(width ? { params: { width } } : {}),
});

const seq: BoardSequence = {
  inputs: ['a', 'b', 's'],
  expect: ['y', 'p'],
  rows: [
    { set: [1, 0, 1], expect: [3, null], note: 'first' },
    { set: [2, 1, 0], expect: [0, 1] },
  ],
  advance: { mode: 'clock', clock: 'clk' },
  hideExpected: true,
};
const board = [
  comp('a', 'toggle', 4),
  comp('b', 'button'),
  comp('s', 'spdt'),
  comp('y', 'led', 4),
  comp('p', 'probe'),
  comp('clk', 'clock'),
];
const without = (id: string) => board.filter((c) => c.id !== id);

describe('pruneSequence', () => {
  it('returns the same object when every reference still fits', () => {
    expect(pruneSequence(seq, board)).toBe(seq);
  });

  it('drops a gone input and its cells, keeping the other columns in order', () => {
    const out = pruneSequence(seq, without('b'));
    expect(out.inputs).toEqual(['a', 's']);
    expect(out.rows.map((r) => r.set)).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expect(out.rows[0]!.note).toBe('first');
    expect(out.rows[0]!.expect).toEqual([3, null]);
  });

  it('drops a column whose component became a kind a sequence cannot use', () => {
    const out = pruneSequence(seq, [...without('y'), comp('y', 'and')]);
    expect(out.expect).toEqual(['p']);
    expect(out.rows.map((r) => r.expect)).toEqual([[null], [1]]);
  });

  it('falls back to key mode when the clock is gone or is not a clock', () => {
    expect(pruneSequence(seq, without('clk')).advance).toEqual({ mode: 'key' });
    expect(pruneSequence(seq, [...without('clk'), comp('clk', 'toggle')]).advance).toEqual({
      mode: 'key',
    });
  });
});

describe('dropIds', () => {
  it('removes every column for the ids in one pass', () => {
    const out = dropIds(seq, new Set(['a', 'p']));
    expect(out.inputs).toEqual(['b', 's']);
    expect(out.expect).toEqual(['y']);
    expect(out.rows[1]).toEqual({ set: [1, 0], expect: [0] });
  });

  it('leaves the sequence untouched for unrelated ids', () => {
    expect(dropIds(seq, new Set(['zz']))).toBe(seq);
  });
});

describe('comparison', () => {
  it('passes anything against a don’t care', () => {
    expect(cellPasses(null, bv.allX(4), 4)).toBe(true);
  });

  it('needs a fully known, equal value', () => {
    expect(cellPasses(5, bv.known(5, 4), 4)).toBe(true);
    expect(cellPasses(5, bv.known(4, 4), 4)).toBe(false);
    expect(cellPasses(0, bv.allX(4), 4)).toBe(false);
    expect(cellPasses(0, bv.allZ(1), 1)).toBe(false);
  });

  it('compares only the column width', () => {
    expect(cellPasses(0x15, bv.known(5, 4), 4)).toBe(true);
  });

  it('handles width 32 without a sign flip', () => {
    expect(cellPasses(0xffffffff, bv.known(0xffffffff, 32), 32)).toBe(true);
  });

  it('passes a row with no expected cells and fails one missing its actual value', () => {
    expect(rowPasses({ set: [] }, [], [])).toBe(true);
    expect(rowPasses({ set: [], expect: [1] }, [undefined], [1])).toBe(false);
  });
});

describe('editing', () => {
  it('adds an input column filled with its initial value, once', () => {
    const out = addInputColumn(seq, 'n', 7);
    expect(out.rows.map((r) => r.set.at(-1))).toEqual([7, 7]);
    expect(addInputColumn(out, 'n', 1)).toBe(out);
  });

  it('adds an expected column as don’t care, filling rows that had none', () => {
    const bare = addRow(emptySequence(), { set: [] });
    const out = addExpectColumn(addExpectColumn(bare, 'y'), 'p');
    expect(out.rows[0]!.expect).toEqual([null, null]);
  });

  it('sets a cell without touching the other rows', () => {
    const out = setInputCell(seq, 1, 0, 9);
    expect(out.rows[1]!.set).toEqual([9, 1, 0]);
    expect(out.rows[0]).toBe(seq.rows[0]);
    expect(setInputCell(seq, 5, 0, 1)).toBe(seq);
  });

  it('sets an expected cell to a value or back to don’t care', () => {
    expect(setExpectCell(seq, 0, 1, 2).rows[0]!.expect).toEqual([3, 2]);
    expect(setExpectCell(seq, 0, 0, null).rows[0]!.expect).toEqual([null, null]);
  });

  it('inserts and deletes rows', () => {
    const out = addRow(seq, { set: [0, 0, 0] }, 0);
    expect(out.rows).toHaveLength(3);
    expect(deleteRow(out, 0).rows).toEqual(seq.rows);
  });

  it('drops an empty note and keeps a real one', () => {
    expect(setRowNote(seq, 0, '  ').rows[0]).not.toHaveProperty('note');
    expect(setRowNote(seq, 1, 'carry').rows[1]!.note).toBe('carry');
  });
});
