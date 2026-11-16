import * as bv from '../value/busValue';
import type { BoardSequence, Component, ComponentKind, SequenceRow } from './types';

export const SEQUENCE_INPUT_KINDS: ReadonlySet<ComponentKind> = new Set([
  'toggle',
  'button',
  'spdt',
]);
export const SEQUENCE_EXPECT_KINDS: ReadonlySet<ComponentKind> = new Set(['led', 'probe']);

export function emptySequence(): BoardSequence {
  return { inputs: [], expect: [], rows: [], advance: { mode: 'key' }, hideExpected: true };
}

/** Bits a column's cell may hold: a toggle's width, else one (button held, SPDT throw b). */
export function columnWidth(comp: Component | undefined): number {
  if (comp?.kind !== 'toggle' && comp?.kind !== 'led' && comp?.kind !== 'probe') return 1;
  const w = comp.params?.['width'];
  return typeof w === 'number' && w >= 1 && w <= bv.MAX_WIDTH ? w : 1;
}

export function maskToWidth(value: number, width: number): number {
  return (value & bv.widthMask(width)) >>> 0;
}

function keepIndexes<T>(cells: readonly T[] | undefined, keep: readonly number[]): T[] | undefined {
  return cells && keep.map((i) => cells[i]!);
}

/**
 * Drops columns whose component is gone or no longer a kind a sequence can
 * drive or read, and a clock advance whose clock is gone. Returns the same
 * object when nothing changed, so a caller can skip a dirty mark.
 */
export function pruneSequence(seq: BoardSequence, components: readonly Component[]): BoardSequence {
  const byId = new Map(components.map((c) => [c.id, c]));
  const misfit = (kinds: ReadonlySet<ComponentKind>) => (id: string) => {
    const kind = byId.get(id)?.kind;
    return kind === undefined || !kinds.has(kind);
  };
  const gone = new Set([
    ...seq.inputs.filter(misfit(SEQUENCE_INPUT_KINDS)),
    ...seq.expect.filter(misfit(SEQUENCE_EXPECT_KINDS)),
  ]);
  if (seq.advance.mode === 'clock' && byId.get(seq.advance.clock)?.kind !== 'clock')
    gone.add(seq.advance.clock);
  return dropIds(seq, gone);
}

function withRowCells(
  row: SequenceRow,
  set: number[],
  expect: (number | null)[] | undefined,
): SequenceRow {
  const next: SequenceRow = { set };
  if (expect !== undefined) next.expect = expect;
  if (row.note !== undefined) next.note = row.note;
  return next;
}

/** Shape faults a schema cannot catch; dangling ids are pruned, not refused. */
export function sequenceErrors(seq: BoardSequence): string[] {
  const errors: string[] = [];
  const dup = (ids: string[]) => ids.find((id, i) => ids.indexOf(id) !== i);
  const dupIn = dup(seq.inputs);
  if (dupIn !== undefined) errors.push(`/sequence/inputs lists ${dupIn} twice`);
  const dupEx = dup(seq.expect);
  if (dupEx !== undefined) errors.push(`/sequence/expect lists ${dupEx} twice`);
  seq.rows.forEach((row, i) => {
    if (row.set.length !== seq.inputs.length)
      errors.push(
        `/sequence/rows/${i}/set has ${row.set.length} cells, expected ${seq.inputs.length}`,
      );
    if (row.expect && row.expect.length !== seq.expect.length)
      errors.push(
        `/sequence/rows/${i}/expect has ${row.expect.length} cells, expected ${seq.expect.length}`,
      );
  });
  return errors;
}

/** An expected null passes anything; a value needs a fully known, equal actual. */
export function cellPasses(expected: number | null, actual: bv.BusValue, width: number): boolean {
  if (expected === null) return true;
  return (
    bv.isFullyKnown(actual, width) && maskToWidth(actual.v, width) === maskToWidth(expected, width)
  );
}

export function rowPasses(
  row: SequenceRow,
  actual: readonly (bv.BusValue | undefined)[],
  widths: readonly number[],
): boolean {
  const expect = row.expect ?? [];
  return expect.every((cell, i) => {
    const value = actual[i];
    return cell === null || (value !== undefined && cellPasses(cell, value, widths[i] ?? 1));
  });
}

export function addRow(seq: BoardSequence, row: SequenceRow, at = seq.rows.length): BoardSequence {
  const rows = seq.rows.slice();
  rows.splice(at, 0, row);
  return { ...seq, rows };
}

export function deleteRow(seq: BoardSequence, index: number): BoardSequence {
  return { ...seq, rows: seq.rows.filter((_, i) => i !== index) };
}

export function addInputColumn(seq: BoardSequence, id: string, initial: number): BoardSequence {
  if (seq.inputs.includes(id)) return seq;
  return {
    ...seq,
    inputs: [...seq.inputs, id],
    rows: seq.rows.map((row) => withRowCells(row, [...row.set, initial], row.expect)),
  };
}

export function addExpectColumn(seq: BoardSequence, id: string): BoardSequence {
  if (seq.expect.includes(id)) return seq;
  const width = seq.expect.length;
  return {
    ...seq,
    expect: [...seq.expect, id],
    rows: seq.rows.map((row) =>
      withRowCells(row, row.set, [...(row.expect ?? new Array<null>(width).fill(null)), null]),
    ),
  };
}

export function removeColumn(seq: BoardSequence, id: string): BoardSequence {
  return dropIds(seq, new Set([id]));
}

/** The sequence with every column for these component ids removed. */
export function dropIds(seq: BoardSequence, ids: ReadonlySet<string>): BoardSequence {
  const keepIn = seq.inputs.flatMap((id, i) => (ids.has(id) ? [] : [i]));
  const keepEx = seq.expect.flatMap((id, i) => (ids.has(id) ? [] : [i]));
  const clockGone = seq.advance.mode === 'clock' && ids.has(seq.advance.clock);
  if (keepIn.length === seq.inputs.length && keepEx.length === seq.expect.length && !clockGone)
    return seq;
  return {
    ...seq,
    inputs: keepIn.map((i) => seq.inputs[i]!),
    expect: keepEx.map((i) => seq.expect[i]!),
    rows: seq.rows.map((row) =>
      withRowCells(row, keepIndexes(row.set, keepIn)!, keepIndexes(row.expect, keepEx)),
    ),
    advance: clockGone ? { mode: 'key' } : seq.advance,
  };
}

export function setInputCell(
  seq: BoardSequence,
  row: number,
  col: number,
  value: number,
): BoardSequence {
  const target = seq.rows[row];
  if (!target || col < 0 || col >= seq.inputs.length) return seq;
  const set = target.set.slice();
  set[col] = value >>> 0;
  return { ...seq, rows: seq.rows.map((r, i) => (i === row ? withRowCells(r, set, r.expect) : r)) };
}

export function setExpectCell(
  seq: BoardSequence,
  row: number,
  col: number,
  value: number | null,
): BoardSequence {
  const target = seq.rows[row];
  if (!target || col < 0 || col >= seq.expect.length) return seq;
  const expect = (target.expect ?? new Array<null>(seq.expect.length).fill(null)).slice();
  expect[col] = value === null ? null : value >>> 0;
  return { ...seq, rows: seq.rows.map((r, i) => (i === row ? withRowCells(r, r.set, expect) : r)) };
}

export function setRowNote(seq: BoardSequence, row: number, note: string): BoardSequence {
  const target = seq.rows[row];
  if (!target) return seq;
  const next: SequenceRow = { set: target.set };
  if (target.expect) next.expect = target.expect;
  if (note.trim()) next.note = note;
  return { ...seq, rows: seq.rows.map((r, i) => (i === row ? next : r)) };
}
