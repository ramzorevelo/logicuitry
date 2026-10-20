// Editing either side rewrites the other, which is what makes this teachable
// rather than just a generator: the table and the expression are one function
// seen two ways.

import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import * as bv from '../../core/value/busValue';
import { ExprError, parseExpr, printExpr, truthTableOfExpr } from '../../core/boolean/expr';
import { MAX_KMAP_INPUTS, MIN_KMAP_INPUTS } from '../../core/boolean/kmap';
import {
  exprOfCover,
  exprOfPosCover,
  synthesizeExpr,
  synthesizeTable,
} from '../../core/boolean/synthesize';
import type { SynthNetlist } from '../../core/boolean/synthesize';
import type { TruthTable } from '../../core/boolean/truthTable';
import {
  cellKeyAction,
  closeStep,
  constantNote,
  minimiseFirstBlock,
  nextCell,
  resizeTable,
  TABLE_LETTERS,
  tableFromExpression,
  type Cell,
} from './buildGrid';
import { useModalKeys } from '../modalKeys';
import { useCoarsePointer } from '../pointerKind';
import { useCompact } from '../compact';

type GateSet = 'any' | 'nand' | 'nor';

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

/** The table a dialog opens with: the seed expression's own, when it has one. */
function initialTable(text: string): { names: string[]; cells: Cell[]; note: string | null } {
  const sync = tableFromExpression(text);
  if (sync.kind === 'fit') return { names: sync.names, cells: sync.cells, note: null };
  return {
    names: TABLE_LETTERS.slice(0, 3),
    cells: Array<Cell>(8).fill('0'),
    note: sync.kind === 'unfit' ? sync.message : null,
  };
}

export function BuildCircuitDialog({ initialExpression, onBuild, onClose }: Props) {
  const seed = initialExpression ?? "A'B + BC";
  const [first] = useState(() => initialTable(seed));
  const [tab, setTab] = useState<'expression' | 'table'>('expression');
  const [text, setText] = useState(seed);
  const [names, setNames] = useState<string[]>(first.names);
  const [cells, setCells] = useState<Cell[]>(first.cells);
  // Non-null means the cells are stale: the typed expression does not fit a table.
  const [tableNote, setTableNote] = useState<string | null>(first.note);
  const [tableEdited, setTableEdited] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [name, setName] = useState('Built circuit');
  const [twoInputOnly, setTwoInputOnly] = useState(false);
  const [gateSet, setGateSet] = useState<GateSet>('any');
  const [cancelNotPairs, setCancelNotPairs] = useState(false);
  const [minimiseFirst, setMinimiseFirst] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const coarse = useCoarsePointer();
  const compact = useCompact();
  const varCount = names.length;

  const requestClose = () => {
    if (closeStep(tableEdited, confirmDiscard) === 'confirm') setConfirmDiscard(true);
    else onClose();
  };
  useModalKeys(onClose, requestClose);

  const parsed = useMemo(() => {
    try {
      return { expr: parseExpr(text), error: null as ExprError | null };
    } catch (e) {
      return { expr: null, error: e instanceof ExprError ? e : new ExprError(String(e), 0) };
    }
  }, [text]);

  const dontCares = useMemo(
    () => new Set(cells.flatMap((c, i) => (c === 'x' ? [i] : []))),
    [cells],
  );

  // A half-typed expression leaves the table alone, so it never wipes one
  // built by hand.
  const onExpressionChange = (next: string) => {
    setText(next);
    const sync = tableFromExpression(next);
    if (sync.kind === 'fit') {
      setNames(sync.names);
      setCells(sync.cells);
      setTableNote(null);
    } else if (sync.kind === 'unfit') {
      setTableNote(sync.message);
    }
  };

  const writeCell = (index: number, value: Cell) => {
    const next = [...cells];
    next[index] = value;
    setCells(next);
    setTableEdited(true);
    setConfirmDiscard(false);
    setTableNote(null);
    // The same minimiser the Analyze drawer reveals, so the two agree. An
    // expression cannot say "don't care", so the cells, not this text, stay
    // the truth while the table is being edited.
    const dcs = new Set(next.flatMap((c, i) => (c === 'x' ? [i] : [])));
    setText(printExpr(exprOfCover(tableOf(names, next), 0, dcs)));
  };

  const resize = (count: number) => {
    const table = resizeTable(text, count);
    setNames(table.names);
    setCells(table.cells);
    setTableNote(null);
  };

  const cover = useMemo(
    () => exprOfCover(tableOf(names, cells), 0, dontCares),
    [names, cells, dontCares],
  );
  // The table path builds NOR-only from the product of sums, not the SOP above.
  const posCover = useMemo(
    () => (gateSet === 'nor' ? exprOfPosCover(tableOf(names, cells), 0, dontCares) : null),
    [gateSet, names, cells, dontCares],
  );
  const builtCover = posCover ?? cover;

  const minimiseBlock = minimiseFirstBlock(text);

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

  const buildable = tab === 'table' ? tableNote === null : parsed.expr !== null;

  const build = () => {
    if (!buildable) return;
    setBuildError(null);
    try {
      const options = {
        twoInputGatesOnly: twoInputOnly,
        nandOnly: gateSet === 'nand',
        norOnly: gateSet === 'nor',
        cancelNotPairs: gateSet !== 'any' && cancelNotPairs,
      };
      const expression = { ...options, outputLabel: text.trim() };
      const netlist =
        tab === 'table'
          ? synthesizeTable(tableOf(names, cells), { ...options, dontCares })
          : minimiseFirst && minimiseBlock === null
            ? synthesizeTable(truthTableOfExpr(parseExpr(text)), expression)
            : synthesizeExpr(parseExpr(text), expression);
      onBuild(netlist, name.trim() || 'Built circuit');
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = 1 << varCount;
  const constant = constantNote(builtCover);

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <div className="package-dialog build-dialog">
        <h3>Build circuit</h3>

        <div className="package-scroll">
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
                  // A phone would pop its keyboard over the sheet on open.
                  autoFocus={!compact}
                  onChange={(e) => onExpressionChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    build();
                  }}
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
                <select value={varCount} onChange={(e) => resize(Number(e.target.value))}>
                  {Array.from({ length: MAX_KMAP_INPUTS - MIN_KMAP_INPUTS + 1 }, (_, i) => (
                    <option key={i} value={MIN_KMAP_INPUTS + i}>
                      {MIN_KMAP_INPUTS + i} variables
                    </option>
                  ))}
                </select>
                <span className="settings-row__text">
                  <span>Inputs</span>
                  <span className="settings-row__hint">
                    {coarse
                      ? "Tap a cell to cycle 0, 1, then a don't-care."
                      : "Click a cell to cycle 0, 1, then a don't-care, or type 0, 1 or x to fill the row and drop to the next. Arrow keys move up and down."}
                  </span>
                </span>
              </label>
              {tableNote !== null ? <p className="build-error">{tableNote}</p> : null}
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
              <p className="analyze-muted">Minimal cover: {printExpr(cover)}</p>
              {posCover !== null ? (
                <p className="analyze-muted">
                  NOR only builds the minimum POS: {printExpr(posCover)}
                </p>
              ) : null}
              {constant !== null && tableNote === null ? (
                <p className="analyze-muted">{constant}</p>
              ) : null}
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
            <select
              value={gateSet}
              aria-label="Gates"
              onChange={(e) => setGateSet(e.target.value as GateSet)}
            >
              <option value="any">Gates: Any</option>
              <option value="nand">Gates: NAND only</option>
              <option value="nor">Gates: NOR only</option>
            </select>
          </label>
          {gateSet !== 'any' ? (
            <label className="settings-row">
              <input
                type="checkbox"
                checked={cancelNotPairs}
                onChange={(e) => setCancelNotPairs(e.target.checked)}
              />
              <span className="settings-row__text">
                <span>Remove double inversions</span>
              </span>
            </label>
          ) : null}
          {tab === 'expression' ? (
            <label className="settings-row">
              <input
                type="checkbox"
                checked={minimiseFirst && minimiseBlock === null}
                disabled={minimiseBlock !== null}
                onChange={(e) => setMinimiseFirst(e.target.checked)}
              />
              <span className="settings-row__text">
                <span>Minimise first</span>
                <span className="settings-row__hint">
                  {minimiseBlock ??
                    `Build the minimum ${gateSet === 'nor' ? 'product of sums' : 'sum of products'} instead of the expression as written.`}
                </span>
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
        </div>

        {confirmDiscard ? (
          <p className="build-error">Discard the table? Esc again to close</p>
        ) : null}
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
