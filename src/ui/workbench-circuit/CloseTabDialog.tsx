// Closing a chip tab with unsaved edits prompts save/discard/cancel instead of
// silently dropping them.

import { useModalKeys } from '../modalKeys';
import { useShellStore } from '../store';
import { saveOpenChip } from '../document/chipSave';
import { useCircuitStore } from './circuitStore';

export function CloseTabDialog() {
  const pending = useCircuitStore((s) => s.pendingTabClose);
  const resolve = useCircuitStore((s) => s.resolveTabClose);
  const cancel = useCircuitStore((s) => s.cancelTabClose);

  useModalKeys(pending ? cancel : null);

  // A declined picker or a failed write leaves the dialog up: closing would lose the edits.
  const saveThenClose = async () => {
    const st = useCircuitStore.getState();
    const tab = st.tabs.find((t) => t.id === pending);
    if (tab?.kind !== 'def') return;
    const { chipsDir, boardsDir } = useShellStore.getState();
    if (await saveOpenChip(tab.defId, { startIn: chipsDir ?? boardsDir ?? undefined })) {
      resolve('save');
    }
  };

  if (!pending) return null;
  return (
    <div className="package-overlay">
      <div className="package-dialog close-tab-dialog">
        <h3>Unsaved edits</h3>
        <p className="label-conflict-hint">
          This chip has unsaved edits. Save writes it to its file; Discard restores the chip to how
          it was when the tab opened.
        </p>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={() => void saveThenClose()}>
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
