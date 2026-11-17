import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { handleLessonEditorKey, type EditorKeyEvent } from './lessonEditorKeys';
import { useLessonEditorStore } from './lessonEditorStore';
import { handleLessonKey } from './lessonKeys';
import { useLessonStore } from './lessonStore';
import { useWorkspaceStore } from './workspace/workspaceStore';

const lesson = BUILTIN_LESSONS[0]!;
const alu = EXAMPLES.find((e) => e.id === lesson.board)!;
const ed = () => useLessonEditorStore.getState();

/** A target that answers `closest` for the selectors it sits inside. */
function target(tagName: string, inside: string[] = []): EventTarget {
  return {
    tagName,
    closest: (sel: string) => (sel.split(',').some((s) => inside.includes(s.trim())) ? {} : null),
  } as unknown as EventTarget;
}

function press(
  key: string,
  opts: Partial<Pick<EditorKeyEvent, 'ctrlKey' | 'altKey' | 'shiftKey'>> & {
    tag?: string;
    inside?: string[];
  } = {},
) {
  const e: EditorKeyEvent & { prevented: boolean } = {
    key,
    target: target(opts.tag ?? 'BODY', opts.inside),
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    metaKey: false,
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  // The workbench's order: the runner's keys, then the editor's.
  const taken = handleLessonKey(e) || handleLessonEditorKey(e);
  return { taken, prevented: e.prevented };
}

beforeEach(() => {
  useWorkspaceStore.setState({ maxArea: null, narrow: false, hoverArea: null, focusArea: null });
  ed().close();
  useLessonStore.getState().close();
  useCircuitStore.getState().loadBoard(structuredClone(alu.board));
  ed().open(structuredClone(lesson), 'alu-flags.lcirl');
});

describe('editor keys', () => {
  it('PageUp and PageDown select steps and never scroll', () => {
    expect(press('PageDown')).toEqual({ taken: true, prevented: true });
    expect(ed().sel).toBe(1);
    press('PageUp');
    press('PageUp');
    expect(ed().sel).toBe(0);
  });

  it('Alt+arrows move the selected step', () => {
    press('ArrowDown', { altKey: true });
    expect(ed().sel).toBe(1);
    expect(ed().draft!.steps[1]!.prose).toBe(lesson.steps[0]!.prose);
  });

  it('Ctrl+D duplicates; Ctrl+Z and Ctrl+Y undo and redo the lesson', () => {
    press('d', { ctrlKey: true });
    expect(ed().draft!.steps).toHaveLength(lesson.steps.length + 1);
    press('z', { ctrlKey: true });
    expect(ed().draft!.steps).toHaveLength(lesson.steps.length);
    press('y', { ctrlKey: true });
    expect(ed().draft!.steps).toHaveLength(lesson.steps.length + 1);
    press('Z', { ctrlKey: true, shiftKey: true });
    expect(ed().past.length).toBe(1);
  });

  it('Ctrl+Z in the Sequence tab is left to the board', () => {
    useCircuitStore.getState().setDockTab('sequence');
    expect(press('z', { ctrlKey: true, tag: 'BUTTON', inside: ['.wave-panel'] }).taken).toBe(false);
  });

  it('text boxes keep their own keys, except Ctrl+S', () => {
    expect(press('z', { ctrlKey: true, tag: 'TEXTAREA' }).taken).toBe(false);
    expect(press('Delete', { tag: 'INPUT', inside: ['.lesson-steps'] }).taken).toBe(false);
    expect(press('s', { ctrlKey: true, tag: 'TEXTAREA' })).toEqual({
      taken: true,
      prevented: true,
    });
  });

  it('Delete in the step list deletes the selected step, never the last one', () => {
    press('Delete', { tag: 'LI', inside: ['.lesson-steps'] });
    expect(ed().draft!.steps).toHaveLength(lesson.steps.length - 1);
    ed().open({ ...structuredClone(lesson), steps: [lesson.steps[0]!] }, 'one.lcirl');
    press('Delete', { tag: 'LI', inside: ['.lesson-steps'] });
    expect(ed().draft!.steps).toHaveLength(1);
  });

  it('Delete on the board does nothing to the lesson or the board', () => {
    const board = useCircuitStore.getState().board;
    expect(press('Delete').taken).toBe(true);
    expect(ed().draft!.steps).toHaveLength(lesson.steps.length);
    expect(useCircuitStore.getState().board).toBe(board);
  });

  it('Space and . are swallowed, so they never reach the power keys', () => {
    expect(press(' ').taken).toBe(true);
    expect(press('.').taken).toBe(true);
  });

  it('Enter never reveals; Home is left to the board for Zoom to fit', () => {
    ed().select(2);
    expect(press('Enter').taken).toBe(true);
    expect(useLessonStore.getState().lesson).toBeNull();
    expect(press('Home').taken).toBe(false);
  });

  it('Enter finishes a pick and Esc cancels it', () => {
    ed().select(4);
    ed().beginPick(0);
    ed().togglePick(['y']);
    press('Enter');
    expect(ed().pick).toBeNull();
    expect(ed().past).toHaveLength(1);
    ed().beginPick(0);
    ed().togglePick(['a']);
    press('Escape');
    expect(ed().pick).toBeNull();
    expect(ed().draft!.steps[4]!.actions[0]).toMatchObject({ components: ['mux', 'y'] });
  });

  it('Esc from Play goes back to the editor at the step play reached', () => {
    ed().select(1);
    ed().play();
    expect(press('PageDown').taken).toBe(true);
    expect(useLessonStore.getState().step).toBe(2);
    press('Escape');
    expect(ed().playing).toBe(false);
    expect(ed().sel).toBe(2);
  });

  it('Ctrl+Space maximises the hovered area, from a text box too, and toggles back', () => {
    useWorkspaceStore.setState({ maxArea: null, narrow: false, hoverArea: 'a1', focusArea: 'a3' });
    expect(press(' ', { ctrlKey: true, tag: 'TEXTAREA' })).toEqual({
      taken: true,
      prevented: true,
    });
    expect(useWorkspaceStore.getState().maxArea).toBe('a1');
    press(' ', { ctrlKey: true });
    expect(useWorkspaceStore.getState().maxArea).toBeNull();
    useWorkspaceStore.setState({ hoverArea: null });
    press(' ', { ctrlKey: true });
    expect(useWorkspaceStore.getState().maxArea).toBe('a3');
  });

  it('Esc cancels a pick before it restores a maximised area', () => {
    useWorkspaceStore.setState({ maxArea: 'a2', narrow: false });
    ed().select(4);
    ed().beginPick(0);
    press('Escape');
    expect(ed().pick).toBeNull();
    expect(useWorkspaceStore.getState().maxArea).toBe('a2');
    expect(press('Escape')).toEqual({ taken: true, prevented: true });
    expect(useWorkspaceStore.getState().maxArea).toBeNull();
  });

  it('Esc in a text box leaves the maximised area alone', () => {
    useWorkspaceStore.setState({ maxArea: 'a2', narrow: false });
    expect(press('Escape', { tag: 'INPUT' }).taken).toBe(false);
    expect(useWorkspaceStore.getState().maxArea).toBe('a2');
  });

  it('does nothing with the editor closed', () => {
    ed().close();
    expect(press('PageDown').taken).toBe(false);
  });
});
