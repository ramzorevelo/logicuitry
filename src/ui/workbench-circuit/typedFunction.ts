import { create } from 'zustand';
import * as bv from '../../core/value/busValue';
import { canonicalSop } from '../../core/boolean/canonical';
import { ExprError, parseExpr, printExpr, truthTableOfExpr } from '../../core/boolean/expr';
import { MAX_KMAP_INPUTS, MIN_KMAP_INPUTS } from '../../core/boolean/kmap';
import { parseFunctionSpec } from '../../core/boolean/notation';
import type { TruthTable } from '../../core/boolean/truthTable';
import type { Cell } from './buildGrid';

// The Analyze drawer's "Typed function" source: one single-output function the
// instructor types instead of wiring. Session state, kept above the drawer so
// closing and reopening it loses nothing; never in the board, undo or storage.

export type TypedMode = 'sigma' | 'expr' | 'table';
export type AnalyzeSource = 'board' | 'typed';

export interface TypedFunction {
  names: string[];
  /** One per truth-table row, MSB-first; 'x' is a don't-care. */
  cells: Cell[];
}

export const TYPED_OUTPUT_PATH = 'Y';
const VAR_NAMES = ['A', 'B', 'C', 'D'];

export const emptyFunction = (n: number): TypedFunction => ({
  names: VAR_NAMES.slice(0, n),
  cells: Array<Cell>(1 << n).fill('0'),
});

function checkWidth(n: number): void {
  if (n < MIN_KMAP_INPUTS || n > MAX_KMAP_INPUTS)
    throw new ExprError(`the K-map needs ${MIN_KMAP_INPUTS} to ${MAX_KMAP_INPUTS} variables`, 0);
}

export function functionFromSigma(src: string, n: number): TypedFunction {
  const spec = parseFunctionSpec(src, VAR_NAMES.slice(0, n));
  const names = spec.table.inputPaths.slice();
  checkWidth(names.length);
  const cells = spec.table.rows.map(
    (r, i): Cell => (spec.dontCares.has(i) ? 'x' : (r[0]!.v & 1) === 1 ? '1' : '0'),
  );
  return { names, cells };
}

export function functionFromExpr(src: string): TypedFunction {
  const table = truthTableOfExpr(parseExpr(src));
  checkWidth(table.inputPaths.length);
  return {
    names: table.inputPaths.slice(),
    cells: table.rows.map((r): Cell => ((r[0]!.v & 1) === 1 ? '1' : '0')),
  };
}

/** A don't-care row is stored as 0, as the drawer's own DC set marks it. */
export function tableOfFunction(f: TypedFunction): TruthTable {
  return {
    inputPaths: f.names,
    outputPaths: [TYPED_OUTPUT_PATH],
    rows: f.cells.map((c) => [bv.known(c === '1' ? 1 : 0, 1)]),
  };
}

export function dontCaresOf(f: TypedFunction): Set<number> {
  return new Set(f.cells.flatMap((c, i) => (c === 'x' ? [i] : [])));
}

export function sigmaTextOf(f: TypedFunction): string {
  const ones = f.cells.flatMap((c, i) => (c === '1' ? [i] : []));
  const dcs = f.cells.flatMap((c, i) => (c === 'x' ? [i] : []));
  const d = dcs.length > 0 ? ` + d(${dcs.join(',')})` : '';
  return `${TYPED_OUTPUT_PATH}(${f.names.join(',')}) = m(${ones.join(',')})${d}`;
}

/** The canonical sum of products, never the minimised one: printing the
 *  answer into the box would spoil the lesson. Don't-cares are not expressible. */
export function exprTextOf(f: TypedFunction): string {
  return printExpr(canonicalSop(tableOfFunction(f)));
}

export interface TypedError {
  message: string;
  offset: number;
}

const asError = (e: unknown): TypedError =>
  e instanceof ExprError
    ? { message: e.message, offset: e.offset }
    : { message: e instanceof Error ? e.message : String(e), offset: 0 };

export interface TypedState {
  source: AnalyzeSource;
  mode: TypedMode;
  /** Used when the notation carries no `Y(A,B,C) =` prefix. */
  varCount: number;
  fn: TypedFunction;
  sigmaText: string;
  exprText: string;
  error: TypedError | null;
  setSource: (s: AnalyzeSource) => void;
  setMode: (m: TypedMode) => void;
  setVarCount: (n: number) => void;
  editSigma: (text: string) => void;
  editExpr: (text: string) => void;
  setCell: (index: number, value: Cell) => void;
  toggleDontCare: (index: number) => void;
}

const initial = emptyFunction(3);

/** One store per surface: the Analyze drawer and the Algebra tab each keep
 *  their own function, so typing in one never rewrites the other. */
export const createTypedFunction = () =>
  create<TypedState>((set, get) => ({
    source: 'board',
    mode: 'sigma',
    varCount: 3,
    fn: initial,
    sigmaText: '',
    exprText: '',
    error: null,
    setSource: (source) => set({ source }),
    // Re-print the function in the form being opened, so the modes edit one thing.
    setMode: (mode) => {
      const { fn } = get();
      set({
        mode,
        error: null,
        sigmaText: mode === 'sigma' ? sigmaTextOf(fn) : get().sigmaText,
        exprText: mode === 'expr' ? exprTextOf(fn) : get().exprText,
      });
    },
    // A different width restarts the function: its rows no longer line up.
    setVarCount: (varCount) =>
      set({ varCount, fn: emptyFunction(varCount), sigmaText: '', exprText: '', error: null }),
    // A half-typed line leaves the function alone and only reports the error.
    editSigma: (sigmaText) => {
      try {
        const fn = functionFromSigma(sigmaText, get().varCount);
        set({ sigmaText, fn, varCount: fn.names.length, error: null });
      } catch (e) {
        set({ sigmaText, error: asError(e) });
      }
    },
    editExpr: (exprText) => {
      try {
        const fn = functionFromExpr(exprText);
        set({ exprText, fn, varCount: fn.names.length, error: null });
      } catch (e) {
        set({ exprText, error: asError(e) });
      }
    },
    setCell: (index, value) => {
      const cells = get().fn.cells.slice();
      cells[index] = value;
      set({ fn: { ...get().fn, cells }, error: null });
    },
    toggleDontCare: (index) => {
      const cur = get().fn.cells[index];
      get().setCell(index, cur === 'x' ? '0' : 'x');
    },
  }));

export const useTypedFunction = createTypedFunction();
