import { useMemo, useState } from 'react';
import { partsReport } from '../../core/challenge/parts';
import { challengeChanged } from '../../core/challenge/fingerprint';
import { useLessonEditorStore } from '../lesson/lessonEditorStore';
import { useLessonStore } from '../lesson/lessonStore';
import { useCircuitStore } from './circuitStore';
import { freshness, useChallengeStore, type CheckFreshness } from './challengeStore';
import {
  behaviorRowViews,
  partsRowViews,
  tally,
  type ChallengeRowView,
  type ChallengeTally,
  type RowState,
} from './challengeView';
import type { Challenge } from '../../core/model/types';

/** The board tab of a board that carries a challenge, with no lesson over it. */
export function useChallengeApplies(): boolean {
  const onBoard = useCircuitStore(
    (s) => (s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0])?.kind === 'board',
  );
  const has = useCircuitStore((s) => s.board.challenge !== undefined);
  const lessonOpen = useLessonOpen();
  return onBoard && has && !lessonOpen;
}

export function useLessonOpen(): boolean {
  const running = useLessonStore((s) => s.lesson !== null);
  const editing = useLessonEditorStore((s) => s.draft !== null);
  return running || editing;
}

export interface ChallengeView {
  challenge: Challenge;
  parts: ChallengeRowView[];
  behavior: ChallengeRowView[];
  freshness: CheckFreshness;
  timing: string | undefined;
  tally: ChallengeTally;
  changed: boolean;
}

/**
 * Parts rows from the board's components, so a running sim's frames, which
 * only bump `rev`, never recompute or re-render them.
 */
export function useChallengeView(): ChallengeView | null {
  const challenge = useCircuitStore((s) => s.board.challenge);
  const components = useCircuitStore((s) => s.board.components);
  const groups = useCircuitStore((s) => s.board.groups);
  const chipLib = useCircuitStore((s) => s.chipLib);
  const last = useChallengeStore((s) => s.last);
  const fresh = useCircuitStore((s) => freshness(last, s));
  const parts = useMemo(() => {
    if (!challenge) return [];
    const b = useCircuitStore.getState().board;
    return partsRowViews(challenge, partsReport(b, chipLib, challenge));
  }, [challenge, components, groups, chipLib]);
  return useMemo(() => {
    if (!challenge) return null;
    const report = fresh === 'none' ? null : (last?.report ?? null);
    const behavior = behaviorRowViews(challenge, report);
    // A stale result is shown greyed but counts as not yet met, so the pill never overstates.
    const counted =
      fresh === 'stale'
        ? [...parts, ...behavior.map((r) => ({ ...r, state: 'pending' as RowState }))]
        : [...parts, ...behavior];
    return {
      challenge,
      parts,
      behavior,
      freshness: fresh,
      timing: report?.timing,
      tally: tally(counted),
      changed: challengeChanged(challenge),
    };
  }, [challenge, parts, last, fresh]);
}

/** Met, unmet or not checked, by shape and not by colour alone. */
export function ChallengeMark({ state }: { state: RowState }) {
  const label = state === 'met' ? 'Met' : state === 'unmet' ? 'Not met' : 'Not checked';
  return (
    <svg
      className={`challenge-mark challenge-mark--${state}`}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
    >
      {state === 'met' && (
        <>
          <circle cx="8" cy="8" r="6.6" className="challenge-mark__ring" />
          <path d="M4.8 8.3 7 10.4 11.3 5.8" className="challenge-mark__tick" />
        </>
      )}
      {state === 'unmet' && (
        <>
          <path d="M8 1.5 15 14.5H1z" className="challenge-mark__fill" />
          <rect x="7.2" y="6" width="1.6" height="4.6" className="challenge-mark__cut" />
          <rect x="7.2" y="11.6" width="1.6" height="1.6" className="challenge-mark__cut" />
        </>
      )}
      {state === 'pending' && <circle cx="8" cy="8" r="6.2" className="challenge-mark__dash" />}
    </svg>
  );
}

export function tallyState(t: ChallengeTally): RowState {
  return t.unmet > 0 ? 'unmet' : t.pending > 0 ? 'pending' : 'met';
}

/** Opens the Challenge tab; the toolbar's one-glance summary. */
export function ChallengePill() {
  const view = useChallengeView();
  const applies = useChallengeApplies();
  const checking = useChallengeStore((s) => s.checking !== null);
  if (!view || !applies) return null;
  const { tally: t } = view;
  return (
    <button
      type="button"
      className="tool-btn challenge-pill"
      title={`${view.challenge.title || 'Challenge'}: ${t.met} of ${t.total} met`}
      onClick={() => {
        const st = useCircuitStore.getState();
        st.setDockTab('challenge');
        st.setWaveformOpen(true);
      }}
    >
      <ChallengeMark state={tallyState(t)} />
      <span className="challenge-pill__text">
        {checking ? 'Checking...' : `${t.met}/${t.total}`}
        {view.changed ? ' (changed)' : ''}
      </span>
    </button>
  );
}

function TruthTableResult({ row, dim }: { row: ChallengeRowView; dim: boolean }) {
  const { spec, report } = row.table!;
  return (
    <div className={`challenge-tt${dim ? ' challenge-row--dim' : ''}`}>
      <table>
        <thead>
          <tr>
            {spec.inputs.map((n) => (
              <th key={`i${n}`}>{n}</th>
            ))}
            {spec.outputs.map((n, j) => (
              <th key={`e${n}`} className={j === 0 ? 'challenge-tt__sep' : undefined}>
                {n} expected
              </th>
            ))}
            {spec.outputs.map((n) => (
              <th key={`a${n}`}>{n}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r, i) => (
            <tr key={i} className={r.ok ? undefined : 'challenge-tt__bad'}>
              {r.inputs.map((b, j) => (
                <td key={`i${j}`}>{b}</td>
              ))}
              {r.expected.map((b, j) => (
                <td key={`e${j}`} className={j === 0 ? 'challenge-tt__sep' : undefined}>
                  {b === null ? '-' : b}
                </td>
              ))}
              {r.actual.map((a, j) => {
                const want = r.expected[j];
                const bad = want !== null && want !== undefined && a !== String(want);
                return (
                  <td key={`a${j}`} className={bad ? 'challenge-tt__got' : undefined}>
                    {a}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChallengePanel({ viewOnly }: { viewOnly: boolean }) {
  const view = useChallengeView();
  const checking = useChallengeStore((s) => s.checking);
  const [picked, setPicked] = useState<string | null>(null);
  if (!view) return null;
  const { challenge, tally: t } = view;
  const stale = view.freshness === 'stale';

  const rowEl = (row: ChallengeRowView, dim: boolean) => {
    const target = row.state === 'unmet' ? row.components : [];
    return (
      <div key={row.id}>
        <button
          type="button"
          className={`challenge-row${picked === row.id ? ' challenge-row--picked' : ''}${dim ? ' challenge-row--dim' : ''}`}
          disabled={target.length === 0}
          title={target.length > 0 ? 'Select it on the board' : undefined}
          onClick={() => {
            setPicked(row.id);
            useCircuitStore.getState().revealItems(target);
          }}
        >
          <ChallengeMark state={row.state} />
          <span className="challenge-row__text">
            <span className="challenge-row__title">{row.title}</span>
            {row.detail && <span className="challenge-row__detail">{row.detail}</span>}
          </span>
        </button>
        {row.table && <TruthTableResult row={row} dim={dim} />}
      </div>
    );
  };

  let summary = `${t.met} of ${t.total} met.`;
  if (t.unmet > 0) summary += ` ${t.unmet} not met.`;
  if (view.behavior.length > 0 && view.freshness === 'none')
    summary += ' Behavior not checked yet.';

  return (
    <div className="challenge-panel">
      <div className="challenge-panel__brief">
        <span className="challenge-panel__title">{challenge.title || 'Untitled challenge'}</span>
        {view.changed && (
          <span className="challenge-panel__changed">Changed after it was set.</span>
        )}
        {!challenge.fingerprint && (
          <span className="challenge-panel__from">Draft: not set yet.</span>
        )}
        {challenge.brief && <p className="challenge-panel__text">{challenge.brief}</p>}
        {stale && (
          <div className="challenge-panel__stale">
            Board changed since the last check. Behavior results are from before the change.
          </div>
        )}
        <span className="challenge-panel__summary">
          {summary}
          {view.timing && view.freshness !== 'none' ? ` Checked with ${view.timing} timing.` : ''}
        </span>
        <div className="challenge-panel__acts">
          {checking ? (
            <>
              <span className="challenge-panel__busy">Checking...</span>
              <button
                type="button"
                className="tool-btn"
                onClick={() => useChallengeStore.getState().cancel()}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tool-btn"
              disabled={view.behavior.length === 0}
              title={
                view.behavior.length === 0 ? 'This challenge has no behavior to check' : undefined
              }
              onClick={() => void useChallengeStore.getState().check()}
            >
              Check challenge
            </button>
          )}
          {!viewOnly && (
            <button
              type="button"
              className="tool-btn"
              onClick={() => useChallengeStore.getState().openEditor(false)}
            >
              Edit challenge...
            </button>
          )}
        </div>
      </div>
      <div className="challenge-panel__rows">
        {view.parts.length > 0 && (
          <section>
            <h3 className="challenge-panel__group">
              <span>Parts</span>
              <span>updates as you build</span>
            </h3>
            {view.parts.map((r) => rowEl(r, false))}
          </section>
        )}
        {view.behavior.length > 0 && (
          <section>
            <h3 className="challenge-panel__group">
              <span>Behavior</span>
              <span>on Check</span>
            </h3>
            {view.behavior.map((r) => rowEl(r, stale))}
          </section>
        )}
        {view.parts.length === 0 && view.behavior.length === 0 && (
          <div className="wave-panel__empty">This challenge sets no requirements yet.</div>
        )}
      </div>
    </div>
  );
}

/** View only has no dock; the brief and rows still need a place to show. */
export function ViewOnlyChallenge() {
  const applies = useChallengeApplies();
  const shown = useCircuitStore((s) => s.waveformOpen && s.dockTab === 'challenge');
  if (!applies || !shown) return null;
  return (
    <div className="wave-panel challenge-view-only">
      <div className="wave-panel__header">
        <button
          type="button"
          className="tool-btn"
          title="Fold the challenge panel"
          onClick={() => useCircuitStore.getState().setWaveformOpen(false)}
        >
          ▾ Challenge
        </button>
      </div>
      <div className="wave-panel__body wave-panel__body--challenge">
        <ChallengePanel viewOnly />
      </div>
    </div>
  );
}
