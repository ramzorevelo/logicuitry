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
import type { Board, ChipDef, Lesson } from '../../core/model/types';
import { docFileWritable, exportDoc, filePickersSupported } from '../../io/fsAccess';
import {
  boardFileName,
  loadRecentBoards,
  openBoardFile,
  pickDocumentFiles,
  readDocumentFile,
  rememberRecentBoard,
  saveBoardAs,
  writeBoardTo,
  type OpenedDocument,
  type RecentBoard,
} from '../../io/boardFile';
import { parseDocument, serializeDocument } from '../../io/library';
import { loadSession, saveSession } from '../../io/sessionStore';
import { loadFileLessons, rememberFileLesson } from '../../io/lessonFiles';
import { emptyBoard, starterBoard, useCircuitStore } from '../workbench-circuit/circuitStore';
import { OpenChipDialog } from '../workbench-circuit/OpenChipDialog';
import { ExamplesDialog } from '../components/ExamplesDialog';
import { isDesktop } from '../../io/platform';
import type { DocFile } from '../../io/platform';
import { EXAMPLES, type Example } from '../../examples';
import { UnsavedChangesDialog } from '../workbench-circuit/UnsavedChangesDialog';
import { useShellStore } from '../store';
import { getPrefs } from '../prefs';
import { SHORTCUTS } from '../menu/shortcuts';
import type { Menu } from '../menu/menuModel';
import { modalKeysHeld } from '../modalKeys';
import { isDirtyAgainst, restoredCleanMark, type CleanMark } from './cleanMark';
import { useCompact } from '../compact';
import { useExportDialog } from '../export/exportActions';
import { useLessonStore } from '../lesson/lessonStore';
import {
  findLibraryBoard,
  lessonsForBoard,
  loadLibraryLessons,
  type LibraryLesson,
} from '../lesson/lessonLibrary';
import { lessonDirty, useLessonEditorStore } from '../lesson/lessonEditorStore';
import { LessonUnsavedDialog } from '../lesson/LessonEditor';
import { lessonFileName } from '../lesson/lessonSave';
import { newLesson } from '../../core/lesson';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { isBuiltinChipDef } from '../../core/parts/packages';
import { saveOpenChip } from './chipSave';
import { chipTabsOf, openChipFileOf, restoreChipTabs } from './chipTabsSession';
import { TUTORIAL_BOARD_ID, useOnboardingStore } from '../onboarding/onboardingStore';
import type { OnboardingActions } from '../onboarding/Onboarding';
import {
  boardWithChips,
  planEmbedded,
  rememberChipCopyChoice,
  rememberedChipCopyChoice,
  type ChipCopyChoice,
  type EmbeddedPlan,
} from './embeddedChips';
import { ChipsDifferDialog } from './ChipsDifferDialog';
import { openChipFile, openChipFiles, type PickedChip } from './openChips';

const AUTOSAVE_DEBOUNCE_MS = 400;

export function unsavedDetail(boardDirty: boolean, chipsDirty: boolean): string {
  if (boardDirty && chipsDirty) return 'This board and an open chip have unsaved changes.';
  if (chipsDirty) return 'An open chip has unsaved changes.';
  return 'This board has unsaved changes.';
}

const editor = () => useLessonEditorStore.getState();

/** An open lesson draft asks first; then `run`. */
const afterLessonEditor = (action: string, run: () => void) => editor().requestClose(action, run);

/** The File Handling API's launch queue, Chromium only and absent from the DOM lib. */
interface LaunchWindow {
  launchQueue?: {
    setConsumer(consume: (params: { files: readonly FileSystemHandle[] }) => void): void;
  };
}

export interface BoardDocument {
  /** File menu contribution, ready to hand to useContributeMenus. */
  menus: Menu[];
  /** Rendered by the shell: both dialogs belong to the document, not a canvas. */
  dialogs: JSX.Element | null;
  dirty: boolean;
  /** Settles once startup has restored the last session, if it was going to. */
  whenStarted(): Promise<void>;
  onboarding: Omit<OnboardingActions, 'openKeys'>;
}

export function useBoardDocument(): BoardDocument {
  const store = useCircuitStore;
  // Every File command acts on the board, so off the Circuit workbench they
  // are greyed rather than hidden: a menu bar that changes shape as you switch
  // tabs is harder to learn than one whose items grey out.
  const onBoard = useShellStore((st) => st.workbench) === 'circuit';
  const rev = useCircuitStore((s) => s.rev);
  // Opening, closing or switching a chip tab changes no `rev`, but the session keeps them.
  const tabs = useCircuitStore((s) => s.tabs);
  const activeTabId = useCircuitStore((s) => s.activeTabId);
  const chipLib = useCircuitStore((s) => s.chipLib);
  // Open and Save As start in the BOARDS folder, not the chip shelf.
  const boardsDir = useShellStore((st) => st.boardsDir);
  // The library root: chips/, boards/ and lessons/ live under it.
  const libraryDir = useShellStore((st) => st.chipsDir);
  const compact = useCompact();
  // Save and Save As follow the tab in front: a chip tab saves its chip, the board tab the board.
  const chipTabDefId = useCircuitStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.kind === 'def' ? tab.defId : null;
  });
  const chipDirty = useCircuitStore((s) => s.chipTabDirty(s.activeTabId));
  const chipReadOnly = useCircuitStore((s) => {
    const def = chipTabDefId ? s.chipLib.get(chipTabDefId) : undefined;
    return def !== undefined && isBuiltinChipDef(def);
  });

  // The file this board came from (Save writes back here) and whether it has
  // edits since the last save/load. Both ride along in the autosave so a
  // reload lands on the same document, not just the same shapes.
  const [currentFile, setCurrentFile] = useState<DocFile | null>(null);
  const [dirty, setDirty] = useState(false);
  // The board at the last save or load: any other board is unsaved work.
  const board = useCircuitStore((s) => s.board);
  const cleanRef = useRef<CleanMark | null>(null);
  const markClean = useCallback(() => {
    cleanRef.current = store.getState().board;
    setDirty(false);
  }, [store]);

  useEffect(() => {
    if (cleanRef.current === null) {
      cleanRef.current = board;
      return;
    }
    setDirty(isDirtyAgainst(board, cleanRef.current));
  }, [board]);

  // Held until ChipsDifferDialog answers; `then` loads the board.
  const [pendingChips, setPendingChips] = useState<{
    plan: EmbeddedPlan;
    then: () => void;
  } | null>(null);

  const applyEmbedded = (plan: EmbeddedPlan, choice: ChipCopyChoice, then: () => void) => {
    const defs = choice === 'board' ? [...plan.load, ...plan.differ] : plan.load;
    const result = defs.length > 0 ? store.getState().loadChipDefs(defs) : null;
    then();
    const notes = [
      ...(result && !result.ok ? [`the board's own chips were not loaded: ${result.error}`] : []),
      ...(plan.kept.length > 0
        ? [`${plan.kept.join(', ')} kept the unsaved edits in its tab, not the board's copy`]
        : []),
    ];
    // After the board loads, which clears the strip.
    if (notes.length > 0) useCircuitStore.setState({ error: `open: ${notes.join('; ')}` });
  };

  /** Loads a board's own chips before the board, asking only when one differs from an open copy. */
  const withEmbeddedChips = (board: Board, mode: 'ask' | 'quiet', then: () => void) => {
    const st = store.getState();
    const dirtyTabIds = new Set(
      st.tabs.flatMap((t) => (t.kind === 'def' && st.chipTabDirty(t.id) ? [t.defId] : [])),
    );
    const plan = planEmbedded(board, st.chipLib, dirtyTabIds);
    const choice = mode === 'quiet' ? 'open' : rememberedChipCopyChoice();
    if (plan.differ.length === 0 || choice) applyEmbedded(plan, choice ?? 'open', then);
    else setPendingChips({ plan, then });
  };
  const withEmbeddedChipsRef = useRef(withEmbeddedChips);
  withEmbeddedChipsRef.current = withEmbeddedChips;

  // Restore once on mount, then autosave whenever the board settles. Both go
  // through the normal document pipeline: a restored board is migrated and
  // schema-validated like any file, never trusted just because we wrote it.
  const restoredRef = useRef(false);
  // Settles once the restore is done, so a file the app was launched with lands after it.
  const restoreDone = useRef<Promise<void>>(Promise.resolve());
  // Settles once the desktop shell has said whether it was launched with a file.
  const launchChecked = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!getPrefs().restoreLastBoard) return;
    restoreDone.current = loadSession()
      .then((session) => {
        if (!session) return;
        const doc = parseDocument(serializeDocument(session.board));
        if (doc.format !== 'lcir.board') return;
        useOnboardingStore.getState().noteDocumentOpened();
        // Startup never asks: whatever is already loaded wins.
        withEmbeddedChipsRef.current(doc, 'quiet', () => useCircuitStore.getState().loadBoard(doc));
        if (getPrefs().fitOnOpen) useCircuitStore.getState().requestFit();
        setCurrentFile(session.file ?? null);
        cleanRef.current = restoredCleanMark(session.dirty, useCircuitStore.getState().board);
        setDirty(session.dirty);
        restoreChipTabs(session);
      })
      .catch(() => {
        // A corrupt or stale session must never block startup: the starter
        // board is already loaded, so silently keep it.
      });
  }, []);

  useEffect(() => {
    if (!restoredRef.current || !getPrefs().autosave) return;
    const id = window.setTimeout(() => {
      // A library load can land before the restore does; saving then would keep the starter board.
      void restoreDone.current
        .then(() => {
          const st = store.getState();
          return saveSession({
            // Always with its chips, whatever the setting: a reload must find them.
            board: boardWithChips(st.board, st.chipLib, true),
            ...chipTabsOf(st, openChipFileOf),
            ...(currentFile ? { file: currentFile } : {}),
            dirty,
            savedAt: Date.now(),
          });
        })
        .catch(() => {
          // Storage full or blocked -- autosave is best-effort by design.
        });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [rev, tabs, activeTabId, chipLib, currentFile, dirty, store]);

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
  const guardDiscard = (action: string, run: () => void) =>
    afterLessonEditor(action, () => {
      // Read from the refs, not `dirty`: a launch right after the restore runs before the render
      // that sets it.
      const clean = cleanRef.current;
      const unsaved =
        (clean !== null && isDirtyAgainst(store.getState().board, clean)) ||
        store.getState().hasTabEdits();
      if (!unsaved || !getPrefs().confirmReplaceBoard) run();
      else setPendingDiscard({ action, run });
    });

  // `guardDiscard` closes over `dirty`, which changes on every edit; a ref
  // keeps `acceptOpened` memoised without going stale.
  const guardDiscardRef = useRef(guardDiscard);
  guardDiscardRef.current = guardDiscard;

  const adoptFile = useCallback(
    (file: DocFile, board: Board) => {
      // An upload cannot be written back, so Save downloads instead.
      if (!docFileWritable(file)) {
        setCurrentFile(null);
        markClean();
        return;
      }
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
  const openExample = (example: Example, then?: () => void) => {
    setExamplesOpen(false);
    guardDiscardRef.current(`Open ${example.name}`, () => {
      if (example.chips?.length) store.getState().loadChipDefs(structuredClone(example.chips));
      store.getState().loadBoard(structuredClone(example.board));
      // An example ships no camera worth restoring, so it always frames --
      // the `fitOnOpen` preference governs the user's own boards only.
      store.getState().requestFit();
      setCurrentFile(null);
      markClean();
      then?.();
    });
  };
  const openExampleRef = useRef(openExample);
  openExampleRef.current = openExample;

  const [folderLessons, setFolderLessons] = useState<LibraryLesson[]>([]);
  const [fileLessons, setFileLessons] = useState<LibraryLesson[]>([]);
  const lessonSaves = useLessonEditorStore((s) => s.savedCount);
  const [lessonFilesSeen, setLessonFilesSeen] = useState(0);
  useEffect(() => {
    if (!libraryDir) {
      setFolderLessons([]);
      return;
    }
    let cancelled = false;
    void loadLibraryLessons(libraryDir).then((lessons) => {
      if (!cancelled) setFolderLessons(lessons);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryDir, lessonSaves]);
  useEffect(() => {
    let cancelled = false;
    void loadFileLessons()
      .then((list) => {
        if (cancelled) return;
        setFileLessons(list.map(({ lesson, file }) => ({ lesson, fileName: file.name, file })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lessonSaves, lessonFilesSeen]);
  // A lesson opened through File > Open saves back to that file, before its listing has reloaded.
  const openedLessonFiles = useRef(new WeakMap<Lesson, DocFile>());
  // The library's own folder first: a copy there wins over a file elsewhere.
  const libraryLessons = useMemo(
    () => [...folderLessons, ...fileLessons],
    [folderLessons, fileLessons],
  );

  const playLesson = useCallback((lesson: Lesson) => {
    const fromEditor = editor().draft !== null;
    afterLessonEditor(`Play ${lesson.title}`, () => {
      useShellStore.getState().setWorkbench('circuit');
      useLessonStore.getState().open(lesson, 0, { keepDock: fromEditor });
    });
  }, []);

  /** Opens the editor on a lesson; one already open asks first, unless it is this one. */
  const editLesson = useCallback(
    (lesson: Lesson, opts?: { isNew?: boolean; takenIds?: ReadonlySet<string> }) => {
      const ed = editor();
      if (ed.draft?.id === lesson.id && !opts?.isNew) {
        ed.backFromPlay();
        return;
      }
      const runner = useLessonStore.getState();
      const step = runner.lesson?.id === lesson.id ? runner.step : 0;
      const fromRunner = runner.lesson !== null;
      // The menu's own entry first: another board's lesson can share this id.
      const entry =
        libraryLessons.find((l) => l.lesson === lesson) ??
        libraryLessons.find((l) => l.lesson.id === lesson.id && l.lesson.board === lesson.board);
      const opened = openedLessonFiles.current.get(lesson);
      const file = opened ?? entry?.file;
      const fileName = opened?.name ?? entry?.fileName ?? lessonFileName(lesson.id);
      afterLessonEditor(`Edit ${lesson.title}`, () => {
        useLessonStore.getState().close();
        useShellStore.getState().setWorkbench('circuit');
        editor().open(lesson, fileName, {
          step,
          keepDock: fromRunner,
          ...(file ? { file } : {}),
          ...opts,
        });
      });
    },
    [libraryLessons],
  );

  /** A lesson opens over its board: the open one, an example, or a library board, in that order. */
  const openLesson = useCallback(
    async (lesson: Lesson) => {
      const id = lesson.board;
      if (!id) {
        useCircuitStore.setState({ error: 'open: This lesson names no board' });
        return;
      }
      const example = EXAMPLES.find((e) => e.id === id);
      if (store.getState().board.id === id) {
        // A restored session keeps the board but not an example's own chips.
        const lib = store.getState().chipLib;
        const missing = (example?.chips ?? []).filter((c) => !lib.has(c.id));
        if (missing.length > 0) store.getState().loadChipDefs(structuredClone(missing));
        playLesson(lesson);
        return;
      }
      if (example) {
        openExampleRef.current(example, () => playLesson(lesson));
        return;
      }
      const { boardsDir: boards, chipsDir: library } = useShellStore.getState();
      const found = await findLibraryBoard(id, [
        ...(boards ? [{ dir: boards }] : []),
        ...(library ? [{ dir: library, sub: 'boards' as const }] : []),
      ]);
      if (!found) {
        useCircuitStore.setState({
          error: `open: This lesson's board (${id}) is not in the library or the examples`,
        });
        return;
      }
      guardDiscardRef.current(`Open ${found.board.name}`, () =>
        withEmbeddedChipsRef.current(found.board, 'ask', () => {
          store.getState().loadBoard(found.board);
          if (getPrefs().fitOnOpen) store.getState().requestFit();
          adoptFile(found.file, found.board);
          playLesson(lesson);
        }),
      );
    },
    [adoptFile, playLesson, store],
  );

  const fileNew = () => {
    guardDiscard('Start a new board', () => {
      store.getState().loadBoard(starterBoard());
      // Like an example, the starter board ships no camera worth restoring, so
      // it always frames; `fitOnOpen` governs the user's saved boards only.
      store.getState().requestFit();
      setCurrentFile(null);
      markClean();
    });
  };

  /** An empty board, through the same guard as New: the tutorial and the welcome's blank start. */
  const startEmpty = (action: string, id: string, then?: () => void) => {
    guardDiscard(action, () => {
      store.getState().loadBoard(emptyBoard(id));
      setCurrentFile(null);
      markClean();
      then?.();
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
      useOnboardingStore.getState().noteDocumentOpened();
      if (doc.kind === 'board') {
        guardDiscardRef.current('Open another board', () =>
          withEmbeddedChipsRef.current(doc.board, 'ask', () => {
            store.getState().loadBoard(doc.board);
            if (getPrefs().fitOnOpen) store.getState().requestFit();
            adoptFile(file, doc.board);
          }),
        );
        return;
      }
      if (doc.kind === 'lesson') {
        // Listed in the Lesson menu from now on, and Edit then saves back to this file.
        if (docFileWritable(file)) {
          openedLessonFiles.current.set(doc.lesson, file);
          void rememberFileLesson({ lesson: doc.lesson, file, savedAt: Date.now() })
            .then(() => setLessonFilesSeen((n) => n + 1))
            .catch(() => {});
        }
        void openLesson(doc.lesson);
        return;
      }
      setPendingChip({ def: doc.def, file });
    },
    [adoptFile, openLesson, store],
  );

  // Double-clicking a document in the file manager launches us
  // with the path as an argument; the shell hands it over once, at startup.
  useEffect(() => {
    if (!isDesktop()) return;
    let launchPath: (path: string | null) => void = () => {};
    launchChecked.current = new Promise<string | null>((resolve) => {
      launchPath = resolve;
    }).then((path) => {
      if (path) useOnboardingStore.getState().noteDocumentOpened();
    });
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string | null>('launch_file');
        launchPath(path);
        if (!path) return;
        const name = path.split(/[\/]/).pop() ?? path;
        const file = { name, path } as unknown as DocFile;
        const doc = await readDocumentFile(file);
        await restoreDone.current;
        acceptOpened(doc, file);
      } catch {
        launchPath(null);
        // No argument, an unreadable file, or a document this app does not
        // open: the app is already running and usable, which is the point.
      }
    })();
  }, [acceptOpened]);

  // The installed PWA's half of the same: the manifest's file_handlers offer it for documents,
  // and Chrome or Edge hands the file over through the launch queue.
  useEffect(() => {
    const queue = isDesktop() ? undefined : (window as LaunchWindow).launchQueue;
    queue?.setConsumer(({ files }) => {
      const handle = files.find((f) => f.kind === 'file');
      if (!handle) return;
      useOnboardingStore.getState().noteDocumentOpened();
      const file = handle as unknown as DocFile;
      void (async () => {
        try {
          const doc = await readDocumentFile(file);
          await restoreDone.current;
          acceptOpened(doc, file);
        } catch (e) {
          useCircuitStore.setState({ error: `open: ${(e as Error).message}` });
        }
      })();
    });
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
    openChipFile(pending.def, pending.file);
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
    let files: DocFile[];
    try {
      files = await pickDocumentFiles(boardsDir ?? undefined);
    } catch (e) {
      useCircuitStore.setState({ error: `open: ${(e as Error).message}` });
      return;
    }
    if (files.length === 0) return;
    const chips: PickedChip[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        const doc = await readDocumentFile(file);
        if (doc.kind === 'chip') chips.push({ def: doc.def, file });
        else failed.push(`${file.name} is a ${doc.kind}, not a chip`);
      } catch (e) {
        failed.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    const opened = openChipFiles(chips, failed);
    if (files.length === 1 && failed.length === 0) return;
    const parts = [
      ...(opened.length > 0 ? [`opened ${opened.join(', ')}`] : []),
      ...(failed.length > 0 ? [`not opened: ${failed.join('; ')}`] : []),
    ];
    useCircuitStore.setState({ error: `open: ${parts.join('. ')}` });
  };

  const openRecent = async (entry: RecentBoard) => {
    try {
      acceptOpened(await readDocumentFile(entry.file), entry.file);
    } catch (e) {
      // Most often the file moved, or permission lapsed and the read was denied.
      useCircuitStore.setState({ error: `open: ${(e as Error).message}` });
    }
  };

  const boardToWrite = () => {
    const st = store.getState();
    return boardWithChips(st.pruneHiddenChecks(), st.chipLib, getPrefs().embedChips);
  };

  const fileSaveAs = async () => {
    const board = boardToWrite();
    try {
      const file = await saveBoardAs(board, boardFileName(board), boardsDir ?? undefined);
      if (!file) return;
      adoptFile(file, board);
    } catch (e) {
      useCircuitStore.setState({ error: `save: ${(e as Error).message}` });
    }
  };

  const fileSave = async () => {
    const board = boardToWrite();
    if (!currentFile) {
      if (filePickersSupported()) await fileSaveAs();
      else {
        exportDoc(board, boardFileName(board));
        // The board is on disk now, even though nothing can be written back to it later.
        markClean();
      }
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

  const saveChipDef = (defId: string, saveAs: boolean): Promise<boolean> =>
    saveOpenChip(defId, { saveAs, startIn: libraryDir ?? boardsDir ?? undefined });

  const activeChipId = () => {
    const st = store.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    return tab?.kind === 'def' ? tab.defId : null;
  };
  const saveFront = async () => {
    const chip = activeChipId();
    if (chip) await saveChipDef(chip, false);
    else await fileSave();
  };
  const saveFrontAs = async () => {
    const chip = activeChipId();
    if (chip) await saveChipDef(chip, true);
    else await fileSaveAs();
  };

  /** The board if it has edits, then every chip tab that has: what a replace would lose. */
  const saveEverything = async () => {
    const unsavedBoard = () => {
      const clean = cleanRef.current;
      return clean === null || isDirtyAgainst(store.getState().board, clean);
    };
    if (unsavedBoard()) {
      await fileSave();
      // A declined picker: asking again for every chip would only pile up pickers.
      if (unsavedBoard()) return;
    }
    const st = store.getState();
    const dirtyChips = new Set(
      st.tabs.flatMap((t) => (t.kind === 'def' && st.chipTabDirty(t.id) ? [t.defId] : [])),
    );
    for (const id of dirtyChips) await saveChipDef(id, false);
  };
  const saveEverythingRef = useRef(saveEverything);
  saveEverythingRef.current = saveEverything;

  const fileSaveRef = useRef(saveFront);
  const fileSaveAsRef = useRef(saveFrontAs);
  const fileOpenRef = useRef(fileOpen);
  fileSaveRef.current = saveFront;
  fileSaveAsRef.current = saveFrontAs;
  fileOpenRef.current = fileOpen;

  // A greyed menu item and a live shortcut for the same command would be a
  // contradiction, so the keys follow the menu.
  const onBoardRef = useRef(onBoard);
  onBoardRef.current = onBoard;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog is up: it owns the keyboard, buttons and all.
      if (modalKeysHeld()) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!(e.ctrlKey || e.metaKey) || !onBoardRef.current) return;
      // The lesson editor saves the lesson; its own key handler has it.
      if (editor().draft && !editor().playing) return;
      // Ctrl+N is not bound: a browser reserves it for a new window and it
      // cannot be reliably intercepted, so New lives in the menu only.
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        // Save As is greyed without file pickers, so its key stands down too.
        if (e.shiftKey) {
          if (filePickersSupported()) void fileSaveAsRef.current();
        } else void fileSaveRef.current();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        void fileOpenRef.current();
      } else if ((e.key === 'e' || e.key === 'E') && !e.shiftKey) {
        e.preventDefault();
        useExportDialog.getState().show('schematic');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A browser offers only its own Leave or Stay here, never Save.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      // A chip lives only in its file; the board at least has its autosave.
      if (!lessonDirty(editor()) && !useCircuitStore.getState().hasTabEdits()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const openLessonId = useLessonStore((s) => s.lesson?.id);
  const autoplaying = useLessonStore((s) => s.autoplay);
  const editingId = useLessonEditorStore((s) => s.draft?.id);
  const menus = useMemo<Menu[]>(() => {
    const pickers = filePickersSupported();
    const lessons = lessonsForBoard(board.id, libraryLessons);
    const running = useLessonStore.getState().lesson;
    const draft = editor().draft;
    // A lesson needs its board findable by id: a library file or a built-in example.
    const boardSaved = !!currentFile || EXAMPLES.some((e) => e.id === board.id);
    const takenIds = new Set([
      ...BUILTIN_LESSONS.map((l) => l.id),
      ...libraryLessons.flatMap((l) => [l.lesson.id, l.fileName.replace(/\.[^.]+$/, '')]),
    ]);
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
          // Without pickers nothing opened can be reopened: an upload is a one-off snapshot.
          ...(pickers
            ? [
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
              ]
            : []),
          { separator: true },
          ...(chipTabDefId
            ? [
                {
                  id: 'save',
                  label: chipDirty ? 'Save Chip *' : 'Save Chip',
                  shortcut: SHORTCUTS.save,
                  disabled: !onBoard || chipReadOnly,
                  ...(chipReadOnly ? { title: 'Built-in parts are read-only' } : {}),
                  run: () => void saveChipDef(chipTabDefId, false),
                },
                {
                  id: 'saveAs',
                  label: 'Save Chip As...',
                  shortcut: SHORTCUTS.saveAs,
                  disabled: !onBoard || !pickers || chipReadOnly,
                  run: () => void saveChipDef(chipTabDefId, true),
                },
              ]
            : [
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
              ]),
          { separator: true },
          {
            id: 'exportImage',
            label: 'Export image...',
            shortcut: SHORTCUTS.exportImage,
            disabled: !onBoard,
            run: () => useExportDialog.getState().show('schematic'),
          },
          // A phone has no print dialog worth the name; Save and Copy cover it.
          ...(compact
            ? []
            : [
                {
                  id: 'print',
                  label: 'Print...',
                  disabled: !onBoard,
                  run: () => useExportDialog.getState().show('schematic', { print: true }),
                },
              ]),
        ],
      },
      {
        id: 'lesson',
        items: [
          ...(lessons.length > 0
            ? lessons.map((lesson) => ({
                id: `play-${lesson.id}`,
                label: lesson.title,
                checked: lesson.id === openLessonId,
                disabled: !onBoard,
                run: () => playLesson(lesson),
              }))
            : [
                {
                  id: 'noLessons',
                  label: 'No lessons for this board',
                  disabled: true,
                  run: () => {},
                },
              ]),
          { separator: true },
          // Phones play lessons but never author them.
          ...(compact
            ? []
            : [
                {
                  id: 'newLesson',
                  label: 'New lesson',
                  disabled: !onBoard || !boardSaved,
                  ...(boardSaved ? {} : { title: 'Save the board first' }),
                  run: () => editLesson(newLesson(board.id, takenIds), { isNew: true, takenIds }),
                },
                {
                  id: 'editLesson',
                  label: 'Edit lesson',
                  disabled: !onBoard || lessons.length === 0,
                  items: lessons.map((lesson) => ({
                    id: `edit-${lesson.id}`,
                    label: lesson.title,
                    checked: lesson.id === editingId,
                    run: () => editLesson(lesson),
                  })),
                },
              ]),
          {
            id: 'playFromStart',
            label: 'Play from step 1',
            disabled: !onBoard || !(running || draft),
            run: () => {
              if (draft) editor().play(0);
              else if (running) playLesson(running);
            },
          },
          {
            id: 'autoplay',
            label: autoplaying ? 'Pause autoplay' : 'Autoplay',
            disabled: !onBoard || !running,
            run: () => {
              const run = useLessonStore.getState();
              if (run.autoplay) run.stopAutoplay();
              else run.startAutoplay();
            },
          },
          {
            id: 'closeLesson',
            label: 'Close lesson',
            disabled: !running && !draft,
            run: () => afterLessonEditor('Close lesson', () => useLessonStore.getState().close()),
          },
        ],
      },
    ];
    // fileNew and friends are rebuilt every render by design; the values they
    // read that actually change the menu are listed here.
  }, [
    dirty,
    chipTabDefId,
    chipDirty,
    chipReadOnly,
    recents,
    currentFile,
    boardsDir,
    onBoard,
    board.id,
    libraryLessons,
    openLessonId,
    autoplaying,
    editingId,
    compact,
    playLesson,
    editLesson,
  ]);

  const lessonPrompt = useLessonEditorStore((s) => s.pendingClose !== null);
  const dialogs =
    pendingDiscard || pendingChip || pendingChips || examplesOpen || lessonPrompt ? (
      <>
        <LessonUnsavedDialog />
        {pendingChips && (
          <ChipsDifferDialog
            chips={pendingChips.plan.differ}
            onChoose={(choice, remember) => {
              const { plan, then } = pendingChips;
              setPendingChips(null);
              if (remember) rememberChipCopyChoice(choice);
              applyEmbedded(plan, choice, then);
            }}
            onCancel={() => setPendingChips(null)}
          />
        )}
        {examplesOpen && (
          <ExamplesDialog
            onOpen={openExample}
            onOpenLesson={(lesson) => {
              setExamplesOpen(false);
              void openLesson(lesson);
            }}
            onCancel={() => setExamplesOpen(false)}
          />
        )}
        {pendingDiscard && (
          <UnsavedChangesDialog
            action={pendingDiscard.action}
            hasFile={!!currentFile || !dirty}
            detail={unsavedDetail(dirty, store.getState().hasTabEdits())}
            onSave={() => {
              const next = pendingDiscard.run;
              void (async () => {
                await saveEverythingRef.current();
                // markClean() sets cleanRef synchronously; `dirty` state has
                // not re-rendered yet, so read the ref, not the flag. A declined
                // picker or a failed write leaves the dialog up.
                const clean = cleanRef.current;
                if (clean === null || isDirtyAgainst(store.getState().board, clean)) return;
                if (store.getState().hasTabEdits()) return;
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

  const basicGates = BUILTIN_LESSONS.find((l) => l.id === 'basic-gates');
  return {
    menus,
    dialogs,
    dirty,
    whenStarted: () => Promise.all([restoreDone.current, launchChecked.current]).then(() => {}),
    onboarding: {
      startTutorialBoard: (then) => startEmpty('Start the tutorial', TUTORIAL_BOARD_ID, then),
      startBlankBoard: () => startEmpty('Start a blank board', starterBoard().id),
      openExamples: () => setExamplesOpen(true),
      openBasicGatesLesson: () => {
        if (basicGates) void openLesson(basicGates);
      },
    },
  };
}
