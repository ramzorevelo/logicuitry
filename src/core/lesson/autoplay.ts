import type { Lesson, LessonStep } from '../model/types';
import { actionPhase, hasReveal } from './plan';

/** A little above the ~240 wpm adult average: the class reads along while the teacher talks. */
export const AUTOPLAY_WPM = 280;
export const AUTOPLAY_MIN_SECONDS = 4;
/** Time to look at the board after a step sets inputs, powers or retimes it. */
export const AUTOPLAY_BOARD_SECONDS = 2;
export const AUTOPLAY_MAX_SECONDS = 600;

/** `question` is a whole narrate step, or a predict step before its reveal. */
export type AutoplayPhase = 'question' | 'answer';

/** What the countdown does when it runs out; `hold` means there is no countdown at all. */
export type AutoplayMove = 'reveal' | 'next' | 'end' | 'hold';

export function wordCount(markdown: string): number {
  return markdown
    .replace(/[*_`#>[\]()]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const changesBoard = (step: LessonStep, phase: AutoplayPhase): boolean =>
  step.actions.some(
    (a) =>
      a.kind !== 'highlight' &&
      a.kind !== 'tab' &&
      (actionPhase(step, a) === 'reveal') === (phase === 'answer'),
  );

function readText(step: LessonStep, phase: AutoplayPhase): string {
  if (phase === 'answer') {
    const right = step.choices?.find((c) => c.right)?.text ?? '';
    return `${right} ${step.answer ?? ''}`;
  }
  const choices = (step.choices ?? []).map((c) => c.text).join(' ');
  return `${step.headline ?? ''} ${step.prose} ${choices}`;
}

/**
 * Seconds a step stays up in autoplay. A pace override wins, then the step's
 * own `seconds`, then reading time. A predict step spends its time once on the
 * question and again on the answer.
 */
export function autoplaySeconds(step: LessonStep, phase: AutoplayPhase, pace = 0): number {
  if (pace > 0) return pace;
  if (step.seconds !== undefined) {
    return Math.min(AUTOPLAY_MAX_SECONDS, Math.max(1, step.seconds));
  }
  const reading = (wordCount(readText(step, phase)) * 60) / AUTOPLAY_WPM;
  const board = changesBoard(step, phase) ? AUTOPLAY_BOARD_SECONDS : 0;
  return Math.max(AUTOPLAY_MIN_SECONDS, Math.round(reading + board));
}

export function autoplayPhase(step: LessonStep, revealed: boolean): AutoplayPhase {
  return hasReveal(step) && revealed ? 'answer' : 'question';
}

export function autoplayMove(
  lesson: Lesson,
  step: number,
  revealed: boolean,
  waitOnQuestions: boolean,
): AutoplayMove {
  const current = lesson.steps[step];
  if (!current) return 'end';
  if (hasReveal(current) && !revealed) return waitOnQuestions ? 'hold' : 'reveal';
  return step < lesson.steps.length - 1 ? 'next' : 'end';
}
