import './lesson.css';
import './lessonEditor.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Component,
  LessonAction,
  LessonDockTab,
  LessonStep,
  SequenceRow,
} from '../../core/model/types';
import {
  announceStep,
  defaultAction,
  hasReveal,
  lastRowBefore,
  lessonWarnings,
  moveAction,
  removeAction,
  replaceAction,
  rowAction,
  stepOps,
  warningText,
  type LessonWarning,
  type NewActionKind,
} from '../../core/lesson';
import { EXAMPLES } from '../../examples';
import { useModalKeys } from '../modalKeys';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { lessonDirty, showsAnswer, useLessonEditorStore } from './lessonEditorStore';
import { saveLessonDraft } from './lessonSave';
import { renderMarkdown } from './markdown';

const notice = (text: string) => useCircuitStore.setState({ error: `lesson: ${text}` });

const TAB_LABELS: Record<LessonDockTab, string> = {
  waveform: 'Waveform',
  analyze: 'Analyze',
  checks: 'Checks',
  sequence: 'Sequence',
};

const ACTION_TITLES: Record<LessonAction['kind'], string> = {
  row: 'Apply sequence row',
  power: 'Power',
  timing: 'Timing mode',
  highlight: 'Highlight parts',
  tab: 'Open dock tab',
};

const ADD_LABELS: Record<NewActionKind, string> = {
  row: 'Apply sequence row',
  highlight: 'Highlight parts',
  power: 'Power on or off',
  timing: 'Timing mode',
  tab: 'Open dock tab',
};

function shortAction(a: LessonAction, step: LessonStep): string {
  switch (a.kind) {
    case 'row':
      return `row ${a.index + 1}${hasReveal(step) && a.when === 'reveal' ? ' on reveal' : ''}`;
    case 'highlight':
      return `highlight ${a.components.length}`;
    case 'power':
      return a.on ? 'power on' : 'power off';
    case 'timing':
      return `${a.mode} timing`;
    case 'tab':
      return `${TAB_LABELS[a.tab]} tab`;
  }
}

function rowLabel(row: SequenceRow | undefined, i: number): string {
  if (!row) return `Row ${i + 1}: missing`;
  return `Row ${i + 1}: ${row.note?.trim() || row.set.join(' ')}`;
}

/** Which warnings belong to which action; the rest are the step's own. */
function warningsOfAction(a: LessonAction, ws: readonly LessonWarning[]): LessonWarning[] {
  return ws.filter((w) => {
    if (a.kind === 'row') return 'index' in w && w.index === a.index;
    if (a.kind !== 'highlight') return false;
    if (w.kind === 'highlight-empty') return a.components.length === 0;
    return 'id' in w && a.components.includes(w.id);
  });
}

function useBoardView() {
  const board = useCircuitStore((s) => s.board);
  return useMemo(
    () => ({
      componentIds: new Set(board.components.map((c) => c.id)),
      sequence: board.sequence,
      byId: new Map<string, Component>(board.components.map((c) => [c.id, c])),
      name: board.name,
      example: EXAMPLES.some((e) => e.id === board.id),
    }),
    [board],
  );
}

function useStepWarnings(): LessonWarning[] {
  const draft = useLessonEditorStore((s) => s.draft);
  const view = useBoardView();
  return useMemo(() => (draft ? lessonWarnings(draft, view) : []), [draft, view]);
}

/** Left pane: the steps, in place of the palette. */
export function LessonStepList() {
  const draft = useLessonEditorStore((s) => s.draft);
  const sel = useLessonEditorStore((s) => s.sel);
  const saved = useLessonEditorStore((s) => s.saved);
  const canUndo = useLessonEditorStore((s) => s.past.length > 0);
  const canRedo = useLessonEditorStore((s) => s.future.length > 0);
  const warnings = useStepWarnings();
  const view = useBoardView();
  const listRef = useRef<HTMLOListElement>(null);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null);
  const dragFrom = useRef<number | null>(null);

  // A keyboard move or select keeps focus on the row it acted on.
  useEffect(() => {
    const list = listRef.current;
    if (!list?.contains(document.activeElement)) return;
    list.querySelector<HTMLElement>('.lesson-steps__row--sel')?.focus();
  }, [sel, draft]);

  if (!draft) return null;
  const ed = useLessonEditorStore.getState();
  const dirty = lessonDirty({ draft, saved });
  const n = draft.steps.length;

  const onDrop = (target: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    const after = drop?.after ?? false;
    setDrop(null);
    if (from === null) return;
    let to = target + (after ? 1 : 0);
    if (from < to) to -= 1;
    ed.moveStep(from, to);
  };

  return (
    <section className="lesson-steps" aria-label="Lesson steps">
      <header className="lesson-steps__head">
        <div className="lesson-steps__title-row">
          <input
            type="text"
            className="lesson-steps__title"
            aria-label="Lesson title"
            value={draft.title}
            onFocus={ed.beginText}
            onChange={(e) => {
              const title = e.target.value;
              ed.editText((l) => ({ ...l, title }));
            }}
          />
          <button
            type="button"
            className="tool-btn lesson-panel__close"
            title="Close the lesson editor"
            aria-label="Close the lesson editor"
            onClick={() => ed.requestClose('Close the lesson editor')}
          >
            ×
          </button>
        </div>
        <span className="lesson-steps__sub">
          <span>
            over <b>{view.name}</b>
            {view.example ? ' (example)' : ''}
          </span>
          <span className={dirty ? 'lesson-steps__dirty' : undefined}>
            {dirty ? 'Unsaved changes' : 'Saved'}
          </span>
        </span>
      </header>
      <ol className="lesson-steps__list" ref={listRef} aria-label="Steps">
        {draft.steps.map((step, i) => {
          const first = step.prose.split('\n')[0]!.replace(/[*`]/g, '').trim();
          const warn = warnings.find((w) => w.step === i);
          const classes = ['lesson-steps__row'];
          if (i === sel) classes.push('lesson-steps__row--sel');
          if (drop?.index === i)
            classes.push(
              drop.after ? 'lesson-steps__row--drop-after' : 'lesson-steps__row--drop-before',
            );
          return (
            <li
              key={i}
              className={classes.join(' ')}
              tabIndex={i === sel ? 0 : -1}
              aria-current={i === sel ? 'step' : undefined}
              draggable
              onClick={() => ed.select(i)}
              onDragStart={(e) => {
                dragFrom.current = i;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(i));
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setDrop(null);
              }}
              onDragOver={(e) => {
                if (dragFrom.current === null) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > r.top + r.height / 2;
                if (drop?.index !== i || drop.after !== after) setDrop({ index: i, after });
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(i);
              }}
            >
              <span className="lesson-steps__grip" aria-hidden="true" title="Drag to move">
                ⋮⋮
              </span>
              <span className="lesson-steps__num">{i + 1}</span>
              <span className="lesson-steps__body">
                <span className={`lesson-steps__line${first ? '' : ' lesson-steps__line--empty'}`}>
                  <span className={`lesson-steps__tag lesson-steps__tag--${step.kind}`}>
                    {step.kind}
                  </span>
                  {first || 'no prose yet'}
                </span>
                {step.actions.length > 0 && (
                  <span className="lesson-steps__sum">
                    {step.actions.map((a) => shortAction(a, step)).join(' · ')}
                  </span>
                )}
                {warn && <span className="lesson-steps__warn">⚠ {warningText(warn)}</span>}
              </span>
              <span className="lesson-steps__ctl">
                <button
                  type="button"
                  className="tool-btn"
                  title="Move up (Alt+Up)"
                  aria-label="Move step up"
                  disabled={i === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    ed.moveStep(i, i - 1);
                  }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  title="Move down (Alt+Down)"
                  aria-label="Move step down"
                  disabled={i === n - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    ed.moveStep(i, i + 1);
                  }}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  title="Duplicate (Ctrl+D)"
                  aria-label="Duplicate step"
                  onClick={(e) => {
                    e.stopPropagation();
                    ed.duplicateStep(i);
                  }}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  title={n === 1 ? 'A lesson keeps at least one step' : 'Delete (Del)'}
                  aria-label="Delete step"
                  disabled={n === 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (ed.deleteStep(i))
                      notice(`Step ${i + 1} deleted: Undo (Ctrl+Z) brings it back`);
                  }}
                >
                  ✕
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <footer className="lesson-steps__foot">
        <span className="lesson-steps__group">
          <button type="button" className="tool-btn" onClick={() => ed.addStep('narrate')}>
            + Narrate
          </button>
          <button type="button" className="tool-btn" onClick={() => ed.addStep('predict')}>
            + Predict
          </button>
        </span>
        <span className="lesson-steps__group">
          <button
            type="button"
            className="tool-btn"
            title="Undo a lesson edit (Ctrl+Z)"
            disabled={!canUndo}
            onClick={ed.undo}
          >
            Undo
          </button>
          <button
            type="button"
            className="tool-btn"
            title="Redo (Ctrl+Y)"
            disabled={!canRedo}
            onClick={ed.redo}
          >
            Redo
          </button>
        </span>
      </footer>
    </section>
  );
}

function ActionFields({
  step,
  action,
  index,
  rows,
  byId,
}: {
  step: LessonStep;
  action: LessonAction;
  index: number;
  rows: readonly SequenceRow[];
  byId: ReadonlyMap<string, Component>;
}) {
  const ed = useLessonEditorStore.getState();
  const pick = useLessonEditorStore((s) => s.pick);
  const set = (next: LessonAction) => ed.updateSelected((s) => replaceAction(s, index, next));
  switch (action.kind) {
    case 'row': {
      const options = rows.map((r, i) => ({ value: i, label: rowLabel(r, i) }));
      if (action.index >= rows.length)
        options.push({ value: action.index, label: rowLabel(undefined, action.index) });
      return (
        <>
          <select
            aria-label="Row"
            value={action.index}
            onChange={(e) => set(rowAction(Number(e.target.value), rows, action.when))}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {hasReveal(step) && (
            <select
              aria-label="When"
              value={action.when}
              onChange={(e) => set({ ...action, when: e.target.value as 'open' | 'reveal' })}
            >
              <option value="open">when the step opens</option>
              <option value="reveal">held back until reveal</option>
            </select>
          )}
        </>
      );
    }
    case 'power':
      return (
        <span className="lesson-seg">
          {[true, false].map((on) => (
            <button
              key={String(on)}
              type="button"
              className="tool-btn"
              aria-pressed={action.on === on}
              onClick={() => set({ ...action, on })}
            >
              {on ? 'On' : 'Off'}
            </button>
          ))}
        </span>
      );
    case 'timing':
      return (
        <span className="lesson-seg">
          {(['ideal', 'datasheet'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="tool-btn"
              aria-pressed={action.mode === mode}
              onClick={() => set({ ...action, mode })}
            >
              {mode === 'ideal' ? 'Ideal' : 'Datasheet'}
            </button>
          ))}
        </span>
      );
    case 'tab':
      return (
        <select
          aria-label="Tab"
          value={action.tab}
          onChange={(e) => set({ ...action, tab: e.target.value as LessonDockTab })}
        >
          {(Object.keys(TAB_LABELS) as LessonDockTab[]).map((t) => (
            <option key={t} value={t}>
              {TAB_LABELS[t]}
            </option>
          ))}
        </select>
      );
    case 'highlight': {
      const picking = pick?.action === index;
      return (
        <>
          <span className="lesson-parts">
            {action.components.length === 0 ? (
              <span className="lesson-parts__none">none</span>
            ) : (
              action.components.map((id) => (
                <span key={id} title={id}>
                  {byId.get(id)?.label || id}
                </span>
              ))
            )}
          </span>
          <button
            type="button"
            className="tool-btn"
            aria-pressed={picking}
            onClick={() => (picking ? ed.finishPick() : ed.beginPick(index))}
          >
            {picking ? 'Picking on the board' : 'Pick on board'}
          </button>
        </>
      );
    }
  }
}

/** Right pane: the selected step, in the lesson panel's place. */
export function LessonInspector() {
  const draft = useLessonEditorStore((s) => s.draft);
  const sel = useLessonEditorStore((s) => s.sel);
  const saved = useLessonEditorStore((s) => s.saved);
  const warnings = useStepWarnings();
  const view = useBoardView();
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const step = draft?.steps[sel];
  const choices = step?.choices?.length ?? 0;
  const choiceCount = useRef({ sel, count: choices });

  useEffect(() => setAddOpen(false), [sel]);
  useEffect(() => {
    if (!addOpen) return;
    const away = (e: PointerEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAddOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [addOpen]);

  // A choice just added takes the cursor; switching steps moves no focus.
  useEffect(() => {
    const last = choiceCount.current;
    if (last.sel === sel && choices > last.count)
      document
        .querySelectorAll<HTMLInputElement>('.lesson-choice input[type="text"]')
        [choices - 1]?.focus();
    choiceCount.current = { sel, count: choices };
  }, [choices, sel]);

  if (!draft || !step) return null;
  const ed = useLessonEditorStore.getState();
  const mine = warnings.filter((w) => w.step === sel);
  const ownWarnings = mine.filter((w) => w.kind === 'nothing-to-reveal');
  const rows = view.sequence?.rows ?? [];
  const predict = hasReveal(step);
  const announced = announceStep(step, view.sequence);
  const has = (kind: LessonAction['kind']) => step.actions.some((a) => a.kind === kind);
  const dirty = lessonDirty({ draft, saved });

  const editStep = (fn: (s: LessonStep) => LessonStep) =>
    ed.editText((l) => ({ ...l, steps: l.steps.map((s, i) => (i === sel ? fn(s) : s)) }));

  const addAction = (kind: NewActionKind) => {
    setAddOpen(false);
    const action = defaultAction(kind, step, rows, lastRowBefore(draft, sel));
    ed.updateSelected((s) => ({ ...s, actions: [...s.actions, action] }));
    if (kind === 'highlight') ed.beginPick(step.actions.length);
  };

  return (
    <aside className="lesson-panel lesson-inspector" aria-label="Step inspector">
      <header className="lesson-inspector__head">
        <b>
          Step {sel + 1} of {draft.steps.length}
        </b>
        <span className="lesson-steps__group">
          <button
            type="button"
            className="tool-btn"
            title="Save the lesson (Ctrl+S)"
            onClick={() => void saveLessonDraft()}
          >
            {dirty ? 'Save *' : 'Save'}
          </button>
          <button
            type="button"
            className="tool-btn lesson-inspector__play"
            title="Play the lesson from this step; Esc comes back here"
            onClick={() => ed.play()}
          >
            Play from this step
          </button>
        </span>
      </header>
      <div className="lesson-panel__body lesson-inspector__body">
        <div className="lesson-field">
          <span className="lesson-field__label">Kind</span>
          <span className="lesson-seg">
            {(['narrate', 'predict'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="tool-btn"
                aria-pressed={step.kind === kind}
                onClick={() => {
                  if (step.kind === kind) return;
                  const msg = ed.setKind(kind);
                  if (msg) notice(msg);
                }}
              >
                {kind === 'narrate' ? 'Narrate' : 'Predict'}
              </button>
            ))}
            <button
              type="button"
              className="tool-btn"
              disabled
              aria-pressed={step.kind === 'widget'}
              title="No widgets registered yet"
            >
              Widget
            </button>
          </span>
        </div>

        <div className="lesson-field">
          <label className="lesson-field__label" htmlFor="lesson-prose">
            {predict ? 'Question' : 'Prose'}
            <span>Markdown: **bold**, *italic*, `code`, - lists</span>
          </label>
          <textarea
            id="lesson-prose"
            rows={4}
            value={step.prose}
            onFocus={ed.beginText}
            onChange={(e) => {
              const prose = e.target.value;
              editStep((s) => ({ ...s, prose }));
            }}
          />
          <div className="lesson-preview lesson-panel__prose">
            {step.prose.trim() ? (
              renderMarkdown(step.prose)
            ) : (
              <p className="lesson-parts__none">Nothing typed yet.</p>
            )}
          </div>
        </div>

        {predict && (
          <>
            <div className="lesson-field">
              <span className="lesson-field__label">
                Choices<span>for a show of hands; optional</span>
              </span>
              {(step.choices ?? []).map((c, ci) => (
                <div key={ci} className="lesson-choice">
                  <label title="The right answer; click again to clear">
                    <input
                      type="radio"
                      name={`lesson-right-${sel}`}
                      checked={!!c.right}
                      onChange={() => {}}
                      onClick={() =>
                        ed.updateSelected((s) => ({
                          ...s,
                          choices: (s.choices ?? []).map((x, k) => ({
                            text: x.text,
                            ...(k === ci && !c.right ? { right: true } : {}),
                          })),
                        }))
                      }
                    />
                    right
                  </label>
                  <input
                    type="text"
                    aria-label={`Choice ${ci + 1}`}
                    value={c.text}
                    onFocus={ed.beginText}
                    onChange={(e) => {
                      const text = e.target.value;
                      editStep((s) => ({
                        ...s,
                        choices: (s.choices ?? []).map((x, k) => (k === ci ? { ...x, text } : x)),
                      }));
                    }}
                  />
                  <button
                    type="button"
                    className="tool-btn"
                    aria-label={`Remove choice ${ci + 1}`}
                    onClick={() =>
                      ed.updateSelected((s) => ({
                        ...s,
                        choices: (s.choices ?? []).filter((_, k) => k !== ci),
                      }))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div>
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() =>
                    ed.updateSelected((s) => ({
                      ...s,
                      choices: [...(s.choices ?? []), { text: '' }],
                    }))
                  }
                >
                  + Choice
                </button>
              </div>
            </div>
            <div className="lesson-field">
              <label className="lesson-field__label" htmlFor="lesson-answer">
                Answer<span>shown on reveal</span>
              </label>
              <textarea
                id="lesson-answer"
                rows={3}
                value={step.answer ?? ''}
                onFocus={ed.beginText}
                onChange={(e) => {
                  const answer = e.target.value;
                  editStep((s) => ({ ...s, answer }));
                }}
              />
            </div>
          </>
        )}

        <div className="lesson-field">
          <span className="lesson-field__label">
            Board actions<span>run in this order</span>
          </span>
          {step.actions.map((a, ai) => {
            const ws = warningsOfAction(a, mine);
            const changed = a.kind === 'row' && ws.some((w) => w.kind === 'row-changed');
            return (
              <div key={ai} className={`lesson-act${ws.length ? ' lesson-act--bad' : ''}`}>
                <div className="lesson-act__head">
                  <span>{ACTION_TITLES[a.kind]}</span>
                  <span>
                    <button
                      type="button"
                      className="tool-btn"
                      aria-label="Move action up"
                      disabled={ai === 0}
                      onClick={() => ed.updateSelected((s) => moveAction(s, ai, ai - 1))}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="tool-btn"
                      aria-label="Move action down"
                      disabled={ai === step.actions.length - 1}
                      onClick={() => ed.updateSelected((s) => moveAction(s, ai, ai + 1))}
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      className="tool-btn"
                      aria-label="Remove action"
                      onClick={() => ed.updateSelected((s) => removeAction(s, ai))}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="lesson-act__fields">
                  <ActionFields step={step} action={a} index={ai} rows={rows} byId={view.byId} />
                </div>
                {ws.map((w, k) => (
                  <span key={k} className="lesson-act__warn">
                    ⚠ {warningText(w)}
                  </span>
                ))}
                {changed && a.kind === 'row' && (
                  <button
                    type="button"
                    className="tool-btn lesson-act__fix"
                    onClick={() =>
                      ed.updateSelected((s) =>
                        replaceAction(s, ai, rowAction(a.index, rows, a.when)),
                      )
                    }
                  >
                    Use the row as it is now
                  </button>
                )}
              </div>
            );
          })}
          <div className="lesson-add" ref={addRef}>
            <button
              type="button"
              className="tool-btn"
              aria-expanded={addOpen}
              aria-haspopup="menu"
              onClick={() => setAddOpen((o) => !o)}
            >
              + Action
            </button>
            {addOpen && (
              <div className="lesson-add__menu" role="menu">
                {(Object.keys(ADD_LABELS) as NewActionKind[]).map((kind) => {
                  const why =
                    kind === 'row' && rows.length === 0
                      ? 'The board has no sequence rows: add them in the Sequence tab'
                      : (kind === 'highlight' || kind === 'tab') && has(kind)
                        ? 'This step already has one'
                        : undefined;
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      disabled={!!why}
                      title={why}
                      onClick={() => addAction(kind)}
                    >
                      {ADD_LABELS[kind]}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <span className="lesson-field__hint">
            Highlights last for this step only. Power, timing, rows and the open tab carry into
            later steps.
          </span>
        </div>

        {ownWarnings.map((w, k) => (
          <div key={k} className="lesson-act lesson-act--bad">
            <span className="lesson-act__warn">⚠ {warningText(w)}</span>
          </div>
        ))}

        <div className="lesson-field">
          <span className="lesson-field__label">The class sees</span>
          <div className="lesson-panel__acts">
            <b>This step</b>
            {announced.length > 0 ? (
              announced.map((line, i) => <span key={i}>{line}</span>)
            ) : (
              <span>No change to the board</span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Over the canvas: what the board shows, or the pick in progress. */
export function LessonCanvasBar() {
  const draft = useLessonEditorStore((s) => s.draft);
  const sel = useLessonEditorStore((s) => s.sel);
  const pick = useLessonEditorStore((s) => s.pick);
  const afterReveal = useLessonEditorStore((s) => s.afterReveal);
  const playing = useLessonEditorStore((s) => s.playing);
  if (!draft || playing) return null;
  const ed = useLessonEditorStore.getState();
  const step = draft.steps[sel];
  if (!step) return null;
  if (pick) {
    const a = step.actions[pick.action];
    const count = a?.kind === 'highlight' ? a.components.length : 0;
    return (
      <div className="lesson-canvas-bar lesson-canvas-bar--picking" role="status">
        <span>
          Click parts to highlight them on step {sel + 1}. <b>{count}</b> picked.
        </span>
        <span className="lesson-canvas-bar__spacer" />
        <button type="button" className="tool-btn" onClick={ed.finishPick}>
          Done <kbd>Enter</kbd>
        </button>
        <button type="button" className="tool-btn" onClick={ed.cancelPick}>
          Cancel <kbd>Esc</kbd>
        </button>
      </div>
    );
  }
  const held = hasReveal(step) && stepOps(step, 'reveal').length > 0;
  const after = showsAnswer(draft, sel, afterReveal);
  return (
    <div className="lesson-canvas-bar">
      <span>
        Board at step {sel + 1}
        {held ? '' : ', as the class sees it'}
      </span>
      {held && (
        <span className="lesson-seg">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={!after}
            onClick={() => ed.setAfterReveal(false)}
          >
            Before reveal
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-pressed={after}
            onClick={() => ed.setAfterReveal(true)}
          >
            After reveal
          </button>
        </span>
      )}
      <span className="lesson-canvas-bar__spacer" />
      <span className="lesson-canvas-bar__hint">Board locked while editing</span>
    </div>
  );
}

/** Save, Discard or Cancel for an unsaved lesson. */
export function LessonUnsavedDialog() {
  const pending = useLessonEditorStore((s) => s.pendingClose);
  const title = useLessonEditorStore((s) => s.draft?.title);
  if (!pending) return null;
  return <UnsavedLessonPrompt action={pending.action} title={title ?? ''} />;
}

function UnsavedLessonPrompt({ action, title }: { action: string; title: string }) {
  const ed = useLessonEditorStore.getState();
  useModalKeys(() => ed.resolveClose('cancel'));
  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && ed.resolveClose('cancel')}
    >
      <div className="package-dialog close-tab-dialog" role="dialog" aria-label={action}>
        <h3>{action}</h3>
        <p className="label-conflict-hint">
          The lesson {title ? `"${title}" ` : ''}has unsaved changes.
        </p>
        <div className="label-conflict-buttons">
          <button
            type="button"
            className="tool-btn"
            autoFocus
            onClick={() =>
              void saveLessonDraft().then((ok) => {
                if (ok) useLessonEditorStore.getState().resolveClose('saved');
              })
            }
          >
            Save
          </button>
          <button type="button" className="tool-btn" onClick={() => ed.resolveClose('discard')}>
            Discard
          </button>
          <button type="button" className="tool-btn" onClick={() => ed.resolveClose('cancel')}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
