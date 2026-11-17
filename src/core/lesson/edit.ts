import type {
  Lesson,
  LessonAction,
  LessonDockTab,
  LessonStep,
  SequenceRow,
  TimingMode,
} from '../model/types';
import type { LessonWarning } from './warnings';
import { canHoldBack } from './plan';
import {
  annotationIds,
  deletedAt,
  insertedAt,
  movedTo,
  nextAnnotationId,
  remapUntils,
} from './annotations';

// Every edit returns a new lesson and never mutates its input, so a snapshot is an undo entry.

export type EditableKind = 'narrate' | 'predict';

export function newStep(kind: EditableKind): LessonStep {
  return kind === 'predict'
    ? { kind, prose: '', actions: [], choices: [], answer: '' }
    : { kind, prose: '', actions: [] };
}

/** Lower-case words joined by hyphens; never empty. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

/** `base`, or `base-2`, `base-3`... whichever is free first. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function newLesson(boardId: string, takenIds: ReadonlySet<string>): Lesson {
  const title = 'Untitled lesson';
  return {
    format: 'lcir.lesson',
    formatVersion: 5,
    id: uniqueId(slugify(title), takenIds),
    title,
    workbench: 'circuit',
    board: boardId,
    steps: [newStep('narrate')],
  };
}

const withSteps = (lesson: Lesson, steps: LessonStep[]): Lesson => ({ ...lesson, steps });

export function updateStep(lesson: Lesson, i: number, fn: (s: LessonStep) => LessonStep): Lesson {
  const step = lesson.steps[i];
  if (!step) return lesson;
  return withSteps(
    lesson,
    lesson.steps.map((s, k) => (k === i ? fn(step) : s)),
  );
}

/** Annotation `until`s keep pointing at the same steps; the inserted step's own are left as given. */
export function insertStep(lesson: Lesson, at: number, step: LessonStep): Lesson {
  const where = Math.max(0, Math.min(at, lesson.steps.length));
  const steps = remapUntils(lesson.steps, insertedAt(where));
  steps.splice(where, 0, step);
  return withSteps(lesson, steps);
}

/** Null when it is the last step: a lesson keeps at least one. */
export function deleteStep(lesson: Lesson, i: number): Lesson | null {
  if (lesson.steps.length <= 1 || !lesson.steps[i]) return null;
  return withSteps(
    lesson,
    remapUntils(lesson.steps, deletedAt(i)).filter((_, k) => k !== i),
  );
}

/**
 * The copy gets fresh annotation ids and keeps only the annotations that
 * ended on the original: the others already show on the copy's step.
 */
export function duplicateStep(lesson: Lesson, i: number): Lesson {
  const step = lesson.steps[i];
  if (!step) return lesson;
  const copy = structuredClone(step);
  if (copy.annots) {
    const taken = annotationIds(lesson);
    copy.annots = copy.annots
      .filter((a) => a.until === undefined || a.until <= i)
      .map((a) => {
        const fresh = { ...a, id: nextAnnotationId(taken) };
        delete fresh.until;
        return fresh;
      });
    if (copy.annots.length === 0) delete copy.annots;
  }
  return insertStep(lesson, i + 1, copy);
}

/** `to` is the index the step ends up at. */
export function moveStep(lesson: Lesson, from: number, to: number): Lesson {
  const n = lesson.steps.length;
  if (from === to || from < 0 || from >= n || to < 0 || to >= n) return lesson;
  const steps = remapUntils(lesson.steps, movedTo(from, to));
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved!);
  return withSteps(lesson, steps);
}

/**
 * Narrate has no reveal, so its held-back rows and pulses fire on open and its
 * choices, answer and revealFreely go. `heldRows` counts the actions that moved, for the notice.
 */
export function setStepKind(
  step: LessonStep,
  kind: EditableKind,
): { step: LessonStep; heldRows: number } {
  if (step.kind === kind) return { step, heldRows: 0 };
  if (kind === 'predict')
    return {
      step: { ...step, kind, choices: step.choices ?? [], answer: step.answer ?? '' },
      heldRows: 0,
    };
  let heldRows = 0;
  const actions = step.actions.map((a): LessonAction => {
    if (!canHoldBack(a) || a.when !== 'reveal') return a;
    heldRows++;
    return { ...a, when: 'open' };
  });
  const { choices: _c, answer: _a, revealFreely: _f, ...rest } = step;
  void _c;
  void _a;
  void _f;
  return { step: { ...rest, kind, actions }, heldRows };
}

/** The row's values ride along so a later edit of that row is caught. */
export function rowAction(
  index: number,
  rows: readonly SequenceRow[],
  when: 'open' | 'reveal',
): LessonAction {
  const row = rows[index];
  return { kind: 'row', index, ...(row ? { set: [...row.set] } : {}), when };
}

export type NewActionKind = LessonAction['kind'];

/**
 * A fresh action of `kind`: a row is the one after the last row applied before
 * it (clamped to the sequence), held back on a predict step.
 */
export function defaultAction(
  kind: NewActionKind,
  step: LessonStep,
  rows: readonly SequenceRow[],
  lastRow: number,
  clockIds: readonly string[] = [],
): LessonAction {
  switch (kind) {
    case 'row':
      return rowAction(
        Math.max(0, Math.min(rows.length - 1, lastRow + 1)),
        rows,
        step.kind === 'predict' ? 'reveal' : 'open',
      );
    case 'power':
      return { kind, on: true };
    case 'timing':
      return { kind, mode: 'datasheet' satisfies TimingMode };
    case 'highlight':
      return { kind, components: [] };
    case 'tab':
      return { kind, tab: 'waveform' satisfies LessonDockTab };
    case 'pulse':
      return { kind, clock: clockIds[0] ?? '', when: step.kind === 'predict' ? 'reveal' : 'open' };
  }
}

/** The index of the last row applied by steps 0 to k, step k included; -1 for none. */
export function lastRowBefore(lesson: Lesson, k: number): number {
  let last = -1;
  for (const step of lesson.steps.slice(0, k + 1))
    for (const a of step.actions) if (a.kind === 'row') last = a.index;
  return last;
}

export function moveAction(step: LessonStep, from: number, to: number): LessonStep {
  const n = step.actions.length;
  if (from === to || from < 0 || from >= n || to < 0 || to >= n) return step;
  const actions = step.actions.slice();
  const [moved] = actions.splice(from, 1);
  actions.splice(to, 0, moved!);
  return { ...step, actions };
}

export function removeAction(step: LessonStep, i: number): LessonStep {
  return { ...step, actions: step.actions.filter((_, k) => k !== i) };
}

export function replaceAction(step: LessonStep, i: number, action: LessonAction): LessonStep {
  return { ...step, actions: step.actions.map((a, k) => (k === i ? action : a)) };
}

/**
 * Toggles ids in a highlight action as one: all removed when every one is
 * already in, else the missing ones appended. Picking order is kept.
 */
export function toggleHighlight(components: readonly string[], ids: readonly string[]): string[] {
  const all = ids.length > 0 && ids.every((id) => components.includes(id));
  if (all) return components.filter((c) => !ids.includes(c));
  return [...components, ...ids.filter((id) => !components.includes(id))];
}

const sameRow = (a: SequenceRow, b: SequenceRow): boolean =>
  a === b ||
  (a.set.length === b.set.length &&
    a.set.every((v, i) => v === b.set[i]) &&
    (a.note ?? '') === (b.note ?? '') &&
    JSON.stringify(a.expect ?? []) === JSON.stringify(b.expect ?? []));

/**
 * A single row inserted or deleted between two versions of a sequence, found
 * by the first row that differs; anything else (an edit, a reorder, several
 * rows at once) is not a renumbering.
 */
export function rowShift(
  before: readonly SequenceRow[],
  after: readonly SequenceRow[],
): { at: number; delta: 1 | -1 } | null {
  const delta = after.length - before.length;
  if (delta !== 1 && delta !== -1) return null;
  const longer = delta === 1 ? after : before;
  const shorter = delta === 1 ? before : after;
  let at = 0;
  while (at < shorter.length && sameRow(shorter[at]!, longer[at]!)) at++;
  for (let i = at; i < shorter.length; i++) if (!sameRow(shorter[i]!, longer[i + 1]!)) return null;
  return { at, delta };
}

/**
 * Row references after a sequence row insert or delete. A reference to the
 * deleted row keeps its index, so its saved values flag it as changed.
 */
export function renumberRows(lesson: Lesson, shift: { at: number; delta: 1 | -1 }): Lesson {
  let touched = false;
  const steps = lesson.steps.map((step) => {
    let changed = false;
    const actions = step.actions.map((a): LessonAction => {
      if (a.kind !== 'row') return a;
      const moves = shift.delta === 1 ? a.index >= shift.at : a.index > shift.at;
      if (!moves) return a;
      changed = true;
      return { ...a, index: a.index + shift.delta };
    });
    if (!changed) return step;
    touched = true;
    return { ...step, actions };
  });
  return touched ? withSteps(lesson, steps) : lesson;
}

/** 1-based numbers of the steps that carry at least one warning, ascending. */
export function flaggedSteps(warnings: readonly LessonWarning[]): number[] {
  return [...new Set(warnings.map((w) => w.step + 1))].sort((a, b) => a - b);
}

export function playWarningText(flagged: readonly number[]): string {
  const n = flagged.length;
  return `Playing with ${n} flagged ${n === 1 ? 'step' : 'steps'} (${flagged.join(', ')}): a missing row is skipped and announced as missing`;
}
