// Two outputs' truth tables side by side, inputs aligned by displayed name:
// the lab builds the original and the simplified circuit apart, each with its
// own switch called A, so nets cannot be what lines them up.

import { diffRows, type TruthTable } from './truthTable';

export type OutputComparison =
  | {
      kind: 'table';
      /** Shared input names, MSB first; row r reads them as r's bits. */
      names: string[];
      a: TruthTable;
      b: TruthTable;
      /** Rows where the two outputs disagree. */
      differ: number[];
      /** Names one side does not read at all, so its value ignores them. */
      unreadByA: string[];
      unreadByB: string[];
    }
  | { kind: 'mismatch'; onlyA: string[]; onlyB: string[] }
  | { kind: 'duplicate'; name: string };

/** `t` over `names` (parallel to its inputs), re-indexed over `union`. A name
 *  in `union` that `t` lacks cannot change its output, so every row repeats. */
function widen(t: TruthTable, names: readonly string[], union: readonly string[]): TruthTable {
  const n = union.length;
  const k = names.length;
  const at = names.map((name) => union.indexOf(name));
  const rows = Array.from({ length: 1 << n }, (_, r) => {
    let old = 0;
    for (let i = 0; i < k; i++) if ((r >> (n - 1 - at[i]!)) & 1) old |= 1 << (k - 1 - i);
    return t.rows[old]!;
  });
  return { inputPaths: [...union], outputPaths: t.outputPaths, rows };
}

const firstDuplicate = (names: readonly string[]): string | undefined =>
  names.find((name, i) => names.indexOf(name) !== i);

/** Compares output column 0 of each table. One side's inputs may be a subset
 *  of the other's (a simplification can drop a variable); any other
 *  difference in names is reported, never guessed at. */
export function compareOutputs(
  a: TruthTable,
  aNames: readonly string[],
  b: TruthTable,
  bNames: readonly string[],
): OutputComparison {
  const dup = firstDuplicate(aNames) ?? firstDuplicate(bNames);
  if (dup !== undefined) return { kind: 'duplicate', name: dup };
  const onlyA = aNames.filter((name) => !bNames.includes(name));
  const onlyB = bNames.filter((name) => !aNames.includes(name));
  if (onlyA.length > 0 && onlyB.length > 0) return { kind: 'mismatch', onlyA, onlyB };
  const names = [...aNames, ...onlyB];
  const wa = widen(a, aNames, names);
  const wb = widen(b, bNames, names);
  return {
    kind: 'table',
    names,
    a: wa,
    b: wb,
    differ: diffRows(wa, wb),
    unreadByA: onlyB,
    unreadByB: onlyA,
  };
}
