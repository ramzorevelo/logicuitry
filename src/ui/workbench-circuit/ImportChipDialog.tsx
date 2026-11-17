import { useModalKeys } from '../modalKeys';
import type { ChipDef } from '../../core/model/types';

/** Import on a chip file: opening it keeps the chip a part; pasting copies loose parts. */
export function ImportChipDialog({
  def,
  onOpen,
  onPaste,
  onCancel,
}: {
  def: ChipDef;
  onOpen: () => void;
  onPaste: () => void;
  onCancel: () => void;
}) {
  useModalKeys(onCancel);

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="package-dialog close-tab-dialog">
        <h3>{def.name} is a chip file</h3>
        <p className="label-conflict-hint">
          Open it as a chip so boards that use it find it, or paste the parts inside it onto this
          board as loose parts.
        </p>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" autoFocus onClick={onOpen}>
            Open as chip
          </button>
          <button type="button" className="tool-btn" onClick={onPaste}>
            Paste its parts
          </button>
          <button type="button" className="tool-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
