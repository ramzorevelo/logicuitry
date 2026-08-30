// Opening a .chip.json is ambiguous on purpose: the file is both a reusable
// part and a circuit. Ask rather than pick -- "open the chip" and "open what's
// inside it" are different intentions and neither is rare.

import { useEffect } from 'react';
import type { ChipDef } from '../../core/model/types';

export function OpenChipDialog({
  def,
  onChoose,
  onCancel,
}: {
  def: ChipDef;
  onChoose: (as: 'chip' | 'board') => void;
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
        <h3>Open {def.name}</h3>
        <p className="label-conflict-hint">Opening the contents replaces the current board.</p>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" autoFocus onClick={() => onChoose('chip')}>
            Open as chip
          </button>
          <button type="button" className="tool-btn" onClick={() => onChoose('board')}>
            Open contents as board
          </button>
          <button type="button" className="tool-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
