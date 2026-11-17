import { useState } from 'react';
import { useModalKeys } from '../modalKeys';
import type { ChipDef } from '../../core/model/types';
import type { ChipCopyChoice } from './embeddedChips';

/** A board carries its own copy of a chip that is already open with different contents. */
export function ChipsDifferDialog({
  chips,
  onChoose,
  onCancel,
}: {
  chips: readonly ChipDef[];
  onChoose: (choice: ChipCopyChoice, remember: boolean) => void;
  onCancel: () => void;
}) {
  useModalKeys(onCancel);
  const [remember, setRemember] = useState(false);
  const names = chips.map((c) => c.name).join(', ');

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="package-dialog close-tab-dialog">
        <h3>Chips differ</h3>
        <p className="label-conflict-hint">
          This board carries its own copy of {names}, and the open copy is different.
        </p>
        <label className="chips-differ-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />{' '}
          Don&apos;t ask again until the page reloads
        </label>
        <div className="label-conflict-buttons">
          <button
            type="button"
            className="tool-btn"
            autoFocus
            onClick={() => onChoose('open', remember)}
          >
            Use the open chips
          </button>
          <button type="button" className="tool-btn" onClick={() => onChoose('board', remember)}>
            Use the board&apos;s copies
          </button>
          <button type="button" className="tool-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
