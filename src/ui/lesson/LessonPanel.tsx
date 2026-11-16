import './lesson.css';
import { useEffect, useMemo, useState } from 'react';
import { announceStep, hasReveal, lessonWarnings, warningText } from '../../core/lesson';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { renderMarkdown } from './markdown';
import { useLessonStore } from './lessonStore';
import { useLessonEditorStore } from './lessonEditorStore';

export const AUTOPLAY_PACES = [0, 5, 10, 20] as const;

/** Re-renders a few times a second while `active`, for a countdown that reads the clock. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** The lesson runner: right of the board on a desktop, a bottom sheet on a phone. */
export function LessonPanel() {
  const lesson = useLessonStore((s) => s.lesson);
  const step = useLessonStore((s) => s.step);
  const revealed = useLessonStore((s) => s.revealed);
  const picked = useLessonStore((s) => s.picked);
  const notes = useLessonStore((s) => s.notes);
  const fromEditor = useLessonStore((s) => s.fromEditor);
  const autoplay = useLessonStore((s) => s.autoplay);
  const pace = useLessonStore((s) => s.autoplayPace);
  const wait = useLessonStore((s) => s.autoplayWait);
  const deadline = useLessonStore((s) => s.autoplayDeadline);
  const totalMs = useLessonStore((s) => s.autoplayTotalMs);
  const now = useNow(autoplay && deadline !== null);
  const board = useCircuitStore((s) => s.board);

  const warnings = useMemo(() => {
    if (!lesson) return [];
    const view = {
      componentIds: new Set(board.components.map((c) => c.id)),
      sequence: board.sequence,
    };
    return lessonWarnings(lesson, view).filter((w) => w.step === step);
  }, [lesson, board.components, board.sequence, step]);

  if (!lesson) return null;
  const current = lesson.steps[step];
  if (!current) return null;
  const run = useLessonStore.getState();
  const count = lesson.steps.length;
  const predict = hasReveal(current);
  const shown = revealed.has(step);
  const choices = current.choices ?? [];
  const right = choices.find((c) => c.right);
  const announced = [...announceStep(current, board.sequence), ...notes];
  const leftMs = deadline === null ? 0 : Math.max(0, deadline - now);
  const leftS = Math.ceil(leftMs / 1000);
  const status = !autoplay
    ? ''
    : deadline === null
      ? 'Waiting for Reveal'
      : predict && !shown
        ? `Answer in ${leftS} s`
        : step === count - 1
          ? `Ends in ${leftS} s`
          : `Next in ${leftS} s`;
  const fill = autoplay && totalMs > 0 ? 1 - leftMs / totalMs : 0;

  return (
    <aside className="lesson-panel" aria-label="Lesson">
      <header className="lesson-panel__head">
        <div className="lesson-panel__title-row">
          <span className="lesson-panel__title">{lesson.title}</span>
          <button
            type="button"
            className="tool-btn lesson-panel__close"
            title={fromEditor ? 'Back to the editor (Esc)' : 'Close lesson'}
            aria-label={fromEditor ? 'Back to the editor' : 'Close lesson'}
            onClick={fromEditor ? () => useLessonEditorStore.getState().backFromPlay() : run.close}
          >
            ×
          </button>
        </div>
        <span className="lesson-panel__count">
          <span>
            Step {step + 1} of {count}
          </span>
          {lesson.board && <span className="lesson-panel__board">{lesson.board}</span>}
        </span>
        <div className="lesson-panel__bar" aria-hidden="true">
          {lesson.steps.map((_, i) => (
            <span
              key={i}
              className={
                i < step
                  ? 'lesson-panel__seg lesson-panel__seg--done'
                  : i === step
                    ? 'lesson-panel__seg lesson-panel__seg--current'
                    : 'lesson-panel__seg'
              }
            />
          ))}
        </div>
      </header>

      <div className="lesson-panel__body">
        <span className="lesson-panel__kind">{current.kind}</span>
        <div className="lesson-panel__prose">{renderMarkdown(current.prose)}</div>
        {choices.length > 0 && (
          <div className="lesson-panel__chips">
            {choices.map((choice, i) => (
              <button
                key={i}
                type="button"
                className={`tool-btn lesson-panel__chip${shown && choice.right ? ' lesson-panel__chip--right' : ''}`}
                aria-pressed={picked.get(step) === i}
                onClick={() => run.pick(i)}
              >
                {choice.text}
              </button>
            ))}
          </div>
        )}
        {predict &&
          (shown ? (
            <div className="lesson-panel__answer">
              {right && (
                <p>
                  <strong>{right.text}</strong>
                </p>
              )}
              {renderMarkdown(current.answer ?? '')}
            </div>
          ) : (
            <div className="lesson-panel__withheld">Answer hidden until you reveal it.</div>
          ))}
        {announced.length > 0 && (
          <div className="lesson-panel__acts">
            <b>This step</b>
            {announced.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </div>
        )}
        {warnings.map((w, i) => (
          <p key={i} className="lesson-panel__warning">
            {warningText(w)}
          </p>
        ))}
      </div>

      <footer className="lesson-panel__foot">
        {autoplay && (
          <span
            className={`lesson-panel__status${deadline === null ? ' lesson-panel__status--wait' : ''}`}
            aria-live="polite"
          >
            {status}
          </span>
        )}
        <button type="button" className="tool-btn" disabled={step === 0} onClick={run.pageUp}>
          Back <kbd>PgUp</kbd>
        </button>
        <button
          type="button"
          className="tool-btn"
          disabled={!predict || shown}
          onClick={run.reveal}
        >
          Reveal <kbd>Enter</kbd>
        </button>
        <button
          type="button"
          className="tool-btn lesson-panel__next"
          disabled={step === count - 1}
          onClick={run.next}
        >
          Next <kbd>PgDn</kbd>
          {autoplay && (
            <span
              className="lesson-panel__fill"
              style={{ transform: `scaleX(${fill})` }}
              aria-hidden="true"
            />
          )}
        </button>
        <div className="lesson-panel__auto">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={autoplay}
            onClick={autoplay ? run.stopAutoplay : run.startAutoplay}
          >
            {autoplay ? 'Pause' : 'Autoplay'}
          </button>
          <label className="lesson-panel__pace">
            <span>Pace</span>
            <select value={pace} onChange={(e) => run.setAutoplayPace(Number(e.target.value))}>
              {AUTOPLAY_PACES.map((p) => (
                <option key={p} value={p}>
                  {p === 0 ? 'As authored' : `${p} s a step`}
                </option>
              ))}
            </select>
          </label>
          <label className="lesson-panel__wait">
            <input
              type="checkbox"
              checked={wait}
              onChange={(e) => run.setAutoplayWait(e.target.checked)}
            />
            <span>Wait on questions</span>
          </label>
        </div>
      </footer>
    </aside>
  );
}
