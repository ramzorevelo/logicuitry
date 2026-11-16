import { describe, expect, it } from 'vitest';
import type { Lesson, LessonAction, LessonStep, SequenceRow } from '../model/types';
import {
  defaultAction,
  deleteStep,
  duplicateStep,
  flaggedSteps,
  insertStep,
  lastRowBefore,
  moveAction,
  moveStep,
  newLesson,
  newStep,
  playWarningText,
  removeAction,
  renumberRows,
  rowAction,
  rowShift,
  setStepKind,
  slugify,
  toggleHighlight,
  uniqueId,
  updateStep,
} from './edit';

const narrate = (prose: string, ...actions: LessonAction[]): LessonStep => ({
  kind: 'narrate',
  prose,
  actions,
});
const lessonOf = (...steps: LessonStep[]): Lesson => ({
  format: 'lcir.lesson',
  formatVersion: 4,
  id: 'l',
  title: 'L',
  workbench: 'circuit',
  board: 'b',
  steps,
});
const rows: SequenceRow[] = [{ set: [0, 0] }, { set: [1, 0] }, { set: [1, 1], note: 'both' }];
const proseOf = (l: Lesson) => l.steps.map((s) => s.prose);

describe('ids and names', () => {
  it('slugifies a title, never to an empty string', () => {
    expect(slugify('ALU flags: when is V set?')).toBe('alu-flags-when-is-v-set');
    expect(slugify('  ---  ')).toBe('untitled');
  });

  it('picks the first free id', () => {
    expect(uniqueId('a', new Set())).toBe('a');
    expect(uniqueId('a', new Set(['a', 'a-2']))).toBe('a-3');
  });

  it('a new lesson names its board and has one narrate step', () => {
    const l = newLesson('board-1', new Set(['untitled-lesson']));
    expect(l.board).toBe('board-1');
    expect(l.id).toBe('untitled-lesson-2');
    expect(l.steps).toEqual([newStep('narrate')]);
  });
});

describe('step list edits', () => {
  const base = lessonOf(narrate('a'), narrate('b'), narrate('c'));

  it('never mutates the lesson it was given', () => {
    const frozen = structuredClone(base);
    insertStep(base, 1, newStep('predict'));
    deleteStep(base, 0);
    duplicateStep(base, 0);
    moveStep(base, 0, 2);
    updateStep(base, 1, (s) => ({ ...s, prose: 'x' }));
    expect(base).toEqual(frozen);
  });

  it('inserts after the selection', () => {
    expect(proseOf(insertStep(base, 2, narrate('new')))).toEqual(['a', 'b', 'new', 'c']);
  });

  it('keeps at least one step', () => {
    expect(deleteStep(lessonOf(narrate('only')), 0)).toBeNull();
    expect(proseOf(deleteStep(base, 1)!)).toEqual(['a', 'c']);
  });

  it('duplicates a deep copy right after the original', () => {
    const src = lessonOf(narrate('a', { kind: 'highlight', components: ['x'] }));
    const dup = duplicateStep(src, 0);
    expect(dup.steps).toHaveLength(2);
    expect(dup.steps[1]).toEqual(dup.steps[0]);
    expect(dup.steps[1]!.actions).not.toBe(dup.steps[0]!.actions);
  });

  it('moves a step to its target index and ignores out-of-range moves', () => {
    expect(proseOf(moveStep(base, 0, 2))).toEqual(['b', 'c', 'a']);
    expect(proseOf(moveStep(base, 2, 0))).toEqual(['c', 'a', 'b']);
    expect(moveStep(base, 0, 3)).toBe(base);
    expect(moveStep(base, -1, 0)).toBe(base);
  });
});

describe('setStepKind', () => {
  it('turns held-back rows into on-open rows on narrate and drops the answer', () => {
    const predict: LessonStep = {
      kind: 'predict',
      prose: 'q',
      actions: [
        { kind: 'row', index: 1, when: 'reveal' },
        { kind: 'row', index: 2, when: 'open' },
      ],
      choices: [{ text: 'x', right: true }],
      answer: 'because',
    };
    const { step, heldRows } = setStepKind(predict, 'narrate');
    expect(heldRows).toBe(1);
    expect(step.kind).toBe('narrate');
    expect(step.actions.map((a) => a.kind === 'row' && a.when)).toEqual(['open', 'open']);
    expect(step.choices).toBeUndefined();
    expect(step.answer).toBeUndefined();
  });

  it('gives a predict step empty choices and answer', () => {
    const { step } = setStepKind(narrate('n'), 'predict');
    expect(step).toMatchObject({ kind: 'predict', choices: [], answer: '' });
  });
});

describe('actions', () => {
  it('a row action stores the row values', () => {
    expect(rowAction(2, rows, 'reveal')).toEqual({
      kind: 'row',
      index: 2,
      set: [1, 1],
      when: 'reveal',
    });
  });

  it('a new row follows the last applied one, clamped, and is held back on predict', () => {
    const p = newStep('predict');
    expect(defaultAction('row', p, rows, 0)).toMatchObject({ index: 1, when: 'reveal' });
    expect(defaultAction('row', newStep('narrate'), rows, 5)).toMatchObject({
      index: 2,
      when: 'open',
    });
    expect(defaultAction('highlight', p, rows, -1)).toEqual({ kind: 'highlight', components: [] });
  });

  it('finds the last row applied up to a step', () => {
    const l = lessonOf(
      narrate('a', { kind: 'row', index: 0, when: 'open' }),
      narrate('b'),
      narrate('c', { kind: 'row', index: 2, when: 'open' }),
    );
    expect(lastRowBefore(l, 1)).toBe(0);
    expect(lastRowBefore(l, 2)).toBe(2);
  });

  it('moves and removes actions', () => {
    const s = narrate('a', { kind: 'power', on: true }, { kind: 'tab', tab: 'checks' });
    expect(moveAction(s, 1, 0).actions.map((a) => a.kind)).toEqual(['tab', 'power']);
    expect(removeAction(s, 0).actions.map((a) => a.kind)).toEqual(['tab']);
  });

  it('toggles highlight ids as one', () => {
    expect(toggleHighlight(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
    expect(toggleHighlight(['a', 'b'], ['a'])).toEqual(['b']);
    expect(toggleHighlight(['a'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(toggleHighlight(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
  });
});

describe('row renumbering', () => {
  it('detects a single insert or delete', () => {
    const inserted = [rows[0]!, { set: [9, 9] }, rows[1]!, rows[2]!];
    expect(rowShift(rows, inserted)).toEqual({ at: 1, delta: 1 });
    expect(rowShift(rows, [rows[0]!, rows[2]!])).toEqual({ at: 1, delta: -1 });
    expect(rowShift(rows, [...rows, { set: [0, 1] }])).toEqual({ at: 3, delta: 1 });
  });

  it('matches rows by value, not identity', () => {
    const copy = rows.map((r) => structuredClone(r));
    expect(rowShift(rows, [{ set: [5, 5] }, ...copy])).toEqual({ at: 0, delta: 1 });
  });

  it('ignores edits and multi-row changes', () => {
    expect(rowShift(rows, rows)).toBeNull();
    expect(rowShift(rows, [rows[0]!, { set: [7, 7] }, rows[2]!])).toBeNull();
    expect(rowShift(rows, [rows[0]!])).toBeNull();
    expect(rowShift(rows, [{ set: [5] }, rows[0]!, rows[1]!, { set: [6] }])).toBeNull();
  });

  const refs = lessonOf(
    narrate(
      'a',
      { kind: 'row', index: 0, when: 'open' },
      { kind: 'row', index: 1, when: 'open' },
      { kind: 'row', index: 2, when: 'open' },
    ),
    narrate('b'),
  );
  const indexes = (l: Lesson) => l.steps[0]!.actions.map((a) => a.kind === 'row' && a.index);

  it('shifts references at or after an insert', () => {
    expect(indexes(renumberRows(refs, { at: 1, delta: 1 }))).toEqual([0, 2, 3]);
  });

  it('shifts references after a delete; the deleted row keeps its index', () => {
    expect(indexes(renumberRows(refs, { at: 1, delta: -1 }))).toEqual([0, 1, 1]);
  });

  it('returns the same lesson and steps when nothing moves', () => {
    expect(renumberRows(refs, { at: 3, delta: 1 })).toBe(refs);
    const moved = renumberRows(refs, { at: 0, delta: 1 });
    expect(moved.steps[1]).toBe(refs.steps[1]);
  });
});

describe('play warning', () => {
  it('lists each flagged step once, 1-based', () => {
    const flagged = flaggedSteps([
      { kind: 'highlight-empty', step: 4 },
      { kind: 'row-past-end', step: 1, index: 8 },
      { kind: 'nothing-to-reveal', step: 4 },
    ]);
    expect(flagged).toEqual([2, 5]);
    expect(playWarningText(flagged)).toBe(
      'Playing with 2 flagged steps (2, 5): a missing row is skipped and announced as missing',
    );
    expect(playWarningText([3])).toContain('1 flagged step (3)');
  });
});
