import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SELECTABLE_THEMES,
  applyTheme,
  cycleTheme,
  isThemeName,
  themeInfo,
  setPresentationMode,
  togglePresentation,
  type ThemeName,
} from '../render/theme';
import {
  ensurePermission,
  fileSystemAccessSupported,
  loadChipLibrary,
  pickDirectory,
  restoreDirectory,
} from '../io/fsAccess';
import { useCircuitStore } from './workbench-circuit/circuitStore';
import { getPrefs, usePrefsStore } from './prefs';
import { useShellStore, type Workbench } from './store';
import type { LibraryDir } from '../io/platform';
import { useCompact, useLandscape } from './compact';
import { HoldTip } from './components/HoldTip';
import {
  exitAppFullscreen,
  fullscreenSupported,
  requestAppFullscreen,
  useFullscreenState,
} from './fullscreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeMark } from './components/ThemeMark';
import { MenuBar } from './menu/MenuBar';
import { useContributeMenus, useMenuContributions } from './menu/MenuProvider';
import { mergeMenus, type Menu } from './menu/menuModel';
import { SHORTCUTS } from './menu/shortcuts';
import { inactiveCircuitMenus } from './menu/circuitCommands';
import { SettingsDialog } from './settings/SettingsDialog';
import { AboutDialog } from './settings/AboutDialog';
import { HelpDialog } from './settings/HelpDialog';
import { useBoardDocument } from './document/useBoardDocument';
import { BugReportDialog } from './components/BugReportDialog';
import { UpdateBanner } from './components/UpdateBanner';
import { DesktopUpdateBanner } from './desktop/DesktopUpdateBanner';
import { applyUpdateOnClose, checkForUpdate } from './desktop/updater';
import { isDesktop } from '../io/platform';
import { ReferenceDrawer, ReferenceDrawerProvider } from './components/ReferenceDrawer';
import { NumbersWorkbench } from './workbench-numbers/NumbersWorkbench';
import { CircuitWorkbench } from './workbench-circuit/CircuitWorkbench';
import { DeviceLabWorkbench } from './workbench-devicelab/DeviceLabWorkbench';

// Gates workbench retired: bubble pushing is the Circuit workbench's locked
// bubble mode now (B key / mode bar).
const WORKBENCHES: { id: Workbench; label: string }[] = [
  { id: 'numbers', label: 'Numbers' },
  { id: 'circuit', label: 'Circuit' },
  { id: 'devicelab', label: 'Device Lab' },
];

const WORKBENCH_VIEWS: Record<Workbench, () => JSX.Element> = {
  numbers: NumbersWorkbench,
  circuit: CircuitWorkbench,
  devicelab: DeviceLabWorkbench,
};

function currentTheme(): ThemeName {
  const attr = document.documentElement.getAttribute('data-theme');
  return isThemeName(attr) ? attr : getPrefs().defaultTheme;
}

// App shell: toolbar switcher + mode toggles, workbench host, drawer/waveform
// chrome. Bare number keys are reserved for in-workbench operator select; the
// shell switches workbenches with the toolbar or Ctrl+1..4.
export function App() {
  const workbench = useShellStore((s) => s.workbench);
  const setWorkbench = useShellStore((s) => s.setWorkbench);
  const setChipsDir = useShellStore((s) => s.setChipsDir);
  const chipsDir = useShellStore((s) => s.chipsDir);
  const setBoardsDir = useShellStore((s) => s.setBoardsDir);
  const boardsDir = useShellStore((s) => s.boardsDir);
  const [theme, setTheme] = useState<ThemeName>(currentTheme);
  const [presentation, setPresentation] = useState(() => getPrefs().presentationAtLaunch);
  // A folder was picked in an earlier session but this load has no permission
  // yet: the button offers to reconnect instead of pretending nothing was set.
  const [pending, setPending] = useState<LibraryDir | null>(null);
  const [libraryNote, setLibraryNote] = useState<string | null>(null);

  // Chips live as files; without this the library is write-only and every
  // packaged chip disappears on reload.
  const connectLibrary = useCallback(
    async (dir: LibraryDir) => {
      setChipsDir(dir);
      setPending(null);
      const { chips, skipped } = await loadChipLibrary(dir);
      const result = useCircuitStore.getState().loadChipDefs(chips);
      setLibraryNote(
        !result.ok
          ? result.error
          : skipped.length > 0
            ? `${result.count} chips loaded, ${skipped.length} skipped`
            : null,
      );
    },
    [setChipsDir],
  );

  // Applied from the launch preference in an effect, not in the useState
  // initializer: StrictMode double-invokes that in dev, which a toggle survives
  // only by accident.
  useEffect(() => {
    setPresentationMode(presentation);
  }, []);

  // The second and last permitted install() call site (see updater.ts's
  // invariant): quitting applies a downloaded update, so the next launch is
  // already the new version and nothing bounces mid-lecture.
  useEffect(() => {
    if (!isDesktop()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const off = await getCurrentWindow().onCloseRequested(async (e) => {
        try {
          if (!(await applyUpdateOnClose())) return;
          // install() exits the app itself; stop the close so the two do not race.
          e.preventDefault();
        } catch {
          // A failed apply must still let the app quit: leaving the close
          // prevented here would strand the window open with no way out.
        }
      });
      // Registering the listener hands the close to JS, so a cleanup that ran
      // during the await above must not leave a second handler behind.
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // One update check, at the first idle moment after launch, and never while
  // presenting. Offline it fails silently inside checkForUpdate.
  useEffect(() => {
    if (!isDesktop() || getPrefs().presentationAtLaunch) return;
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 2000));
    idle(() => void checkForUpdate());
  }, []);

  useEffect(() => {
    // Permission cannot be re-requested here -- that needs a user gesture --
    // so an ungranted handle is parked for the Reconnect button below.
    void restoreDirectory('chips')
      .then(({ handle, needsPermission }) => {
        if (!handle) return;
        if (needsPermission) setPending(handle);
        else void connectLibrary(handle);
      })
      .catch(() => {
        // IndexedDB can be unavailable or blocked; a missing folder handle is
        // not worth an unhandled rejection at startup.
      });
    // The boards folder only seeds the Open/Save As pickers, so an ungranted
    // handle needs no reconnect flow: the picker just starts somewhere else.
    void restoreDirectory('boards')
      .then(({ handle, needsPermission }) => {
        if (handle && !needsPermission) setBoardsDir(handle);
      })
      .catch(() => {
        // As above.
      });
  }, [connectLibrary, setBoardsDir]);

  // The chosen theme IS the stored default: one source of truth, so a picker
  // choice and a fresh launch can never disagree.
  const setPref = usePrefsStore((s) => s.setPref);
  const pickTheme = useCallback(
    (next: ThemeName) => {
      applyTheme(next);
      setPref('defaultTheme', next);
      setTheme(next);
    },
    [setPref],
  );

  // One control, two effects: the scaled chrome AND real browser fullscreen.
  // Where fullscreen is refused (iOS Safari on a non-video element) the class
  // still flips, which is exactly what this did before fullscreen existed.
  const compact = useCompact();
  // Only a compact shell cares: a desktop is landscape too and wants none of
  // the edge-mounted chrome.
  const landscape = useLandscape() && compact;
  const fullscreen = useFullscreenState();
  const toggleFullscreen = () => {
    const next = togglePresentation();
    setPresentation(next);
    void (next ? requestAppFullscreen() : exitAppFullscreen());
  };

  // The class, not a Theme field: readTheme reads a token, and every canvas
  // already re-reads on a documentElement class change.
  const thickStrokes = usePrefsStore((s) => s.prefs.thickenStrokesInPresentation);
  useEffect(() => {
    document.documentElement.classList.toggle('thin-strokes', !thickStrokes);
  }, [thickStrokes]);

  // Esc and F11 leave fullscreen without passing through the button, so the
  // scaled chrome has to follow the real state rather than our memory of it.
  const leftFullscreenRef = useRef(false);
  useEffect(() => {
    if (fullscreen) {
      leftFullscreenRef.current = true;
      return;
    }
    if (!leftFullscreenRef.current) return;
    leftFullscreenRef.current = false;
    setPresentation(setPresentationMode(false));
  }, [fullscreen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'F10') {
        // The APG-conformant way into a menu bar. Alt+letter is deliberately
        // not used: Alt is already a canvas modifier (Alt+drag detaches).
        e.preventDefault();
        document.querySelector<HTMLElement>('.menubar__title')?.focus();
        return;
      }
      // Shift+/ on a US layout, and whatever key carries '?' elsewhere: the
      // question mark is the one shortcut that should not need looking up.
      if (e.key === '?') {
        setHelpOpen(true);
      } else if (e.key === 't' || e.key === 'T') {
        pickTheme(cycleTheme(currentTheme(), e.shiftKey ? -1 : 1));
      } else if ((e.key === 'p' || e.key === 'P') && !compact) {
        toggleFullscreen();
      } else if (e.ctrlKey) {
        const target = WORKBENCHES[Number.parseInt(e.key, 10) - 1];
        if (target) {
          e.preventDefault();
          setWorkbench(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setWorkbench, pickTheme, compact]);

  const openLibrary = async () => {
    try {
      // This click is the transient activation both paths need.
      if (pending && (await ensurePermission(pending, true))) {
        await connectLibrary(pending);
        return;
      }
      await connectLibrary(await pickDirectory('chips'));
    } catch {
      // User dismissed the picker or denied permission; nothing to do.
    }
  };

  // The document layer lives here, not in the Circuit workbench: the board is
  // global state, so File belongs on the bar whichever workbench is showing.
  const document_ = useBoardDocument();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Rebuilt whenever the state its handlers read changes: a menu item is a
  // closure, and a stale one acts on a stale value.
  const shellMenus = useMemo<Menu[]>(
    () => [
      {
        id: 'view',
        items: [
          // A phone browser has no useful fullscreen, and the scaled chrome
          // targets a TV, so neither this nor the toolbar button appears there.
          ...(compact
            ? []
            : [
                {
                  id: 'fullscreen',
                  label: 'Fullscreen',
                  shortcut: SHORTCUTS.fullscreen,
                  checked: presentation,
                  run: toggleFullscreen,
                },
              ]),
          {
            id: 'theme',
            label: 'Next theme',
            shortcut: SHORTCUTS.theme,
            run: () => pickTheme(cycleTheme(currentTheme(), 1)),
          },
        ],
      },
      {
        id: 'settings',
        items: [
          { id: 'preferences', label: 'Preferences...', run: () => setSettingsOpen(true) },
          ...(fileSystemAccessSupported()
            ? [
                { separator: true } as const,
                {
                  // Carries what the toolbar button used to say: a parked
                  // handle needs a click to regain permission, and a partial
                  // library load is worth seeing rather than silently missing
                  // chips.
                  id: 'chipsFolder',
                  label: chipsDir
                    ? `Chips folder: ${chipsDir.name}${libraryNote ? ` (${libraryNote})` : ''}`
                    : pending
                      ? `Reconnect chips: ${pending.name}...`
                      : 'Choose chips folder...',
                  run: () => void openLibrary(),
                },
                {
                  id: 'boardsFolder',
                  label: boardsDir ? `Boards folder: ${boardsDir.name}` : 'Choose boards folder...',
                  run: () => {
                    void pickDirectory('boards')
                      .then(setBoardsDir)
                      .catch(() => {
                        // Picker dismissed; nothing to do.
                      });
                  },
                },
              ]
            : []),
        ],
      },
      {
        // A real keyboard reference is still a backlog item; pointing Help at
        // Preferences would be a link to something that is not there.
        id: 'help',
        items: [
          ...(isDesktop()
            ? [
                {
                  id: 'checkUpdates',
                  label: 'Check for updates',
                  run: () => void checkForUpdate(),
                },
                { separator: true } as const,
              ]
            : []),
          { id: 'keys', label: 'Keys and gestures', shortcut: '?', run: () => setHelpOpen(true) },
          { id: 'report', label: 'Report a problem...', run: () => setReportOpen(true) },
          { id: 'about', label: 'About', run: () => setAboutOpen(true) },
        ],
      },
    ],
    [presentation, compact, chipsDir, libraryNote, pending, boardsDir, setBoardsDir],
  );
  useContributeMenus('shell', shellMenus);
  useContributeMenus('document', document_.menus);
  // The Circuit workbench contributes File/Edit/View/Simulate only while it is
  // mounted; these greyed stand-ins keep the bar the same shape everywhere.
  const inactive = useMemo(
    () => (workbench === 'circuit' ? [] : inactiveCircuitMenus()),
    [workbench],
  );
  useContributeMenus('circuit-inactive', inactive);
  const menus = mergeMenus(...useMenuContributions());

  const ActiveWorkbench = WORKBENCH_VIEWS[workbench];

  return (
    <ReferenceDrawerProvider>
      <div
        className={`app-shell${compact ? ' app-shell--compact' : ''}${
          landscape ? ' app-shell--landscape' : ''
        }`}
      >
        {/* One row: the window title bar (installed) or the tab title
            (browser) already names the app, so no <h1> here. */}
        <header className="app-toolbar" aria-label="Logicuitry">
          <ThemeMark theme={theme} />
          <MenuBar menus={menus} />
          <nav className="workbench-switcher">
            {WORKBENCHES.map((wb, i) => (
              <button
                key={wb.id}
                type="button"
                className="workbench-tab"
                aria-pressed={workbench === wb.id}
                onClick={() => setWorkbench(wb.id)}
              >
                <span className="workbench-tab__key">{i + 1}</span>
                <span className="workbench-tab__label">{wb.label}</span>
              </button>
            ))}
          </nav>
          <div className="toolbar-modes">
            <label className="theme-picker">
              <span className="theme-picker__icon" aria-hidden="true">
                {themeInfo(theme).appearance === 'dark' ? '☾' : '☀'}
              </span>
              <select
                className="theme-picker__select"
                aria-label="Theme"
                value={theme}
                onChange={(e) => pickTheme(e.target.value as ThemeName)}
              >
                {SELECTABLE_THEMES.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {compact ? null : (
              <button
                type="button"
                className="mode-btn"
                aria-pressed={presentation}
                title={
                  fullscreenSupported()
                    ? 'Fullscreen and presentation scaling (P)'
                    : 'Presentation scaling (P)'
                }
                onClick={toggleFullscreen}
              >
                ⛶ Fullscreen
              </button>
            )}
          </div>
        </header>

        <div className="app-body">
          <main className="workbench-area">
            <ErrorBoundary key={workbench}>
              <ActiveWorkbench />
            </ErrorBoundary>
          </main>

          <ReferenceDrawer />
        </div>

        {document_.dialogs}
        {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
        {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
        {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
        {reportOpen ? <BugReportDialog onClose={() => setReportOpen(false)} /> : null}
        <HoldTip />
        <UpdateBanner presentation={presentation} />
        <DesktopUpdateBanner presentation={presentation} />

        {/* Waveform/steps footer returns with M6 when a workbench supplies it. */}
      </div>
    </ReferenceDrawerProvider>
  );
}
