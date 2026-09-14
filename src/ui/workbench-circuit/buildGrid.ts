// Keyboard decisions for the truth-table grid in the Build circuit dialog,
// kept out of the component so they are unit-testable.

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
