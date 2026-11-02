import { useState } from 'react';
import { useCircuitStore } from './circuitStore';
import { activeChecks, type ChecksView } from './checksView';
import type { CheckRow, CheckSeverity } from '../../core/checks/checks';
import { isBuiltinChipDef } from '../../core/parts/packages';

/** The active tab's checks. Subscribed through a signature of the rows, not
 *  `rev`: a running sim bumps rev every frame, and the dock must not re-render with it. */
export function useChecksView(): ChecksView {
  useCircuitStore((s) => {
    const v = activeChecks(s);
    return `${v.shown.map((r) => r.id + r.title + (r.detail ?? '')).join('|')}#${v.hidden.map((r) => r.id + r.title).join('|')}`;
  });
  return activeChecks(useCircuitStore.getState());
}

const SEVERITY_LABEL: Record<CheckSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

/** Severity by shape, not hue: filled triangle, hollow triangle, circled i. */
export function SeverityIcon({ severity }: { severity: CheckSeverity }) {
  return (
    <svg
      className={`check-sev check-sev--${severity}`}
      viewBox="0 0 16 16"
      aria-label={SEVERITY_LABEL[severity]}
      role="img"
    >
      {severity === 'error' && (
        <>
          <path d="M8 1.5 15 14.5H1z" className="check-sev__fill" />
          <rect x="7.2" y="6" width="1.6" height="4.6" className="check-sev__cut" />
          <rect x="7.2" y="11.6" width="1.6" height="1.6" className="check-sev__cut" />
        </>
      )}
      {severity === 'warning' && (
        <>
          <path d="M8 2.5 14.2 13.8H1.8z" className="check-sev__line" />
          <rect x="7.25" y="6.3" width="1.5" height="4" className="check-sev__fill" />
          <rect x="7.25" y="11.1" width="1.5" height="1.5" className="check-sev__fill" />
        </>
      )}
      {severity === 'info' && (
        <>
          <circle cx="8" cy="8" r="6.2" className="check-sev__line" />
          <rect x="7.25" y="7" width="1.5" height="4.6" className="check-sev__fill" />
          <rect x="7.25" y="4.4" width="1.5" height="1.5" className="check-sev__fill" />
        </>
      )}
    </svg>
  );
}

/** The tab's own label: one count per severity present, or a plain 0. */
export function CheckCounts({ counts }: { counts: ChecksView['counts'] }) {
  const present = (['error', 'warning', 'info'] as const).filter((k) => counts[k] > 0);
  if (present.length === 0) return <span className="check-count">0</span>;
  return (
    <>
      {present.map((k) => (
        <span key={k} className="check-count">
          <SeverityIcon severity={k} />
          {counts[k]}
        </span>
      ))}
    </>
  );
}

/** Whether Hide may change the active tab: not view-only, not a built-in part. */
function useCanHide(viewOnly: boolean): boolean {
  const tab = useCircuitStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const def = useCircuitStore((s) => (tab?.kind === 'def' ? s.chipLib.get(tab.defId) : undefined));
  return !viewOnly && !(def && isBuiltinChipDef(def));
}

export function ChecksPanel({
  view,
  viewOnly,
  showHidden,
}: {
  view: ChecksView;
  viewOnly: boolean;
  showHidden: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const canHide = useCanHide(viewOnly);
  const store = useCircuitStore;

  const rowEl = (row: CheckRow, hidden: boolean) => {
    const target = [...row.components, ...row.wires];
    return (
      <div
        key={`${hidden ? 'h' : 's'}:${row.id}`}
        className={`check-row${picked === row.id ? ' check-row--picked' : ''}${hidden ? ' check-row--hidden' : ''}`}
      >
        <button
          type="button"
          className="check-row__main"
          disabled={target.length === 0}
          title={target.length > 0 ? 'Select it on the board' : undefined}
          onClick={() => {
            setPicked(row.id);
            store.getState().revealItems(target);
          }}
        >
          <SeverityIcon severity={row.severity} />
          <span className="check-row__text">
            <span className="check-row__title">
              {row.title}
              {row.live && <span className="check-row__live">live</span>}
            </span>
            {row.detail && <span className="check-row__detail">{row.detail}</span>}
          </span>
        </button>
        {row.keys.length > 0 && (
          <button
            type="button"
            className="tool-btn check-row__hide"
            disabled={!canHide}
            title={hidden ? 'Show this check again' : 'Hide this check; saved with the document'}
            onClick={() => store.getState().setChecksHidden(row.keys, !hidden)}
          >
            {hidden ? 'Unhide' : 'Hide'}
          </button>
        )}
      </div>
    );
  };

  const groups = (['error', 'warning', 'info'] as const)
    .map((severity) => ({ severity, rows: view.shown.filter((r) => r.severity === severity) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="checks-panel">
      {groups.length === 0 && <div className="wave-panel__empty">No problems.</div>}
      {groups.map((g) => (
        <section key={g.severity}>
          <h3 className="checks-panel__group">{SEVERITY_LABEL[g.severity]}</h3>
          {g.rows.map((r) => rowEl(r, false))}
        </section>
      ))}
      {showHidden && view.hidden.length > 0 && (
        <section>
          <h3 className="checks-panel__group">Hidden</h3>
          {view.hidden.map((r) => rowEl(r, true))}
        </section>
      )}
    </div>
  );
}
