import type { DocFile } from './platform';
// Crash/reload recovery for the working board. Separate from handleStore's
// library-folder key but the same IndexedDB database, since it is the same
// question: what should survive a reload without asking the user anything?
//
// IndexedDB, not the library folder: this must work before any folder is
// connected (and needs no permission prompt), which is exactly the case where
// a student would otherwise lose everything. Cleared by clearing site data,
// like any browser storage -- it is recovery, not a substitute for saving.

import type { Board, ChipDef } from '../core/model/types';
import { openLcirDb, requestOf } from './handleStore';

const STORE = 'session';
const KEY = 'working-board';

/** An open chip tab; `def` differing from `saved` is unsaved work. */
export interface SessionChipTab {
  def: ChipDef;
  saved: ChipDef;
  prefix: string;
  breadcrumb: string;
  /** The `.lcirc` it was opened from or saved to, so Save still writes there. */
  file?: DocFile;
}

export interface Session {
  /** Chip tabs after the board tab, in order; absent in sessions from before 0.8.3. */
  chipTabs?: SessionChipTab[];
  /** Index into `chipTabs` of the tab in front; absent means the board. */
  activeChipTab?: number;
  /** Serialized board document; parsed back through the migrate+validate pipeline. */
  board: Board;
  /** The file this board came from, so Ctrl+S still targets it after a reload. */
  file?: DocFile;
  /** Unsaved edits exist relative to `file`. */
  dirty: boolean;
  savedAt: number;
}

export function saveSession(session: Session): Promise<void> {
  return requestOf<IDBValidKey>(STORE, 'readwrite', (s) => s.put(session, KEY)).then(
    () => undefined,
  );
}

export function loadSession(): Promise<Session | undefined> {
  return requestOf<Session | undefined>(STORE, 'readonly', (s) => s.get(KEY));
}

export function clearSession(): Promise<void> {
  return requestOf<undefined>(STORE, 'readwrite', (s) => s.delete(KEY)).then(() => undefined);
}

/** Exposed so a caller can await the database without importing handleStore. */
export const sessionDb = openLcirDb;
