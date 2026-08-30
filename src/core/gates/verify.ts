// Defense-in-depth equivalence check: every transform in transform.ts is constructed to
// already preserve boolean equivalence, but every commit re-verifies via
// core/boolean rather than trusting that by construction.

import type { Board, ChipLibrary } from '../model/types';
import { compile, componentPaths } from '../model/compile';
import {
  buildTruthTable,
  resolveInputNet,
  resolveOutputNet,
  tablesEqual,
  type TruthTable,
} from '../boolean/truthTable';
import { lowerCircuit } from './lower';
import { dedupTerminals, reachableInputBits, type TerminalRef } from './reach';

// SPEC: bubble-push-mode policy for which components count as truth-table
// terminals on a Circuit-workbench board -- interactive sources are inputs,
// pure observers are outputs. core/boolean stays generic (it takes explicit
// terminal paths); the kind lists live here because they are a gates-mode
// decision, not a boolean-eval concern.
export const INPUT_TERMINAL_KINDS: ReadonlySet<string> = new Set(['inport', 'toggle', 'button']);
export const OUTPUT_TERMINAL_KINDS: ReadonlySet<string> = new Set(['outport', 'led', 'probe']);

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

function terminalRefs(board: Board, kinds: ReadonlySet<string>): TerminalRef[] {
  // The same naming compile uses, from the same function: a group qualifies a
  // name, and a name already taken falls back to the component id.
  const paths = componentPaths(board, 'main/');
  return board.components
    .filter((c) => kinds.has(c.kind))
    .map((c) => {
      const base = paths.get(c.id)!;
      const path = c.kind === 'inport' ? `${base}.y` : c.kind === 'outport' ? `${base}.a` : base;
      return { path, kind: c.kind, labeled: !!c.label };
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
  const inputCols = inputs.flatMap((r) => bitCols(compiled, r, resolveInputNet));
  const outputCols = outputs.flatMap((r) => bitCols(compiled, r, resolveOutputNet));
  return outputCols.map((outCol, i) => {
    if (i >= MAX_ANALYSIS_OUTPUTS)
      return {
        outputPath: outCol,
        table: null,
        error: `output limit ${MAX_ANALYSIS_OUTPUTS} exceeded`,
      };
    try {
      const reachable = reachableInputBits(compiled, inputCols, outCol);
      if (reachable.length > MAX_ANALYSIS_INPUTS)
        throw new RangeError(
          `needs ${reachable.length} inputs, max ${MAX_ANALYSIS_INPUTS} analyzable`,
        );
      return {
        outputPath: outCol,
        table: buildTruthTable(compiled, reachable, [outCol]),
        error: null,
      };
    } catch (e) {
      return {
        outputPath: outCol,
        table: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

/** True iff `updated` computes the exact same function as `original` (same
 *  input/output terminal component ids -- transforms never rename those). */
export function isEquivalent(original: Board, updated: Board, lib: ChipLibrary): boolean {
  return tablesEqual(truthTableOf(original, lib), truthTableOf(updated, lib));
}
