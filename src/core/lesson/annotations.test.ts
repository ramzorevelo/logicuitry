import { describe, expect, it } from 'vitest';
import type { Lesson, LessonAnnotation, LessonStep } from '../model/types';
import { setAnnotationUntil, visibleAnnotations } from './annotations';
import { deleteStep, duplicateStep, insertStep, moveStep, newStep, setStepKind } from './edit';

const note = (id: string, until?: number): LessonAnnotation => ({
  kind: 'text',
  id,
  at: { x: 0, y: 0 },
  text: id,
  ...(until === undefined ? {} : { until }),
});
const stepWith = (prose: string, ...annots: LessonAnnotation[]): LessonStep => ({
  kind: 'narrate',
  prose,
  actions: [],
  ...(annots.length ? { annots } : {}),
});
const lessonOf = (...steps: LessonStep[]): Lesson => ({
  format: 'lcir.lesson',
  formatVersion: 4,
  id: 'l',
  title: 'L',
  workbench: 'circuit',
  steps,
});
const ids = (l: Lesson, k: number) => visibleAnnotations(l, k).map((v) => v.annotation.id);
/** Each annotation as `id@own..end`, the shape the rules are stated in. */
const spans = (l: Lesson) =>
  l.steps.flatMap((s, own) => (s.annots ?? []).map((a) => `${a.id}@${own}..${a.until ?? own}`));

// Steps 0 to 4; a on 0 through 2, b on 1 only, c on 2 through 4.
const base = lessonOf(
  stepWith('s0', note('a', 2)),
  stepWith('s1', note('b')),
  stepWith('s2', note('c', 4)),
  stepWith('s3'),
  stepWith('s4'),
);

describe('visibleAnnotations', () => {
  it('shows each annotation from its own step through its until, in step then list order', () => {
    expect(ids(base, 0)).toEqual(['a']);
    expect(ids(base, 1)).toEqual(['a', 'b']);
    expect(ids(base, 2)).toEqual(['a', 'c']);
    expect(ids(base, 4)).toEqual(['c']);
    expect(visibleAnnotations(base, 2)[1]).toEqual({ annotation: note('c', 4), step: 2 });
  });

  it('clamps a stale until past the end or before its own step', () => {
    const l = lessonOf(stepWith('s0'), stepWith('s1', note('x', 9), note('y', 0)));
    expect(ids(l, 1)).toEqual(['x', 'y']);
    expect(ids(l, 0)).toEqual([]);
  });
});

describe('until across step edits', () => {
  it('insert before or inside a span keeps it on the same step', () => {
    expect(spans(insertStep(base, 1, newStep('narrate')))).toEqual(['a@0..3', 'b@2..2', 'c@3..5']);
    expect(spans(insertStep(base, 0, newStep('narrate')))).toEqual(['a@1..3', 'b@2..2', 'c@3..5']);
    expect(spans(insertStep(base, 5, newStep('narrate')))).toEqual(['a@0..2', 'b@1..1', 'c@2..4']);
  });

  it('deleting the until step moves it to the step before, never before its owner', () => {
    expect(spans(deleteStep(base, 2)!)).toEqual(['a@0..1', 'b@1..1']);
    expect(spans(deleteStep(base, 0)!)).toEqual(['b@0..0', 'c@1..3']);
    expect(spans(deleteStep(base, 3)!)).toEqual(['a@0..2', 'b@1..1', 'c@2..3']);
    const short = lessonOf(stepWith('s0'), stepWith('s1', note('z', 2)), stepWith('s2'));
    const kept = deleteStep(short, 2)!;
    expect(kept.steps[1]!.annots).toEqual([note('z')]);
  });

  it('a move follows the step, and an owner moved past its until ends on its own step', () => {
    // s2 to the end: a still ends on s2, now last; c's s4 now sits before it.
    expect(spans(moveStep(base, 2, 4))).toEqual(['a@0..4', 'b@1..1', 'c@4..4']);
    // s4 to the front: c still ends on s4, which now sits before its owner.
    expect(spans(moveStep(base, 4, 0))).toEqual(['a@1..3', 'b@2..2', 'c@3..3']);
    // s0 (owning a..2) to index 1: a keeps ending on s2.
    expect(spans(moveStep(base, 0, 1))).toEqual(['b@0..0', 'a@1..2', 'c@2..4']);
  });

  it('never writes an until equal to its own step', () => {
    const moved = moveStep(base, 2, 4);
    expect(moved.steps[4]!.annots).toEqual([note('c')]);
    expect('until' in moved.steps[4]!.annots![0]!).toBe(false);
  });

  it('leaves steps without a changed until as the same objects', () => {
    const out = insertStep(base, 5, newStep('narrate'));
    expect(out.steps[1]).toBe(base.steps[1]);
  });

  it('duplicate gives fresh ids and keeps only what ended on the original', () => {
    const l = lessonOf(stepWith('s0', note('n1', 2), note('n2')), stepWith('s1'), stepWith('s2'));
    const out = duplicateStep(l, 0);
    expect(out.steps[1]!.annots).toEqual([{ ...note('n2'), id: 'n3' }]);
    expect(spans(out)).toEqual(['n1@0..3', 'n2@0..0', 'n3@1..1']);
    const plain = duplicateStep(lessonOf(stepWith('s0', note('n1', 1)), stepWith('s1')), 0);
    expect(plain.steps[1]!.annots).toBeUndefined();
  });

  it('keeps annotations, notes and narration through a kind switch, but not revealFreely', () => {
    const predict: LessonStep = {
      kind: 'predict',
      prose: 'Q',
      actions: [],
      choices: [],
      answer: 'A',
      revealFreely: true,
      notes: 'n',
      narr: { at: 'caption' },
      annots: [note('n1')],
    };
    const { step } = setStepKind(predict, 'narrate');
    expect(step).toEqual({
      kind: 'narrate',
      prose: 'Q',
      actions: [],
      notes: 'n',
      narr: { at: 'caption' },
      annots: [note('n1')],
    });
  });
});

describe('setAnnotationUntil', () => {
  it('clamps to the owner and the lesson end and normalises its own step away', () => {
    expect(spans(setAnnotationUntil(base, 1, 'b', 3))).toContain('b@1..3');
    expect(spans(setAnnotationUntil(base, 1, 'b', 99))).toContain('b@1..4');
    const back = setAnnotationUntil(base, 0, 'a', 0);
    expect(back.steps[0]!.annots).toEqual([note('a')]);
  });

  it('returns the lesson itself for an unknown id or step', () => {
    expect(setAnnotationUntil(base, 1, 'zz', 3)).toBe(base);
    expect(setAnnotationUntil(base, 9, 'a', 3)).toBe(base);
  });
});
