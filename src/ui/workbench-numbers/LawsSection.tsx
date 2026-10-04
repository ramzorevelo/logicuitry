import { useEffect, useMemo, useState } from 'react';
import { parseExpr } from '../../core/boolean/expr';
import type { Law } from '../../core/boolean/laws';
import { BoolExpr } from '../components/BoolExpr';
import { modalKeysHeld } from '../modalKeys';
import { useCompact } from '../compact';
import { lawRows, maskedLaws, type LawDrill } from './algebraLogic';
import { useAlgebraStore } from './algebraStore';

const DRILLS: readonly (readonly [LawDrill, string])[] = [
  ['none', 'Show all'],
  ['rhs', 'Hide right sides'],
  ['duals', 'Hide duals'],
];

const MASK = '▯';

function Equation({ law, hideRhs }: { law: Law; hideRhs: boolean }) {
  const [lhs, rhs] = useMemo(() => [parseExpr(law.lhs), parseExpr(law.rhs)], [law]);
  return (
    <span className="algebra-law__eq">
      <BoolExpr expr={lhs} /> {'= '}
      {hideRhs ? <span className="algebra-law__mask">{MASK}</span> : <BoolExpr expr={rhs} />}
    </span>
  );
}

export function LawsSection() {
  const drill = useAlgebraStore((s) => s.drill);
  const revealed = useAlgebraStore((s) => s.revealedLaws);
  const setDrill = useAlgebraStore((s) => s.setDrill);
  const revealLaw = useAlgebraStore((s) => s.revealLaw);
  const revealNext = useAlgebraStore((s) => s.revealNextLaw);
  const reset = useAlgebraStore((s) => s.resetLaws);
  const compact = useCompact();
  const rows = useMemo(lawRows, []);
  // The other names a law goes by, off the table body: the table's own names
  // are the ones students memorize.
  const [aka, setAka] = useState<Law | null>(null);

  const masked = useMemo(() => new Set(maskedLaws(drill)), [drill]);
  const hidden = (law: Law): boolean => masked.has(law.id) && !revealed.includes(law.id);
  const remaining = [...masked].filter((id) => !revealed.includes(id)).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalKeysHeld()) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) revealNext();
      else if (e.key === 'r' || e.key === 'R') reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealNext, reset]);

  const cell = (law: Law | null) => {
    if (!law) return <td className="algebra-law__cell algebra-law__cell--empty" />;
    if (drill === 'duals' && hidden(law))
      return (
        <td className="algebra-law__cell">
          <button
            type="button"
            className="algebra-law__unmask"
            aria-label={`Reveal row ${law.id}`}
            onClick={() => revealLaw(law.id)}
          >
            {MASK}
          </button>
        </td>
      );
    if (drill === 'rhs' && hidden(law))
      return (
        <td className="algebra-law__cell">
          <button
            type="button"
            className="algebra-law__unmask"
            aria-label={`Reveal the right side of row ${law.id}`}
            onClick={() => revealLaw(law.id)}
          >
            <Equation law={law} hideRhs />
          </button>
        </td>
      );
    return (
      <td className="algebra-law__cell">
        <Equation law={law} hideRhs={false} />
      </td>
    );
  };

  return (
    <div className="algebra-section">
      <div className="algebra-controls">
        <div className="segmented">
          {DRILLS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={drill === id} onClick={() => setDrill(id)}>
              {label}
            </button>
          ))}
        </div>
        {drill !== 'none' && (
          <>
            <button
              type="button"
              className="reveal-btn"
              disabled={remaining === 0}
              onClick={revealNext}
            >
              Reveal next
            </button>
            <button type="button" className="reveal-btn" onClick={reset}>
              Reset
            </button>
            <span className="hint">
              {remaining === 0 ? 'Everything is showing' : `${remaining} hidden`}
              {compact ? '' : ' · Enter reveal · R reset'}
            </span>
          </>
        )}
      </div>

      <table className="algebra-laws">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">a</th>
            <th scope="col">b (dual)</th>
            <th scope="col">Law</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, a, b }) => (
            <tr key={row}>
              <th scope="row" className="algebra-law__row">
                {row}
              </th>
              {cell(a)}
              {cell(b)}
              <td
                className="algebra-law__name"
                onMouseEnter={() => setAka(a.alsoCalled.length > 0 ? a : null)}
                onMouseLeave={() => setAka(null)}
                onClick={() => setAka(aka === a || a.alsoCalled.length === 0 ? null : a)}
              >
                {a.name}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="algebra-aka" aria-live="polite">
        {aka ? `${aka.name}, also called: ${aka.alsoCalled.join(', ')}` : ''}
      </div>
    </div>
  );
}
