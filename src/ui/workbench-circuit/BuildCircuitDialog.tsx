// Editing either side rewrites the other, which is what makes this teachable
// rather than just a generator: the table and the expression are one function
// seen two ways.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import * as bv from '../../core/value/busValue';
import { ExprError, parseExpr, printExpr, truthTableOfExpr } from '../../core/boolean/expr';
import { MAX_KMAP_INPUTS, MIN_KMAP_INPUTS } from '../../core/boolean/kmap';
import { exprOfCover, synthesizeExpr, synthesizeTable } from '../../core/boolean/synthesize';
import type { SynthNetlist } from '../../core/boolean/synthesize';
import type { TruthTable } from '../../core/boolean/truthTable';
import { cellKeyAction, nextCell, type Cell } from './buildGrid';
import { useModalKeys } from '../modalKeys';

const VAR_NAMES = ['A', 'B', 'C', 'D'];

interface Props {
  /** Seeds the expression box, e.g. the cover showing in the Analyze drawer. */
  initialExpression?: string;
  onBuild: (netlist: SynthNetlist, name: string) => void;
  onClose: () => void;
}

function tableOf(names: readonly string[], cells: readonly Cell[]): TruthTable {
  return {
    inputPaths: names,
    outputPaths: ['Y'],
    rows: cells.map((c) => [bv.known(c === '1' ? 1 : 0, 1)]),
  };
}

function cellsOfExpression(src: string, names: readonly string[]): Cell[] | null {
  try {
    const table = truthTableOfExpr(parseExpr(src));
    if (table.inputPaths.length !== names.length) return null;
    return table.rows.map((r) => ((r[0]!.v & 1) === 1 ? '1' : '0'));
  } catch {
    return null;
  }
}

export function BuildCircuitDialog({ initialExpression, onBuild, onClose }: Props) {
  const [tab, setTab] = useState<'expression' | 'table'>('expression');
  const [text, setText] = useState(initialExpression ?? "A'B + BC");
  const [varCount, setVarCount] = useState(3);
  const [cells, setCells] = useState<Cell[]>(() => Array<Cell>(8).fill('0'));
  const [name, setName] = useState('Built circuit');
  const [twoInputOnly, setTwoInputOnly] = useState(false);
  const [nandOnly, setNandOnly] = useState(false);
  const [cancelNotPairs, setCancelNotPairs] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  useModalKeys(onClose);

  const parsed = useMemo(() => {
    try {
      return { expr: parseExpr(text), error: null as ExprError | null };
    } catch (e) {
      return { expr: null, error: e instanceof ExprError ? e : new ExprError(String(e), 0) };
    }
  }, [text]);

  const names = useMemo(() => VAR_NAMES.slice(0, varCount), [varCount]);
  const dontCares = useMemo(
    () => new Set(cells.flatMap((c, i) => (c === 'x' ? [i] : []))),
    [cells],
  );

  // An expression cannot say "don't care", so re-deriving the cells from the
  // cover this dialog just printed would resolve every x to whatever the
  // minimiser picked for it. Only text the user typed reaches the table.
  const printedCover = useRef<string | null>(null);

  // Only when the parse agrees on the variable count, so a half-typed
  // expression does not wipe a table built by hand.
  useEffect(() => {
    if (text === printedCover.current) return;
    printedCover.current = null;
    const next = cellsOfExpression(text, names);
    if (next) setCells(next);
  }, [text, names]);

  const writeCell = (index: number, value: Cell) => {
    const next = [...cells];
    next[index] = value;
    setCells(next);
    // The same minimiser the Analyze drawer reveals, so the two agree.
    const dcs = new Set(next.flatMap((c, i) => (c === 'x' ? [i] : [])));
    try {
      const printed = printExpr(exprOfCover(tableOf(names, next), 0, dcs));
      printedCover.current = printed;
      setText(printed);
    } catch {
      // A width the K-map engine refuses; the table stays the truth.
    }
  };

  const cycleCell = (index: number) => writeCell(index, nextCell(cells[index]!));

  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onCellKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const action = cellKeyAction(e.key);
    if (!action) return;
    // Digits select a tool on the board behind this dialog.
    e.preventDefault();
    e.stopPropagation();
    if (action.write !== undefined) writeCell(index, action.write);
    const next = index + action.step;
    if (next >= 0 && next < cells.length) cellRefs.current[next]?.focus();
  };

  const build = () => {
    setBuildError(null);
    try {
      const options = {
        twoInputGatesOnly: twoInputOnly,
        nandOnly,
        cancelNotPairs: nandOnly && cancelNotPairs,
      };
      const netlist =
        tab === 'expression'
          ? synthesizeExpr(parseExpr(text), { ...options, outputLabel: text.trim() })
          : synthesizeTable(tableOf(names, cells), { ...options, dontCares });
      onBuild(netlist, name.trim() || 'Built circuit');
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = 1 << varCount;
  const buildable = tab === 'table' || parsed.expr !== null;

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog build-dialog">
        <h3>Build circuit</h3>

        <div className="build-tabs">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={tab === 'expression'}
            onClick={() => setTab('expression')}
          >
            Expression
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-pressed={tab === 'table'}
            onClick={() => setTab('table')}
          >
            Truth table
          </button>
        </div>

        {tab === 'expression' ? (
          <div className="build-expression">
            <label className="settings-row">
              <input
                type="text"
                value={text}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                aria-label="Expression"
              />
              <span className="settings-row__text">
                <span>Expression</span>
                <span className="settings-row__hint">
                  {"A'B + BC"} &nbsp; {"(A + B)C'"} &nbsp; {'A ^ B'} &nbsp; {'A AND NOT B'}
                </span>
              </span>
            </label>
            {parsed.error ? (
              <pre className="build-error">
                {text}
                {'\n'}
                {' '.repeat(Math.max(0, parsed.error.offset))}^{'\n'}
                {parsed.error.message}
              </pre>
            ) : (
              <p className="analyze-muted">Reads as {printExpr(parsed.expr!)}</p>
            )}
          </div>
        ) : (
          <div className="build-table">
            <label className="settings-row">
              <select
                value={varCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setVarCount(n);
                  setCells(Array<Cell>(1 << n).fill('0'));
                  setText('0');
                }}
              >
                {Array.from({ length: MAX_KMAP_INPUTS - MIN_KMAP_INPUTS + 1 }, (_, i) => (
                  <option key={i} value={MIN_KMAP_INPUTS + i}>
                    {MIN_KMAP_INPUTS + i} variables
                  </option>
                ))}
              </select>
              <span className="settings-row__text">
                <span>Inputs</span>
                <span className="settings-row__hint">
                  Click a cell to cycle 0, 1, then a don't-care, or type 0, 1 or x to fill the row
                  and drop to the next. Arrow keys move up and down.
                </span>
              </span>
            </label>
            <table className="build-grid">
              <thead>
                <tr>
                  {names.map((v) => (
                    <th key={v}>{v}</th>
                  ))}
                  <th>Y</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, m) => (
                  <tr key={m}>
                    {names.map((v, i) => (
                      <td key={v}>{(m >> (varCount - 1 - i)) & 1}</td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className="tool-btn build-cell"
                        ref={(el) => {
                          cellRefs.current[m] = el;
                        }}
                        onClick={() => cycleCell(m)}
                        onKeyDown={(e) => onCellKey(e, m)}
                        aria-label={`Output for row ${m}`}
                      >
                        {cells[m]}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="analyze-muted">Minimal cover: {text}</p>
          </div>
        )}

        <label className="settings-row">
          <input
            type="checkbox"
            checked={twoInputOnly}
            onChange={(e) => setTwoInputOnly(e.target.checked)}
          />
          <span className="settings-row__text">
            <span>Use two-input gates only</span>
          </span>
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={nandOnly}
            onChange={(e) => setNandOnly(e.target.checked)}
          />
          <span className="settings-row__text">
            <span>Use NAND gates only</span>
          </span>
        </label>
        {nandOnly ? (
          <label className="settings-row">
            <input
              type="checkbox"
              checked={cancelNotPairs}
              onChange={(e) => setCancelNotPairs(e.target.checked)}
            />
            <span className="settings-row__text">
              <span>Cancel back-to-back NOT pairs</span>
            </span>
          </label>
        ) : null}
        <label className="settings-row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <span className="settings-row__text">
            <span>Name for the new circuit</span>
            <span className="settings-row__hint">
              It lands as its own group, with its own switches and LED.
            </span>
          </span>
        </label>

        {buildError ? <p className="build-error">{buildError}</p> : null}

        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tool-btn" disabled={!buildable} onClick={build}>
            Build
          </button>
        </div>
      </div>
    </div>
  );
}
