import { isDocumentName } from '../docExtensions';
// Desktop file backend. Same eleven signatures as the browser one, on native
// pickers and a real filesystem.
//
// Why this exists at all: WebView2 exposes `showDirectoryPicker`, so the
// browser backend appears to work in a desktop shell -- but a persisted handle
// is NOT reusable across app restarts, the permission is dropped. That breaks
// "grant the folder once, restore it silently every launch", which is the
// entire contract handleStore exists to keep. Here a folder is a path string
// and `tauri-plugin-persisted-scope` restores the grant.
//
// The Tauri modules are imported dynamically so they stay out of the browser
// build's main chunk; nothing here runs unless isDesktop() said so.

import { parseDocument, serializeDocument, type LibraryDoc } from '../library';
import { loadDirectoryHandle, saveDirectoryHandle, type DirKind } from '../handleStore';
import type { DocFile, LibraryDir } from '../platform';
import { loadChipLibraryWith } from './chipLibrary';
import type { LibrarySubdir, LibraryRestore } from './browserFs';

/** A folder or file on disk. `name` is what the UI shows; `path` is the truth. */
interface Located {
  readonly name: string;
  readonly path: string;
}

const located = (dir: LibraryDir | DocFile): Located => dir as Located;

const dialog = () => import('@tauri-apps/plugin-dialog');
const fs = () => import('@tauri-apps/plugin-fs');

async function join(...parts: string[]): Promise<string> {
  const { join: j } = await import('@tauri-apps/api/path');
  return j(...parts);
}

async function basename(path: string): Promise<string> {
  const { basename: b } = await import('@tauri-apps/api/path');
  return b(path);
}

/** Always: a desktop shell has native pickers, whatever the webview supports. */
export function fileSystemAccessSupported(): boolean {
  return true;
}

export async function pickDirectory(kind: DirKind): Promise<LibraryDir> {
  const { open } = await dialog();
  const path = await open({ directory: true, multiple: false });
  if (typeof path !== 'string') throw new Error('no folder chosen');
  const dir: Located = { name: await basename(path), path };
  await saveDirectoryHandle(dir, kind);
  return dir;
}

/** No permission dance on desktop: the scope plugin restored the grant with
 *  the path, so a stored folder is usable straight away. */
export async function restoreDirectory(kind: DirKind): Promise<LibraryRestore> {
  const dir = await loadDirectoryHandle(kind);
  return dir ? { handle: dir, needsPermission: false } : { needsPermission: false };
}

/** No-op by design: `tauri-plugin-persisted-scope` owns permission here. The
 *  signature stays so callers do not branch on the platform. */
export async function ensurePermission(_handle: object, _request: boolean): Promise<boolean> {
  void _handle;
  void _request;
  return true;
}

export async function listFiles(root: LibraryDir, sub: LibrarySubdir): Promise<string[]> {
  const { readDir } = await fs();
  const entries = await readDir(await join(located(root).path, sub));
  return entries
    .filter((e) => e.isFile && isDocumentName(e.name))
    .map((e) => e.name)
    .sort();
}

export async function readDoc(
  root: LibraryDir,
  sub: LibrarySubdir,
  name: string,
): Promise<LibraryDoc> {
  const { readTextFile } = await fs();
  return parseDocument(await readTextFile(await join(located(root).path, sub, name)));
}

export async function writeDoc(
  root: LibraryDir,
  sub: LibrarySubdir,
  name: string,
  doc: LibraryDoc,
): Promise<void> {
  const { mkdir, writeTextFile } = await fs();
  const dir = await join(located(root).path, sub);
  await mkdir(dir, { recursive: true });
  await writeTextFile(await join(dir, name), serializeDocument(doc));
}

export function loadChipLibrary(root: LibraryDir) {
  return loadChipLibraryWith({ listFiles, readDoc }, root);
}

/** Import still arrives as a File (a drop, or the fallback input), so this is
 *  the browser's implementation unchanged. */
export async function importDocFromFile(file: File): Promise<LibraryDoc> {
  return parseDocument(await file.text());
}

/** No download folder to fall back on: ask where to put it, like Save As. */
export function exportDoc(doc: LibraryDoc, filename: string): void {
  void (async () => {
    const { save } = await dialog();
    const path = await save({ defaultPath: filename });
    if (!path) return;
    const { writeTextFile } = await fs();
    await writeTextFile(path, serializeDocument(doc));
  })();
}

// --- Document files (File > Open / Save As), the boardFile.ts half ---

export async function pickDocumentFile(startIn?: LibraryDir): Promise<DocFile | undefined> {
  const { open } = await dialog();
  const path = await open({
    multiple: false,
    filters: [{ name: 'Logicuitry document', extensions: ['json'] }],
    ...(startIn ? { defaultPath: located(startIn).path } : {}),
  });
  if (typeof path !== 'string') return undefined;
  const file: Located = { name: await basename(path), path };
  return file;
}

export async function pickSavePath(
  suggestedName: string,
  startIn?: LibraryDir,
): Promise<DocFile | undefined> {
  const { save } = await dialog();
  const path = await save({
    defaultPath: startIn ? await join(located(startIn).path, suggestedName) : suggestedName,
    filters: [{ name: 'Logicuitry board', extensions: ['json'] }],
  });
  if (!path) return undefined;
  const file: Located = { name: await basename(path), path };
  return file;
}

export async function readDocFile(file: DocFile): Promise<string> {
  const { readTextFile } = await fs();
  return readTextFile(located(file).path);
}

export async function writeDocFile(file: DocFile, text: string): Promise<void> {
  const { writeTextFile } = await fs();
  await writeTextFile(located(file).path, text);
}

/** Two paths are the same file; there is no handle identity to compare. */
export async function sameFile(a: DocFile, b: DocFile): Promise<boolean> {
  return located(a).path === located(b).path;
}

/** Native pickers are always there. */
export function filePickersSupported(): boolean {
  return true;
}
