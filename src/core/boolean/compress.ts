// Compressed truth-table view (Harris & Harris Fig 2.29): recursive Shannon
// expansion collapses runs of rows that share one output value into a single
// row with X's over the irrelevant inputs. Pure data, no DOM.

import type { TruthTable } from './truthTable';
import { isFullyKnown } from '../value/busValue';

export interface CompressedRow {
  /** One entry per table input, in table order; null = irrelevant (shown as X). */
  bits: readonly (0 | 1 | null)[];
  value: 0 | 1 | 'x' | null;
}

/** Collapses `table`'s rows for one output into the fewest disjoint,
 *  exhaustive rows (Fig 2.29 style): a uniform-value subspace -- including a
 *  uniform don't-care region -- becomes one row with X over its free inputs. */
export function compressTable(
  table: TruthTable,
  outputIndex: number,
  dontCares?: ReadonlySet<number>,
): readonly CompressedRow[] {
  const n = table.inputPaths.length;
  const displayValue = (m: number): 0 | 1 | 'x' | null => {
    if (dontCares?.has(m)) return 'x';
    const v = table.rows[m]![outputIndex]!;
    if (!isFullyKnown(v, 1)) return null;
    return (v.v & 1) === 1 ? 1 : 0;
  };

  const rows: CompressedRow[] = [];

  // Depth-first over fixed-bit prefixes, MSB first: a subspace collapses to
  // one row the moment every minterm under it shares a display value.
  const recurse = (prefix: readonly (0 | 1)[]): void => {
    const depth = prefix.length;
    const free = n - depth;
    const base = prefix.reduce((acc: number, b, i) => acc | (b << (n - 1 - i)), 0);
    let uniform: 0 | 1 | 'x' | null | undefined;
    let allSame = true;
    for (let sub = 0; sub < 1 << free; sub++) {
      const v = displayValue(base | sub);
      if (uniform === undefined) uniform = v;
      else if (uniform !== v) {
        allSame = false;
        break;
      }
    }
    if (allSame || depth === n) {
      // SPEC: don't-care is a display value like 0/1/unknown, so a uniform-DC
      // subspace collapses to one row too, with value 'x' rather than 0 or 1.
      const bits: (0 | 1 | null)[] = [...prefix, ...Array<null>(free).fill(null)];
      rows.push({ bits, value: uniform! });
      return;
    }
    recurse([...prefix, 0]);
    recurse([...prefix, 1]);
  };

  recurse([]);
  return rows;
}
