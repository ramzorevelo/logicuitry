import { describe, expect, it } from 'vitest';
import type { Lesson, LessonAction, LessonStep } from '../model/types';
import {
  advanceOps,
  hasReveal,
  pageDownAction,
  replayPlan,
  stepHighlight,
  stepOps,
  stepTab,
} from './plan';

const narrate = (...actions: LessonAction[]): LessonStep => ({
  kind: 'narrate',
  prose: '',
  actions,
});
const predict = (...actions: LessonAction[]): LessonStep => ({
  kind: 'predict',
  prose: '?',
  actions,
  answer: 'yes',
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

const row = (index: number, when: 'open' | 'reveal' = 'open'): LessonAction => ({
  kind: 'row',
  index,
  when,
});
const power = (on: boolean): LessonAction => ({ kind: 'power', on });
const highlight = (...components: string[]): LessonAction => ({ kind: 'highlight', components });

describe('hasReveal', () => {
  it('is true for every predict step and only those', () => {
    expect(hasReveal(predict())).toBe(true);
    expect(hasReveal(narrate())).toBe(false);
    expect(hasReveal({ kind: 'widget', prose: '', actions: [], widget: { id: 'w' } })).toBe(false);
  });
});

describe('stepOps', () => {
  it('keeps action order within a phase and drops highlight and tab', () => {
    const step = narrate(
      { kind: 'timing', mode: 'datasheet' },
      highlight('a'),
      power(true),
      { kind: 'tab', tab: 'waveform' },
      row(3),
    );
    expect(stepOps(step, 'open')).toEqual([
      { op: 'timing', mode: 'datasheet' },
      { op: 'power', on: true },
      { op: 'row', index: 3 },
    ]);
    expect(stepOps(step, 'reveal')).toEqual([]);
  });

  it('holds a reveal row back on a predict step', () => {
    const step = predict(power(true), row(1, 'reveal'), row(2));
    expect(stepOps(step, 'open')).toEqual([
      { op: 'power', on: true },
      { op: 'row', index: 2 },
    ]);
    expect(stepOps(step, 'reveal')).toEqual([{ op: 'row', index: 1 }]);
  });

  it('treats a reveal row on a narrate step as an open row', () => {
    const step = narrate(row(4, 'reveal'));
    expect(stepOps(step, 'open')).toEqual([{ op: 'row', index: 4 }]);
    expect(stepOps(step, 'reveal')).toEqual([]);
  });
});

describe('stepHighlight', () => {
  it('unions every highlight action of the step', () => {
    expect(stepHighlight(narrate(highlight('a', 'b'), highlight('b', 'c')))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(stepHighlight(narrate())).toEqual([]);
  });
});

describe('replayPlan', () => {
  const lesson = lessonOf(
    narrate(power(true), highlight('a'), { kind: 'tab', tab: 'waveform' }),
    predict(row(0), row(1, 'reveal'), { kind: 'timing', mode: 'datasheet' }),
    narrate(power(false), row(2, 'reveal'), highlight('b')),
    predict(power(true), row(3, 'reveal'), { kind: 'tab', tab: 'sequence' }),
    narrate(),
  );

  it('opens the first step on its own ops from the lesson start', () => {
    expect(replayPlan(lesson, 0, false)).toEqual({
      ops: [{ op: 'power', on: true }],
      highlight: ['a'],
      tab: 'waveform',
      dock: 'waveform',
    });
  });

  it("replays every earlier step's reveal, interleaving power, timing and rows in order", () => {
    expect(replayPlan(lesson, 3, false).ops).toEqual([
      { op: 'power', on: true },
      { op: 'row', index: 0 },
      { op: 'timing', mode: 'datasheet' },
      { op: 'row', index: 1 },
      { op: 'power', on: false },
      { op: 'row', index: 2 },
      { op: 'power', on: true },
    ]);
  });

  it("adds step k's own reveal ops only when revealed", () => {
    const shut = replayPlan(lesson, 1, false).ops;
    const open = replayPlan(lesson, 1, true).ops;
    expect(shut).toEqual([
      { op: 'power', on: true },
      { op: 'row', index: 0 },
      { op: 'timing', mode: 'datasheet' },
    ]);
    expect(open).toEqual([...shut, { op: 'row', index: 1 }]);
  });

  it('never carries a highlight to a later step', () => {
    expect(replayPlan(lesson, 1, true).highlight).toEqual([]);
    expect(replayPlan(lesson, 2, false).highlight).toEqual(['b']);
    expect(replayPlan(lesson, 3, false).highlight).toEqual([]);
  });

  it('carries the last tab opened, and leaves it undefined before any', () => {
    expect(replayPlan(lesson, 2, false).tab).toBe('waveform');
    expect(replayPlan(lesson, 3, false).tab).toBe('sequence');
    expect(replayPlan(lesson, 4, false).tab).toBe('sequence');
    expect(replayPlan(lessonOf(narrate(), narrate()), 1, false).tab).toBeUndefined();
  });

  it('keeps the dock tab an earlier step opened when a later one asks for Analyze', () => {
    const analyze = lessonOf(
      narrate({ kind: 'tab', tab: 'waveform' }),
      narrate({ kind: 'tab', tab: 'analyze' }),
      narrate({ kind: 'tab', tab: 'checks' }, { kind: 'tab', tab: 'analyze' }),
    );
    expect(replayPlan(analyze, 1, false)).toMatchObject({ tab: 'analyze', dock: 'waveform' });
    expect(replayPlan(analyze, 2, false)).toMatchObject({ tab: 'analyze', dock: 'checks' });
    expect(
      replayPlan(lessonOf(narrate({ kind: 'tab', tab: 'analyze' })), 0, false).dock,
    ).toBeUndefined();
  });
});

describe('advanceOps', () => {
  const lesson = lessonOf(predict(row(1, 'reveal')), narrate(power(true), row(2)));

  it("applies only the next step's open ops, skipping an unrevealed reveal", () => {
    expect(advanceOps(lesson, 0)).toEqual([
      { op: 'power', on: true },
      { op: 'row', index: 2 },
    ]);
  });

  it('is empty past the last step', () => {
    expect(advanceOps(lesson, 1)).toEqual([]);
  });
});

describe('pageDownAction', () => {
  const lesson = lessonOf(narrate(), predict(), narrate(), predict());

  it.each([
    [0, false, 'next'],
    [0, true, 'next'],
    [1, false, 'reveal'],
    [1, true, 'next'],
    [2, false, 'next'],
    [3, false, 'reveal'],
    [3, true, 'none'],
  ] as const)('step %i, revealed %s -> %s', (k, revealed, action) => {
    expect(pageDownAction(lesson, k, revealed)).toBe(action);
  });

  it('does nothing on the last narrate step', () => {
    expect(pageDownAction(lessonOf(narrate()), 0, false)).toBe('none');
  });

  it('does nothing on a step that is not there', () => {
    expect(pageDownAction(lesson, 9, false)).toBe('none');
  });
});

describe('stepTab', () => {
  it('is the last tab action, or none', () => {
    expect(stepTab(narrate())).toBeUndefined();
    expect(stepTab(narrate({ kind: 'tab', tab: 'checks' }, { kind: 'tab', tab: 'sequence' }))).toBe(
      'sequence',
    );
  });
});
