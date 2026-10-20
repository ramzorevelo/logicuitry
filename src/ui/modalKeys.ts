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

import { useEffect, useRef } from 'react';
import { useBackLayer } from './backStack';

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

const escapeOwners: object[] = [];

export interface EscapeClaim {
  /** True while this is the newest open dialog, the only one Escape closes. */
  readonly isTop: boolean;
  release(): void;
}

/** Every dialog's capture listener sees one Escape; only the top one may act on it. */
export function claimEscape(): EscapeClaim {
  const token = {};
  escapeOwners.push(token);
  return {
    get isTop() {
      return escapeOwners[escapeOwners.length - 1] === token;
    },
    release() {
      const i = escapeOwners.indexOf(token);
      if (i >= 0) escapeOwners.splice(i, 1);
    },
  };
}

/**
 * Claims the keyboard for a modal and closes it on Escape.
 * Pass null while the dialog is not showing, for the ones that decide that
 * from the store rather than by being mounted. `onEscape`, when given, takes
 * Escape instead, for a dialog that asks before it discards work; Back still
 * closes, since the layer it pops cannot be put back.
 */
export function useModalKeys(onClose: (() => void) | null, onEscape?: () => void): void {
  const open = onClose !== null;
  useBackLayer(onClose);
  useEffect(() => {
    if (!open) return;
    return pushModalKeys();
  }, [open]);
  const latest = useRef(onEscape ?? onClose);
  latest.current = onEscape ?? onClose;
  useEffect(() => {
    if (!open) return;
    const claim = claimEscape();
    // Capture, so the dialog's Escape wins over the workbench's.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !claim.isTop) return;
      e.stopPropagation();
      latest.current?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      claim.release();
    };
  }, [open]);
}
