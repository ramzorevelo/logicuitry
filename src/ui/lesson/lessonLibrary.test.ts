import { describe, expect, it } from 'vitest';
import type { Lesson } from '../../core/model/types';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { lessonsForBoard, type LibraryLesson } from './lessonLibrary';

const builtin = BUILTIN_LESSONS[0]!;
const mine = (id: string, board: string, title = id): LibraryLesson => ({
  lesson: { ...builtin, id, board, title } satisfies Lesson,
  fileName: `${id}.lcirl`,
});

describe('lessonsForBoard', () => {
  it('lists the built-in lessons first, then the library ones for that board', () => {
    const library = [mine('extra', builtin.board!), mine('elsewhere', 'other-board')];
    expect(lessonsForBoard(builtin.board!, library).map((l) => l.id)).toEqual([
      builtin.id,
      'extra',
    ]);
  });

  it('lets a library copy of a built-in lesson stand in for it', () => {
    const copy = mine(builtin.id, builtin.board!, 'Edited');
    expect(lessonsForBoard(builtin.board!, [copy]).map((l) => l.title)).toEqual(['Edited']);
  });

  it('lists a lesson once when the library and a saved file both hold its id', () => {
    const library = [mine('dup', builtin.board!, 'Library'), mine('dup', builtin.board!, 'File')];
    expect(lessonsForBoard(builtin.board!, library).map((l) => l.title)).toEqual([
      builtin.title,
      'Library',
    ]);
  });

  it('is empty for a board no lesson names', () => {
    expect(lessonsForBoard('nothing-here', [])).toEqual([]);
  });
});
