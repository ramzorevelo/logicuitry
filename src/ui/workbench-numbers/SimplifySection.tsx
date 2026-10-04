import { useEffect, useMemo, useRef, useState } from 'react';
import { exprVars } from '../../core/boolean/expr';
import { checkMinimal } from '../../core/boolean/minimal';
import { citeStep, localChange, nodeAt, type Step } from '../../core/boolean/rewrite';
import { BoolExpr, type ExprSelection } from '../components/BoolExpr';
import { Toggle } from '../components/Toggle';
import { modalKeysHeld } from '../modalKeys';
import { useCompact } from '../compact';
import {
  checkLine,
  clickTarget,
  describeMinimal,
  stepsForSelection,
  type LineCheck,
} from './algebraLogic';
import { useAlgebraStore, type SimplifyMode } from './algebraStore';
import { useNumbersStore } from './numbersStore';

const MASK = '▯';

const MODES: readonly (readonly [SimplifyMode, string])[] = [
  ['hand', 'By hand'],
  ['worked', 'Worked'],
];

function ErrorBox({
  text,
  error,
}: {
  text: string;
  error: { message: string; offset: number | null };
}) {
  if (error.offset === null) return <div className="algebra-error">{error.message}</div>;
  return (
    <pre className="algebra-error">
      {text + '\n' + ' '.repeat(error.offset) + '^ ' + error.message}
    </pre>
  );
}

export function SimplifySection() {
  const a = useAlgebraStore();
  const hideAnswers = useNumbersStore((s) => s.hideAnswers);
  const toggleHideAnswers = useNumbersStore((s) => s.toggleHideAnswers);
  const compact = useCompact();
  const worked = a.mode === 'worked';
  const hiding = hideAnswers;
  const [next, setNext] = useState('');
  const [nextError, setNextError] = useState<Extract<LineCheck, { ok: false }> | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [marked, setMarked] = useState<ExprSelection | null>(null);
  const [verdict, setVerdict] = useState<ReturnType<typeof describeMinimal> | null>(null);
  const ladderRef = useRef<HTMLDivElement>(null);

  const last = a.lines[a.lines.length - 1];
  const menu = useMemo(
    () => (last && a.selection && !worked ? stepsForSelection(last.expr, a.selection) : null),
    [last, a.selection, worked],
  );
  const menuSteps = menu
    ? menu.shorter.length === 0 || showMore
      ? [...menu.shorter, ...menu.others]
      : menu.shorter
    : [];

  useEffect(() => {
    setShowMore(false);
    setMarked(null);
  }, [a.selection]);
  // A verdict is about one line; any change to the ladder makes it stale.
  useEffect(() => setVerdict(null), [a.lines]);

  const checkSimplified = () => {
    if (!last || !a.start) return;
    setVerdict(describeMinimal(checkMinimal(last.expr, exprVars(a.start))));
  };

  const stepButton = (s: Step, i: number) => {
    const change = localChange(s);
    const uses: ExprSelection = s.operands ? { at: s.at, operands: s.operands } : { at: s.at };
    return (
      <button
        key={i}
        type="button"
        className="algebra-step"
        onClick={() => a.pushLine({ expr: s.to, cite: citeStep(s) })}
        onMouseEnter={() => setMarked(uses)}
        onMouseLeave={() => setMarked(null)}
        onFocus={() => setMarked(uses)}
        onBlur={() => setMarked(null)}
      >
        <span className="algebra-step__cite">{citeStep(s)}</span>
        <span className="algebra-step__change">
          {change ? (
            <>
              <BoolExpr expr={change.before} />
              <span className="algebra-step__arrow">→</span>
              <BoolExpr expr={change.after} />
            </>
          ) : (
            <BoolExpr expr={s.to} />
          )}
        </span>
      </button>
    );
  };

  // Turning hiding on or off restarts the reveal, so no line stays unmasked
  // that the new setting says to mask.
  const { restart } = a;
  useEffect(() => {
    if (worked) restart();
  }, [hideAnswers, worked, restart]);

  useEffect(() => {
    ladderRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [a.lines.length, a.shown, a.open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalKeysHeld()) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !worked) {
        e.preventDefault();
        a.undo();
      } else if (e.key === 'Escape') {
        a.select(null);
      } else if (!worked || !a.start) {
        return;
      } else if (e.key === ' ' || e.key === '.') {
        e.preventDefault();
        a.step(hiding);
      } else if (e.key === 'Enter' && !(t instanceof HTMLButtonElement)) {
        a.revealRest();
      } else if (e.key === 'r' || e.key === 'R') {
        a.restart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a, worked, hiding]);

  const submitNext = () => {
    if (!last || next.trim() === '') return;
    const result = checkLine(last.expr, next);
    if (result.ok) {
      a.pushLine(result.line);
      setNext('');
      setNextError(null);
    } else setNextError(result);
  };

  const shownLines = worked
    ? a.start
      ? [{ expr: a.start, cite: null }, ...a.derived.slice(0, a.shown)]
      : []
    : a.lines;

  return (
    <div className="algebra-section">
      <div className="algebra-controls">
        <div className="segmented">
          {MODES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={a.mode === id}
              onClick={() => a.setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="algebra-input"
          aria-label="Expression to simplify"
          placeholder="A'B + A'B'C'D' + ABCD'"
          spellCheck={false}
          value={a.startText}
          onChange={(e) => a.setStartText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') a.begin();
          }}
        />
        <button type="button" className="reveal-btn" onClick={a.begin}>
          Start
        </button>
        {worked ? (
          <>
            <Toggle checked={hideAnswers} onChange={toggleHideAnswers} label="Hide answers" />
            {compact && a.start ? (
              <>
                <button type="button" className="reveal-btn" onClick={() => a.step(hiding)}>
                  Step
                </button>
                <button type="button" className="reveal-btn" onClick={a.revealRest}>
                  Reveal
                </button>
                <button type="button" className="reveal-btn" onClick={a.restart}>
                  Reset
                </button>
              </>
            ) : (
              <span className="hint">Space step · Enter reveal rest · R reset</span>
            )}
          </>
        ) : (
          a.start && (
            <>
              <button
                type="button"
                className="reveal-btn"
                disabled={a.lines.length < 2 && !a.previous}
                onClick={a.undo}
              >
                Undo
              </button>
            </>
          )
        )}
      </div>
      {a.startError && <ErrorBox text={a.startText} error={a.startError} />}
      {!worked && a.previous && a.lines.length === 1 && (
        <div className="analyze-muted">
          Started on a new expression. Undo brings back the previous {a.previous.lines.length}{' '}
          lines.
        </div>
      )}

      {!a.start ? (
        <div className="analyze-muted">Type an expression and press Enter to start.</div>
      ) : (
        <div className="algebra-ladder" ref={ladderRef}>
          {shownLines.map((line, i) => {
            const isLast = i === shownLines.length - 1;
            const masked = worked && i > 0 && hiding && i > a.open;
            return (
              <div
                key={i}
                className={line.flagged ? 'algebra-line algebra-line--flagged' : 'algebra-line'}
              >
                <span className="algebra-line__expr">
                  {masked ? (
                    <span className="algebra-law__mask">{MASK}</span>
                  ) : (
                    <BoolExpr
                      expr={line.expr}
                      selected={!worked && isLast ? (a.selection ?? undefined) : undefined}
                      marked={!worked && isLast ? (marked ?? undefined) : undefined}
                      onSelect={!worked && isLast ? (at) => a.select({ at }) : undefined}
                      targetOf={
                        !worked && isLast
                          ? (leaf) => clickTarget(line.expr, a.selection, leaf)
                          : undefined
                      }
                    />
                  )}
                </span>
                <span className="algebra-line__cite">{line.cite ?? ''}</span>
              </div>
            );
          })}
          {worked && a.shown === a.derived.length && (
            <div className="analyze-muted">
              {a.derived.length === 0 ? 'No law applies to this line.' : 'No further step found.'}
            </div>
          )}
        </div>
      )}

      {a.start && !worked && (
        <>
          {menu && (
            <div className="algebra-steps">
              {menuSteps.length === 0 ? (
                <div className="analyze-muted">No law applies to that selection.</div>
              ) : (
                <>
                  <div className="algebra-steps__head">
                    <span className="analyze-muted">Selected:</span>
                    <BoolExpr expr={nodeAt(last!.expr, a.selection!.at)} />
                    <span className="analyze-muted">
                      {menu.shorter.length > 0
                        ? 'Laws that shorten it. Pick one to write the next line.'
                        : 'No law shortens it. Laws that rewrite it:'}
                    </span>
                  </div>
                  {menuSteps.map(stepButton)}
                  {menu.shorter.length > 0 && menu.others.length > 0 && (
                    <button
                      type="button"
                      className="reveal-btn algebra-steps__more"
                      aria-expanded={showMore}
                      onClick={() => setShowMore(!showMore)}
                    >
                      {showMore
                        ? 'Hide the rewrites that keep or grow the length'
                        : `${menu.others.length} more that keep or grow the length`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          <div className="algebra-controls">
            <input
              type="text"
              className="algebra-input"
              aria-label="Next line"
              placeholder="Type the next line"
              spellCheck={false}
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setNextError(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') submitNext();
              }}
            />
            <button type="button" className="reveal-btn" onClick={submitNext}>
              Add line
            </button>
            <button type="button" className="reveal-btn" onClick={checkSimplified}>
              Is it simplified?
            </button>
            <span className="hint">
              {compact
                ? 'Tap a term in the last line to list the laws for it. Tap it again to pick a smaller part.'
                : 'Click a term in the last line to list the laws for it. Click again to pick a smaller part, click a + for the whole sum. Esc clears.'}
            </span>
          </div>
          {nextError && <ErrorBox text={next} error={nextError} />}
          {verdict && (
            <div
              className={verdict.done ? 'algebra-verdict' : 'algebra-verdict algebra-verdict--not'}
            >
              {verdict.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}
