import { exprVars, parseExpr } from '../../core/boolean/expr';
import type { TruthTable } from '../../core/boolean/truthTable';
import { isFullyKnown } from '../../core/value/busValue';

// The Analyze drawer's decisions that need no React: which output is shown,
// when a reveal starts over, which colour a revealed group takes, and what the
// output and the variables of a build are called.

/** Display char for one table cell: 'X' = instructor-marked don't-care,
 *  '–' = circuit-unknown (X/Z), else '0'/'1'. */
export function bitChar(t: TruthTable, row: number, col: number, dc?: ReadonlySet<number>): string {
  if (dc?.has(row)) return 'X';
  const v = t.rows[row]![col]!;
  if (!isFullyKnown(v, 1)) return '–';
  return (v.v & 1) === 1 ? '1' : '0';
}

/** Rows whose output is X or Z; a row marked don't-care is no longer unknown. */
export function unknownRows(t: TruthTable, dc?: ReadonlySet<number>): number {
  let n = 0;
  for (let r = 0; r < t.rows.length; r++) if (bitChar(t, r, 0, dc) === '–') n++;
  return n;
}

/** The output at `path`, or the first one once that path is gone. */
export function outputIndexOf(paths: readonly string[], path: string | null | undefined): number {
  return path == null ? 0 : Math.max(0, paths.indexOf(path));
}

/** Changes exactly when the function on screen does, so a reveal of one
 *  function never carries over to another. */
export function revealResetKey(source: string, path: string, table: TruthTable | null): string {
  if (!table) return `${source}|${path}`;
  const rows = table.rows.map((_, r) => bitChar(table, r, 0)).join('');
  return `${source}|${path}|${table.inputPaths.join(',')}|${rows}`;
}

export interface ColouredGroup {
  minterms: readonly number[];
  color: number;
}

const groupKey = (g: readonly number[]): string => g.join(',');

/** Colour and inset per revealed group. A group the user circled too keeps that
 *  circle's colour one inset step inside it; every other takes a palette colour
 *  no user circle holds, and only reuses one once the palette runs out. */
export function revealColors(
  user: readonly ColouredGroup[],
  reveal: readonly (readonly number[])[],
  palette = 8,
): { color: number; inset: number }[] {
  const taken = new Set(user.map((c) => c.color % palette));
  let fallback = 0;
  return reveal.map((g, i) => {
    const match = user.findIndex((c) => groupKey(c.minterms) === groupKey(g));
    if (match !== -1) return { color: user[match]!.color, inset: match + 1 };
    let color = 0;
    while (color < palette && taken.has(color)) color++;
    if (color < palette) taken.add(color);
    else color = fallback++ % palette;
    return { color, inset: user.length + i };
  });
}

export function isCircled(
  circles: readonly { minterms: readonly number[] }[],
  minterms: readonly number[],
): boolean {
  const key = groupKey(minterms);
  return circles.some((c) => groupKey(c.minterms) === key);
}

/** Tried in order for an output whose label cannot name it. */
const OUTPUT_LETTERS = ['Y', 'Z', 'F', 'G', 'H', 'Q', 'W'];

/** What the table, function line and As built line call an output. A label
 *  written as an expression over the inputs (a built output's, or one equal to
 *  an input) would print `D = D`, so the output takes a free letter and the
 *  label becomes its caption. */
export function outputDisplay(
  label: string,
  inputNames: readonly string[],
): { name: string; caption: string | null } {
  let overInputs = false;
  try {
    overInputs = exprVars(parseExpr(label)).every((v) => inputNames.includes(v));
  } catch {
    overInputs = false;
  }
  if (!overInputs) return { name: label, caption: null };
  const name =
    OUTPUT_LETTERS.find((l) => !inputNames.includes(l)) ??
    `Y${inputNames.filter((n) => n.startsWith('Y')).length + 1}`;
  return { name, caption: label };
}

/** A terminal path split into the component it addresses and the bus bit, if any:
 *  `main/Q.a[2]`, `main/P[2]` and `main/X.y` all name a component by their base. */
export function splitTerminalPath(path: string): { base: string; bit?: number } {
  const m = /\[(\d+)\]$/.exec(path);
  const base = (m ? path.slice(0, m.index) : path).replace(/\.(y|a)$/, '');
  return m ? { base, bit: Number(m[1]) } : { base };
}

export const withBit = (name: string, bit: number | undefined): string =>
  bit === undefined ? name : `${name}[${bit}]`;

/** Variable names for a built expression: each must parse as one variable and
 *  name one input, so a bus bit drops its brackets and a repeated name gets a
 *  number. */
export function buildVarNames(names: readonly string[]): string[] {
  const clean = names.map(
    (n) =>
      n
        .replace(/\[(\d+)\]$/, '$1')
        .replace(/[\]\n]/g, '')
        .trim() || 'X',
  );
  const reserved = new Set(clean);
  const taken = new Set<string>();
  return clean.map((name) => {
    let out = name;
    for (let k = 2; taken.has(out) || (out !== name && reserved.has(out)); k++)
      out = `${name}${/\d$/.test(name) ? '_' : ''}${k}`;
    taken.add(out);
    return out;
  });
}
