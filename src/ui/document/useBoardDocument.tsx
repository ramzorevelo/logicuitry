// The document layer: which file the board came from, whether it has unsaved
// edits, autosave, and the File menu's commands.
//
// This lives in the shell rather than in the Circuit workbench because the
// board is global state; keeping it in the workbench meant File vanished
// from the menu bar whenever Numbers or Device Lab was showing, and autosave
// only ran while the canvas happened to be mounted.
//
// Import and "Package as chip" deliberately stay in the workbench: both need
// the canvas (the current view's centre, the live selection).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, ChipDef } from '../../core/model/types';
import { exportDoc, filePickersSupported } from '../../io/fsAccess';
import {
  boardFileName,
  loadRecentBoards,
  openBoardFile,
  pickDocumentFile,
  readDocumentFile,
  rememberRecentBoard,
  saveBoardAs,
  writeBoardTo,
  type OpenedDocument,
  type RecentBoard,
} from '../../io/boardFile';
import { parseDocument, serializeDocument } from '../../io/library';
import { loadSession, saveSession } from '../../io/sessionStore';
import { starterBoard, useCircuitStore } from '../workbench-circuit/circuitStore';
import { OpenChipDialog } from '../workbench-circuit/OpenChipDialog';
import { ExamplesDialog } from '../components/ExamplesDialog';
import { isDesktop } from '../../io/platform';
import type { DocFile } from '../../io/platform';
import type { Example } from '../../examples';
import { UnsavedChangesDialog } from '../workbench-circuit/UnsavedChangesDialog';
import { useShellStore } from '../store';
import { getPrefs } from '../prefs';
import { SHORTCUTS } from '../menu/shortcuts';
import type { Menu } from '../menu/menuModel';

const AUTOSAVE_DEBOUNCE_MS = 400;

export interface BoardDocument {
  /** File menu contribution, ready to hand to useContributeMenus. */
  menus: Menu[];
  /** Rendered by the shell: both dialogs belong to the document, not a canvas. */
  dialogs: JSX.Element | null;
  dirty: boolean;
}

export function useBoardDocument(): BoardDocument {
  const store = useCircuitStore;
  // Every File command acts on the board, so off the Circuit workbench they
  // are greyed rather than hidden: a menu bar that changes shape as you switch
  // tabs is harder to learn than one whose items grey out.
  const onBoard = useShellStore((st) => st.workbench) === 'circuit';
  const rev = useCircuitStore((s) => s.rev);
  // Open and Save As start in the BOARDS folder, not the chip shelf.
  const boardsDir = useShellStore((st) => st.boardsDir);

  // The file this board came from (Save writes back here) and whether it has
  // edits since the last save/load. Both ride along in the autosave so a
  // reload lands on the same document, not just the same shapes.
  const [currentFile, setCurrentFile] = useState<DocFile | null>(null);
  const [dirty, setDirty] = useState(false);
  // `rev` at the last save or load: anything past it is unsaved work.
  const cleanRevRef = useRef<number | null>(null);
  const markClean = useCallback(() => {
    cleanRevRef.current = store.getState().rev;
    setDirty(false);
  }, [store]);

  useEffect(() => {
    if (cleanRevRef.current === null) {
      cleanRevRef.current = rev;
      return;
    }
    setDirty(rev !== cleanRevRef.current);
  }, [rev]);

  // Restore once on mount, then autosave whenever the board settles. Both go
  // through the normal document pipeline: a restored board is migrated and
  // schema-validated like any file, never trusted just because we wrote it.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!getPrefs().restoreLastBoard) return;
    void loadSession()
      .then((session) => {
        if (!session) return;
        const doc = parseDocument(serializeDocument(session.board));
        if (doc.format !== 'lcir.board') return;
        useCircuitStore.getState().loadBoard(doc);
        if (getPrefs().fitOnOpen) useCircuitStore.getState().requestFit();
        setCurrentFile(session.file ?? null);
        markClean();
        setDirty(session.dirty);
      })
      .catch(() => {
        // A corrupt or stale session must never block startup: the starter
        // board is already loaded, so silently keep it.
      });
  }, [markClean]);

  useEffect(() => {
    if (!restoredRef.current || !getPrefs().autosave) return;
    const id = window.setTimeout(() => {
      const st = store.getState();
      void saveSession({
        board: st.board,
        ...(currentFile ? { file: currentFile } : {}),
        dirty,
        savedAt: Date.now(),
      }).catch(() => {
        // Storage full or blocked -- autosave is best-effort by design.
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [rev, currentFile, dirty, store]);

  // The menu bar builds its items up front, so the recent list loads on mount
  // and again whenever the board's own file changes (which is what adds one).
  const [recents, setRecents] = useState<RecentBoard[]>([]);
  useEffect(() => {
    void loadRecentBoards()
      .then(setRecents)
      .catch(() => setRecents([]));
  }, [currentFile]);

  // Anything that replaces the board asks first, and offers Save rather than
  // only discard/cancel. Held here until UnsavedChangesDialog answers; `run`
  // is the action that was interrupted.
  const [pendingDiscard, setPendingDiscard] = useState<{
    action: string;
    run: () => void;
  } | null>(null);

  /** Runs `run` now when there is nothing to lose, else asks. Turning the
   *  confirmation preference off skips the ask entirely, unsaved work included
   *  -- that is what the preference says. */
  const guardDiscard = (action: string, run: () => void) => {
    if (!dirty || !getPrefs().confirmReplaceBoard) run();
    else setPendingDiscard({ action, run });
  };

  // `guardDiscard` closes over `dirty`, which changes on every edit; a ref
  // keeps `acceptOpened` memoised without going stale.
  const guardDiscardRef = useRef(guardDiscard);
  guardDiscardRef.current = guardDiscard;

  const adoptFile = useCallback(
    (file: DocFile, board: Board) => {
      setCurrentFile(file);
      markClean();
      void rememberRecentBoard({ name: file.name, file, openedAt: Date.now() }).catch(() => {
        // The recent list is a convenience; failing to record it changes nothing.
      });
      void board;
    },
    [markClean],
  );

  const [examplesOpen, setExamplesOpen] = useState(false);

  // An example always opens UNTITLED: no file is adopted, so Save is Save As
  // and a bundled example can never be clobbered by a student's edits. The
  // board is deep-copied because the imported JSON module is shared.
  const openExample = (example: Example) => {
    setExamplesOpen(false);
    guardDiscard(`Open ${example.name}`, () => {
      if (example.chips?.length) store.getState().loadChipDefs(structuredClone(example.chips));
      store.getState().loadBoard(structuredClone(example.board));
      // An example ships no camera worth restoring, so it always frames --
      // the `fitOnOpen` preference governs the user's own boards only.
      store.getState().requestFit();
      setCurrentFile(null);
      markClean();
    });
  };

  const fileNew = () => {
    guardDiscard('Start a new board', () => {
      store.getState().loadBoard(starterBoard());
      setCurrentFile(null);
      markClean();
    });
  };

  // A chip file is both a part and a circuit, so the choice is the user's:
  // held here until OpenChipDialog answers.
  const [pendingChip, setPendingChip] = useState<{
    def: ChipDef;
    file: DocFile;
  } | null>(null);

  const acceptOpened = useCallback(
    (doc: OpenedDocument, file: DocFile) => {
      if (doc.kind === 'board') {
        guardDiscardRef.current('Open another board', () => {
          store.getState().loadBoard(doc.board);
          if (getPrefs().fitOnOpen) store.getState().requestFit();
          adoptFile(file, doc.board);
        });
        return;
      }
      setPendingChip({ def: doc.def, file });
    },
    [adoptFile, store],
  );

  // Double-clicking a document in the file manager launches us
  // with the path as an argument; the shell hands it over once, at startup.
  // This is the one capability the PWA cannot match (the File Handling API is
  // Chrome/Edge only).
  useEffect(() => {
    if (!isDesktop()) return;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string | null>('launch_file');
        if (!path) return;
        const name = path.split(/[\/]/).pop() ?? path;
        const file = { name, path } as unknown as DocFile;
        acceptOpened(await readDocumentFile(file), file);
      } catch {
        // No argument, an unreadable file, or a document this app does not
        // open: the app is already running and usable, which is the point.
      }
    })();
  }, [acceptOpened]);

  const resolveChipOpen = (as: 'chip' | 'board') => {
    const pending = pendingChip;
    setPendingChip(null);
    if (!pending) return;
    if (as === 'board') {
      guardDiscard('Open the chip contents as a board', () => {
        // The chip's own ports carry over as ordinary ports; what it loses is
        // its identity as a part (its boundary-pin list), not any component.
        const blank = starterBoard();
        if (getPrefs().fitOnOpen) queueMicrotask(() => store.getState().requestFit());
        store.getState().loadBoard({
          ...blank,
          id: pending.def.id,
          name: pending.def.name,
          probes: [],
          components: pending.def.components,
          wires: pending.def.wires,
          junctions: pending.def.junctions,
        });
        // NOT adoptFile: Save must not overwrite the chip file with a board.
        setCurrentFile(null);
        markClean();
      });
      return;
    }
    openAsChip(pending.def, pending.file);
  };

  const openAsChip = (def: ChipDef, file: DocFile) => {
    const result = store.getState().loadChipDefs([def]);
    if (!result.ok) {
      useCircuitStore.setState({ error: `open: ${result.error}` });
      return;
    }
    // Same flow as double-clicking an instance; the board tab is untouched, so
    // Ctrl+S keeps targeting the board.
    store.getState().openDefTab(def.id, `${def.id}/`, def.name);
    void rememberRecentBoard({ name: file.name, file, openedAt: Date.now() }).catch(() => {
      // Convenience only.
    });
  };

  const fileOpen = async () => {
    try {
      const picked = await openBoardFile(boardsDir ?? undefined);
      if (!picked) return;
      acceptOpened(picked.doc, picked.file);
    } catch (e) {
      useCircuitStore.setState({ error: `open: ${(e as Error).message}` });
    }
  };

  // Open Chip skips OpenChipDialog: the menu item already said which of the
  // two a chip file should be opened as.
  const fileOpenChip = async () => {
    try {
      const file = await pickDocumentFile(boardsDir ?? undefined);
      if (!file) return;
      const doc = await readDocumentFile(file);
      if (doc.kind !== 'chip') {
        useCircuitStore.setState({ error: 'open: that file is a board, not a chip' });
        return;
      }
      openAsChip(doc.def, file);
    } catch (e) {
      useCircuitStore.setState({ error: `open: ${(e as Error).message}` });
    }
  };

  const openRecent = async (entry: RecentBoard) => {
    try {
      acceptOpened(await readDocumentFile(entry.file), entry.file);
    } catch (e) {
      // Most often the file moved, or permission lapsed and the read was denied.
      useCircuitStore.setState({ error: `open: ${(e as Error).message}` });
    }
  };

  const fileSaveAs = async () => {
    const board = store.getState().board;
    try {
      const file = await saveBoardAs(board, boardFileName(board), boardsDir ?? undefined);
      if (!file) return;
      adoptFile(file, board);
    } catch (e) {
      useCircuitStore.setState({ error: `save: ${(e as Error).message}` });
    }
  };

  const fileSave = async () => {
    const board = store.getState().board;
    if (!currentFile) {
      if (filePickersSupported()) await fileSaveAs();
      else exportDoc(board, boardFileName(board));
      return;
    }
    try {
      // Permission can lapse between sessions; falling back to Save As beats
      // reporting a save that never happened.
      if (await writeBoardTo(currentFile, board)) markClean();
      else await fileSaveAs();
    } catch (e) {
      useCircuitStore.setState({ error: `save: ${(e as Error).message}` });
    }
  };

  const fileSaveRef = useRef(fileSave);
  const fileSaveAsRef = useRef(fileSaveAs);
  const fileOpenRef = useRef(fileOpen);
  fileSaveRef.current = fileSave;
  fileSaveAsRef.current = fileSaveAs;
  fileOpenRef.current = fileOpen;

  // A greyed menu item and a live shortcut for the same command would be a
  // contradiction, so the keys follow the menu.
  const onBoardRef = useRef(onBoard);
  onBoardRef.current = onBoard;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!(e.ctrlKey || e.metaKey) || !onBoardRef.current) return;
      // Ctrl+N is not bound: a browser reserves it for a new window and it
      // cannot be reliably intercepted, so New lives in the menu only.
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (e.shiftKey) void fileSaveAsRef.current();
        else void fileSaveRef.current();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        void fileOpenRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const menus = useMemo<Menu[]>(() => {
    const pickers = filePickersSupported();
    return [
      {
        id: 'file',
        items: [
          { id: 'new', label: 'New board', disabled: !onBoard, run: fileNew },
          {
            id: 'examples',
            label: 'Examples...',
            disabled: !onBoard,
            run: () => setExamplesOpen(true),
          },
          {
            id: 'open',
            label: 'Open Board...',
            shortcut: SHORTCUTS.open,
            disabled: !onBoard,
            run: () => void fileOpen(),
          },
          {
            id: 'openChip',
            label: 'Open Chip...',
            disabled: !onBoard,
            run: () => void fileOpenChip(),
          },
          {
            id: 'openRecent',
            label: 'Open Recent',
            disabled: !onBoard,
            items: recents.map((entry) => ({
              id: `recent-${entry.name}-${entry.openedAt}`,
              label: entry.name,
              run: () => void openRecent(entry),
            })),
          },
          { separator: true },
          {
            id: 'save',
            label: dirty ? 'Save *' : 'Save',
            shortcut: SHORTCUTS.save,
            disabled: !onBoard,
            run: () => void fileSave(),
          },
          {
            id: 'saveAs',
            label: 'Save As...',
            shortcut: SHORTCUTS.saveAs,
            disabled: !onBoard || !pickers,
            run: () => void fileSaveAs(),
          },
        ],
      },
    ];
    // fileNew and friends are rebuilt every render by design; the values they
    // read that actually change the menu are listed here.
  }, [dirty, recents, currentFile, boardsDir, onBoard]);

  const dialogs =
    pendingDiscard || pendingChip || examplesOpen ? (
      <>
        {examplesOpen && (
          <ExamplesDialog onOpen={openExample} onCancel={() => setExamplesOpen(false)} />
        )}
        {pendingDiscard && (
          <UnsavedChangesDialog
            action={pendingDiscard.action}
            hasFile={!!currentFile}
            onSave={() => {
              const next = pendingDiscard.run;
              void (async () => {
                await fileSaveRef.current();
                // markClean() sets cleanRevRef synchronously; `dirty` state has
                // not re-rendered yet, so read the ref, not the flag. A declined
                // picker or a failed write leaves the dialog up.
                if (cleanRevRef.current !== store.getState().rev) return;
                setPendingDiscard(null);
                next();
              })();
            }}
            onDiscard={() => {
              const next = pendingDiscard.run;
              setPendingDiscard(null);
              next();
            }}
            onCancel={() => setPendingDiscard(null)}
          />
        )}
        {pendingChip && (
          <OpenChipDialog
            def={pendingChip.def}
            onChoose={resolveChipOpen}
            onCancel={() => setPendingChip(null)}
          />
        )}
      </>
    ) : null;

  return { menus, dialogs, dirty };
}
