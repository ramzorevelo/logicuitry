import { describe, expect, it } from 'vitest';
import { compareOutputs } from './compare';
import { parseExpr, truthTableOfExpr } from './expr';
import * as bv from '../value/busValue';

const tableOf = (src: string) => {
  const t = truthTableOfExpr(parseExpr(src));
  return { t, names: [...t.inputPaths] };
};

const compare = (x: string, y: string) => {
  const a = tableOf(x);
  const b = tableOf(y);
  return compareOutputs(a.t, a.names, b.t, b.names);
};

describe('compareOutputs', () => {
  it('finds an original and its simplification equal on every row', () => {
    const r = compare("A'B + AB + AB'", 'A + B');
    expect(r.kind).toBe('table');
    if (r.kind !== 'table') return;
    expect(r.names).toEqual(['A', 'B']);
    expect(r.differ).toEqual([]);
  });

  it('aligns by name, not by column position', () => {
    const a = tableOf("AB'");
    const b = tableOf("B'A");
    const swapped = { ...b.t, inputPaths: ['B', 'A'] };
    const rows = [0, 1, 2, 3].map((r) => a.t.rows[((r & 1) << 1) | (r >> 1)]!);
    const r = compareOutputs(a.t, a.names, { ...swapped, rows }, ['B', 'A']);
    expect(r.kind === 'table' && r.differ).toEqual([]);
  });

  it('widens the side that dropped a variable and says so', () => {
    const r = compare("AB + AB'", 'A');
    if (r.kind !== 'table') throw new Error(r.kind);
    expect(r.names).toEqual(['A', 'B']);
    expect(r.unreadByB).toEqual(['B']);
    expect(r.differ).toEqual([]);
  });

  it('lists the rows that differ', () => {
    const r = compare('A + B', 'AB');
    if (r.kind !== 'table') throw new Error(r.kind);
    expect(r.differ).toEqual([1, 2]);
    expect(bv.toString(r.a.rows[1]![0]!, 1)).toBe('1');
    expect(bv.toString(r.b.rows[1]![0]!, 1)).toBe('0');
  });

  it('reports names that do not match instead of guessing', () => {
    expect(compare('AB', 'AC')).toEqual({ kind: 'mismatch', onlyA: ['B'], onlyB: ['C'] });
  });

  it('refuses two inputs sharing a name on one side', () => {
    const a = tableOf('AB');
    expect(compareOutputs(a.t, ['A', 'A'], a.t, ['A', 'B'])).toEqual({
      kind: 'duplicate',
      name: 'A',
    });
  });
});
