// Keyboard and sync decisions for the truth-table grid in the Build circuit dialog,
// kept out of the component so they are unit-testable.

import { exprVars, parseExpr, truthTableOfExpr, type Expr } from '../../core/boolean/expr';
import { MAX_KMAP_INPUTS, MIN_KMAP_INPUTS } from '../../core/boolean/kmap';

/** 0, 1, or a don't-care the minimiser may choose freely. */
export type Cell = '0' | '1' | 'x';

/** `d` and `-` are the two other ways a textbook writes a don't-care. */
const TYPED: Record<string, Cell | undefined> = {
  '0': '0',
  '1': '1',
  x: 'x',
  d: 'x',
  '-': 'x',
};

export interface CellKeyAction {
  /** Absent when the key only moves the focus. */
  write?: Cell;
  /** Rows to move by, so typing a value falls through to the next row. */
  step: number;
}

export function cellKeyAction(key: string): CellKeyAction | null {
  const write = TYPED[key.toLowerCase()];
  if (write !== undefined) return { write, step: 1 };
  if (key === 'ArrowDown') return { step: 1 };
  if (key === 'ArrowUp') return { step: -1 };
  return null;
}

export const nextCell = (c: Cell): Cell => (c === '0' ? '1' : c === '1' ? 'x' : '0');

/** Column names a fresh table starts with. */
export const TABLE_LETTERS = ['A', 'B', 'C', 'D'];

/** What the truth-table tab makes of the expression box. */
export type TableSync =
  | { kind: 'fit'; names: string[]; cells: Cell[] }
  | { kind: 'unfit'; message: string }
  | { kind: 'unparsed' };

export function tableFromExpression(src: string): TableSync {
  let expr: Expr;
  try {
    expr = parseExpr(src);
  } catch {
    return { kind: 'unparsed' };
  }
  const n = exprVars(expr).length;
  if (n < MIN_KMAP_INPUTS || n > MAX_KMAP_INPUTS)
    return {
      kind: 'unfit',
      message: `The truth table needs ${MIN_KMAP_INPUTS} to ${MAX_KMAP_INPUTS} variables; this expression has ${n === 0 ? 'none' : n}.`,
    };
  const table = truthTableOfExpr(expr);
  return {
    kind: 'fit',
    names: [...table.inputPaths],
    cells: table.rows.map((r) => ((r[0]!.v & 1) === 1 ? '1' : '0')),
  };
}

/** A new variable count keeps the expression when it has that many variables;
 *  any other count starts an empty table. */
export function resizeTable(src: string, count: number): { names: string[]; cells: Cell[] } {
  const sync = tableFromExpression(src);
  if (sync.kind === 'fit' && sync.names.length === count)
    return { names: sync.names, cells: sync.cells };
  return { names: TABLE_LETTERS.slice(0, count), cells: Array<Cell>(1 << count).fill('0') };
}

/** Why Minimise first cannot run on `src`, or null when it can. The minimiser
 *  is the K-map's, so it shares the map's range. */
export function minimiseFirstBlock(src: string): string | null {
  let n: number;
  try {
    n = exprVars(parseExpr(src)).length;
  } catch {
    return null;
  }
  return n >= MIN_KMAP_INPUTS && n <= MAX_KMAP_INPUTS
    ? null
    : `Minimise first needs ${MIN_KMAP_INPUTS} to ${MAX_KMAP_INPUTS} variables`;
}

/** The line a constant cover earns, or null when some input matters. */
export function constantNote(cover: Expr): string | null {
  return cover.kind === 'const' ? `Y is constant ${cover.value}: no input affects it` : null;
}

/** Esc or a backdrop press: an edited table asks once before it is thrown away. */
export function closeStep(tableEdited: boolean, confirming: boolean): 'close' | 'confirm' {
  return tableEdited && !confirming ? 'confirm' : 'close';
}
