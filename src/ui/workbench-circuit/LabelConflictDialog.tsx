// One or more nets, each with 2+ user-named labels, raised by a single edit
// (labelSync via a wire commit or a rename touching several output nets at
// once, e.g. naming a decoder): one radio group per net, picked locally and
// committed together via Apply (one undo step for the whole dialog). Esc or
// a click outside the dialog instead undoes the edit that raised the
// conflict -- the attempted rename itself reverts, not just the label pick.

import { useEffect, useState } from 'react';
import { oneLine } from '../../render/glyphs/symbol';
import { useCircuitStore } from './circuitStore';

const KEEP_BOTH = '__keep_both__';

export function LabelConflictDialog() {
  const conflicts = useCircuitStore((s) => s.labelConflict);
  const apply = useCircuitStore((s) => s.applyLabelConflicts);
  const cancel = useCircuitStore((s) => s.cancelLabelConflict);

  // Local pick per row, keyed by row index; defaults to "keep both" so an
  // untouched row Applies as a no-op rather than silently picking one side.
  const [choices, setChoices] = useState<Record<number, string>>({});

  useEffect(() => {
    setChoices({});
  }, [conflicts]);

  useEffect(() => {
    if (!conflicts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [conflicts, cancel]);

  if (!conflicts || conflicts.length === 0) return null;
  const title =
    conflicts.length === 1 ? 'Two labels on one net' : `Label conflicts (${conflicts.length} nets)`;

  const applyAll = () => {
    apply(conflicts.map((_, i) => (choices[i] && choices[i] !== KEEP_BOTH ? choices[i]! : null)));
  };

  return (
    <div className="package-overlay" onClick={cancel}>
      <div className="package-dialog label-conflict-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="label-conflict-hint">
          Pick a label for each net, then Apply. Esc or clicking outside cancels the rename.
        </p>
        {conflicts.map((row, i) => (
          <fieldset className="label-conflict-row" key={`${i}-${row.heading}`}>
            {conflicts.length > 1 && <legend className="label-conflict-net">{row.heading}</legend>}
            <div className="label-conflict-buttons">
              {row.candidates.map((label) => (
                <label className="label-conflict-radio" key={label}>
                  <input
                    type="radio"
                    name={`label-conflict-${i}`}
                    checked={choices[i] === label}
                    onChange={() => setChoices((c) => ({ ...c, [i]: label }))}
                  />
                  {oneLine(label)}
                </label>
              ))}
              <label className="label-conflict-radio">
                <input
                  type="radio"
                  name={`label-conflict-${i}`}
                  checked={!choices[i] || choices[i] === KEEP_BOTH}
                  onChange={() => setChoices((c) => ({ ...c, [i]: KEEP_BOTH }))}
                />
                keep both
              </label>
            </div>
          </fieldset>
        ))}
        <div className="label-conflict-actions">
          <button type="button" className="tool-btn" onClick={applyAll}>
            Apply
          </button>
          <button type="button" className="tool-btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
