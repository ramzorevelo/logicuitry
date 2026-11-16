import { describe, expect, it } from 'vitest';
import type { BoardSequence, Lesson, LessonAction, LessonStep } from '../model/types';
import type { LessonBoardView } from './plan';
import { lessonWarnings, warningText, type LessonWarning } from './warnings';

const sequence: BoardSequence = {
  inputs: ['a', 'b'],
  expect: ['y'],
  rows: [{ set: [0, 0] }, { set: [1, 0] }, { set: [1, 1], note: 'both' }],
  advance: { mode: 'key' },
  hideExpected: true,
};
const board: LessonBoardView = { componentIds: new Set(['a', 'b', 'y', 'u1']), sequence };

const step = (kind: LessonStep['kind'], ...actions: LessonAction[]): LessonStep => ({
  kind,
  prose: '',
  actions,
  ...(kind === 'predict' ? { answer: 'because' } : {}),
});
const lessonOf = (...steps: LessonStep[]): Lesson => ({
  format: 'lcir.lesson',
  formatVersion: 4,
  id: 'l',
  title: 'L',
  workbench: 'circuit',
  steps,
});
const on: LessonAction = { kind: 'power', on: true };
const off: LessonAction = { kind: 'power', on: false };

describe('lessonWarnings', () => {
  it('is empty for a clean lesson', () => {
    const lesson = lessonOf(
      step('narrate', on, { kind: 'row', index: 1, set: [1, 0], when: 'open' }),
      step(
        'predict',
        { kind: 'row', index: 2, when: 'reveal' },
        { kind: 'highlight', components: ['y'] },
      ),
    );
    expect(lessonWarnings(lesson, board)).toEqual([]);
  });

  it('flags a row past the end of the sequence', () => {
    const lesson = lessonOf(step('narrate', on, { kind: 'row', index: 3, when: 'open' }));
    expect(lessonWarnings(lesson, board)).toEqual([{ kind: 'row-past-end', step: 0, index: 3 }]);
  });

  it('flags a row whose saved values differ from the board, but not one with none saved', () => {
    const lesson = lessonOf(
      step('narrate', on, { kind: 'row', index: 1, set: [1, 1], when: 'open' }),
      step('narrate', { kind: 'row', index: 1, when: 'open' }),
    );
    expect(lessonWarnings(lesson, board)).toEqual([{ kind: 'row-changed', step: 0, index: 1 }]);
  });

  it('flags a row applied while the board is off, simulating power from unpowered', () => {
    const lesson = lessonOf(
      step('narrate', { kind: 'row', index: 0, when: 'open' }),
      step('narrate', on, { kind: 'row', index: 1, when: 'open' }),
      step('narrate', { kind: 'row', index: 2, when: 'open' }, off),
      step('narrate', { kind: 'row', index: 0, when: 'open' }),
    );
    expect(lessonWarnings(lesson, board)).toEqual([
      { kind: 'row-while-off', step: 0, index: 0 },
      { kind: 'row-while-off', step: 3, index: 0 },
    ]);
  });

  it('takes power from the open phase before a held-back row', () => {
    const lesson = lessonOf(step('predict', { kind: 'row', index: 1, when: 'reveal' }, on));
    expect(lessonWarnings(lesson, board)).toEqual([]);
  });

  it('flags a row when the board has no sequence', () => {
    const lesson = lessonOf(step('narrate', on, { kind: 'row', index: 0, when: 'open' }));
    const bare = { componentIds: board.componentIds };
    expect(lessonWarnings(lesson, bare)).toEqual([{ kind: 'no-sequence', step: 0, index: 0 }]);
  });

  it('flags an empty highlight, a missing part, and a part inside a chip', () => {
    const lesson = lessonOf(
      step('narrate', { kind: 'highlight', components: [] }),
      step('narrate', { kind: 'highlight', components: ['u7', 'u1/g3', 'a'] }),
    );
    expect(lessonWarnings(lesson, board)).toEqual([
      { kind: 'highlight-empty', step: 0 },
      { kind: 'missing-component', step: 1, id: 'u7' },
      { kind: 'inside-chip', step: 1, id: 'u1/g3' },
    ]);
  });

  it('calls a path inside-chip even when its first segment is not a component', () => {
    const lesson = lessonOf(step('narrate', { kind: 'highlight', components: ['zz/g1'] }));
    expect(lessonWarnings(lesson, board)).toEqual([{ kind: 'inside-chip', step: 0, id: 'zz/g1' }]);
  });

  it('flags a predict step with nothing to reveal', () => {
    const bare: LessonStep = { kind: 'predict', prose: '?', actions: [], answer: '  ' };
    const choices: LessonStep = { ...bare, choices: [{ text: 'x' }, { text: 'y' }] };
    const right: LessonStep = { ...bare, choices: [{ text: 'x', right: true }] };
    const answered: LessonStep = { kind: 'predict', prose: '?', actions: [], answer: 'It is.' };
    expect(lessonWarnings(lessonOf(bare, choices, right, answered), board)).toEqual([
      { kind: 'nothing-to-reveal', step: 0 },
      { kind: 'nothing-to-reveal', step: 1 },
    ]);
  });
});

describe('warningText', () => {
  it.each<[LessonWarning, string]>([
    [{ kind: 'row-past-end', step: 0, index: 8 }, "Row 9 is past the end of the board's sequence"],
    [{ kind: 'row-changed', step: 0, index: 2 }, 'Row 3 changed since this lesson was written'],
    [{ kind: 'row-while-off', step: 0, index: 1 }, 'Row 2 is applied while the board is off'],
    [{ kind: 'no-sequence', step: 0, index: 1 }, 'The board has no sequence for row 2'],
    [{ kind: 'highlight-empty', step: 0 }, 'Highlight names no parts'],
    [{ kind: 'missing-component', step: 0, id: 'u7' }, 'Part u7 is no longer on the board'],
    [
      { kind: 'inside-chip', step: 0, id: 'u1/g3' },
      'Part u1/g3 is inside a chip; highlight the chip instead',
    ],
    [
      { kind: 'nothing-to-reveal', step: 0 },
      'Nothing to reveal: add an answer or mark a right choice',
    ],
  ])('%j', (w, text) => {
    expect(warningText(w)).toBe(text);
  });
});

describe('board note warnings', () => {
  const callout = (part: string, until?: number) => ({
    kind: 'callout' as const,
    id: `c-${part}`,
    part,
    text: '',
    offset: { x: 0, y: 0 },
    ...(until === undefined ? {} : { until }),
  });
  const withNotes = (extra: Partial<LessonStep>): LessonStep => ({ ...step('narrate'), ...extra });

  it('flags a callout or narration part that is gone or inside a chip', () => {
    const lesson = lessonOf(
      withNotes({ annots: [callout('gone'), callout('u1/g1'), callout('y')] }),
      withNotes({ narr: { at: 'callout', part: 'u1/q' } }),
      withNotes({ narr: { at: 'callout', part: 'old' } }),
    );
    expect(lessonWarnings(lesson, board)).toEqual([
      { kind: 'target-missing', step: 0, id: 'gone', by: 'callout' },
      { kind: 'target-inside-chip', step: 0, id: 'u1/g1', by: 'callout' },
      { kind: 'target-inside-chip', step: 1, id: 'u1/q', by: 'narration' },
      { kind: 'target-missing', step: 2, id: 'old', by: 'narration' },
    ]);
  });

  it('flags a narration callout with no part, but not a panel or caption with a stale part', () => {
    const lesson = lessonOf(
      withNotes({ narr: { at: 'callout' } }),
      withNotes({ narr: { at: 'caption', part: 'gone' } }),
    );
    expect(lessonWarnings(lesson, board)).toEqual([{ kind: 'narration-no-part', step: 0 }]);
  });

  it('flags an until before its own step or past the last step', () => {
    const lesson = lessonOf(
      withNotes({}),
      withNotes({ annots: [callout('y', 0), callout('a', 5), callout('b', 1)] }),
    );
    expect(lessonWarnings(lesson, board)).toEqual([
      { kind: 'until-before-step', step: 1, until: 0 },
      { kind: 'until-past-end', step: 1, until: 5 },
    ]);
  });

  it('words every new warning without an em dash', () => {
    const ws: LessonWarning[] = [
      { kind: 'target-missing', step: 0, id: 'q', by: 'callout' },
      { kind: 'target-inside-chip', step: 0, id: 'u1/q', by: 'narration' },
      { kind: 'narration-no-part', step: 0 },
      { kind: 'until-before-step', step: 2, until: 0 },
      { kind: 'until-past-end', step: 0, until: 6 },
    ];
    expect(ws.map(warningText)).toEqual([
      'A callout points at q, which is no longer on the board',
      'The narration points at u1/q inside a chip; point at the chip instead',
      'Narration shows as a callout but names no part',
      'A note ends at step 1, before its own step',
      'A note lasts until step 7, past the last step',
    ]);
  });
});
