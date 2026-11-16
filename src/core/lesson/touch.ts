import type { Lesson, LessonStep } from '../model/types';
import { firingOrder, type LessonBoardView } from './plan';

/** `input`: a switch a row sets to a new value. Badges show only some reasons. */
export type TouchReason = 'input' | 'highlight' | 'callout' | 'narration';

export interface StepTouch {
  part: string;
  reasons: TouchReason[];
}

export interface TouchIndex {
  /** Per step, its parts in first-touch order. */
  byStep: StepTouch[][];
  /** Per part, the steps touching it, ascending; a part no step touches is absent. */
  byPart: ReadonlyMap<string, number[]>;
}

/**
 * Which parts each step touches. A row counts only the inputs it moves from
 * the value an earlier row left; before any row the saved switch values are
 * unknown here, so the first row touches every input it sets.
 */
export function touchIndex(lesson: Lesson, board: LessonBoardView): TouchIndex {
  const last = new Map<string, number>();
  const byPart = new Map<string, number[]>();
  const byStep = lesson.steps.map((step, i) => {
    const touches = new Map<string, TouchReason[]>();
    const add = (part: string, reason: TouchReason): void => {
      const reasons = touches.get(part);
      if (!reasons) touches.set(part, [reason]);
      else if (!reasons.includes(reason)) reasons.push(reason);
    };
    for (const part of movedInputs(step, board, last)) add(part, 'input');
    for (const a of step.actions)
      if (a.kind === 'highlight') for (const id of a.components) add(id, 'highlight');
    for (const a of step.annots ?? []) if (a.kind === 'callout') add(a.part, 'callout');
    if (step.narr?.at === 'callout' && step.narr.part) add(step.narr.part, 'narration');
    for (const part of touches.keys()) {
      const steps = byPart.get(part);
      if (steps) steps.push(i);
      else byPart.set(part, [i]);
    }
    return [...touches].map(([part, reasons]) => ({ part, reasons }));
  });
  return { byStep, byPart };
}

/** Inputs a step's rows move, updating `last` as the board would. */
function movedInputs(
  step: LessonStep,
  board: LessonBoardView,
  last: Map<string, number>,
): string[] {
  const seq = board.sequence;
  if (!seq) return [];
  const moved: string[] = [];
  for (const a of firingOrder(step)) {
    if (a.kind !== 'row') continue;
    const row = seq.rows[a.index];
    if (!row) continue;
    seq.inputs.forEach((id, j) => {
      const value = row.set[j];
      if (value === undefined || last.get(id) === value) return;
      last.set(id, value);
      if (!moved.includes(id)) moved.push(id);
    });
  }
  return moved;
}
