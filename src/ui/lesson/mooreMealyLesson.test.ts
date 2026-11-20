import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { useLessonStore } from './lessonStore';

const cs = () => useCircuitStore.getState();
const ls = () => useLessonStore.getState();
const board = EXAMPLES.find((e) => e.id === 'moore-and-mealy-01-recognizers')!;
const lesson = BUILTIN_LESSONS.find((l) => l.id === 'moore-vs-mealy')!;

const lit = (id: string) => cs().pinRawValue(id, 'a')?.v;
const reading = () => ({
  s1: lit('ls1'),
  s0: lit('ls0'),
  q: lit('lq'),
  moore: lit('lmoore'),
  mealy: lit('lmealy'),
});

// The prose and answers state these; a lesson edit that breaks one is caught here.
const AFTER_STEP: Record<number, Partial<ReturnType<typeof reading>>> = {
  0: { s1: 0, s0: 0, q: 0, moore: 0, mealy: 0 },
  1: { s1: 0, s0: 1, q: 1, moore: 0, mealy: 0 },
  2: { moore: 0, mealy: 1 },
  3: { s1: 1, q: 0, moore: 1, mealy: 0 },
  5: { s1: 0, s0: 1, q: 1, moore: 0, mealy: 0 },
};

beforeEach(() => {
  ls().close();
  cs().loadBoard(structuredClone(board.board));
});

describe('the Moore vs Mealy lesson', () => {
  it('reads what each step says, played straight through with every reveal', () => {
    ls().open(lesson);
    const seen: Record<number, ReturnType<typeof reading>> = {};
    for (let k = 0; k < lesson.steps.length; k++) {
      if (k > 0) ls().next();
      if (lesson.steps[k]!.kind === 'predict') ls().reveal();
      expect(ls().notes, `step ${k + 1}`).toEqual([]);
      seen[k] = reading();
    }
    for (const [k, want] of Object.entries(AFTER_STEP))
      expect(seen[Number(k)], `step ${Number(k) + 1}`).toMatchObject(want);
  });

  it('holds A and the clock pulse until Reveal', () => {
    ls().open(lesson);
    ls().jump(2);
    expect(reading()).toMatchObject({ mealy: 0 });
    ls().reveal();
    expect(reading()).toMatchObject({ mealy: 1 });
    ls().next();
    expect(reading()).toMatchObject({ moore: 0, mealy: 1 });
    ls().reveal();
    expect(reading()).toMatchObject({ moore: 1, mealy: 0 });
  });
});
