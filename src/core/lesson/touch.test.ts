import { describe, expect, it } from 'vitest';
import type { BoardSequence, Lesson, LessonAction, LessonStep } from '../model/types';
import type { LessonBoardView } from './plan';
import { touchIndex } from './touch';

const sequence: BoardSequence = {
  inputs: ['a', 'b', 'f'],
  expect: ['y'],
  rows: [{ set: [3, 2, 0] }, { set: [7, 1, 0] }, { set: [7, 1, 2] }],
  advance: { mode: 'key' },
  hideExpected: true,
};
const board: LessonBoardView = { componentIds: new Set(['a', 'b', 'f', 'y', 'flags']), sequence };
const row = (index: number, when: 'open' | 'reveal' = 'open'): LessonAction => ({
  kind: 'row',
  index,
  when,
});
const step = (extra: Partial<LessonStep>, ...actions: LessonAction[]): LessonStep => ({
  kind: 'narrate',
  prose: '',
  actions,
  ...extra,
});
const lessonOf = (...steps: LessonStep[]): Lesson => ({
  format: 'lcir.lesson',
  formatVersion: 4,
  id: 'l',
  title: 'L',
  workbench: 'circuit',
  steps,
});

describe('touchIndex', () => {
  const lesson = lessonOf(
    step({}, row(0)),
    step({}, row(1), { kind: 'highlight', components: ['flags', 'a'] }),
    step(
      {
        narr: { at: 'callout', part: 'flags' },
        annots: [{ kind: 'callout', id: 'n1', part: 'y', text: '', offset: { x: 0, y: 0 } }],
      },
      row(2),
    ),
    step({ narr: { at: 'caption', part: 'y' } }),
  );
  const index = touchIndex(lesson, board);

  it('the first row touches every input; later rows only the ones they move', () => {
    expect(index.byStep[0]).toEqual([
      { part: 'a', reasons: ['input'] },
      { part: 'b', reasons: ['input'] },
      { part: 'f', reasons: ['input'] },
    ]);
    expect(index.byStep[2]!.filter((t) => t.reasons.includes('input'))).toEqual([
      { part: 'f', reasons: ['input'] },
    ]);
  });

  it('merges reasons per part and records highlights, callouts and narration callouts', () => {
    expect(index.byStep[1]).toEqual([
      { part: 'a', reasons: ['input', 'highlight'] },
      { part: 'b', reasons: ['input'] },
      { part: 'flags', reasons: ['highlight'] },
    ]);
    expect(index.byStep[2]).toEqual([
      { part: 'f', reasons: ['input'] },
      { part: 'y', reasons: ['callout'] },
      { part: 'flags', reasons: ['narration'] },
    ]);
  });

  it('a narration part counts only when it shows as a callout', () => {
    expect(index.byStep[3]).toEqual([]);
  });

  it('maps each part to the steps touching it, ascending, and leaves untouched parts out', () => {
    expect(index.byPart.get('a')).toEqual([0, 1]);
    expect(index.byPart.get('flags')).toEqual([1, 2]);
    expect(index.byPart.get('f')).toEqual([0, 2]);
    expect(index.byPart.has('nobody')).toBe(false);
  });

  it('a row past the end, or a board with no sequence, touches nothing', () => {
    const l = lessonOf(step({}, row(9)));
    expect(touchIndex(l, board).byStep[0]).toEqual([]);
    expect(touchIndex(lessonOf(step({}, row(0))), { componentIds: new Set() }).byStep[0]).toEqual(
      [],
    );
  });

  it('a held-back row on a predict step moves inputs after the open rows', () => {
    const predict: LessonStep = { kind: 'predict', prose: '', actions: [row(1, 'reveal'), row(0)] };
    const l = lessonOf(predict, step({}, row(1)));
    // Open row 0, then reveal row 1 leaves a=7, b=1: step 1's row 1 moves nothing.
    expect(touchIndex(l, board).byStep[1]).toEqual([]);
  });
});
