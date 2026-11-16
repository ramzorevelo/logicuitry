import type {
  BoardSequence,
  Lesson,
  LessonAction,
  LessonDockTab,
  LessonStep,
  TimingMode,
} from '../model/types';

/** What a lesson needs to know about its board; the UI builds it from the store. */
export interface LessonBoardView {
  /** Top-level component ids. */
  componentIds: ReadonlySet<string>;
  sequence?: BoardSequence | undefined;
}

/** One board change, in the order it must happen. */
export type BoardOp =
  | { op: 'power'; on: boolean }
  | { op: 'timing'; mode: TimingMode }
  | { op: 'row'; index: number };

export type Phase = 'open' | 'reveal';

/** True when the step has a reveal stage: every predict step does. */
export function hasReveal(step: LessonStep): boolean {
  return step.kind === 'predict';
}

/** The phase an action fires in; a held-back row only means something on a predict step. */
export function actionPhase(step: LessonStep, action: LessonAction): Phase {
  return action.kind === 'row' && action.when === 'reveal' && hasReveal(step) ? 'reveal' : 'open';
}

/** A step's actions in the order they reach the board: open phase, then reveal. */
export function firingOrder(step: LessonStep): LessonAction[] {
  const open = step.actions.filter((a) => actionPhase(step, a) === 'open');
  const reveal = step.actions.filter((a) => actionPhase(step, a) === 'reveal');
  return [...open, ...reveal];
}

function opOf(action: LessonAction): BoardOp | undefined {
  switch (action.kind) {
    case 'power':
      return { op: 'power', on: action.on };
    case 'timing':
      return { op: 'timing', mode: action.mode };
    case 'row':
      return { op: 'row', index: action.index };
    default:
      return undefined;
  }
}

/** Actions of one step for one phase, as ops. Highlights and tab are not ops. */
export function stepOps(step: LessonStep, phase: Phase): BoardOp[] {
  const ops: BoardOp[] = [];
  for (const action of step.actions) {
    if (actionPhase(step, action) !== phase) continue;
    const op = opOf(action);
    if (op) ops.push(op);
  }
  return ops;
}

/** The tab a step opens: its last tab action wins. */
export function stepTab(step: LessonStep): LessonDockTab | undefined {
  let tab: LessonDockTab | undefined;
  for (const action of step.actions) if (action.kind === 'tab') tab = action.tab;
  return tab;
}

/** A tab that lives in the dock; Analyze is a drawer of its own and opens beside it. */
export type LessonDockPanelTab = Exclude<LessonDockTab, 'analyze'>;

/** The dock tab a step leaves showing: its last tab action that is not Analyze. */
export function stepDockTab(step: LessonStep): LessonDockPanelTab | undefined {
  let tab: LessonDockPanelTab | undefined;
  for (const action of step.actions)
    if (action.kind === 'tab' && action.tab !== 'analyze') tab = action.tab;
  return tab;
}

/** Union of a step's highlight actions, first mention first. */
export function stepHighlight(step: LessonStep): string[] {
  const ids = new Set<string>();
  for (const action of step.actions)
    if (action.kind === 'highlight') for (const id of action.components) ids.add(id);
  return [...ids];
}

/**
 * Board state for showing step k, from the lesson start (board as saved,
 * unpowered, Run off): every earlier step's open then reveal ops, then step k's
 * open ops, plus its reveal ops when `revealed`. Highlights never carry; the
 * open tab does. `dock` is the dock tab showing, which a later Analyze leaves
 * open, as Next does.
 */
export function replayPlan(
  lesson: Lesson,
  k: number,
  revealed: boolean,
): { ops: BoardOp[]; highlight: string[]; tab?: LessonDockTab; dock?: LessonDockPanelTab } {
  const ops: BoardOp[] = [];
  let tab: LessonDockTab | undefined;
  let dock: LessonDockPanelTab | undefined;
  const steps = lesson.steps.slice(0, k + 1);
  steps.forEach((step, i) => {
    ops.push(...stepOps(step, 'open'));
    if (i < k || revealed) ops.push(...stepOps(step, 'reveal'));
    tab = stepTab(step) ?? tab;
    dock = stepDockTab(step) ?? dock;
  });
  const current = lesson.steps[k];
  return {
    ops,
    highlight: current ? stepHighlight(current) : [],
    ...(tab ? { tab } : {}),
    ...(dock ? { dock } : {}),
  };
}

/**
 * Next: the ops going from step k (as it is now) to step k+1 opened. A step
 * left unrevealed keeps its reveal ops unapplied: Next after a skipped reveal
 * skips it.
 */
export function advanceOps(lesson: Lesson, k: number): BoardOp[] {
  const next = lesson.steps[k + 1];
  return next ? stepOps(next, 'open') : [];
}

export type PageDownAction = 'reveal' | 'next' | 'none';

/** PageDown on a step whose answer is still hidden reveals first; on the last step once revealed, nothing. */
export function pageDownAction(lesson: Lesson, k: number, revealed: boolean): PageDownAction {
  const step = lesson.steps[k];
  if (!step) return 'none';
  if (hasReveal(step) && !revealed) return 'reveal';
  return k + 1 < lesson.steps.length ? 'next' : 'none';
}
