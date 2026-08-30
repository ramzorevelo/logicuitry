import type { LibraryDir } from '../io/platform';
import { create } from 'zustand';

export type Workbench = 'numbers' | 'circuit' | 'devicelab';

interface ShellState {
  workbench: Workbench;
  setWorkbench: (workbench: Workbench) => void;
  /** Where packaged chips are read from and written to. */
  chipsDir: LibraryDir | null;
  setChipsDir: (dir: LibraryDir | null) => void;
  /** Where Open and Save As start. Separate from the chip shelf on purpose:
   *  a library of parts and a folder of the instructor's own boards are
   *  different things and rarely live together. */
  boardsDir: LibraryDir | null;
  setBoardsDir: (dir: LibraryDir | null) => void;
}

// ?wb=circuit etc. picks the starting workbench (headless visual QA cannot click).
function initialWorkbench(): Workbench {
  const wb =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('wb') : null;
  return wb === 'circuit' || wb === 'devicelab' || wb === 'numbers' ? wb : 'numbers';
}

export const useShellStore = create<ShellState>((set) => ({
  workbench: initialWorkbench(),
  setWorkbench: (workbench) => set({ workbench }),
  chipsDir: null,
  setChipsDir: (chipsDir) => set({ chipsDir }),
  boardsDir: null,
  setBoardsDir: (boardsDir) => set({ boardsDir }),
}));
