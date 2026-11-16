import type { Board, Lesson } from '../../core/model/types';
import { listDocFiles, listFiles, readDoc, type DocFile, type LibraryDir } from '../../io/fsAccess';
import { readDocumentFile } from '../../io/boardFile';
import { BUILTIN_LESSONS } from '../../examples/lessons';

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A lesson from the library, with the file Save writes it back to; `file`
 *  when it lives outside the library. */
export interface LibraryLesson {
  lesson: Lesson;
  fileName: string;
  file?: DocFile;
}

/** The library's `lessons/` folder. A missing folder is no lessons; a file that
 *  does not parse is skipped so one bad file never hides the rest. */
export async function loadLibraryLessons(root: LibraryDir): Promise<LibraryLesson[]> {
  let names: string[];
  try {
    names = await listFiles(root, 'lessons');
  } catch {
    return [];
  }
  const lessons: LibraryLesson[] = [];
  for (const name of names) {
    try {
      const doc = await readDoc(root, 'lessons', name);
      if (doc.format === 'lcir.lesson') lessons.push({ lesson: doc, fileName: name });
      else console.warn(`lessons/${name} skipped: it is a ${doc.format}, not a lesson`);
    } catch (e) {
      console.warn(`lessons/${name} skipped: ${reason(e)}`);
    }
  }
  return lessons;
}

/** Built-in lessons first, then the given ones; the first of an id wins, and any copy beats a built-in. */
export function lessonsForBoard(boardId: string, library: readonly LibraryLesson[]): Lesson[] {
  const own = new Set<string>();
  const mine: Lesson[] = [];
  for (const { lesson } of library) {
    if (lesson.board !== boardId || own.has(lesson.id)) continue;
    own.add(lesson.id);
    mine.push(lesson);
  }
  const builtin = BUILTIN_LESSONS.filter((l) => l.board === boardId && !own.has(l.id));
  return [...builtin, ...mine];
}

/** The first board with this id in the given folders, with its file so Save writes back to it. */
export async function findLibraryBoard(
  id: string,
  folders: readonly { dir: LibraryDir; sub?: 'boards' }[],
): Promise<{ board: Board; file: DocFile } | null> {
  for (const { dir, sub } of folders) {
    let files: DocFile[];
    try {
      files = await listDocFiles(dir, sub);
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const doc = await readDocumentFile(file);
        if (doc.kind === 'board' && doc.board.id === id) return { board: doc.board, file };
      } catch {
        // Not every file in a boards folder is ours to read.
      }
    }
  }
  return null;
}
