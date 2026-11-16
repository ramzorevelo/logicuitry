import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { handleLessonKey, type LessonKeyEvent } from './lessonKeys';
import { useLessonStore } from './lessonStore';

const lesson = BUILTIN_LESSONS[0]!;
const alu = EXAMPLES.find((e) => e.id === lesson.board)!;

function pressEvent(key: string, tagName = 'BODY'): LessonKeyEvent & { prevented: boolean } {
  return {
    key,
    target: { tagName } as unknown as EventTarget,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function press(key: string, tagName = 'BODY') {
  const e: LessonKeyEvent & { prevented: boolean } = {
    key,
    target: { tagName } as unknown as EventTarget,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  return { taken: handleLessonKey(e), prevented: e.prevented };
}

beforeEach(() => {
  useLessonStore.getState().close();
  useCircuitStore.getState().loadBoard(structuredClone(alu.board));
});

describe('lesson keys', () => {
  it('leave every key alone while no lesson plays', () => {
    expect(press('PageDown')).toEqual({ taken: false, prevented: false });
  });

  it('PageDown and PageUp step and never scroll, even from a focused button', () => {
    useLessonStore.getState().open(lesson);
    expect(press('PageDown', 'BUTTON')).toEqual({ taken: true, prevented: true });
    expect(useLessonStore.getState().step).toBe(1);
    expect(press('PageUp')).toEqual({ taken: true, prevented: true });
    expect(useLessonStore.getState().step).toBe(0);
  });

  it('Enter reveals on a predict step, and stays taken once revealed', () => {
    useLessonStore.getState().open(lesson);
    useLessonStore.getState().jump(2);
    expect(press('Enter').taken).toBe(true);
    expect(useLessonStore.getState().revealed.has(2)).toBe(true);
    expect(press('Enter').taken).toBe(true);
  });

  it('Enter goes to the board on a narrate step, and to a focused button or text box', () => {
    useLessonStore.getState().open(lesson);
    expect(press('Enter').taken).toBe(false);
    useLessonStore.getState().jump(2);
    expect(press('Enter', 'BUTTON').taken).toBe(false);
    expect(press('Enter', 'INPUT').taken).toBe(false);
    expect(useLessonStore.getState().revealed.has(2)).toBe(false);
  });

  it('Enter on a lesson-panel button reveals rather than clicking it', () => {
    useLessonStore.getState().open(lesson);
    useLessonStore.getState().jump(2);
    const chip = {
      tagName: 'BUTTON',
      closest: (sel: string) => (sel === '.lesson-panel' ? {} : null),
    };
    const e = { ...pressEvent('Enter'), target: chip as unknown as EventTarget };
    expect(handleLessonKey(e)).toBe(true);
    expect(e.prevented).toBe(true);
    expect(useLessonStore.getState().revealed.has(2)).toBe(true);
    expect(useLessonStore.getState().step).toBe(2);
  });

  it('text boxes keep PageDown', () => {
    useLessonStore.getState().open(lesson);
    expect(press('PageDown', 'TEXTAREA').taken).toBe(false);
  });
});
