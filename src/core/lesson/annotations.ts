import type { Lesson, LessonAnnotation, LessonStep } from '../model/types';

/** The last step an annotation owned by step `own` shows on, clamped to the lesson. */
export function annotationEnd(a: LessonAnnotation, own: number, stepCount: number): number {
  return Math.max(own, Math.min(stepCount - 1, a.until ?? own));
}

export interface VisibleAnnotation {
  annotation: LessonAnnotation;
  /** The owning step. */
  step: number;
}

/** Annotations showing at step k, in step then list order. */
export function visibleAnnotations(lesson: Lesson, k: number): VisibleAnnotation[] {
  const out: VisibleAnnotation[] = [];
  lesson.steps.forEach((step, own) => {
    if (own > k) return;
    for (const annotation of step.annots ?? [])
      if (k <= annotationEnd(annotation, own, lesson.steps.length))
        out.push({ annotation, step: own });
  });
  return out;
}

/** `until` as stored: absent when the annotation ends on its own step. */
export function withUntil(a: LessonAnnotation, own: number, until: number): LessonAnnotation {
  if (until > own) return a.until === until ? a : { ...a, until };
  if (a.until === undefined) return a;
  const copy = { ...a };
  delete copy.until;
  return copy;
}

/**
 * Every `until` re-pointed after a step edit, in the input's step order.
 * `newIndexOf(old)` is where old step `old` lands; a deleted step maps to the
 * step before it. An annotation never ends before its (moved) owner.
 */
export function remapUntils(
  steps: readonly LessonStep[],
  newIndexOf: (old: number) => number,
): LessonStep[] {
  return steps.map((step, own) => {
    const annots = step.annots;
    if (!annots?.some((a) => a.until !== undefined)) return step;
    const ownNew = newIndexOf(own);
    const next = annots.map((a) =>
      a.until === undefined ? a : withUntil(a, ownNew, newIndexOf(a.until)),
    );
    return next.every((a, i) => a === annots[i]) ? step : { ...step, annots: next };
  });
}

export const insertedAt =
  (at: number) =>
  (old: number): number =>
    old >= at ? old + 1 : old;

export const deletedAt =
  (i: number) =>
  (old: number): number =>
    old < i ? old : old - 1;

/** The new index of each old step after moving `from` so it ends up at `to`. */
export function movedTo(from: number, to: number) {
  return (old: number): number => {
    if (old === from) return to;
    if (from < to && old > from && old <= to) return old - 1;
    if (to < from && old >= to && old < from) return old + 1;
    return old;
  };
}

export function annotationIds(lesson: Lesson): Set<string> {
  const ids = new Set<string>();
  for (const step of lesson.steps) for (const a of step.annots ?? []) ids.add(a.id);
  return ids;
}

/** `n1`, `n2`... the first not in `taken`, which it joins. */
export function nextAnnotationId(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`n${n}`)) n++;
  const id = `n${n}`;
  taken.add(id);
  return id;
}

/** Sets an annotation's last step, clamped to its own step and the lesson. */
export function setAnnotationUntil(lesson: Lesson, own: number, id: string, until: number): Lesson {
  const step = lesson.steps[own];
  if (!step?.annots?.some((a) => a.id === id)) return lesson;
  const end = Math.max(own, Math.min(lesson.steps.length - 1, until));
  const annots = step.annots.map((a) => (a.id === id ? withUntil(a, own, end) : a));
  return {
    ...lesson,
    steps: lesson.steps.map((s, k) => (k === own ? { ...step, annots } : s)),
  };
}
