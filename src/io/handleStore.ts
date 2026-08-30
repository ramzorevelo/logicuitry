// Persist the picked library directory handle in IndexedDB so re-granting access
// is one click per browser profile, not a fresh picker every session. A minimal
// wrapper shared with sessionStore; no dependency for two keys.
//
// IndexedDB is scoped to the origin. In a desktop shell the origin comes from
// the webview's custom scheme, so changing that scheme orphans every key here
// (and the session autosave, and localStorage): pin it once and never change it.

import type { LibraryDir } from './platform';

const DB_NAME = 'lcir';
const HANDLES = 'handles';
const SESSION = 'session';
/** Chips and boards get their own folder: a chip library is a shelf of parts,
 *  a board folder is the instructor's own work, and they rarely live together.
 *  The chips key keeps its original name so an existing grant survives. */
export type DirKind = 'chips' | 'boards';

const KEYS: Record<DirKind, string> = { chips: 'library-dir', boards: 'board-dir' };

/**
 * Every object store this app uses, created on first open of a given version.
 * `onupgradeneeded` fires for a browser that already holds v1 (library handle
 * only), so an existing profile gains the session store without losing its
 * folder grant.
 */
export function openLcirDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains(SESSION)) db.createObjectStore(SESSION);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function requestOf<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openLcirDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

/** Stores whatever the active backend calls a folder: a handle in a browser,
 *  a path string in a desktop shell. The keys are the same either way. */
export function saveDirectoryHandle(handle: LibraryDir, kind: DirKind): Promise<void> {
  return requestOf<IDBValidKey>(HANDLES, 'readwrite', (s) => s.put(handle, KEYS[kind])).then(
    () => undefined,
  );
}

export function loadDirectoryHandle(kind: DirKind): Promise<LibraryDir | undefined> {
  return requestOf<LibraryDir | undefined>(HANDLES, 'readonly', (s) => s.get(KEYS[kind]));
}

export function clearDirectoryHandle(kind: DirKind): Promise<void> {
  return requestOf<undefined>(HANDLES, 'readwrite', (s) => s.delete(KEYS[kind])).then(
    () => undefined,
  );
}
