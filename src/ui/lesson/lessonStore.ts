import { create } from 'zustand';
import type { Lesson, LessonDockTab } from '../../core/model/types';
import {
  advanceOps,
  hasReveal,
  pageDownAction,
  replayPlan,
  rowMissingText,
  rowWhileOffText,
  stepDockTab,
  stepHighlight,
  stepOps,
  stepTab,
  type BoardOp,
} from '../../core/lesson';
import { useCircuitStore, type DockTab } from '../workbench-circuit/circuitStore';

interface LessonState {
  lesson: Lesson | null;
  step: number;
  /** Steps whose answer is showing. */
  revealed: ReadonlySet<number>;
  /** Chip index the class picked, by step. */
  picked: ReadonlyMap<number, number>;
  /** Rows the current step skipped, as shown in its "This step" box. */
  notes: readonly string[];
  /** A step asked for Analyze, which is the workbench's own drawer: it opens
   *  the drawer and clears this, now or when it next mounts. */
  analyzePending: boolean;
  /** Started by the editor's Play: Esc and Close go back to it. */
  fromEditor: boolean;
  analyzeServed: () => void;
  /** `keepDock`: handed over from the editor, so its dock at start stays the one Back rebuilds. */
  open: (
    lesson: Lesson,
    start?: number,
    opts?: { fromEditor?: boolean; keepDock?: boolean },
  ) => void;
  close: () => void;
  next: () => void;
  back: () => void;
  jump: (k: number) => void;
  reveal: () => void;
  pageDown: () => void;
  pageUp: () => void;
  pick: (chip: number) => void;
}

const DOCK_TABS: Record<Exclude<LessonDockTab, 'analyze'>, DockTab> = {
  waveform: 'waves',
  checks: 'checks',
  sequence: 'sequence',
};

const circuit = () => useCircuitStore.getState();

/** The dock as the lesson found it: a replay rebuilds it from here, as it rebuilds the board. */
let dockAtStart: { open: boolean; tab: DockTab } | null = null;

export function rememberDockAtStart(): void {
  const c = circuit();
  dockAtStart = { open: c.waveformOpen, tab: c.dockTab };
}

function restoreDockAtStart(): void {
  if (!dockAtStart) return;
  const c = circuit();
  if (c.waveformOpen !== dockAtStart.open) c.setWaveformOpen(dockAtStart.open);
  if (c.dockTab !== dockAtStart.tab) c.setDockTab(dockAtStart.tab);
}

const CLOSED = {
  lesson: null,
  step: 0,
  revealed: new Set<number>(),
  picked: new Map<number, number>(),
  notes: [],
  analyzePending: false,
  fromEditor: false,
} as const;

function applyOp(op: BoardOp, notes: string[]): void {
  const c = circuit();
  switch (op.op) {
    case 'power':
      if (c.powered !== op.on) c.power();
      return;
    case 'timing': {
      if (c.timing.mode === op.mode) return;
      const wasPowered = c.powered;
      c.setSessionTiming(op.mode);
      if (wasPowered) circuit().power();
      return;
    }
    case 'row':
      if (circuit().applySequenceRow(op.index)) return;
      notes.push(circuit().powered ? rowMissingText(op.index) : rowWhileOffText(op.index));
  }
}

function applyOps(ops: readonly BoardOp[]): string[] {
  const notes: string[] = [];
  for (const op of ops) applyOp(op, notes);
  return notes;
}

/** Rows, power and timing act on the board tab's sim, whatever tab is showing. */
function onBoardTab(): void {
  if (circuit().activeTabId !== 'board') circuit().setActiveTab('board');
}

/**
 * Step k as it looks however it was reached: replayed from the board as saved,
 * Run off. Returns the notes for rows step k itself skipped. `keepDock` leaves
 * the dock as the author has it, for a replay that stays on the same step.
 */
export function showStepOnBoard(
  lesson: Lesson,
  k: number,
  showAnswer: boolean,
  opts?: { keepDock?: boolean },
): string[] {
  onBoardTab();
  circuit().resetForLesson();
  const plan = replayPlan(lesson, k, showAnswer);
  const step = lesson.steps[k];
  const own = step
    ? stepOps(step, 'open').length + (showAnswer ? stepOps(step, 'reveal').length : 0)
    : 0;
  applyOps(plan.ops.slice(0, plan.ops.length - own));
  const notes = applyOps(plan.ops.slice(plan.ops.length - own));
  circuit().setLessonHighlight(plan.highlight);
  if (!opts?.keepDock) restoreDockAtStart();
  openDockTab(plan.dock);
  if (plan.tab === 'analyze') openDockTab('analyze');
  return notes;
}

/** Analyze is the workbench's own drawer, so it is asked for rather than opened. */
function openDockTab(tab: LessonDockTab | undefined): void {
  if (!tab) return;
  if (tab === 'analyze') {
    useLessonStore.setState({ analyzePending: true });
    return;
  }
  circuit().setWaveformOpen(true);
  circuit().setDockTab(DOCK_TABS[tab]);
}

/** The board back to itself: no highlight, the saved timing mode. */
export function restoreBoardAfterLesson(): void {
  const c = circuit();
  c.setLessonHighlight([]);
  const saved = c.board.timing.mode;
  if (c.timing.mode !== saved) applyOp({ op: 'timing', mode: saved }, []);
}

export const useLessonStore = create<LessonState>((set, get) => {
  const replayTo = (lesson: Lesson, k: number, showAnswer: boolean) => {
    const notes = showStepOnBoard(lesson, k, showAnswer);
    const revealed = new Set<number>();
    for (let i = 0; i < k; i++) if (hasReveal(lesson.steps[i]!)) revealed.add(i);
    if (showAnswer) revealed.add(k);
    set({ step: k, revealed, notes });
  };

  return {
    lesson: null,
    step: 0,
    revealed: new Set(),
    picked: new Map(),
    notes: [],
    analyzePending: false,
    fromEditor: false,
    analyzeServed: () => set({ analyzePending: false }),

    open: (lesson, start = 0, opts) => {
      if (lesson.steps.length === 0) return;
      const k = Math.max(0, Math.min(start, lesson.steps.length - 1));
      // From the editor, the editor's own start is the one Back rebuilds to.
      if (!opts?.fromEditor && !opts?.keepDock) rememberDockAtStart();
      set({ lesson, picked: new Map(), fromEditor: opts?.fromEditor ?? false });
      replayTo(lesson, k, false);
    },

    close: () => {
      if (!get().lesson) return;
      set(CLOSED);
      restoreBoardAfterLesson();
    },

    next: () => {
      const { lesson, step } = get();
      const target = lesson?.steps[step + 1];
      if (!lesson || !target) return;
      circuit().clearTransientError();
      onBoardTab();
      const notes = applyOps(advanceOps(lesson, step));
      circuit().setLessonHighlight(stepHighlight(target));
      openDockTab(stepDockTab(target));
      if (stepTab(target) === 'analyze') openDockTab('analyze');
      set({ step: step + 1, notes });
    },

    back: () => {
      const { step } = get();
      if (step > 0) get().jump(step - 1);
    },

    jump: (k) => {
      const { lesson, revealed } = get();
      if (!lesson || k < 0 || k >= lesson.steps.length) return;
      circuit().clearTransientError();
      replayTo(lesson, k, revealed.has(k));
      // A compile error raised by the replay says why the board is off; keep it.
      if (circuit().error) return;
      const paused = circuit().powered ? ': the sim is paused' : '';
      useCircuitStore.setState({ error: `lesson: Replayed to step ${k + 1}${paused}` });
    },

    reveal: () => {
      const { lesson, step, revealed, notes } = get();
      const current = lesson?.steps[step];
      if (!current || !hasReveal(current) || revealed.has(step)) return;
      circuit().clearTransientError();
      onBoardTab();
      const skipped = applyOps(stepOps(current, 'reveal'));
      set({ revealed: new Set([...revealed, step]), notes: [...notes, ...skipped] });
    },

    pageDown: () => {
      const { lesson, step, revealed } = get();
      if (!lesson) return;
      const action = pageDownAction(lesson, step, revealed.has(step));
      if (action === 'reveal') get().reveal();
      else if (action === 'next') get().next();
    },

    pageUp: () => get().back(),

    pick: (chip) => {
      const { step, picked } = get();
      const next = new Map(picked);
      if (next.get(step) === chip) next.delete(step);
      else next.set(step, chip);
      set({ picked: next });
    },
  };
});

// A lesson belongs to the board it opened over; another board ends it without
// touching that board's own timing, which loadBoard has just set.
useCircuitStore.subscribe((s, prev) => {
  if (s.boardLoads === prev.boardLoads || !useLessonStore.getState().lesson) return;
  useLessonStore.setState(CLOSED);
});
