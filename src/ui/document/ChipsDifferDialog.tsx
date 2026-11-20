import { useState } from 'react';
import { useModalKeys } from '../modalKeys';
import type { ChipCopyChoice, EmbeddedPlan } from './embeddedChips';

/** A board carries its own copy of a chip that is already loaded with different contents. */
export function ChipsDifferDialog({
  plan,
  onChoose,
  onCancel,
}: {
  plan: EmbeddedPlan;
  onChoose: (choice: ChipCopyChoice, remember: boolean) => void;
  onCancel: () => void;
}) {
  useModalKeys(onCancel);
  const [remember, setRemember] = useState(false);
  const names = plan.differ
    .map((c) => (plan.builtin.includes(c.id) ? `the built-in part ${c.id} (as ${c.name})` : c.name))
    .join(', ');
  const named = (ids: readonly string[]) =>
    plan.differ
      .filter((c) => ids.includes(c.id))
      .map((c) => c.name)
      .join(', ');
  const openBlocked = plan.pinMismatch.length > 0;

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="package-dialog close-tab-dialog">
        <h3>Chips differ</h3>
        <p className="label-conflict-hint">
          This board carries its own copy of {names}, and the one already loaded is different.
        </p>
        {openBlocked && (
          <p className="label-conflict-hint">
            The pins of {named(plan.pinMismatch)} differ, so the loaded copy would leave this
            board&apos;s wires dangling. Only the board&apos;s copies are offered.
          </p>
        )}
        {plan.builtinPinMismatch.length > 0 && (
          <p className="label-conflict-hint">
            Warning: the pins of {named(plan.builtinPinMismatch)} differ from the built-in part, so
            keeping the built-in may leave this board&apos;s wires dangling.
          </p>
        )}
        {plan.tabbed.length > 0 && (
          <p className="label-conflict-hint">
            The board&apos;s copy of {named(plan.tabbed)} would show as unsaved edits in its open
            tab, and saving that tab would overwrite its file with the board&apos;s copy.
          </p>
        )}
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
            autoFocus={!openBlocked}
            disabled={openBlocked}
            onClick={() => onChoose('open', remember)}
          >
            Use the open chips
          </button>
          <button
            type="button"
            className="tool-btn"
            autoFocus={openBlocked}
            onClick={() => onChoose('board', remember)}
          >
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
