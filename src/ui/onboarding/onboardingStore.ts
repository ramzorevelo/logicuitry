// The welcome card and the tutorial are one state machine: at most one of them
// shows, and every way out lands on 'off'. Nothing here runs on a timer.

import { create } from 'zustand';

export type OnboardingPhase = 'off' | 'welcome' | 'tour' | 'build';

/** The board the hands-on part builds on. A different id in the store means
 *  another document replaced it, which ends the tutorial. */
export const TUTORIAL_BOARD_ID = 'first-circuit';

interface OnboardingState {
  phase: OnboardingPhase;
  /** Index into the tour stops that are on screen right now. */
  stop: number;
  /** A document reached the board at startup, so this launch is not a blank first look. */
  documentOpened: boolean;
  showWelcome(): void;
  startTour(): void;
  setStop(stop: number): void;
  startBuild(): void;
  end(): void;
  noteDocumentOpened(): void;
  /** Esc that the board had nothing to cancel for: the hands-on part's way out. */
  idleEscape(): void;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  phase: 'off',
  stop: 0,
  documentOpened: false,
  showWelcome: () => set({ phase: 'welcome' }),
  startTour: () => set({ phase: 'tour', stop: 0 }),
  setStop: (stop) => set({ stop }),
  startBuild: () => set({ phase: 'build' }),
  end: () => set({ phase: 'off', stop: 0 }),
  noteDocumentOpened: () => {
    if (get().phase === 'welcome') set({ phase: 'off' });
    set({ documentOpened: true });
  },
  idleEscape: () => {
    if (get().phase === 'build') set({ phase: 'off' });
  },
}));
