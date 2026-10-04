import { create } from 'zustand';
import { ExprError, parseExpr, printExpr, type Expr } from '../../core/boolean/expr';
import { normalize } from '../../core/boolean/rewrite';
import { createTypedFunction } from '../workbench-circuit/typedFunction';
import type { ExprSelection } from '../components/BoolExpr';
import { advanceReveal, derivedLines, nextMasked, type LawDrill, type Line } from './algebraLogic';
import type { LawId } from '../../core/boolean/laws';

// Session state for the Algebra tab: kept above the tab so switching away and
// back loses nothing, never persisted and never in a board or its undo.

export type AlgebraSection = 'laws' | 'canonical' | 'simplify';
export type SimplifyMode = 'hand' | 'worked';

/** The Canonical forms input, apart from the Analyze drawer's own function. */
export const useCanonicalFunction = createTypedFunction();

interface AlgebraState {
  section: AlgebraSection;
  setSection: (s: AlgebraSection) => void;

  drill: LawDrill;
  revealedLaws: LawId[];
  setDrill: (d: LawDrill) => void;
  revealLaw: (id: LawId) => void;
  revealNextLaw: () => void;
  resetLaws: () => void;

  mode: SimplifyMode;
  setMode: (m: SimplifyMode) => void;
  startText: string;
  startError: { message: string; offset: number } | null;
  /** The line the student started from; null before Start. */
  start: Expr | null;
  setStartText: (t: string) => void;
  begin: () => void;
  /** By hand: the ladder so far, the first line being the start. */
  lines: Line[];
  /** The ladder a Start on a new expression replaced, for Undo to bring back. */
  previous: { start: Expr; lines: Line[] } | null;
  selection: ExprSelection | null;
  select: (s: ExprSelection | null) => void;
  pushLine: (line: Line) => void;
  undo: () => void;
  /** Worked: the derivation and how much of it is on screen. */
  derived: Line[];
  shown: number;
  open: number;
  step: (hiding: boolean) => void;
  revealRest: () => void;
  restart: () => void;
}

const NO_REVEAL = { derived: [] as Line[], shown: 0, open: 0, selection: null };

export const useAlgebraStore = create<AlgebraState>((set, get) => ({
  section: 'laws',
  setSection: (section) => set({ section }),

  drill: 'none',
  revealedLaws: [],
  setDrill: (drill) => set({ drill, revealedLaws: [] }),
  revealLaw: (id) => set((s) => ({ revealedLaws: [...s.revealedLaws, id] })),
  revealNextLaw: () => {
    const { drill, revealedLaws } = get();
    const next = nextMasked(drill, revealedLaws);
    if (next) set({ revealedLaws: [...revealedLaws, next] });
  },
  resetLaws: () => set({ revealedLaws: [] }),

  mode: 'hand',
  setMode: (mode) => {
    set({ mode });
    get().restart();
  },
  startText: '',
  startError: null,
  start: null,
  setStartText: (startText) => set({ startText, startError: null }),
  begin: () => {
    try {
      const start = normalize(parseExpr(get().startText));
      const { start: current, lines, previous, mode } = get();
      // Start again on the same line keeps the work; only a new one replaces it.
      if (current && printExpr(current) === printExpr(start)) {
        set({ startError: null });
        return;
      }
      set({
        start,
        startError: null,
        ...NO_REVEAL,
        lines: [{ expr: start, cite: null }],
        previous: current && lines.length > 1 ? { start: current, lines } : previous,
        derived: mode === 'worked' ? derivedLines(start) : [],
      });
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      set({ startError: { message: e.message, offset: e.offset } });
    }
  },
  lines: [],
  previous: null,
  selection: null,
  select: (selection) => set({ selection }),
  pushLine: (line) => set((s) => ({ lines: [...s.lines, line], selection: null })),
  undo: () =>
    set((s) => {
      if (s.lines.length > 1) return { lines: s.lines.slice(0, -1), selection: null };
      if (!s.previous) return {};
      const { start, lines } = s.previous;
      return {
        start,
        startText: printExpr(start),
        startError: null,
        lines,
        previous: null,
        ...NO_REVEAL,
        derived: s.mode === 'worked' ? derivedLines(start) : [],
      };
    }),
  derived: [],
  shown: 0,
  open: 0,
  step: (hiding) =>
    set((s) => advanceReveal({ shown: s.shown, open: s.open }, s.derived.length, hiding)),
  revealRest: () => set((s) => ({ shown: s.derived.length, open: s.derived.length })),
  // The worked reveal back to its first line. The hand ladder is left alone, so
  // a trip to Worked and back loses nothing.
  restart: () => {
    const { start, mode } = get();
    set({ ...NO_REVEAL, derived: start && mode === 'worked' ? derivedLines(start) : [] });
  },
}));
