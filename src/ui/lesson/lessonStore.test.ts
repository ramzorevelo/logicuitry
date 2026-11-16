import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, LessonStep } from '../../core/model/types';
import { rowMissingText } from '../../core/lesson';
import { EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { usePrefsStore } from '../prefs';
import { useLessonStore } from './lessonStore';

const cs = () => useCircuitStore.getState();
const ls = () => useLessonStore.getState();
const alu = EXAMPLES.find((e) => e.id === 'four-operation-alu')!;
const flagsLesson = BUILTIN_LESSONS.find((l) => l.id === 'alu-flags')!;

function loadAlu() {
  if (alu.chips?.length) cs().loadChipDefs(structuredClone(alu.chips));
  cs().loadBoard(structuredClone(alu.board));
}

const lessonOf = (...steps: LessonStep[]): Lesson => ({
  format: 'lcir.lesson',
  formatVersion: 4,
  id: 'test',
  title: 'Test',
  workbench: 'circuit',
  board: alu.board.id,
  steps,
});

/** What a viewer sees of the board: the inputs, the flags and the sequence marks. */
function snapshot() {
  const value = (id: string, pin: string) => cs().pinRawValue(id, pin)?.v;
  return {
    powered: cs().powered,
    inputs: ['a', 'b', 'f1', 'f0'].map((id) => value(id, 'y')),
    flags: ['n', 'z', 'cf', 'vf'].map((id) => value(id, 'a')),
    run: cs().sequenceRun(),
  };
}

beforeEach(() => {
  ls().close();
  usePrefsStore.getState().setPref('keepSwitchesAcrossPower', true);
  loadAlu();
});

describe('playing the ALU flags lesson', () => {
  it('opens on step 1 with the board powered and nothing else applied', () => {
    ls().open(flagsLesson);
    expect(ls().step).toBe(0);
    expect(cs().powered).toBe(true);
    expect(snapshot().inputs).toEqual([0, 0, 0, 0]);
  });

  it('Next applies a row; the highlight belongs to that step only', () => {
    ls().open(flagsLesson);
    ls().next();
    expect(snapshot().inputs).toEqual([3, 2, 0, 0]);
    expect([...cs().lessonHighlight]).toEqual(['a', 'b', 'f1', 'f0']);
    ls().next();
    expect([...cs().lessonHighlight]).toEqual(['n', 'z', 'cf', 'vf']);
    ls().back();
    expect([...cs().lessonHighlight]).toEqual(['a', 'b', 'f1', 'f0']);
  });

  it('reveal applies the held row, once', () => {
    ls().open(flagsLesson);
    ls().next();
    ls().next();
    expect(snapshot().inputs).toEqual([3, 2, 0, 0]);
    ls().reveal();
    expect(snapshot().inputs).toEqual([7, 1, 0, 0]);
    expect(snapshot().flags).toEqual([1, 0, 0, 1]);
    cs().toggleInput('a', 0);
    ls().reveal();
    expect(snapshot().inputs[0]).toBe(6);
  });

  it('PageDown reveals a hidden answer first, then moves on', () => {
    ls().open(flagsLesson);
    ls().pageDown();
    ls().pageDown();
    expect(ls().step).toBe(2);
    ls().pageDown();
    expect(ls().step).toBe(2);
    expect(ls().revealed.has(2)).toBe(true);
    ls().pageDown();
    expect(ls().step).toBe(3);
  });

  it('Next, Back, Next looks the same as a fresh play to that step', () => {
    ls().open(flagsLesson);
    ls().pageDown();
    ls().pageDown();
    ls().pageDown();
    ls().pageDown();
    const fresh = snapshot();
    expect(ls().step).toBe(3);

    ls().close();
    loadAlu();
    ls().open(flagsLesson);
    ls().pageDown();
    ls().pageDown();
    ls().pageDown();
    // The instructor flips a switch; Back must not carry it into the replay.
    cs().toggleInput('f0');
    ls().pageDown();
    ls().pageUp();
    expect(ls().step).toBe(2);
    expect(ls().revealed.has(2)).toBe(true);
    ls().pageDown();
    expect(ls().step).toBe(3);
    expect(snapshot()).toEqual(fresh);
  });

  it('a toggle the instructor clicked survives Next unless the step sets it', () => {
    ls().open(flagsLesson);
    ls().next();
    cs().toggleInput('f0');
    ls().next();
    expect(snapshot().inputs).toEqual([3, 2, 0, 1]);
    ls().reveal();
    expect(snapshot().inputs).toEqual([7, 1, 0, 0]);
  });

  it('Back pauses the sim and says so', () => {
    ls().open(flagsLesson);
    ls().next();
    cs().toggleRun();
    expect(cs().running).toBe(true);
    ls().next();
    expect(cs().running).toBe(true);
    ls().back();
    expect(cs().running).toBe(false);
    expect(cs().error).toBe('lesson: Replayed to step 2: the sim is paused');
  });

  it('a full play leaves the board the same object, so it is not dirty', () => {
    const before = cs().board;
    ls().open(flagsLesson);
    for (let i = 0; i < 20; i++) ls().pageDown();
    expect(ls().step).toBe(flagsLesson.steps.length - 1);
    ls().back();
    ls().jump(0);
    expect(cs().board).toBe(before);
  });

  it('undo has nothing lesson-applied to take back', () => {
    ls().open(flagsLesson);
    ls().next();
    ls().next();
    ls().reveal();
    const shown = snapshot();
    expect(cs().canUndo()).toBe(false);
    cs().undo();
    expect(snapshot()).toEqual(shown);
  });

  it('the last step opens the Sequence tab', () => {
    ls().open(flagsLesson);
    ls().jump(flagsLesson.steps.length - 1);
    expect(cs().dockTab).toBe('sequence');
    expect(cs().waveformOpen).toBe(true);
  });

  it('Back from the last step closes the Sequence tab no earlier step opened', () => {
    cs().setWaveformOpen(false);
    ls().open(flagsLesson);
    ls().jump(flagsLesson.steps.length - 1);
    ls().back();
    expect(cs().waveformOpen).toBe(false);
    ls().jump(2);
    expect(cs().waveformOpen).toBe(false);
  });

  it('Back restores the dock as it was when the lesson opened', () => {
    cs().setWaveformOpen(true);
    cs().setDockTab('checks');
    ls().open(flagsLesson);
    ls().next();
    cs().setWaveformOpen(false);
    ls().next();
    expect(cs().waveformOpen).toBe(false);
    ls().back();
    expect(cs().waveformOpen).toBe(true);
    expect(cs().dockTab).toBe('checks');
  });

  it('a step asking for Analyze keeps the dock tab an earlier step opened, by Next or by Back', () => {
    cs().setWaveformOpen(false);
    const lesson = lessonOf(
      { kind: 'narrate', prose: 'waves', actions: [{ kind: 'tab', tab: 'waveform' }] },
      { kind: 'narrate', prose: 'analyze', actions: [{ kind: 'tab', tab: 'analyze' }] },
      { kind: 'narrate', prose: 'end', actions: [] },
    );
    ls().open(lesson);
    ls().next();
    expect(ls().analyzePending).toBe(true);
    ls().analyzeServed();
    ls().next();
    ls().back();
    expect(cs().waveformOpen).toBe(true);
    expect(cs().dockTab).toBe('waves');
    expect(ls().analyzePending).toBe(true);
  });

  it('Next keeps a dock tab opened by hand', () => {
    cs().setWaveformOpen(false);
    ls().open(flagsLesson);
    cs().setWaveformOpen(true);
    cs().setDockTab('checks');
    ls().next();
    expect(cs().waveformOpen).toBe(true);
    expect(cs().dockTab).toBe('checks');
  });

  it('opening another board closes the lesson', () => {
    ls().open(flagsLesson);
    ls().next();
    cs().loadBoard(structuredClone(EXAMPLES[0]!.board));
    expect(ls().lesson).toBeNull();
  });
});

describe('lesson timing and skipped rows', () => {
  const timed = lessonOf(
    { kind: 'narrate', prose: 'on', actions: [{ kind: 'power', on: true }] },
    { kind: 'narrate', prose: 'slow', actions: [{ kind: 'timing', mode: 'datasheet' }] },
    {
      kind: 'narrate',
      prose: 'missing',
      actions: [{ kind: 'row', index: 99, when: 'open' }],
    },
    { kind: 'narrate', prose: 'end', actions: [] },
  );

  it('a timing step restarts the sim powered, and close restores the saved mode', () => {
    const before = cs().board;
    ls().open(timed);
    ls().next();
    expect(cs().timing.mode).toBe('datasheet');
    expect(cs().powered).toBe(true);
    expect(cs().board).toBe(before);
    ls().close();
    expect(cs().timing.mode).toBe('ideal');
    expect(cs().powered).toBe(true);
    expect(cs().board).toBe(before);
  });

  it('a toggle survives a timing step with the keep-switches pref off', () => {
    usePrefsStore.getState().setPref('keepSwitchesAcrossPower', false);
    ls().open(timed);
    cs().toggleInput('f0');
    ls().next();
    expect(cs().timing.mode).toBe('datasheet');
    expect(snapshot().inputs).toEqual([0, 0, 0, 1]);
  });

  it('a column change mid-lesson keeps the board on its own mode', () => {
    ls().open(timed);
    ls().next();
    cs().setTiming({ datasheet: 'max' });
    expect(cs().timing).toMatchObject({ mode: 'datasheet', datasheet: 'max' });
    expect(cs().board.timing).toMatchObject({ mode: 'ideal', datasheet: 'max' });
    ls().close();
    expect(cs().timing.mode).toBe('ideal');
  });

  it('Back to before the timing step plays at the board timing again', () => {
    ls().open(timed);
    ls().next();
    ls().back();
    expect(cs().timing.mode).toBe('ideal');
  });

  it('a missing row is announced and play goes on', () => {
    ls().open(timed);
    ls().next();
    ls().next();
    expect(ls().notes).toEqual([rowMissingText(99)]);
    ls().next();
    expect(ls().step).toBe(3);
    expect(ls().notes).toEqual([]);
  });
});

describe('autoplay', () => {
  const steps = lessonOf(
    { kind: 'narrate', prose: 'One.', actions: [], seconds: 3 },
    {
      kind: 'predict',
      prose: 'Two?',
      actions: [],
      choices: [{ text: 'a', right: true }, { text: 'b' }],
      answer: 'A.',
      seconds: 5,
    },
    { kind: 'narrate', prose: 'Three.', actions: [], seconds: 2 },
  );

  beforeEach(() => {
    vi.useFakeTimers();
    ls().setAutoplayPace(0);
    ls().setAutoplayWait(false);
  });
  afterEach(() => {
    ls().stopAutoplay();
    vi.useRealTimers();
  });

  it('does nothing until started', () => {
    ls().open(steps);
    vi.advanceTimersByTime(60_000);
    expect(ls().step).toBe(0);
  });

  it('plays through: question, its own reveal, the answer, then on to the end', () => {
    ls().open(steps);
    ls().startAutoplay();
    vi.advanceTimersByTime(2_999);
    expect(ls().step).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ls().step).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(ls().revealed.has(1)).toBe(true);
    expect(ls().step).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(ls().step).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(ls().autoplay).toBe(false);
    expect(ls().step).toBe(2);
  });

  it('Wait on questions holds until a person reveals, then counts the answer', () => {
    ls().setAutoplayWait(true);
    ls().open(steps, 1);
    ls().startAutoplay();
    expect(ls().autoplayDeadline).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(ls().revealed.has(1)).toBe(false);
    ls().reveal();
    vi.advanceTimersByTime(5_000);
    expect(ls().step).toBe(2);
  });

  it('a pace overrides every step', () => {
    ls().setAutoplayPace(10);
    ls().open(steps);
    ls().startAutoplay();
    vi.advanceTimersByTime(9_999);
    expect(ls().step).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ls().step).toBe(1);
  });

  it('Next restarts the countdown; Back, a jump and closing stop it', () => {
    ls().open(steps);
    ls().startAutoplay();
    vi.advanceTimersByTime(2_000);
    ls().next();
    vi.advanceTimersByTime(4_999);
    expect(ls().revealed.has(1)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(ls().revealed.has(1)).toBe(true);
    ls().back();
    expect(ls().autoplay).toBe(false);
    ls().startAutoplay();
    ls().jump(2);
    expect(ls().autoplay).toBe(false);
    ls().startAutoplay();
    ls().close();
    vi.advanceTimersByTime(60_000);
    expect(ls().autoplay).toBe(false);
  });

  it('keeps pace and wait across lessons, not the running state', () => {
    ls().setAutoplayPace(20);
    ls().setAutoplayWait(true);
    ls().open(steps);
    ls().startAutoplay();
    ls().close();
    ls().open(steps);
    expect(ls().autoplay).toBe(false);
    expect(ls().autoplayPace).toBe(20);
    expect(ls().autoplayWait).toBe(true);
  });
});
