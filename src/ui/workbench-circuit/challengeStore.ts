import { create } from 'zustand';
import type { BehaviorReport } from '../../core/challenge/behavior';
import { emptyChallenge, partsOnBoard } from '../../core/challenge/challenge';
import type { Board, Challenge, ChipLibrary, TimingSetting } from '../../core/model/types';
import { useCircuitStore } from './circuitStore';
import { checkInBackground, type BackgroundCheck, type CheckInput } from './checkInBackground';

/** What a check read. Every edit replaces one of these, so a changed one means a stale result. */
interface CheckBasis {
  boardLoads: number;
  components: Board['components'];
  wires: Board['wires'];
  junctions: Board['junctions'];
  groups: Board['groups'];
  challenge: Board['challenge'];
  timing: TimingSetting;
  /** A chip def edit changes what a placed instance does without touching the board. */
  chipLib: ChipLibrary;
}

interface CircuitSlice {
  board: Board;
  boardLoads: number;
  timing: TimingSetting;
  chipLib: ChipLibrary;
}

const basisOf = (s: CircuitSlice): CheckBasis => ({
  boardLoads: s.boardLoads,
  components: s.board.components,
  wires: s.board.wires,
  junctions: s.board.junctions,
  groups: s.board.groups,
  challenge: s.board.challenge,
  timing: s.timing,
  chipLib: s.chipLib,
});

export type CheckFreshness = 'none' | 'fresh' | 'stale';

/** Whether the last check is about this board as it stands; another board loaded means none. */
export function freshness(last: { basis: CheckBasis } | null, s: CircuitSlice): CheckFreshness {
  // An edited challenge asks a different question: the old answers do not line up with it.
  if (!last || last.basis.boardLoads !== s.boardLoads || last.basis.challenge !== s.board.challenge)
    return 'none';
  const now = basisOf(s);
  const same = (Object.keys(now) as (keyof CheckBasis)[]).every((k) => now[k] === last.basis[k]);
  return same ? 'fresh' : 'stale';
}

interface ChallengeState {
  /** Session only, never saved: a reopened board reads "not checked". */
  last: { report: BehaviorReport; basis: CheckBasis } | null;
  checking: BackgroundCheck | null;
  /** The Edit or New challenge dialog, while it is open. */
  editor: { initial: Challenge; isNew: boolean } | null;
  /** New starts from this board: its name and the parts it already uses. */
  openEditor: (isNew: boolean) => void;
  closeEditor: () => void;
  check: (run?: (input: CheckInput) => BackgroundCheck) => Promise<void>;
  cancel: () => void;
}

export const useChallengeStore = create<ChallengeState>((set, get) => ({
  last: null,
  checking: null,
  editor: null,

  openEditor: (isNew) => {
    const s = useCircuitStore.getState();
    const current = s.board.challenge;
    if (!isNew && !current) return;
    const initial =
      isNew || !current
        ? {
            ...emptyChallenge(),
            title: s.board.name,
            allowed: partsOnBoard(s.board, s.chipLib),
          }
        : current;
    set({ editor: { initial, isNew } });
  },

  closeEditor: () => set({ editor: null }),

  check: async (run = checkInBackground) => {
    const s = useCircuitStore.getState();
    const challenge = s.board.challenge;
    if (!challenge || get().checking) return;
    const basis = basisOf(s);
    const job = run({ board: s.board, library: s.chipLib, challenge, timing: s.timing });
    set({ checking: job });
    try {
      const report = await job.result;
      if (report) set({ last: { report, basis } });
    } finally {
      if (get().checking === job) set({ checking: null });
    }
  },

  cancel: () => {
    get().checking?.cancel();
    set({ checking: null });
  },
}));
