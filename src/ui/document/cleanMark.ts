import type { Board } from '../../core/model/types';

// The clean mark is the board as last saved: edits replace the object, running and
// library loads do not. Not `rev`, which the sim bumps on every frame it runs.

/** No board ever is it, so only a save or a load can clear the dirty flag. */
export const NEVER_CLEAN: unique symbol = Symbol('never clean');

export type CleanMark = Board | typeof NEVER_CLEAN;

/**
 * The clean mark for a board just restored from autosave. Marking the loaded
 * board clean would wipe a dirty session's star and let New replace it unasked.
 */
export function restoredCleanMark(sessionDirty: boolean, boardAfterLoad: Board): CleanMark {
  return sessionDirty ? NEVER_CLEAN : boardAfterLoad;
}

export const isDirtyAgainst = (board: Board, clean: CleanMark): boolean => board !== clean;
