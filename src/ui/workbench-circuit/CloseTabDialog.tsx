// Closing a dirty def tab (uncommitted history) prompts save/discard/cancel
// instead of silently dropping the session's edits.

import { useEffect } from 'react';
import { useCircuitStore } from './circuitStore';

export function CloseTabDialog() {
  const pending = useCircuitStore((s) => s.pendingTabClose);
  const resolve = useCircuitStore((s) => s.resolveTabClose);
  const cancel = useCircuitStore((s) => s.cancelTabClose);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, cancel]);

  if (!pending) return null;
  return (
    <div className="package-overlay">
      <div className="package-dialog close-tab-dialog">
        <h3>Unsaved edits</h3>
        <p className="label-conflict-hint">
          This chip has edits open in its own tab. Save keeps them (they're already live); Discard
          restores the chip to how it was when the tab opened.
        </p>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={() => resolve('save')}>
            Save
          </button>
          <button type="button" className="tool-btn" onClick={() => resolve('discard')}>
            Discard
          </button>
          <button type="button" className="tool-btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
