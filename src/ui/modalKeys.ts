// A dialog owns the keyboard while it is up. The global grammar listens on
// window, so without this a key pressed in a dialog also drives the app behind
// it: Space powered the board, T cycled the theme, Delete removed the board
// selection. Space was the one that gave it away. The global handler calls
// preventDefault on it, which is also how a focused button is activated, so
// every button in the report dialog was dead to the space bar and a space
// typed anywhere but the description box went to the simulator instead.
//
// Inputs and textareas were already exempt in each global handler; that is not
// enough, because a dialog is also selects, checkboxes and buttons.

import { useEffect } from 'react';

let held = 0;

/** True while a modal dialog is open. Global key handlers stand down on it. */
export function modalKeysHeld(): boolean {
  return held > 0;
}

/** Claims the keyboard; the returned function releases it. Nested dialogs are
 *  counted, so the one closing does not release the one behind it. */
export function pushModalKeys(): () => void {
  held++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held--;
  };
}

/**
 * Claims the keyboard for a modal and closes it on Escape.
 * Pass null while the dialog is not showing, for the ones that decide that
 * from the store rather than by being mounted.
 */
export function useModalKeys(onClose: (() => void) | null): void {
  const open = onClose !== null;
  useEffect(() => {
    if (!open) return;
    return pushModalKeys();
  }, [open]);
  useEffect(() => {
    if (!onClose) return;
    // Capture, so the dialog's Escape wins over the workbench's.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}
