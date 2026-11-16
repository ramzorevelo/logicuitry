import { useState, type KeyboardEvent } from 'react';
import { useCircuitStore, type SequenceRunView } from './circuitStore';
import { useLessonEditorStore } from '../lesson/lessonEditorStore';
import type { BoardSequence, Component } from '../../core/model/types';
import {
  SEQUENCE_EXPECT_KINDS,
  SEQUENCE_INPUT_KINDS,
  addExpectColumn,
  addInputColumn,
  addRow,
  columnWidth,
  deleteRow,
  removeColumn,
  setExpectCell,
  setInputCell,
  setRowNote,
} from '../../core/model/sequence';
import {
  formatCell,
  formatExpect,
  parseCell,
  parseExpect,
  sequenceTabApplies,
} from './sequenceCells';

const EMPTY_RUN: SequenceRunView = { cursor: -1, results: [], pending: null };

/** The live run, subscribed by its content so a running sim's frames do not re-render the table. */
function useSequenceRun(): SequenceRunView | null {
  useCircuitStore((s) => {
    const run = s.sequenceRun();
    return run ? `${run.cursor}|${run.pending}|${run.results.join(',')}` : '';
  });
  return useCircuitStore.getState().sequenceRun();
}

export function useSequenceAvailable(): boolean {
  return useCircuitStore((s) =>
    sequenceTabApplies((s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0])?.kind, s.board.id),
  );
}

const nameOf = (c: Component) => c.label || c.id;

function initialOf(c: Component): number {
  if (c.kind === 'toggle') return Number(c.params?.['initial'] ?? 0) >>> 0;
  if (c.kind === 'spdt') return c.params?.['position'] === 'b' ? 1 : 0;
  return 0;
}

export function SequencePanel({ viewOnly }: { viewOnly: boolean }) {
  const sequence = useCircuitStore((s) => s.board.sequence);
  const components = useCircuitStore((s) => s.board.components);
  const powered = useCircuitStore((s) => s.powered);
  const running = useCircuitStore((s) => s.running);
  const run = useSequenceRun() ?? EMPTY_RUN;
  // The lesson editor powers the board to show a step, and its rows must stay editable.
  const editingLesson = useLessonEditorStore((s) => s.draft !== null && !s.playing);
  const editable = (!powered || editingLesson) && !viewOnly;
  const edit = (label: string, fn: (seq: BoardSequence) => BoardSequence | undefined) =>
    useCircuitStore.getState().editSequence(label, fn);

  const byId = new Map(components.map((c) => [c.id, c]));
  const seq = sequence;
  const usedIn = new Set(seq?.inputs ?? []);
  const usedEx = new Set(seq?.expect ?? []);
  const freeInputs = components.filter(
    (c) => SEQUENCE_INPUT_KINDS.has(c.kind) && !usedIn.has(c.id),
  );
  const freeExpect = components.filter(
    (c) => SEQUENCE_EXPECT_KINDS.has(c.kind) && !usedEx.has(c.id),
  );
  const clocks = components.filter((c) => c.kind === 'clock');

  const addColumn = (
    <>
      {freeInputs.length > 0 && (
        <select
          id="sequence-add-input"
          className="sequence-panel__picker"
          aria-label="Add an input column"
          value=""
          disabled={!editable}
          onChange={(e) => {
            const comp = byId.get(e.target.value);
            if (comp) edit('add input column', (s) => addInputColumn(s, comp.id, initialOf(comp)));
          }}
        >
          <option value="">+ Input</option>
          {freeInputs.map((c) => (
            <option key={c.id} value={c.id}>
              {nameOf(c)}
            </option>
          ))}
        </select>
      )}
      {freeExpect.length > 0 && (
        <select
          id="sequence-add-expect"
          className="sequence-panel__picker"
          aria-label="Add an expected output column"
          value=""
          disabled={!editable}
          onChange={(e) => {
            const id = e.target.value;
            if (id) edit('add expected column', (s) => addExpectColumn(s, id));
          }}
        >
          <option value="">+ Expected</option>
          {freeExpect.map((c) => (
            <option key={c.id} value={c.id}>
              {nameOf(c)}
            </option>
          ))}
        </select>
      )}
    </>
  );

  if (!seq || seq.inputs.length === 0) {
    return (
      <div className="sequence-panel sequence-panel--empty">
        <p>
          A sequence is a table of input rows saved with the board. Press ] to apply the next row
          while powered, or let each clock fall apply one.
        </p>
        {freeInputs.length === 0 ? (
          <p className="sequence-panel__hint">Place a switch, button or SPDT switch first.</p>
        ) : viewOnly ? null : powered ? (
          <p className="sequence-panel__hint">Power off to add columns.</p>
        ) : (
          <div className="sequence-panel__bar">{addColumn}</div>
        )}
      </div>
    );
  }

  const advance = seq.advance;
  const shown = (i: number) =>
    !powered ||
    !seq.hideExpected ||
    i <= run.cursor ||
    run.results[i] !== undefined ||
    run.pending === i;
  const st = useCircuitStore.getState;
  const atEnd = run.cursor >= seq.rows.length - 1;

  return (
    <div className="sequence-panel">
      <div className="sequence-panel__bar" role="toolbar" aria-label="Sequence">
        <span className="sequence-panel__group">
          <button
            type="button"
            className="tool-btn"
            disabled={!powered || run.cursor <= 0}
            title="Apply the previous row ([)"
            onClick={() => st().stepSequence(-1)}
          >
            Previous <kbd>[</kbd>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={!powered || atEnd}
            title="Apply the next row (])"
            onClick={() => st().stepSequence(1)}
          >
            Apply next <kbd>]</kbd>
          </button>
        </span>
        <span className="sequence-panel__group" role="radiogroup" aria-label="Advance">
          <span className="sequence-panel__label">Advance</span>
          <button
            type="button"
            className="tool-btn"
            aria-pressed={advance.mode === 'key'}
            disabled={viewOnly}
            onClick={() => edit('advance by key', (s) => ({ ...s, advance: { mode: 'key' } }))}
          >
            By key
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-pressed={advance.mode === 'clock'}
            disabled={viewOnly || clocks.length === 0}
            title={
              clocks.length === 0
                ? 'Place a clock to advance one row per falling edge'
                : 'One row per falling edge while running'
            }
            onClick={() =>
              edit('advance on clock', (s) => ({
                ...s,
                advance: { mode: 'clock', clock: clocks[0]!.id },
              }))
            }
          >
            Each clock
          </button>
          {advance.mode === 'clock' && clocks.length > 1 && (
            <select
              id="sequence-clock"
              className="sequence-panel__picker"
              aria-label="Clock"
              value={advance.clock}
              disabled={viewOnly}
              onChange={(e) =>
                edit('advance on clock', (s) => ({
                  ...s,
                  advance: { mode: 'clock', clock: e.target.value },
                }))
              }
            >
              {clocks.map((c) => (
                <option key={c.id} value={c.id}>
                  {nameOf(c)}
                </option>
              ))}
            </select>
          )}
        </span>
        {!viewOnly && (
          <span className="sequence-panel__group">
            <button
              type="button"
              className="tool-btn"
              disabled={!editable}
              onClick={() =>
                edit('add row', (s) =>
                  addRow(s, {
                    set: s.inputs.map((id) => {
                      const c = byId.get(id);
                      return c ? initialOf(c) : 0;
                    }),
                    ...(s.expect.length ? { expect: s.expect.map(() => null) } : {}),
                  }),
                )
              }
            >
              + Row
            </button>
            <button
              type="button"
              className="tool-btn"
              title={
                powered
                  ? 'Copy the inputs as they are now into a new row'
                  : 'Copy the inputs as saved into a new row'
              }
              onClick={() => st().captureSequenceRow()}
            >
              Capture
            </button>
            {addColumn}
          </span>
        )}
        <label className="wave-panel__toggle">
          <input
            id="sequence-hide-expected"
            type="checkbox"
            checked={seq.hideExpected}
            disabled={viewOnly}
            onChange={(e) =>
              edit('hide expected', (s) => ({ ...s, hideExpected: e.target.checked }))
            }
          />
          Hide expected until applied
        </label>
      </div>
      <div className="sequence-panel__scroll">
        <table className="sequence-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              {seq.inputs.map((id) => (
                <ColumnHead
                  key={id}
                  name={byId.get(id) ? nameOf(byId.get(id)!) : id}
                  kind="in"
                  editable={editable}
                  onRemove={() => edit('remove column', (s) => removeColumn(s, id))}
                />
              ))}
              {seq.expect.map((id, i) => (
                <ColumnHead
                  key={id}
                  name={byId.get(id) ? nameOf(byId.get(id)!) : id}
                  kind="expect"
                  first={i === 0}
                  editable={editable}
                  onRemove={() => edit('remove column', (s) => removeColumn(s, id))}
                />
              ))}
              {seq.expect.length > 0 && <th scope="col">Check</th>}
              <th scope="col" className="sequence-table__sep">
                Note
              </th>
              {editable && <th scope="col" aria-label="Delete" />}
            </tr>
          </thead>
          <tbody>
            {seq.rows.map((row, r) => {
              const result = run.results[r];
              const isCurrent = powered && r === run.cursor;
              return (
                <tr key={r} className={isCurrent ? 'sequence-table__current' : undefined}>
                  <th scope="row" className="sequence-table__index">
                    {isCurrent && <span aria-label="current row">{'▶ '}</span>}
                    {r + 1}
                  </th>
                  {seq.inputs.map((id, c) => {
                    const comp = byId.get(id);
                    const width = columnWidth(comp);
                    const text = formatCell(comp?.kind, row.set[c] ?? 0, width);
                    return (
                      <td key={id} className="sequence-table__value">
                        {editable ? (
                          <CellInput
                            id={`seq-in-${r}-${c}`}
                            label={`Row ${r + 1}, ${comp ? nameOf(comp) : id}`}
                            text={text}
                            parse={(t) => parseCell(comp?.kind, t, width) ?? undefined}
                            commit={(v) =>
                              edit('edit cell', (s) => setInputCell(s, r, c, v as number))
                            }
                          />
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                  {seq.expect.map((id, c) => {
                    const width = columnWidth(byId.get(id));
                    const cell = row.expect?.[c] ?? null;
                    const text = formatExpect(cell, width);
                    return (
                      <td
                        key={id}
                        className={`sequence-table__value${c === 0 ? ' sequence-table__sep' : ''}`}
                      >
                        {editable ? (
                          <CellInput
                            id={`seq-ex-${r}-${c}`}
                            label={`Row ${r + 1}, expected ${byId.get(id) ? nameOf(byId.get(id)!) : id}`}
                            text={text}
                            parse={(t) => parseExpect(t, width)}
                            commit={(v) =>
                              edit('edit expected', (s) =>
                                setExpectCell(s, r, c, v as number | null),
                              )
                            }
                          />
                        ) : shown(r) ? (
                          text
                        ) : (
                          <span className="sequence-table__withheld">?</span>
                        )}
                      </td>
                    );
                  })}
                  {seq.expect.length > 0 && (
                    <td className="sequence-table__result">
                      {result === true && <span className="sequence-pass">{'✓ pass'}</span>}
                      {result === false && <span className="sequence-fail">{'✗ fail'}</span>}
                      {result === undefined && run.pending === r && running && (
                        <span className="sequence-table__withheld">settling</span>
                      )}
                    </td>
                  )}
                  <td className="sequence-table__note sequence-table__sep">
                    {editable ? (
                      <CellInput
                        id={`seq-note-${r}`}
                        label={`Row ${r + 1} note`}
                        text={row.note ?? ''}
                        wide
                        parse={(t) => t}
                        commit={(v) => edit('edit note', (s) => setRowNote(s, r, v as string))}
                      />
                    ) : (
                      row.note
                    )}
                  </td>
                  {editable && (
                    <td>
                      <button
                        type="button"
                        className="tool-btn sequence-table__delete"
                        aria-label={`Delete row ${r + 1}`}
                        title="Delete this row"
                        onClick={() => edit('delete row', (s) => deleteRow(s, r))}
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {seq.rows.length === 0 && (
          <p className="sequence-panel__hint">
            No rows yet. + Row adds one from the saved inputs; Capture copies them as they are.
          </p>
        )}
      </div>
      {advance.mode === 'clock' && (
        <p className="sequence-panel__hint">
          While running, each falling edge of the clock applies the next row, so flip-flops see
          settled inputs at the next rising edge.
        </p>
      )}
    </div>
  );
}

function ColumnHead({
  name,
  kind,
  first = false,
  editable,
  onRemove,
}: {
  name: string;
  kind: 'in' | 'expect';
  first?: boolean;
  editable: boolean;
  onRemove: () => void;
}) {
  const cls = [
    'sequence-table__head',
    kind === 'in' ? 'sequence-table__head--in' : '',
    first ? 'sequence-table__sep' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <th scope="col" className={cls}>
      {name}
      {editable && (
        <button
          type="button"
          className="sequence-table__remove"
          aria-label={`Remove column ${name}`}
          title="Remove this column"
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </th>
  );
}

/** A cell edited in place: Enter or leaving the cell commits, Esc puts it back. */
function CellInput({
  id,
  label,
  text,
  parse,
  commit,
  wide = false,
}: {
  id: string;
  label: string;
  text: string;
  /** Undefined refuses the text. */
  parse: (text: string) => number | string | null | undefined;
  commit: (value: number | string | null) => void;
  wide?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const value = draft ?? text;
  const finish = () => {
    if (draft === null || draft === text) {
      setDraft(null);
      return;
    }
    const parsed = parse(draft);
    if (parsed === undefined) {
      setBad(true);
      return;
    }
    setDraft(null);
    setBad(false);
    commit(parsed);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
      setBad(false);
    }
  };
  return (
    <input
      id={id}
      className={`sequence-cell${wide ? ' sequence-cell--wide' : ''}${bad ? ' sequence-cell--bad' : ''}`}
      aria-label={label}
      aria-invalid={bad}
      value={value}
      size={wide ? 14 : Math.max(2, text.length)}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        setBad(false);
      }}
      onBlur={finish}
      onKeyDown={onKeyDown}
    />
  );
}
