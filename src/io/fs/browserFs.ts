import { BOARD_EXT, CHIP_EXT, isDocumentName } from '../docExtensions';
// Browser file backend: the library lives as JSON files in a user-picked
// directory (the git-tracked library folder). Chromium gets the
// real picker with a persisted handle; other browsers fall back to manual
// import/export. All reads go through the parse+validate pipeline in library.ts.
//
// The only module that may name the File System Access handle types; everything
// above this speaks LibraryDir/DocFile (platform.ts).

import { parseDocument, serializeDocument, type LibraryDoc } from '../library';
import { loadDirectoryHandle, saveDirectoryHandle, type DirKind } from '../handleStore';
import type { DocFile, LibraryDir } from '../platform';
import { loadChipLibraryWith } from './chipLibrary';

export type LibrarySubdir = 'chips' | 'boards' | 'lessons';

const asHandle = (dir: LibraryDir) => dir as unknown as FileSystemDirectoryHandle;

// The permission methods are not in the standard DOM lib yet; narrow shim.
interface PermissionCapable {
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export function fileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickDirectory(kind: DirKind): Promise<LibraryDir> {
  const picker = (
    window as unknown as {
      showDirectoryPicker(o?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  const handle = await picker({ mode: 'readwrite' });
  await saveDirectoryHandle(handle, kind);
  return handle;
}

/**
 * What a cold start can know about the library without a user gesture. The
 * handle itself survives in IndexedDB, but permission usually does not:
 * `queryPermission` answers 'prompt' on a fresh load unless the user chose
 * "Allow on every visit", and re-requesting needs transient activation. So a
 * stored-but-ungranted folder is reported rather than silently dropped, and
 * the shell offers to reconnect on a click.
 */
export interface LibraryRestore {
  handle?: LibraryDir;
  /** A folder was picked before, but this load cannot use it until a click. */
  needsPermission: boolean;
}

export async function restoreDirectory(kind: DirKind): Promise<LibraryRestore> {
  const handle = await loadDirectoryHandle(kind);
  if (!handle) return { needsPermission: false };
  if (await ensurePermission(handle, false)) return { handle, needsPermission: false };
  return { handle, needsPermission: true };
}

export function loadChipLibrary(root: LibraryDir) {
  return loadChipLibraryWith({ listFiles, readDoc }, root);
}

export async function ensurePermission(handle: object, request: boolean): Promise<boolean> {
  const cap = handle as PermissionCapable;
  const opts = { mode: 'readwrite' as const };
  if ((await cap.queryPermission?.(opts)) === 'granted') return true;
  if (!request) return false;
  return (await cap.requestPermission?.(opts)) === 'granted';
}

async function subdirHandle(
  root: LibraryDir,
  sub: LibrarySubdir,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  return asHandle(root).getDirectoryHandle(sub, { create });
}

export async function listFiles(root: LibraryDir, sub: LibrarySubdir): Promise<string[]> {
  const dir = await subdirHandle(root, sub, false);
  const names: string[] = [];
  // AsyncIterable of entries; typed loosely as the DOM lib omits values().
  for await (const [name, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (entry.kind === 'file' && isDocumentName(name)) names.push(name);
  }
  return names.sort();
}

export async function readDoc(
  root: LibraryDir,
  sub: LibrarySubdir,
  name: string,
): Promise<LibraryDoc> {
  const dir = await subdirHandle(root, sub, false);
  const file = await (await dir.getFileHandle(name)).getFile();
  return parseDocument(await file.text());
}

export async function writeDoc(
  root: LibraryDir,
  sub: LibrarySubdir,
  name: string,
  doc: LibraryDoc,
): Promise<void> {
  const dir = await subdirHandle(root, sub, true);
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(serializeDocument(doc));
  await writable.close();
}

// Non-Chromium fallback: read one uploaded file, download one document.
export async function importDocFromFile(file: File): Promise<LibraryDoc> {
  return parseDocument(await file.text());
}

export function exportDoc(doc: LibraryDoc, filename: string): void {
  const blob = new Blob([serializeDocument(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Document files (File > Open / Save As) ---

const asFile = (f: DocFile) => f as unknown as FileSystemFileHandle;

interface FilePickerWindow {
  showOpenFilePicker?(o?: unknown): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: unknown): Promise<FileSystemFileHandle>;
}

const filePicker = (): FilePickerWindow => window as unknown as FilePickerWindow;

const DOC_TYPES = [
  {
    description: 'Logicuitry board',
    accept: { 'application/json': [BOARD_EXT] },
  },
  {
    description: 'Logicuitry chip',
    accept: { 'application/json': [CHIP_EXT] },
  },
];

/** Chromium-only, like the directory picker; other browsers fall back to an
 *  <input type="file"> for open and a download for save. */
export function filePickersSupported(): boolean {
  return typeof window !== 'undefined' && typeof filePicker().showOpenFilePicker === 'function';
}

export async function pickDocumentFile(startIn?: LibraryDir): Promise<DocFile | undefined> {
  const show = filePicker().showOpenFilePicker;
  if (!show) return undefined;
  try {
    const handles = await show({ types: DOC_TYPES, ...(startIn ? { startIn } : {}) });
    return handles[0];
  } catch {
    return undefined; // dismissed
  }
}

export async function pickSavePath(
  suggestedName: string,
  startIn?: LibraryDir,
): Promise<DocFile | undefined> {
  const show = filePicker().showSaveFilePicker;
  if (!show) return undefined;
  try {
    return await show({ suggestedName, types: DOC_TYPES, ...(startIn ? { startIn } : {}) });
  } catch {
    return undefined; // dismissed
  }
}

export async function readDocFile(file: DocFile): Promise<string> {
  return (await asFile(file).getFile()).text();
}

/** Throws when permission has lapsed, which is the caller's cue to fall back
 *  to Save As rather than silently losing the save. */
export async function writeDocFile(file: DocFile, text: string): Promise<void> {
  if (!(await ensurePermission(file, true))) throw new PermissionLapsedError();
  const writable = await asFile(file).createWritable();
  await writable.write(text);
  await writable.close();
}

export class PermissionLapsedError extends Error {}

export async function sameFile(a: DocFile, b: DocFile): Promise<boolean> {
  return (await asFile(a).isSameEntry?.(asFile(b))) ?? false;
}
