import './lesson.css';
import { useMemo } from 'react';
import { announceStep, hasReveal, lessonWarnings, warningText } from '../../core/lesson';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { renderMarkdown } from './markdown';
import { useLessonStore } from './lessonStore';
import { useLessonEditorStore } from './lessonEditorStore';

/** The lesson runner: right of the board on a desktop, a bottom sheet on a phone. */
export function LessonPanel() {
  const lesson = useLessonStore((s) => s.lesson);
  const step = useLessonStore((s) => s.step);
  const revealed = useLessonStore((s) => s.revealed);
  const picked = useLessonStore((s) => s.picked);
  const notes = useLessonStore((s) => s.notes);
  const fromEditor = useLessonStore((s) => s.fromEditor);
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
        <button type="button" className="tool-btn" disabled={step === count - 1} onClick={run.next}>
          Next <kbd>PgDn</kbd>
        </button>
      </footer>
    </aside>
  );
}
