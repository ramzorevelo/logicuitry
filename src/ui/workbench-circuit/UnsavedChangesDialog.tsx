// Replacing the board (New, Open, opening a chip's contents) throws away
// unsaved work, so it asks first. Save is offered here rather than in a bare
// confirm because "discard or cancel" is a false choice when the real answer
// is usually "save it".

import { useEffect } from 'react';

export function UnsavedChangesDialog({
  action,
  hasFile,
  onSave,
  onDiscard,
  onCancel,
}: {
  /** What the user asked for, e.g. "Open another board". */
  action: string;
  /** False when the board has never been saved, so Save opens a picker. */
  hasFile: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="package-dialog close-tab-dialog">
        <h3>{action}</h3>
        <p className="label-conflict-hint">This board has unsaved changes.</p>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" autoFocus onClick={onSave}>
            {hasFile ? 'Save' : 'Save as\u2026'}
          </button>
          <button type="button" className="tool-btn" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="tool-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
