import { beforeEach, describe, expect, it } from 'vitest';
import type { Lesson, LessonAction } from '../../core/model/types';
import { addRow, deleteRow } from '../../core/model/sequence';
import { EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { usePrefsStore } from '../prefs';
import { lessonDirty, useLessonEditorStore } from './lessonEditorStore';
import { useLessonStore } from './lessonStore';

const cs = () => useCircuitStore.getState();
const ed = () => useLessonEditorStore.getState();
const alu = EXAMPLES.find((e) => e.id === 'four-operation-alu')!;
const flags = BUILTIN_LESSONS.find((l) => l.id === 'alu-flags')!;

function loadAlu() {
  if (alu.chips?.length) cs().loadChipDefs(structuredClone(alu.chips));
  cs().loadBoard(structuredClone(alu.board));
}

const inputs = () => ['a', 'b', 'f1', 'f0'].map((id) => cs().pinRawValue(id, 'y')?.v);
const rowIndexes = (l: Lesson | null) =>
  (l?.steps ?? [])
    .flatMap((s) =>
      s.actions.filter((a): a is Extract<LessonAction, { kind: 'row' }> => a.kind === 'row'),
    )
    .map((a) => a.index);

beforeEach(() => {
  ed().close();
  useLessonStore.getState().close();
  usePrefsStore.getState().setPref('keepSwitchesAcrossPower', true);
  loadAlu();
  ed().open(structuredClone(flags), 'alu-flags.lcirl');
});

describe('opening the editor', () => {
  it('shows the board at the selected step, as the class sees it', () => {
    ed().select(1);
    expect(cs().powered).toBe(true);
    expect(inputs()).toEqual([3, 2, 0, 0]);
    expect([...cs().lessonHighlight]).toEqual(['a', 'b', 'f1', 'f0']);
  });

  it('opens on the asked step and leaves the board object alone', () => {
    const board = cs().board;
    ed().close();
    ed().open(structuredClone(flags), 'alu-flags.lcirl', { step: 2 });
    expect(ed().sel).toBe(2);
    expect(cs().board).toBe(board);
    expect(cs().canUndo()).toBe(false);
  });

  it('a predict step that holds a row back shows before and after the reveal', () => {
    ed().select(2);
    expect(inputs()).toEqual([3, 2, 0, 0]);
    ed().setAfterReveal(true);
    expect(inputs()).toEqual([7, 1, 0, 0]);
    ed().select(3);
    expect(ed().afterReveal).toBe(false);
  });

  it('selecting back past a tab step gives the dock back as the editor found it', () => {
    ed().close();
    cs().setWaveformOpen(false);
    ed().open(structuredClone(flags), 'alu-flags.lcirl');
    ed().select(5);
    expect(cs().dockTab).toBe('sequence');
    expect(cs().waveformOpen).toBe(true);
    ed().select(4);
    expect(cs().waveformOpen).toBe(false);
  });

  it('an edit on the same step leaves a tab the author opened', () => {
    ed().select(1);
    cs().setWaveformOpen(true);
    cs().setDockTab('sequence');
    cs().editSequence('add row', (s) => addRow(s, { set: [1, 1, 0, 0] }, 3));
    ed().setAfterReveal(true);
    expect(cs().waveformOpen).toBe(true);
    expect(cs().dockTab).toBe('sequence');
  });

  it('handed over from the runner, Back rebuilds to the dock the runner started from', () => {
    ed().close();
    cs().setWaveformOpen(false);
    useLessonStore.getState().open(flags);
    useLessonStore.getState().jump(5);
    expect(cs().waveformOpen).toBe(true);
    useLessonStore.getState().close();
    ed().open(structuredClone(flags), 'alu-flags.lcirl', { step: 5, keepDock: true });
    ed().select(0);
    expect(cs().waveformOpen).toBe(false);
  });

  it('a new lesson is unsaved; an opened one is not', () => {
    expect(lessonDirty(ed())).toBe(false);
    ed().open(structuredClone(flags), 'x.lcirl', { isNew: true });
    expect(lessonDirty(ed())).toBe(true);
  });
});

describe('step edits and the lesson undo stack', () => {
  it('adds after the selection and selects the new step', () => {
    ed().select(1);
    ed().addStep('predict');
    expect(ed().sel).toBe(2);
    expect(ed().draft!.steps[2]).toMatchObject({ kind: 'predict', prose: '' });
    expect(ed().draft!.steps).toHaveLength(flags.steps.length + 1);
  });

  it('undo and redo walk lesson edits and never touch board history', () => {
    ed().duplicateStep(0);
    ed().moveStep(1, 3);
    expect(ed().draft!.steps).toHaveLength(flags.steps.length + 1);
    ed().undo();
    ed().undo();
    expect(ed().draft).toEqual(flags);
    expect(lessonDirty(ed())).toBe(false);
    ed().redo();
    expect(ed().draft!.steps).toHaveLength(flags.steps.length + 1);
    expect(cs().canUndo()).toBe(false);
  });

  it('keeps at least one step', () => {
    ed().open({ ...structuredClone(flags), steps: [flags.steps[0]!] }, 'one.lcirl');
    expect(ed().deleteStep(0)).toBe(false);
    expect(ed().draft!.steps).toHaveLength(1);
  });

  it('a text box session is one undo step', () => {
    ed().select(0);
    ed().beginText();
    ed().editText((l) => ({ ...l, title: 'A' }));
    ed().editText((l) => ({ ...l, title: 'AB' }));
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(ed().draft!.title).toBe(flags.title);
  });

  it('turning predict into narrate moves held-back rows to the step open, and says so', () => {
    ed().select(2);
    expect(ed().setKind('narrate')).toMatch(/held-back rows now apply/);
    const row = ed().draft!.steps[2]!.actions.find((a) => a.kind === 'row');
    expect(row).toMatchObject({ when: 'open' });
    expect(ed().setKind('predict')).toBeNull();
  });
});

describe('pick on board', () => {
  beforeEach(() => ed().select(4));
  const picked = () => {
    const a = ed().draft!.steps[4]!.actions[0]!;
    return a.kind === 'highlight' ? a.components : [];
  };

  it('toggles parts live and finishes as one undo step', () => {
    ed().beginPick(0);
    ed().togglePick(['y']);
    ed().togglePick(['mux']);
    expect(picked()).toEqual(['y']);
    expect([...cs().lessonHighlight]).toEqual(['y']);
    ed().finishPick();
    expect(ed().pick).toBeNull();
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(picked()).toEqual(['mux']);
    expect(lessonDirty(ed())).toBe(false);
  });

  it('typing ends a pick, so a later cancel keeps the text', () => {
    ed().beginPick(0);
    ed().togglePick(['y']);
    ed().beginText();
    ed().editText((l) => ({ ...l, title: 'Typed' }));
    expect(ed().pick).toBeNull();
    ed().cancelPick();
    expect(ed().draft!.title).toBe('Typed');
    expect(picked()).toEqual(['mux', 'y']);
  });

  it('undo mid-pick drops the unfinished picks rather than keeping them for redo', () => {
    ed().addStep('narrate');
    ed().select(4);
    ed().beginPick(0);
    ed().togglePick(['y']);
    ed().undo();
    ed().redo();
    expect(ed().draft!.steps[4]!.actions[0]).toMatchObject({ components: ['mux'] });
  });

  it('a pick that ends where it began is no edit', () => {
    ed().beginPick(0);
    ed().togglePick(['y']);
    ed().togglePick(['y']);
    ed().finishPick();
    expect(ed().past).toHaveLength(0);
    expect(lessonDirty(ed())).toBe(false);
  });

  it('cancel restores the set it started from and adds no undo step', () => {
    ed().beginPick(0);
    ed().togglePick(['a', 'b']);
    ed().cancelPick();
    expect(picked()).toEqual(['mux']);
    expect(ed().past).toHaveLength(0);
    expect([...cs().lessonHighlight]).toEqual(['mux']);
  });
});

describe('sequence rows renumber while the editor is open', () => {
  it('an inserted row shifts later references, undo history included', () => {
    ed().duplicateStep(0);
    const before = rowIndexes(ed().draft);
    cs().editSequence('add row', (s) => addRow(s, { set: [1, 1, 0, 0] }, 1));
    expect(rowIndexes(ed().draft)).toEqual(before.map((i) => (i >= 1 ? i + 1 : i)));
    ed().undo();
    expect(rowIndexes(ed().draft)).toEqual(before.map((i) => (i >= 1 ? i + 1 : i)));
  });

  it('board undo of the insert shifts them back, as a delete', () => {
    const before = rowIndexes(ed().draft);
    cs().editSequence('add row', (s) => addRow(s, { set: [1, 1, 0, 0] }, 0));
    cs().undo();
    expect(rowIndexes(ed().draft)).toEqual(before);
  });

  it('a deleted row shifts the ones after it', () => {
    cs().editSequence('delete row', (s) => deleteRow(s, 0));
    expect(rowIndexes(ed().draft)).toEqual([0, 0, 1]);
  });
});

describe('Play from this step', () => {
  it('plays the draft from the selected step and comes back where play stopped', () => {
    ed().select(1);
    ed().play();
    expect(useLessonStore.getState()).toMatchObject({ step: 1, fromEditor: true });
    expect(ed().playing).toBe(true);
    useLessonStore.getState().next();
    ed().backFromPlay();
    expect(useLessonStore.getState().lesson).toBeNull();
    expect(ed().playing).toBe(false);
    expect(ed().sel).toBe(2);
  });

  it('says how many steps are flagged', () => {
    ed().updateSelected((s) => ({
      ...s,
      actions: [...s.actions, { kind: 'row', index: 40, when: 'open' }],
    }));
    ed().play();
    expect(cs().error).toMatch(/^lesson: Playing with 1 flagged step \(1\)/);
  });
});

describe('closing', () => {
  it('gives the board back: off, saved timing, no highlight', () => {
    ed().select(1);
    ed().close();
    expect(ed().draft).toBeNull();
    expect(cs().powered).toBe(false);
    expect(cs().lessonHighlight.size).toBe(0);
    expect(cs().timing.mode).toBe(cs().board.timing.mode);
  });

  it('asks when unsaved; cancel keeps the editor, discard closes and runs', () => {
    ed().addStep('narrate');
    let ran = 0;
    ed().requestClose('Open another board', () => ran++);
    expect(ed().pendingClose?.action).toBe('Open another board');
    ed().resolveClose('cancel');
    expect(ed().draft).not.toBeNull();
    expect(ran).toBe(0);
    ed().requestClose('Open another board', () => ran++);
    ed().resolveClose('discard');
    expect(ed().draft).toBeNull();
    expect(ran).toBe(1);
  });

  it('closes without asking when saved', () => {
    let ran = 0;
    ed().requestClose('Close', () => ran++);
    expect(ed().draft).toBeNull();
    expect(ran).toBe(1);
  });

  it('a board load that bypassed the prompt still closes it', () => {
    loadAlu();
    expect(ed().draft).toBeNull();
  });
});
