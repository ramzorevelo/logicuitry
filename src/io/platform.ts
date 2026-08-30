// Which shell the app is running in, and the two handle types the rest of the
// app is allowed to know about.
//
// A folder or a file is a `FileSystemDirectoryHandle`/`FileSystemFileHandle` in
// a browser and a path string in a desktop shell. Nothing outside `src/io/fs/`
// may name either concrete form: the only property a consumer ever needs is the
// display name, so that is all these types carry.

/** A user-picked folder. Opaque outside the fs backends. */
export interface LibraryDir {
  readonly name: string;
}

/** A user-picked document file. Opaque outside the fs backends. */
export interface DocFile {
  readonly name: string;
}

/**
 * True in a desktop shell. Probed at runtime rather than read from a build
 * flag: one bundle serves both targets, so a compile-time answer would be
 * wrong for whichever target it was not built for.
 */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
