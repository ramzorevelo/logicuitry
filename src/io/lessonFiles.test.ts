import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '../core/model/types';
import { BUILTIN_LESSONS } from '../examples/lessons';
import { loadFileLessons, rememberFileLesson, type FileLesson } from './lessonFiles';

const db = new Map<string, unknown>();
vi.mock('./handleStore', () => ({
  requestOf: async (_store: string, _mode: string, run: (s: unknown) => unknown) =>
    run({
      get: (key: string) => db.get(key),
      put: (value: unknown, key: string) => db.set(key, structuredClone(value)),
    }),
}));
vi.mock('./fsAccess', () => ({
  sameFile: async (a: { name: string }, b: { name: string }) => a.name === b.name,
}));

const lesson = (title: string): Lesson => ({ ...structuredClone(BUILTIN_LESSONS[0]!), title });
const entry = (name: string, title = name): FileLesson => ({
  lesson: lesson(title),
  file: { name } as never,
  savedAt: 0,
});

beforeEach(() => db.clear());

describe('file lessons', () => {
  it('keeps the newest copy of each file, newest first', async () => {
    await rememberFileLesson(entry('a.lcirl', 'A old'));
    await rememberFileLesson(entry('b.lcirl'));
    await rememberFileLesson(entry('a.lcirl', 'A new'));
    expect((await loadFileLessons()).map((e) => e.lesson.title)).toEqual(['A new', 'b.lcirl']);
  });

  it('keeps both of two saves made at once', async () => {
    await Promise.all([rememberFileLesson(entry('a.lcirl')), rememberFileLesson(entry('b.lcirl'))]);
    expect(await loadFileLessons()).toHaveLength(2);
  });

  it('drops a stored copy that no longer reads as a lesson', async () => {
    await rememberFileLesson(entry('a.lcirl'));
    const [stored] = db.get('lesson-files') as FileLesson[];
    db.set('lesson-files', [{ ...stored!, lesson: { format: 'lcir.lesson' } }, stored]);
    expect(await loadFileLessons()).toHaveLength(1);
  });
});
