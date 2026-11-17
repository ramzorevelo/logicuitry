import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { useLessonEditorStore } from './lessonEditorStore';
import type { LessonKeyEvent } from './lessonKeys';
import { saveLessonDraft } from './lessonSave';
import { useWorkspaceStore } from './workspace/workspaceStore';

export interface EditorKeyEvent extends LessonKeyEvent {
  shiftKey: boolean;
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

type Closest = { closest?: (sel: string) => unknown };
const within = (target: EventTarget | null, selector: string): boolean => {
  const closest = (target as Closest | null)?.closest;
  return typeof closest === 'function' && closest.call(target, selector) != null;
};

/** Undo in the Sequence tab is the board's: that is where its rows are edited. */
const inSequenceTab = (target: EventTarget | null): boolean =>
  within(target, '.wave-panel') && useCircuitStore.getState().dockTab === 'sequence';

/** Board keys that only look, never change: the editor lets them through. */
const VIEW_KEYS = new Set(['Home']);

/**
 * The lesson editor's keys. True when the key was the editor's, which is every
 * key outside a text box while the editor is open, so nothing reaches the
 * locked board. Escape during Play from this step goes back to the editor.
 */
export function handleLessonEditorKey(e: EditorKeyEvent): boolean {
  const ed = useLessonEditorStore.getState();
  if (!ed.draft || e.defaultPrevented) return false;
  const tag = (e.target as { tagName?: string } | null)?.tagName?.toUpperCase() ?? '';
  const editable = EDITABLE.has(tag);
  if (ed.playing) {
    if (e.key !== 'Escape' || editable) return false;
    e.preventDefault();
    ed.backFromPlay();
    return true;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (ctrl && key === 's') {
    e.preventDefault();
    void saveLessonDraft();
    return true;
  }
  // Taken from a text box too, where Ctrl+Space would only type a space.
  if (ctrl && key === ' ') {
    e.preventDefault();
    useWorkspaceStore.getState().toggleMax();
    return true;
  }
  if (editable) return false;
  if (ed.pick && (key === 'Enter' || key === 'Escape')) {
    e.preventDefault();
    if (key === 'Enter') ed.finishPick();
    else ed.cancelPick();
    return true;
  }
  if (key === 'Escape' && useWorkspaceStore.getState().maxArea) {
    e.preventDefault();
    useWorkspaceStore.getState().restore();
    return true;
  }
  if (ctrl && (key === 'z' || key === 'y')) {
    if (inSequenceTab(e.target)) return false;
    e.preventDefault();
    if (key === 'y' || e.shiftKey) ed.redo();
    else ed.undo();
    return true;
  }
  if (ctrl && key === 'd') {
    e.preventDefault();
    ed.duplicateStep(ed.sel);
    return true;
  }
  if (key === 'PageUp' || key === 'PageDown') {
    e.preventDefault();
    ed.select(ed.sel + (key === 'PageDown' ? 1 : -1));
    return true;
  }
  if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    e.preventDefault();
    ed.moveStep(ed.sel, ed.sel + (key === 'ArrowDown' ? 1 : -1));
    return true;
  }
  if (within(e.target, '.lesson-steps')) {
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      ed.select(ed.sel + (key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      if (!ed.deleteStep(ed.sel))
        useCircuitStore.setState({ error: 'lesson: A lesson keeps at least one step' });
    }
    return true;
  }
  return !VIEW_KEYS.has(key);
}
