import type { Lesson } from '../core/model/types';
import { sameFile } from './fsAccess';
import { requestOf } from './handleStore';
import { parseDocument, serializeDocument } from './library';
import type { DocFile } from './platform';

const STORE = 'handles';
const KEY = 'lesson-files';
const LIMIT = 50;

/**
 * A lesson saved or opened outside the library, kept with a copy of itself so
 * the Lesson menu lists it after a reload without asking for file permission
 * in front of a class.
 */
export interface FileLesson {
  lesson: Lesson;
  file: DocFile;
  savedAt: number;
}

const readList = async (): Promise<FileLesson[]> =>
  (await requestOf<FileLesson[] | undefined>(STORE, 'readonly', (s) => s.get(KEY))) ?? [];

/** A copy kept from an older format goes through the same migration as a file would. */
function current(entry: FileLesson): FileLesson | null {
  try {
    const doc = parseDocument(serializeDocument(entry.lesson));
    return doc.format === 'lcir.lesson' ? { ...entry, lesson: doc } : null;
  } catch {
    return null;
  }
}

export async function loadFileLessons(): Promise<FileLesson[]> {
  return (await readList()).map(current).filter((e): e is FileLesson => e !== null);
}

// Read-modify-write across two transactions: chained, so a save and an open at once keep both.
let pending: Promise<unknown> = Promise.resolve();

/** Newest first; a second entry for the same file replaces the first. */
export function rememberFileLesson(entry: FileLesson): Promise<void> {
  const run = pending.then(async () => {
    const rest: FileLesson[] = [];
    for (const item of await readList()) {
      if (!(await sameFile(item.file, entry.file).catch(() => false))) rest.push(item);
    }
    const next = [entry, ...rest].slice(0, LIMIT);
    await requestOf<IDBValidKey>(STORE, 'readwrite', (s) => s.put(next, KEY));
  });
  pending = run.catch(() => {});
  return run;
}
