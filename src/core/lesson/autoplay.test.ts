import { describe, expect, it } from 'vitest';
import type { Lesson, LessonStep } from '../model/types';
import {
  AUTOPLAY_MIN_SECONDS,
  autoplayMove,
  autoplayPhase,
  autoplaySeconds,
  wordCount,
} from './autoplay';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const narrate = (prose: string, extra: Partial<LessonStep> = {}): LessonStep => ({
  kind: 'narrate',
  prose,
  actions: [],
  ...extra,
});
const predict = (extra: Partial<LessonStep> = {}): LessonStep => ({
  kind: 'predict',
  prose: words(28),
  actions: [],
  choices: [{ text: 'Yes', right: true }, { text: 'No' }],
  answer: words(56),
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

describe('wordCount', () => {
  it('counts words, not markdown marks', () => {
    expect(wordCount('The **overflow** flag `V` is set.')).toBe(6);
    expect(wordCount('  ** -- **  ')).toBe(0);
  });
});

describe('autoplaySeconds', () => {
  it('reads at 280 words a minute', () => {
    expect(autoplaySeconds(narrate(words(140)), 'question')).toBe(30);
  });

  it('never drops below the floor', () => {
    expect(autoplaySeconds(narrate('Hi.'), 'question')).toBe(AUTOPLAY_MIN_SECONDS);
  });

  it('adds time to look at the board when the step changes it', () => {
    const plain = narrate(words(70));
    const rows = narrate(words(70), {
      actions: [{ kind: 'row', index: 0, set: [1], when: 'open' }],
    });
    const highlightOnly = narrate(words(70), {
      actions: [{ kind: 'highlight', components: ['a'] }],
    });
    expect(autoplaySeconds(plain, 'question')).toBe(15);
    expect(autoplaySeconds(rows, 'question')).toBe(17);
    expect(autoplaySeconds(highlightOnly, 'question')).toBe(15);
  });

  it('times a predict question and its answer separately', () => {
    const step = predict({ actions: [{ kind: 'row', index: 1, set: [1], when: 'reveal' }] });
    // 28 + 2 choice words -> 6 s; the reveal row only counts on the answer.
    expect(autoplaySeconds(step, 'question')).toBe(6);
    // "Yes" + 56 words -> 12.2 s, plus the board.
    expect(autoplaySeconds(step, 'answer')).toBe(14);
  });

  it('an authored time beats reading time, and a pace beats both', () => {
    const step = narrate(words(140), { seconds: 9 });
    expect(autoplaySeconds(step, 'question')).toBe(9);
    expect(autoplaySeconds(step, 'answer')).toBe(9);
    expect(autoplaySeconds(step, 'question', 5)).toBe(5);
  });
});

describe('autoplayMove', () => {
  const lesson = lessonOf(narrate('a'), predict(), narrate('c'), predict());

  it('moves on from a narrate step', () => {
    expect(autoplayMove(lesson, 0, false, false)).toBe('next');
  });

  it('reveals a question itself unless told to wait', () => {
    expect(autoplayMove(lesson, 1, false, false)).toBe('reveal');
    expect(autoplayMove(lesson, 1, false, true)).toBe('hold');
    expect(autoplayMove(lesson, 1, true, true)).toBe('next');
  });

  it('ends after the last step, answer included', () => {
    expect(autoplayMove(lesson, 3, false, false)).toBe('reveal');
    expect(autoplayMove(lesson, 3, true, false)).toBe('end');
    expect(autoplayMove(lessonOf(narrate('x')), 0, false, false)).toBe('end');
  });

  it('phase follows the reveal on a predict step only', () => {
    expect(autoplayPhase(predict(), false)).toBe('question');
    expect(autoplayPhase(predict(), true)).toBe('answer');
    expect(autoplayPhase(narrate('x'), true)).toBe('question');
  });
});
