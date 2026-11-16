import { useMemo, useState } from 'react';
import { WIRING_AIDS, isPackageDef } from '../../core/challenge/allowed';
import { truthTableFromBoard } from '../../core/challenge/behavior';
import { challengeErrors, partsOnBoard, testsFromSequence } from '../../core/challenge/challenge';
import { canonicalJson, challengeFingerprint } from '../../core/challenge/fingerprint';
import type { Challenge, ChallengeRequirement } from '../../core/model/types';
import { useModalKeys } from '../modalKeys';
import { useCircuitStore } from './circuitStore';
import { partLabel } from './challengeView';
import { PALETTE } from './palette';

/** Every entry an allowed list or a requirement can name: built-in kinds, then 74-series parts. */
function usePartChoices(): string[] {
  const chipLib = useCircuitStore((s) => s.chipLib);
  return useMemo(() => {
    const kinds = [
      ...new Set(
        PALETTE.filter((p) => p.kind !== 'chip' && !WIRING_AIDS.has(p.kind)).map((p) => p.kind),
      ),
    ];
    const parts = [...chipLib.values()]
      .filter(isPackageDef)
      .map((d) => d.id)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return [...kinds, ...parts];
  }, [chipLib]);
}

function PartChips({
  parts,
  onRemove,
}: {
  parts: readonly string[];
  onRemove: (part: string) => void;
}) {
  return (
    <>
      {parts.map((p) => (
        <span key={p} className="challenge-chip">
          {partLabel(p)}
          <button type="button" aria-label={`Remove ${partLabel(p)}`} onClick={() => onRemove(p)}>
            x
          </button>
        </span>
      ))}
    </>
  );
}

function PartPicker({
  choices,
  taken,
  label,
  onPick,
}: {
  choices: readonly string[];
  taken: readonly string[];
  label: string;
  onPick: (part: string) => void;
}) {
  const free = choices.filter((c) => !taken.includes(c));
  return (
    <select
      className="challenge-picker"
      aria-label={label}
      value=""
      disabled={free.length === 0}
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">+ Part</option>
      {free.map((c) => (
        <option key={c} value={c}>
          {partLabel(c)}
        </option>
      ))}
    </select>
  );
}

/** An empty field is "any"; anything else must be a whole number of at least zero, or null. */
function countField(text: string): number | undefined | null {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const cellText = (c: 0 | 1 | null) => (c === null ? '-' : String(c));
const nextCell = (c: 0 | 1 | null): 0 | 1 | null => (c === 0 ? 1 : c === 1 ? null : 0);

/**
 * Edit challenge and New challenge from this board. Set writes the block as
 * one undo step; an edit keeps the first fingerprint, so the board reads as
 * changed, unless the author marks it set again.
 */
export function ChallengeDialog({
  initial,
  isNew,
  onClose,
}: {
  initial: Challenge;
  isNew: boolean;
  onClose: () => void;
}) {
  useModalKeys(onClose);
  const choices = usePartChoices();
  const [draft, setDraft] = useState<Challenge>(initial);
  const [icMin, setIcMin] = useState(initial.ics?.min?.toString() ?? '');
  const [icMax, setIcMax] = useState(initial.ics?.max?.toString() ?? '');
  const [maxGates, setMaxGates] = useState(initial.maxGates?.toString() ?? '');
  const [restamp, setRestamp] = useState(false);
  const [editingRows, setEditingRows] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const patch = (p: Partial<Challenge>) => setDraft((d) => ({ ...d, ...p }));
  const clear = (key: 'tests' | 'truthTable') =>
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  const setReq = (i: number, req: ChallengeRequirement | null) =>
    setDraft((d) => ({
      ...d,
      required: req
        ? d.required.map((r, j) => (j === i ? req : r))
        : d.required.filter((_, j) => j !== i),
    }));
  const wasSet = initial.fingerprint !== undefined && !isNew;

  const board = () => useCircuitStore.getState().board;
  const chipLib = () => useCircuitStore.getState().chipLib;

  const takeSequence = () => {
    const tests = testsFromSequence(board());
    if (typeof tests === 'string') return setNotice(tests);
    setNotice(null);
    patch({ tests });
  };
  const takeAnalyze = () => {
    const table = truthTableFromBoard(board(), chipLib());
    if (typeof table === 'string') return setNotice(table);
    setNotice(null);
    patch({ truthTable: table });
  };

  const set = () => {
    const min = countField(icMin);
    const max = countField(icMax);
    const gates = countField(maxGates);
    if (min === null || max === null || gates === null)
      return setErrors(['IC and gate counts are whole numbers of 0 or more, or empty for any']);
    const body: Challenge = {
      title: draft.title.trim(),
      brief: draft.brief,
      allowed: draft.allowed,
      required: draft.required.filter((r) => r.anyOf.length > 0),
      ...(min !== undefined || max !== undefined
        ? { ics: { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) } }
        : {}),
      ...(gates === undefined ? {} : { maxGates: gates }),
      ...(draft.tests ? { tests: draft.tests } : {}),
      ...(draft.truthTable ? { truthTable: draft.truthTable } : {}),
    };
    const problems = challengeErrors(body);
    if (problems.length > 0) return setErrors(problems);
    // An unchanged block stays as it is: no undo step, and no stamp mismatch from tidying it.
    const unchanged =
      !isNew &&
      canonicalJson({ ...body, fingerprint: undefined }) ===
        canonicalJson({ ...initial, fingerprint: undefined });
    if (unchanged && !restamp) return onClose();
    const stamp = !wasSet || restamp ? challengeFingerprint(body) : initial.fingerprint;
    const next = stamp === undefined ? body : { ...body, fingerprint: stamp };
    useCircuitStore.getState().setChallenge(isNew ? 'new challenge' : 'edit challenge', next);
    onClose();
  };

  const table = draft.truthTable;
  const tableName = table
    ? `${table.outputs.join(', ')} from ${table.inputs.join(', ')}, ${table.rows.length} rows`
    : 'none';
  const testCount = draft.tests?.steps.length ?? 0;

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="package-dialog challenge-dialog"
        role="dialog"
        aria-label={isNew ? 'New challenge' : 'Edit challenge'}
      >
        <h3>{isNew ? 'New challenge' : 'Edit challenge'}</h3>
        <div className="package-scroll challenge-dialog__body">
          <section>
            <h4>Brief</h4>
            <label className="package-field">
              Title
              <input
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
                autoFocus
              />
            </label>
            <label className="package-field">
              What to build
              <textarea
                rows={4}
                value={draft.brief}
                onChange={(e) => patch({ brief: e.target.value })}
              />
            </label>
          </section>
          <section>
            <h4>Allowed parts</h4>
            <div className="challenge-chips">
              <PartChips
                parts={draft.allowed}
                onRemove={(p) => patch({ allowed: draft.allowed.filter((a) => a !== p) })}
              />
              <PartPicker
                choices={choices}
                taken={draft.allowed}
                label="Allow a part"
                onPick={(p) => patch({ allowed: [...draft.allowed, p] })}
              />
              <button
                type="button"
                className="tool-btn"
                onClick={() =>
                  patch({
                    allowed: [...new Set([...draft.allowed, ...partsOnBoard(board(), chipLib())])],
                  })
                }
              >
                Add parts on this board
              </button>
            </div>
            <span className="challenge-hint">
              Empty list: any part. A gate kind allows that gate loose or inside a chip made of
              gates; a part number allows that chip. NAND only is a list with NAND in it. Switches,
              buttons, SPDT switches, LEDs, wires, labels, power, pull resistors, ports and probes
              are always allowed.
            </span>
          </section>
          <section>
            <h4>Counts</h4>
            <label className="challenge-inline">
              ICs from
              <input
                type="number"
                min={0}
                value={icMin}
                placeholder="any"
                onChange={(e) => setIcMin(e.target.value)}
              />
              to
              <input
                type="number"
                min={0}
                value={icMax}
                placeholder="any"
                onChange={(e) => setIcMax(e.target.value)}
              />
            </label>
            <label className="challenge-inline">
              Gates at most
              <input
                type="number"
                min={0}
                value={maxGates}
                placeholder="any"
                onChange={(e) => setMaxGates(e.target.value)}
              />
            </label>
            {draft.required.map((req, i) => (
              <div key={i} className="challenge-inline challenge-chips">
                Require at least
                <input
                  type="number"
                  min={1}
                  value={req.count}
                  aria-label="How many"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 1) setReq(i, { ...req, count: n });
                  }}
                />
                of
                <PartChips
                  parts={req.anyOf}
                  onRemove={(p) => setReq(i, { ...req, anyOf: req.anyOf.filter((a) => a !== p) })}
                />
                <PartPicker
                  choices={choices}
                  taken={req.anyOf}
                  label="Require a part"
                  onPick={(p) => setReq(i, { ...req, anyOf: [...req.anyOf, p] })}
                />
                <button type="button" className="tool-btn" onClick={() => setReq(i, null)}>
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="tool-btn"
                onClick={() => patch({ required: [...draft.required, { anyOf: [], count: 1 }] })}
              >
                + Requirement
              </button>
            </div>
            <span className="challenge-hint">
              ICs are 74-series parts and 555s. A chip made of other parts counts by what is inside
              it. A gate counts its bit width, not its inputs.
            </span>
          </section>
          <section>
            <h4>Behavior</h4>
            <div className="challenge-inline">
              Tests: {testCount === 0 ? 'none' : `${testCount} rows`}
              <button type="button" className="tool-btn" onClick={takeSequence}>
                Take rows from Sequence
              </button>
              <button
                type="button"
                className="tool-btn"
                disabled={!draft.tests}
                onClick={() => clear('tests')}
              >
                Clear
              </button>
            </div>
            <div className="challenge-inline">
              Truth table: {tableName}
              <button type="button" className="tool-btn" onClick={takeAnalyze}>
                Take from Analyze
              </button>
              <button
                type="button"
                className="tool-btn"
                disabled={!table}
                aria-pressed={editingRows}
                onClick={() => setEditingRows((v) => !v)}
              >
                Edit rows
              </button>
              <button
                type="button"
                className="tool-btn"
                disabled={!table}
                onClick={() => {
                  clear('truthTable');
                  setEditingRows(false);
                }}
              >
                Clear
              </button>
            </div>
            {table && editingRows && (
              <div className="challenge-tt">
                <table>
                  <thead>
                    <tr>
                      {[...table.inputs, ...table.outputs].map((n, j) => (
                        <th
                          key={n}
                          className={j === table.inputs.length ? 'challenge-tt__sep' : undefined}
                        >
                          {n}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) =>
                          j < table.inputs.length ? (
                            <td key={j}>{cellText(cell)}</td>
                          ) : (
                            <td
                              key={j}
                              className={
                                j === table.inputs.length ? 'challenge-tt__sep' : undefined
                              }
                            >
                              <button
                                type="button"
                                className="challenge-cell"
                                title="0, 1 or - for do not care"
                                onClick={() =>
                                  patch({
                                    truthTable: {
                                      ...table,
                                      rows: table.rows.map((r, k) =>
                                        k === i ? r.map((c, m) => (m === j ? nextCell(c) : c)) : r,
                                      ),
                                    },
                                  })
                                }
                              >
                                {cellText(cell)}
                              </button>
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <span className="challenge-hint">
              Both read this board, so build the answer first, take its rows, then delete the answer
              before handing the board out. Expected values stay visible: they are the problem.
            </span>
            {notice && <p className="circuit-error">{notice}</p>}
          </section>
          {wasSet && (
            <label className="challenge-inline">
              <input
                type="checkbox"
                checked={restamp}
                onChange={(e) => setRestamp(e.target.checked)}
              />
              Mark as set now (clears "Changed after it was set")
            </label>
          )}
          {errors.length > 0 && (
            <ul className="circuit-error">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="package-actions package-buttons">
          <button type="button" className="tool-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="tool-btn" onClick={set}>
            Set challenge
          </button>
        </div>
      </div>
    </div>
  );
}
