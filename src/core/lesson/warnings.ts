import type { Lesson, LessonAction, LessonStep } from '../model/types';
import { firingOrder, type LessonBoardView } from './plan';

/** Steps and row indexes are 0-based here; `warningText` shows them 1-based. */
export type LessonWarning =
  | { kind: 'row-past-end'; step: number; index: number }
  | { kind: 'row-changed'; step: number; index: number }
  | { kind: 'row-while-off'; step: number; index: number }
  | { kind: 'no-sequence'; step: number; index: number }
  | { kind: 'highlight-empty'; step: number }
  | { kind: 'missing-component'; step: number; id: string }
  | { kind: 'inside-chip'; step: number; id: string }
  | { kind: 'nothing-to-reveal'; step: number }
  | { kind: 'target-missing'; step: number; id: string; by: PointerRole }
  | { kind: 'target-inside-chip'; step: number; id: string; by: PointerRole }
  | { kind: 'narration-no-part'; step: number }
  | { kind: 'until-before-step'; step: number; until: number }
  | { kind: 'until-past-end'; step: number; until: number };

/** What points at a part on the board. */
export type PointerRole = 'callout' | 'narration';

const sameValues = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function rowWarnings(
  step: number,
  action: Extract<LessonAction, { kind: 'row' }>,
  board: LessonBoardView,
  powered: boolean,
): LessonWarning[] {
  const { index } = action;
  const out: LessonWarning[] = [];
  const rows = board.sequence?.rows;
  if (!rows) out.push({ kind: 'no-sequence', step, index });
  else if (index >= rows.length) out.push({ kind: 'row-past-end', step, index });
  else if (action.set && !sameValues(action.set, rows[index]!.set))
    out.push({ kind: 'row-changed', step, index });
  if (!powered) out.push({ kind: 'row-while-off', step, index });
  return out;
}

function highlightWarnings(
  step: number,
  components: readonly string[],
  board: LessonBoardView,
): LessonWarning[] {
  const out: LessonWarning[] = [];
  if (components.length === 0) out.push({ kind: 'highlight-empty', step });
  for (const id of components) {
    if (id.includes('/')) out.push({ kind: 'inside-chip', step, id });
    else if (!board.componentIds.has(id)) out.push({ kind: 'missing-component', step, id });
  }
  return out;
}

function nothingToReveal(step: LessonStep): boolean {
  if (step.kind !== 'predict') return false;
  const answered = (step.answer ?? '').trim() !== '';
  return !answered && !(step.choices ?? []).some((c) => c.right);
}

function targetWarnings(
  step: number,
  id: string,
  by: PointerRole,
  board: LessonBoardView,
): LessonWarning[] {
  if (id.includes('/')) return [{ kind: 'target-inside-chip', step, id, by }];
  if (!board.componentIds.has(id)) return [{ kind: 'target-missing', step, id, by }];
  return [];
}

function boardNoteWarnings(
  i: number,
  step: LessonStep,
  stepCount: number,
  board: LessonBoardView,
): LessonWarning[] {
  const out: LessonWarning[] = [];
  const narr = step.narr;
  if (narr?.at === 'callout') {
    if (narr.part) out.push(...targetWarnings(i, narr.part, 'narration', board));
    else out.push({ kind: 'narration-no-part', step: i });
  }
  for (const a of step.annots ?? []) {
    if (a.kind === 'callout') out.push(...targetWarnings(i, a.part, 'callout', board));
    if (a.until === undefined) continue;
    if (a.until < i) out.push({ kind: 'until-before-step', step: i, until: a.until });
    else if (a.until >= stepCount) out.push({ kind: 'until-past-end', step: i, until: a.until });
  }
  return out;
}

/** Flags for the editor and the runner; a lesson with warnings still plays. */
export function lessonWarnings(lesson: Lesson, board: LessonBoardView): LessonWarning[] {
  const out: LessonWarning[] = [];
  let powered = false;
  lesson.steps.forEach((step, i) => {
    for (const action of firingOrder(step)) {
      if (action.kind === 'power') powered = action.on;
      else if (action.kind === 'row') out.push(...rowWarnings(i, action, board, powered));
      else if (action.kind === 'highlight')
        out.push(...highlightWarnings(i, action.components, board));
    }
    if (nothingToReveal(step)) out.push({ kind: 'nothing-to-reveal', step: i });
    out.push(...boardNoteWarnings(i, step, lesson.steps.length, board));
  });
  return out;
}

/** User-visible text, with 1-based row numbers. */
export function warningText(w: LessonWarning): string {
  switch (w.kind) {
    case 'row-past-end':
      return `Row ${w.index + 1} is past the end of the board's sequence`;
    case 'row-changed':
      return `Row ${w.index + 1} changed since this lesson was written`;
    case 'row-while-off':
      return `Row ${w.index + 1} is applied while the board is off`;
    case 'no-sequence':
      return `The board has no sequence for row ${w.index + 1}`;
    case 'highlight-empty':
      return 'Highlight names no parts';
    case 'missing-component':
      return `Part ${w.id} is no longer on the board`;
    case 'inside-chip':
      return `Part ${w.id} is inside a chip; highlight the chip instead`;
    case 'nothing-to-reveal':
      return 'Nothing to reveal: add an answer or mark a right choice';
    case 'target-missing':
      return `${pointerName(w.by)} points at ${w.id}, which is no longer on the board`;
    case 'target-inside-chip':
      return `${pointerName(w.by)} points at ${w.id} inside a chip; point at the chip instead`;
    case 'narration-no-part':
      return 'Narration shows as a callout but names no part';
    case 'until-before-step':
      return `A note ends at step ${w.until + 1}, before its own step`;
    case 'until-past-end':
      return `A note lasts until step ${w.until + 1}, past the last step`;
  }
}

const pointerName = (by: PointerRole): string => (by === 'callout' ? 'A callout' : 'The narration');
