import { BOARD_EXT } from './docExtensions';
// File > Open / Save / Save As for board documents, plus the recent list.
//
// Every read goes through parseDocument (migrate -> validate), so an older or
// hand-edited file either loads correctly or fails loudly -- a board is never
// trusted just because it came off disk. Writes go straight to a held handle
// when there is one: that is the whole point of Save vs Save As, and it works
// without a picker for the rest of the session once permission is granted
// (across sessions only if the user chose "Allow on every visit").

import type { Board, ChipDef } from '../core/model/types';
import { requestOf } from './handleStore';
import {
  PermissionLapsedError,
  pickDocumentFile as pickFile,
  pickSavePath,
  readDocFile,
  sameFile,
  writeDocFile,
} from './fsAccess';
import { parseDocument, serializeDocument } from './library';
import type { DocFile, LibraryDir } from './platform';

const RECENTS = 'handles';
const RECENT_KEY = 'recent-boards';
const RECENT_LIMIT = 8;

export interface RecentBoard {
  name: string;
  file: DocFile;
  openedAt: number;
}

export class BoardFileError extends Error {}

/** Parses bytes as a board, rejecting any other document kind by format. */
export function parseBoard(text: string): Board {
  const doc = parseDocument(text);
  if (doc.format !== 'lcir.board')
    throw new BoardFileError(`that file is a ${doc.format.replace('lcir.', '')}, not a board`);
  return doc;
}

export async function readBoardFile(file: DocFile): Promise<Board> {
  return parseBoard(await readDocFile(file));
}

/** A board or a chip -- a chip's internals are a circuit too, so Open offers
 *  both rather than refusing by format. Anything else (a lesson) still throws. */
export type OpenedDocument = { kind: 'board'; board: Board } | { kind: 'chip'; def: ChipDef };

export function parseDocumentFile(text: string): OpenedDocument {
  const doc = parseDocument(text);
  if (doc.format === 'lcir.board') return { kind: 'board', board: doc };
  if (doc.format === 'lcir.chip') return { kind: 'chip', def: doc };
  throw new BoardFileError(
    `that file is a ${doc.format.replace('lcir.', '')}, not a board or a chip`,
  );
}

export async function readDocumentFile(file: DocFile): Promise<OpenedDocument> {
  return parseDocumentFile(await readDocFile(file));
}

/** Open picker -> document + the handle to write back to. Undefined if dismissed. */
export async function openBoardFile(
  startIn?: LibraryDir,
): Promise<{ doc: OpenedDocument; file: DocFile } | undefined> {
  const file = await pickDocumentFile(startIn);
  if (!file) return undefined;
  return { doc: await readDocumentFile(file), file };
}

/** Just the handle: Import reads a document without adopting it as the file
 *  Save writes back to. */
export function pickDocumentFile(startIn?: LibraryDir): Promise<DocFile | undefined> {
  return pickFile(startIn);
}

/**
 * Writes to a handle already held. Returns false when permission has lapsed
 * (a handle restored from a previous session, most often), so the caller can
 * fall back to Save As rather than silently losing the save.
 */
export async function writeBoardTo(file: DocFile, board: Board): Promise<boolean> {
  try {
    await writeDocFile(file, serializeDocument(board));
    return true;
  } catch (e) {
    if (e instanceof PermissionLapsedError) return false;
    throw e;
  }
}

/** Save-As picker -> the chosen handle, already written. Undefined if dismissed. */
export async function saveBoardAs(
  board: Board,
  suggestedName: string,
  startIn?: LibraryDir,
): Promise<DocFile | undefined> {
  const file = await pickSavePath(suggestedName, startIn);
  if (!file) return undefined;
  await writeDocFile(file, serializeDocument(board));
  return file;
}

/** Filename for a board, derived from its own name so Save As pre-fills usefully. */
export function boardFileName(board: Board): string {
  const slug = board.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'board'}${BOARD_EXT}`;
}

export async function loadRecentBoards(): Promise<RecentBoard[]> {
  const list = await requestOf<RecentBoard[] | undefined>(RECENTS, 'readonly', (s) =>
    s.get(RECENT_KEY),
  );
  return list ?? [];
}

/** Most-recent-first, de-duplicated by whatever the backend calls identity. */
export async function rememberRecentBoard(entry: RecentBoard): Promise<void> {
  const list = await loadRecentBoards();
  const rest: RecentBoard[] = [];
  for (const item of list) {
    const same = await sameFile(item.file, entry.file).catch(() => false);
    if (!same) rest.push(item);
  }
  const next = [entry, ...rest].slice(0, RECENT_LIMIT);
  await requestOf<IDBValidKey>(RECENTS, 'readwrite', (s) => s.put(next, RECENT_KEY));
}
