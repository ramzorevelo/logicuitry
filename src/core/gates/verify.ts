// Defense-in-depth equivalence check: every transform in transform.ts is constructed to
// already preserve boolean equivalence, but every commit re-verifies via
// core/boolean rather than trusting that by construction.

import type { Board, ChipLibrary } from '../model/types';
import { compile, componentPaths } from '../model/compile';
import {
  buildTruthTable,
  diffRows,
  MAX_TABLE_INPUTS,
  parseBitPath,
  resolveInputNet,
  resolveOutputNet,
  StoredStateError,
  type TruthTable,
} from '../boolean/truthTable';
import { BooleanEvalError } from '../boolean/evaluate';
import { SEGMENT_NAMES } from '../sim/primitives/display';
import { lowerCircuit } from './lower';
import { dedupTerminals, reachableInputBits, type TerminalRef } from './reach';

// SPEC: bubble-push-mode policy for which components count as truth-table
// terminals on a Circuit-workbench board -- interactive sources are inputs,
// pure observers are outputs. core/boolean stays generic (it takes explicit
// terminal paths); the kind lists live here because they are a gates-mode
// decision, not a boolean-eval concern.
export const INPUT_TERMINAL_KINDS: ReadonlySet<string> = new Set(['inport', 'toggle', 'button']);
export const OUTPUT_TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'outport',
  'led',
  'probe',
  'sevenseg',
]);

export const NO_OUTPUT_MESSAGE = 'No output on this board: add an LED, output or probe';

/** Whole-board equivalence check (bubble-push defense-in-depth): a board may
 *  legitimately carry width>1 terminals (M6.6 gate data-bit width) even
 *  though bubble-push itself only ever touches 1-bit gates -- every terminal
 *  is bit-expanded the same way `analysisTablesOf` does, so a wide switch/LED
 *  elsewhere on the board never blocks verifying an unrelated 1-bit push. */
export function truthTableOf(board: Board, lib: ChipLibrary): TruthTable {
  // Defs are lowered too so a packaged chip carrying bubble params evaluates.
  // Deliberately NOT net-deduped (unlike analysisTablesOf): this is a
  // defense-in-depth whole-board check that a transform preserved every
  // physical terminal's value, and a legal transform can itself land two
  // previously-distinct terminals on the same net (e.g. two LEDs merging
  // through a junction) -- deduping those away would hide exactly the shape
  // change this check exists to catch.
  const loweredLib: ChipLibrary = new Map([...lib].map(([id, def]) => [id, lowerCircuit(def)]));
  const compiled = compile(lowerCircuit(board), loweredLib);
  const inputCols = terminalRefs(board, INPUT_TERMINAL_KINDS).flatMap((r) =>
    bitCols(compiled, r, resolveInputNet),
  );
  const outputCols = terminalRefs(board, OUTPUT_TERMINAL_KINDS).flatMap((r) =>
    bitCols(compiled, r, resolveOutputNet),
  );
  return buildTruthTable(compiled, inputCols, outputCols);
}

interface CompiledSide {
  compiled: ReturnType<typeof compile>;
  inputCols: string[];
  outputCols: string[];
}

function compileSide(board: Board, lib: ChipLibrary): CompiledSide {
  const loweredLib: ChipLibrary = new Map([...lib].map(([id, def]) => [id, lowerCircuit(def)]));
  const compiled = compile(lowerCircuit(board), loweredLib);
  return {
    compiled,
    inputCols: terminalRefs(board, INPUT_TERMINAL_KINDS).flatMap((r) =>
      bitCols(compiled, r, resolveInputNet),
    ),
    outputCols: terminalRefs(board, OUTPUT_TERMINAL_KINDS).flatMap((r) =>
      bitCols(compiled, r, resolveOutputNet),
    ),
  };
}

/** Rows (counted per output cone) where `a` and `b` disagree. Each output is
 *  compared over only the inputs that reach it in either board, so independent
 *  groups never add up to one oversized table. Not net-deduped, for the same
 *  reason as `truthTableOf`. */
export function boardDiffRows(a: Board, b: Board, lib: ChipLibrary): number[] {
  const sa = compileSide(a, lib);
  const sb = compileSide(b, lib);
  if (sa.outputCols.length === 0) throw new RangeError(NO_OUTPUT_MESSAGE);
  if (sa.inputCols.length === 0) throw new RangeError('truth table needs at least one input');
  if (
    sa.outputCols.length !== sb.outputCols.length ||
    sa.outputCols.some((c, i) => c !== sb.outputCols[i])
  )
    return [0];
  const diffs: number[] = [];
  for (const outCol of sa.outputCols) {
    const reachA = reachableInputBits(sa.compiled, sa.inputCols, outCol);
    const reachB = reachableInputBits(sb.compiled, sb.inputCols, outCol);
    const cone = sa.inputCols.filter((c) => reachA.includes(c) || reachB.includes(c));
    // A constant output has no cone; any one input gives a valid, trivial table.
    const cols = cone.length > 0 ? cone : [sa.inputCols[0]!];
    if (!cols.every((c) => sb.inputCols.includes(c))) return [0];
    try {
      diffs.push(
        ...diffRows(
          buildTruthTable(sa.compiled, cols, [outCol]),
          buildTruthTable(sb.compiled, cols, [outCol]),
        ),
      );
    } catch (e) {
      if (e instanceof RangeError && /exceeds max/.test(e.message))
        throw new RangeError(
          `output ${outCol} needs ${cols.length} inputs, max ${MAX_TABLE_INPUTS}`,
        );
      throw e;
    }
  }
  return diffs;
}

/** Pins of `component` that some wire actually lands on. A 7-segment has ten
 *  of them and an unwired one has no net to build a column from, so a display
 *  contributes only the segments the board really drives. */
function wiredPins(board: Board, componentId: string): Set<string> {
  const wired = new Set<string>();
  for (const w of board.wires)
    for (const end of [w.a, w.b])
      if (end.kind === 'pin' && end.component === componentId) wired.add(end.pin);
  return wired;
}

/** One ref per terminal, except a 7-segment display, which emits one per wired
 *  segment pin: each segment is its own boolean function, which is how Harris &
 *  Harris presents the seven-segment decoder. The two commons are supply
 *  terminals, never functions of the inputs, so they are skipped. */
export function terminalRefs(board: Board, kinds: ReadonlySet<string>): TerminalRef[] {
  // The same naming compile uses, from the same function: a group qualifies a
  // name, and a name already taken falls back to the component id.
  const paths = componentPaths(board, 'main/');
  return board.components
    .filter((c) => kinds.has(c.kind))
    .flatMap((c): TerminalRef[] => {
      const base = paths.get(c.id)!;
      const shared = { kind: c.kind, labeled: !!c.label, ...(c.group ? { group: c.group } : {}) };
      const name = c.label || c.id;
      if (c.kind === 'sevenseg') {
        const wired = wiredPins(board, c.id);
        return SEGMENT_NAMES.filter((pin) => wired.has(pin)).map((pin) => ({
          ...shared,
          path: `${base}.${pin}`,
          name: `${name} segment ${pin}`,
        }));
      }
      const path = c.kind === 'inport' ? `${base}.y` : c.kind === 'outport' ? `${base}.a` : base;
      return [{ ...shared, path, name }];
    });
}

export interface OutputAnalysis {
  outputPath: string;
  /** Table over only this output's reachable, net-deduped inputs; null with
   *  `error` set when it can't be built (no inputs reach it, too many, ...). */
  table: TruthTable | null;
  error: string | null;
}

/** A K-map exists for 2..4 vars today (5 deferred); reject an output bit
 *  needing more than this many inputs (owner decision, M6.6). */
export const MAX_ANALYSIS_INPUTS = 5;
/** Cap on total per-bit output tables (owner decision, M6.6). */
export const MAX_ANALYSIS_OUTPUTS = 16;

/** Terminal expanded to bit columns: bare path at width 1, `path[b]` MSB
 *  first otherwise -- each output bit is its own table/K-map (M6.6). */
function bitCols(
  compiled: ReturnType<typeof compile>,
  ref: TerminalRef,
  resolve: typeof resolveInputNet,
): string[] {
  const w = compiled.nets[resolve(compiled, ref.path)]!.width;
  if (w === 1) return [ref.path];
  return Array.from({ length: w }, (_, i) => `${ref.path}[${w - 1 - i}]`);
}

/** Per-output-bit analysis tables (Analyze drawer): terminals collapsed
 *  one-per-net, each width-w terminal expanded into w bit columns, and each
 *  output bit's table restricted to the input bits that actually reach it
 *  (lane-aware). `truthTableOf` above keeps its all-inputs 1-bit semantics --
 *  bubble-mode verification depends on them. */
export function analysisTablesOf(board: Board, lib: ChipLibrary): OutputAnalysis[] {
  const loweredLib: ChipLibrary = new Map([...lib].map(([id, def]) => [id, lowerCircuit(def)]));
  const compiled = compile(lowerCircuit(board), loweredLib);
  const inputs = dedupTerminals(
    compiled,
    terminalRefs(board, INPUT_TERMINAL_KINDS),
    resolveInputNet,
  );
  const outputs = dedupTerminals(
    compiled,
    terminalRefs(board, OUTPUT_TERMINAL_KINDS),
    resolveOutputNet,
  );
  const inputCols = inputs.flatMap((r) =>
    bitCols(compiled, r, resolveInputNet).map((col) => ({ col, ref: r })),
  );
  const outputCols = outputs.flatMap((r) =>
    bitCols(compiled, r, resolveOutputNet).map((col) => ({ col, ref: r })),
  );
  const outputNets = new Set(outputs.map((r) => resolveOutputNet(compiled, r.path)));
  // An unwired input still names a variable of the function its group builds.
  const fanOutFree = (col: string): boolean => {
    const net = resolveInputNet(compiled, parseBitPath(col).base);
    return compiled.fanout[net]!.length === 0 && !outputNets.has(net);
  };
  const allInputCols = inputCols.map((c) => c.col);
  return outputCols.map(({ col: outCol, ref: outRef }, i) => {
    const name = columnName(outCol, outRef);
    if (i >= MAX_ANALYSIS_OUTPUTS)
      return {
        outputPath: outCol,
        table: null,
        error: `Analyze handles up to ${MAX_ANALYSIS_OUTPUTS} outputs; ${name} is past that`,
      };
    try {
      const reachable = reachableInputBits(compiled, allInputCols, outCol);
      const outNet = resolveOutputNet(compiled, parseBitPath(outCol).base);
      // An output nothing drives is no function at all, so no stray switch joins it.
      const driven = reachable.length > 0 || compiled.drivers[outNet]!.length > 0;
      const cols = inputCols
        .filter(
          ({ col, ref }) =>
            reachable.includes(col) || (driven && ref.group === outRef.group && fanOutFree(col)),
        )
        .map((c) => c.col);
      if (cols.length === 0) throw new RangeError(`${name} is not connected to any input`);
      if (cols.length > MAX_ANALYSIS_INPUTS)
        throw new RangeError(
          `${name} reads ${cols.length} inputs; Analyze handles up to ${MAX_ANALYSIS_INPUTS}`,
        );
      return {
        outputPath: outCol,
        table: buildTruthTable(compiled, cols, [outCol]),
        error: null,
      };
    } catch (e) {
      return { outputPath: outCol, table: null, error: plainError(e, name) };
    }
  });
}

/** What a message calls one bit column of a terminal. */
function columnName(col: string, ref: TerminalRef): string {
  const { bit } = parseBitPath(col);
  const name = ref.name ?? col;
  return bit === undefined ? name : `${name} bit ${bit}`;
}

/** The drawer shows these as written, so they name the output and never a path. */
function plainError(e: unknown, name: string): string {
  if (e instanceof StoredStateError)
    return `${name} depends on a flip-flop or latch, so it has no truth table`;
  if (e instanceof BooleanEvalError)
    return `The board has a feedback loop, so ${name} has no truth table`;
  return e instanceof Error ? e.message : String(e);
}

/** True iff `updated` computes the exact same function as `original` (same
 *  input/output terminal component ids -- transforms never rename those). */
export function isEquivalent(original: Board, updated: Board, lib: ChipLibrary): boolean {
  return boardDiffRows(original, updated, lib).length === 0;
}
