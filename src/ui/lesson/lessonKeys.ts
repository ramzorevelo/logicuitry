import { hasReveal } from '../../core/lesson';
import { isPanelKeyTarget, type KeyTarget } from '../panelKeys';
import { useLessonStore } from './lessonStore';

export interface LessonKeyEvent {
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/** Text boxes and option lists own their keys; a lesson never takes them. */
const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function inLessonPanel(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (sel: string) => unknown } | null)?.closest;
  return typeof closest === 'function' && closest.call(target, '.lesson-panel') != null;
}

/**
 * PageDown/PageUp step a playing lesson (a clicker sends them, so a focused
 * panel button must not swallow them) and never scroll. Enter reveals ahead of
 * smart connect; inside the lesson panel it is always the lesson's, since a
 * clicked chip or Next keeps focus and would otherwise take it. Elsewhere a
 * focused button or a side panel keeps its own Enter, and Enter on a step with
 * no reveal goes on to the board. True when the key was the lesson's.
 */
export function handleLessonKey(e: LessonKeyEvent): boolean {
  const run = useLessonStore.getState();
  if (!run.lesson || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return false;
  const tag = (e.target as { tagName?: string } | null)?.tagName?.toUpperCase() ?? '';
  if (EDITABLE.has(tag)) return false;
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    if (e.key === 'PageDown') run.pageDown();
    else run.pageUp();
    return true;
  }
  if (e.key !== 'Enter') return false;
  const step = run.lesson.steps[run.step];
  if (inLessonPanel(e.target)) {
    e.preventDefault();
    run.reveal();
    return true;
  }
  if (tag === 'BUTTON' || isPanelKeyTarget(e.target as KeyTarget | null, e.key)) return false;
  if (!step || !hasReveal(step)) return false;
  e.preventDefault();
  run.reveal();
  return true;
}
