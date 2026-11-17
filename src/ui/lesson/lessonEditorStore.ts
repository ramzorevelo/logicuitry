import { create } from 'zustand';
import type { Lesson, LessonAction, LessonStep } from '../../core/model/types';
import type { DocFile } from '../../io/fsAccess';
import {
  deleteStep,
  duplicateStep,
  flaggedSteps,
  hasReveal,
  insertStep,
  lessonWarnings,
  moveStep,
  newStep,
  playWarningText,
  renumberRows,
  replaceAction,
  replayPlan,
  rowShift,
  setStepKind,
  stepOps,
  toggleHighlight,
  updateStep,
  type EditableKind,
  lessonBoardViewOf,
} from '../../core/lesson';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import {
  rememberDockAtStart,
  restoreBoardAfterLesson,
  showStepOnBoard,
  useLessonStore,
} from './lessonStore';

interface Snapshot {
  lesson: Lesson;
  sel: number;
}

interface PickState {
  /** Index of the highlight action in the selected step. */
  action: number;
  before: string[];
  /** The lesson when the pick began: cancel and an unchanged finish go back to this very object. */
  base: Lesson;
}

export interface PendingClose {
  /** What was asked for, as the prompt's heading. */
  action: string;
  run: () => void;
}

interface LessonEditorState {
  draft: Lesson | null;
  /** Where Save writes inside the library's `lessons/` folder, or the name the picker suggests. */
  fileName: string;
  /** A file outside the library that Save writes back to without asking. */
  file: DocFile | null;
  /** The draft as last saved or opened; null for a lesson never saved. */
  saved: Lesson | null;
  /** Ids a never-saved lesson must avoid; its id and file come from its title at the first save. */
  takenIds: ReadonlySet<string> | null;
  sel: number;
  /** On a predict step that holds actions back: show the board after the reveal. */
  afterReveal: boolean;
  pick: PickState | null;
  past: readonly Snapshot[];
  future: readonly Snapshot[];
  /** Play from this step is running; the editor waits under it. */
  playing: boolean;
  pendingClose: PendingClose | null;
  /** Bumped on every save, so the library's lesson list reloads. */
  savedCount: number;

  open: (
    lesson: Lesson,
    fileName: string,
    /** `keepDock`: handed over from the runner, so its dock at start stays the one Back rebuilds. */
    opts?: {
      step?: number;
      isNew?: boolean;
      takenIds?: ReadonlySet<string>;
      keepDock?: boolean;
      file?: DocFile;
    },
  ) => void;
  /** Drops the draft without asking and gives the board back. */
  close: () => void;
  /** Runs `run` once the editor is closed, asking first when the draft is unsaved. */
  requestClose: (action: string, run?: () => void) => void;
  resolveClose: (choice: 'discard' | 'cancel' | 'saved') => void;
  markSaved: (lesson: Lesson, file?: DocFile) => void;
  /** Renames the draft, its undo history with it, and moves where Save writes. */
  assignId: (id: string, fileName: string) => void;

  select: (i: number) => void;
  setAfterReveal: (after: boolean) => void;
  commit: (fn: (lesson: Lesson) => Lesson, sel?: number) => void;
  /** Called on a text box's focus: its first edit becomes one undo step. */
  beginText: () => void;
  editText: (fn: (lesson: Lesson) => Lesson) => void;
  undo: () => void;
  redo: () => void;

  addStep: (kind: EditableKind) => void;
  deleteStep: (i: number) => boolean;
  duplicateStep: (i: number) => void;
  moveStep: (from: number, to: number) => void;
  /** Returns a notice when held-back rows were moved to the step's open. */
  setKind: (kind: EditableKind) => string | null;
  updateSelected: (fn: (step: LessonStep) => LessonStep) => void;

  beginPick: (action: number) => void;
  /** A click on the board: one part, or a group's parts as one. */
  togglePick: (ids: readonly string[]) => void;
  finishPick: () => void;
  cancelPick: () => void;

  /** Play from `step` (default the selected one); Esc comes back to the editor there. */
  play: (step?: number) => void;
  backFromPlay: () => void;
}

const UNDO_LIMIT = 200;
const circuit = () => useCircuitStore.getState();

const CLOSED = {
  draft: null,
  fileName: '',
  file: null,
  saved: null,
  takenIds: null,
  sel: 0,
  afterReveal: false,
  pick: null,
  past: [],
  future: [],
  playing: false,
  pendingClose: null,
} as const;

/** Text boxes stash the state they opened on; it becomes an undo step on the first keystroke. */
let textBase: Snapshot | null = null;

export function lessonDirty(s: Pick<LessonEditorState, 'draft' | 'saved'>): boolean {
  return s.draft !== null && s.draft !== s.saved;
}

/** Whether the board shows step k after its reveal: only a step whose reveal changes the board. */
export function showsAnswer(lesson: Lesson, k: number, afterReveal: boolean): boolean {
  const step = lesson.steps[k];
  return !!step && afterReveal && hasReveal(step) && stepOps(step, 'reveal').length > 0;
}

export const useLessonEditorStore = create<LessonEditorState>((set, get) => {
  const pushPast = (past: readonly Snapshot[], snap: Snapshot) =>
    [...past, snap].slice(-UNDO_LIMIT);

  return {
    ...CLOSED,
    savedCount: 0,

    open: (lesson, fileName, opts) => {
      textBase = null;
      if (!opts?.keepDock) rememberDockAtStart();
      const k = Math.max(0, Math.min(opts?.step ?? 0, lesson.steps.length - 1));
      set({
        ...CLOSED,
        draft: lesson,
        fileName,
        file: opts?.file ?? null,
        saved: opts?.isNew ? null : lesson,
        takenIds: opts?.isNew ? (opts.takenIds ?? new Set()) : null,
        sel: k,
      });
    },

    close: () => {
      if (!get().draft) return;
      textBase = null;
      const wasPlaying = get().playing;
      set(CLOSED);
      if (wasPlaying) useLessonStore.getState().close();
      circuit().resetForLesson();
      restoreBoardAfterLesson();
    },

    requestClose: (action, run) => {
      const s = get();
      if (!s.draft) {
        run?.();
        return;
      }
      if (!lessonDirty(s)) {
        s.close();
        run?.();
        return;
      }
      set({ pendingClose: { action, run: run ?? (() => {}) } });
    },

    resolveClose: (choice) => {
      const pending = get().pendingClose;
      set({ pendingClose: null });
      if (!pending || choice === 'cancel') return;
      get().close();
      pending.run();
    },

    markSaved: (lesson, file) =>
      set({
        saved: lesson,
        takenIds: null,
        savedCount: get().savedCount + 1,
        ...(file ? { file } : {}),
      }),

    assignId: (id, fileName) => {
      const { draft, past, future } = get();
      if (!draft) return;
      const rename = (snap: Snapshot): Snapshot => ({ ...snap, lesson: { ...snap.lesson, id } });
      if (textBase) textBase = rename(textBase);
      set({
        draft: { ...draft, id },
        past: past.map(rename),
        future: future.map(rename),
        fileName,
      });
    },

    select: (i) => {
      const { draft, pick } = get();
      if (!draft) return;
      if (pick) get().cancelPick();
      textBase = null;
      set({ sel: Math.max(0, Math.min(draft.steps.length - 1, i)), afterReveal: false });
    },

    setAfterReveal: (afterReveal) => set({ afterReveal }),

    commit: (fn, sel) => {
      if (get().pick) get().finishPick();
      const { draft, past } = get();
      if (!draft) return;
      const next = fn(draft);
      if (next === draft) return;
      textBase = null;
      const k = Math.max(0, Math.min(next.steps.length - 1, sel ?? get().sel));
      set({
        draft: next,
        past: pushPast(past, { lesson: draft, sel: get().sel }),
        future: [],
        sel: k,
      });
    },

    beginText: () => {
      // Typing ends a pick, or a later cancel would put back the text it predates.
      if (get().pick) get().finishPick();
      const { draft, sel } = get();
      textBase = draft ? { lesson: draft, sel } : null;
    },

    editText: (fn) => {
      if (get().pick) get().finishPick();
      const { draft, past } = get();
      if (!draft) return;
      const next = fn(draft);
      if (next === draft) return;
      if (textBase) {
        set({ draft: next, past: pushPast(past, textBase), future: [] });
        textBase = null;
      } else set({ draft: next });
    },

    undo: () => {
      if (get().pick) get().cancelPick();
      const { draft, past, future, sel } = get();
      const prev = past[past.length - 1];
      if (!draft || !prev) return;
      textBase = null;
      set({
        draft: prev.lesson,
        sel: prev.sel,
        past: past.slice(0, -1),
        future: [...future, { lesson: draft, sel }],
        afterReveal: false,
      });
    },

    redo: () => {
      if (get().pick) get().cancelPick();
      const { draft, past, future, sel } = get();
      const next = future[future.length - 1];
      if (!draft || !next) return;
      textBase = null;
      set({
        draft: next.lesson,
        sel: next.sel,
        future: future.slice(0, -1),
        past: pushPast(past, { lesson: draft, sel }),
        afterReveal: false,
      });
    },

    addStep: (kind) => {
      const at = get().sel + 1;
      get().commit((l) => insertStep(l, at, newStep(kind)), at);
    },

    deleteStep: (i) => {
      const draft = get().draft;
      const next = draft && deleteStep(draft, i);
      if (!next) return false;
      const sel = get().sel;
      get().commit(() => next, sel > i || sel >= next.steps.length ? sel - 1 : sel);
      return true;
    },

    duplicateStep: (i) => get().commit((l) => duplicateStep(l, i), i + 1),

    moveStep: (from, to) => get().commit((l) => moveStep(l, from, to), to),

    setKind: (kind) => {
      const sel = get().sel;
      let held = 0;
      get().commit((l) =>
        updateStep(l, sel, (s) => {
          const r = setStepKind(s, kind);
          held = r.heldRows;
          return r.step;
        }),
      );
      return held > 0
        ? 'Narrate steps have no reveal, so held-back rows and pulses now apply when the step opens'
        : null;
    },

    updateSelected: (fn) => {
      const sel = get().sel;
      get().commit((l) => updateStep(l, sel, fn));
    },

    beginPick: (action) => {
      const { draft, sel, pick } = get();
      const a = draft?.steps[sel]?.actions[action];
      if (a?.kind !== 'highlight') return;
      if (pick) get().finishPick();
      set({ pick: { action, before: [...a.components], base: get().draft! } });
    },

    togglePick: (ids) => {
      const { draft, sel, pick } = get();
      const a = pick && draft?.steps[sel]?.actions[pick.action];
      if (!draft || !pick || a?.kind !== 'highlight') return;
      const next: LessonAction = { ...a, components: toggleHighlight(a.components, ids) };
      // Live while picking; finishPick turns the whole pick into one undo step.
      set({ draft: updateStep(draft, sel, (s) => replaceAction(s, pick.action, next)) });
    },

    finishPick: () => {
      const { draft, sel, pick, past } = get();
      if (!draft || !pick) return;
      const a = draft.steps[sel]?.actions[pick.action];
      const now = a?.kind === 'highlight' ? a.components : pick.before;
      const changed =
        now.length !== pick.before.length || now.some((id, i) => id !== pick.before[i]);
      if (!changed) set({ pick: null, draft: pick.base });
      else set({ pick: null, past: pushPast(past, { lesson: pick.base, sel }), future: [] });
    },

    cancelPick: () => {
      const { pick } = get();
      if (pick) set({ pick: null, draft: pick.base });
    },

    play: (step) => {
      const { draft, pick } = get();
      const sel = step ?? get().sel;
      if (!draft) return;
      if (pick) get().finishPick();
      const board = circuit().board;
      const flagged = flaggedSteps(lessonWarnings(draft, lessonBoardViewOf(board)));
      circuit().clearTransientError();
      set({ playing: true, sel });
      useLessonStore.getState().open(get().draft!, sel, { fromEditor: true });
      if (flagged.length > 0 && !circuit().error)
        useCircuitStore.setState({ error: `lesson: ${playWarningText(flagged)}` });
    },

    backFromPlay: () => {
      if (!get().playing) return;
      const step = useLessonStore.getState().step;
      useLessonStore.getState().close();
      // Leaving `playing` replays through the subscription; syncBoard dropped its key while playing.
      set({ playing: false, sel: step, afterReveal: false });
    },
  };
});

/** The board shows the selected step as the class sees it; replayed only when what it shows changes. */
let replayed: string | null = null;
/** Step last replayed: an edit replays the same step and leaves the dock as the author set it. */
let replayedSel: number | null = null;

function syncBoard(): void {
  const s = useLessonEditorStore.getState();
  if (!s.draft || s.playing) {
    replayed = null;
    replayedSel = null;
    return;
  }
  const answer = showsAnswer(s.draft, s.sel, s.afterReveal);
  const plan = replayPlan(s.draft, s.sel, answer);
  const key = JSON.stringify({ ops: plan.ops, tab: plan.tab ?? null, sel: s.sel, answer });
  if (key !== replayed) {
    replayed = key;
    showStepOnBoard(s.draft, s.sel, answer, { keepDock: replayedSel === s.sel });
    replayedSel = s.sel;
  }
  const pick = s.pick && s.draft.steps[s.sel]?.actions[s.pick.action];
  circuit().setLessonHighlight(pick?.kind === 'highlight' ? pick.components : plan.highlight);
}

useLessonEditorStore.subscribe((s, prev) => {
  if (
    s.draft !== prev.draft ||
    s.sel !== prev.sel ||
    s.afterReveal !== prev.afterReveal ||
    s.pick !== prev.pick ||
    s.playing !== prev.playing
  )
    syncBoard();
});

/** A row inserted or deleted in the Sequence tab renumbers every reference, undo history included. */
useCircuitStore.subscribe((s, prev) => {
  const ed = useLessonEditorStore.getState();
  if (!ed.draft) return;
  if (s.boardLoads !== prev.boardLoads) {
    // The guarded paths asked already; this only catches a load that bypassed them.
    textBase = null;
    replayed = null;
    useLessonEditorStore.setState(CLOSED);
    return;
  }
  if (s.board.sequence === prev.board.sequence) return;
  const shift = rowShift(prev.board.sequence?.rows ?? [], s.board.sequence?.rows ?? []);
  replayed = null;
  if (!shift) {
    if (!ed.playing) queueMicrotask(syncBoard);
    return;
  }
  const fix = (snap: Snapshot): Snapshot => ({ ...snap, lesson: renumberRows(snap.lesson, shift) });
  if (textBase) textBase = fix(textBase);
  useLessonEditorStore.setState({
    draft: renumberRows(ed.draft, shift),
    past: ed.past.map(fix),
    future: ed.future.map(fix),
  });
});
