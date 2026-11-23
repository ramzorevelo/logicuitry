import { BOARD_EXT, CHIP_EXT, LESSON_EXT, isDocumentName } from '../docExtensions';
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

/** Document files in `dir`, or in its `sub` folder, as openable files; throws on a missing folder. */
export async function listDocFiles(dir: LibraryDir, sub?: LibrarySubdir): Promise<DocFile[]> {
  const folder = sub ? await subdirHandle(dir, sub, false) : asHandle(dir);
  const files: DocFile[] = [];
  for await (const [name, entry] of folder as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (entry.kind === 'file' && isDocumentName(name)) files.push(entry as unknown as DocFile);
  }
  return files;
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
  // Not application/json: Android Chrome appends .json to a JSON download's name.
  const blob = new Blob([serializeDocument(doc)], { type: 'application/octet-stream' });
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
  {
    description: 'Logicuitry lesson',
    accept: { 'application/json': [LESSON_EXT] },
  },
];

/** Chromium-only, like the directory picker; other browsers fall back to an
 *  <input type="file"> for open and a download for save. */
export function filePickersSupported(): boolean {
  return typeof window !== 'undefined' && typeof filePicker().showOpenFilePicker === 'function';
}

/** Android and iOS pickers filter by MIME type only and cannot map our extensions to one, so any
 *  type filter grays out every document (a downloaded `.lcirb` is octet-stream). On a touch-first
 *  device the picker shows everything and the content's kind token is the filter. */
function touchFirst(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

export async function pickDocumentFile(startIn?: LibraryDir): Promise<DocFile | undefined> {
  const show = filePicker().showOpenFilePicker;
  if (!show) return (await chooseUploadedFiles(false))[0];
  try {
    const types = touchFirst() ? {} : { types: DOC_TYPES };
    const handles = await show({ ...types, ...(startIn ? { startIn } : {}) });
    return handles[0];
  } catch {
    return undefined; // dismissed
  }
}

/** `accept` lists extensions with the dot; omitted means every document type. Empty when dismissed. */
export async function pickDocumentFiles(
  startIn?: LibraryDir,
  accept?: readonly string[],
): Promise<DocFile[]> {
  const show = filePicker().showOpenFilePicker;
  if (!show) return chooseUploadedFiles(true, accept);
  const types = touchFirst()
    ? {}
    : {
        types: accept
          ? DOC_TYPES.filter((t) => accept.some((e) => t.accept['application/json'].includes(e)))
          : DOC_TYPES,
      };
  try {
    const handles = await show({ multiple: true, ...types, ...(startIn ? { startIn } : {}) });
    return [...handles];
  } catch {
    return []; // dismissed
  }
}

/** The browser's own chooser, for phones and non-Chromium. Must run inside the click that asked
 *  for it, so nothing may be awaited before `input.click()`. */
function chooseUploadedFiles(multiple: boolean, accept?: readonly string[]): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (!touchFirst()) {
      input.accept = (accept ?? [BOARD_EXT, CHIP_EXT, LESSON_EXT]).join(',');
    }
    input.hidden = true;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    // Older Safari ignores click() on an input that is not in the document.
    document.body.append(input);
    input.click();
  });
}

/** An uploaded File is a read-only snapshot: it can be opened, never saved back to. */
export function docFileWritable(file: DocFile): boolean {
  return !(file instanceof File);
}

/** Android renames a JSON save to `copy.lcirb.json`; octet-stream is the one type it leaves alone. */
const SAVE_TYPES_TOUCH = DOC_TYPES.map((t) => ({
  description: t.description,
  accept: { 'application/octet-stream': t.accept['application/json'] },
}));

export async function pickSavePath(
  suggestedName: string,
  startIn?: LibraryDir,
): Promise<DocFile | undefined> {
  const show = filePicker().showSaveFilePicker;
  if (!show) return undefined;
  try {
    const types = touchFirst() ? SAVE_TYPES_TOUCH : DOC_TYPES;
    return await show({ suggestedName, types, ...(startIn ? { startIn } : {}) });
  } catch {
    return undefined; // dismissed
  }
}

export interface BlobKind {
  description: string;
  mime: string;
  ext: string;
}

/** The bytes, or a producer run only after the destination is chosen: the picker needs the
 *  click's user activation, which slow encoding before it would spend. */
export type BlobSource = Blob | (() => Promise<Blob>);

const resolveBlob = (source: BlobSource): Promise<Blob> =>
  typeof source === 'function' ? source() : Promise.resolve(source);

/** The browser may still be reading the object URL when click() returns. */
const REVOKE_DELAY_MS = 30_000;

/** True when written, false when the user dismissed the picker. Without a picker it downloads. */
export async function saveBlob(
  source: BlobSource,
  suggestedName: string,
  kind: BlobKind,
): Promise<boolean> {
  const show = filePicker().showSaveFilePicker;
  if (!show) {
    const url = URL.createObjectURL(await resolveBlob(source));
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    return true;
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await show({
      suggestedName,
      types: [{ description: kind.description, accept: { [kind.mime]: [`.${kind.ext}`] } }],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false;
    throw e;
  }
  const blob = await resolveBlob(source);
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

/** Far above any real document (the largest example is ~0.25 MB). Phone pickers offer every file,
 *  and reading a video whole just to fail JSON.parse can kill the tab. */
export const MAX_DOC_BYTES = 32 * 1024 * 1024;

export async function readDocFile(file: DocFile): Promise<string> {
  const blob = file instanceof File ? file : await asFile(file).getFile();
  if (blob.size > MAX_DOC_BYTES) throw new Error('too large to be a Logicuitry file');
  return blob.text();
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
