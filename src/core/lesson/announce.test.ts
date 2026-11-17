import { describe, expect, it } from 'vitest';
import type { BoardSequence, LessonAction, LessonStep } from '../model/types';
import { announceStep, pulseSkippedText, rowMissingText, rowWhileOffText } from './announce';

const sequence: BoardSequence = {
  inputs: ['a'],
  expect: [],
  rows: [{ set: [0] }, { set: [1], note: '7 + 1 overflows' }],
  advance: { mode: 'key' },
  hideExpected: true,
};
const step = (kind: LessonStep['kind'], ...actions: LessonAction[]): LessonStep => ({
  kind,
  prose: '',
  actions,
});

describe('announceStep', () => {
  it('lists every action but the tab, in action order', () => {
    const lines = announceStep(
      step(
        'narrate',
        { kind: 'power', on: true },
        { kind: 'tab', tab: 'checks' },
        { kind: 'timing', mode: 'datasheet' },
        { kind: 'highlight', components: ['a', 'b', 'c'] },
        { kind: 'row', index: 0, when: 'open' },
        { kind: 'timing', mode: 'ideal' },
        { kind: 'highlight', components: ['a'] },
        { kind: 'power', on: false },
      ),
      sequence,
    );
    expect(lines).toEqual([
      'Powers on',
      'Switches to datasheet timing (restarts the sim)',
      'Highlights 3 parts',
      'Applies sequence row 1',
      'Switches to ideal timing (restarts the sim)',
      'Highlights 1 part',
      'Powers off',
    ]);
  });

  it("says when a predict step holds its row for the reveal, with the row's note", () => {
    expect(
      announceStep(step('predict', { kind: 'row', index: 1, when: 'reveal' }), sequence),
    ).toEqual(['Applies sequence row 2 on reveal: 7 + 1 overflows']);
  });

  it('announces a reveal row on a narrate step as applied on open', () => {
    expect(
      announceStep(step('narrate', { kind: 'row', index: 1, when: 'reveal' }), sequence),
    ).toEqual(['Applies sequence row 2: 7 + 1 overflows']);
  });

  it('works without a sequence or with a row past its end', () => {
    expect(announceStep(step('narrate', { kind: 'row', index: 1, when: 'open' }))).toEqual([
      'Applies sequence row 2',
    ]);
    expect(
      announceStep(step('narrate', { kind: 'row', index: 5, when: 'open' }), sequence),
    ).toEqual(['Applies sequence row 6']);
  });

  it('announces a pulse, and a held one as on reveal', () => {
    const open: LessonAction = { kind: 'pulse', clock: 'clk', when: 'open' };
    const held: LessonAction = { kind: 'pulse', clock: 'clk', when: 'reveal' };
    expect(announceStep(step('predict', open, held))).toEqual([
      'Clocks clk once',
      'Clocks clk once on reveal',
    ]);
  });

  it('is empty for a step with only a tab', () => {
    expect(announceStep(step('narrate', { kind: 'tab', tab: 'sequence' }))).toEqual([]);
  });
});

describe('rowMissingText', () => {
  it('numbers the row from 1', () => {
    expect(rowMissingText(8)).toBe('Row 9 is missing from the sequence: skipped');
  });
});

describe('rowWhileOffText', () => {
  it('numbers the row from 1', () => {
    expect(rowWhileOffText(0)).toBe('Row 1 skipped: the board is off');
  });
});

describe('pulseSkippedText', () => {
  it('says why', () => {
    expect(pulseSkippedText('clk', 'off')).toBe('Clock pulse skipped: the board is off');
    expect(pulseSkippedText('u1', 'missing')).toBe(
      'Clock pulse skipped: u1 is not a clock on this board',
    );
  });
});
