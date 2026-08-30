import { create } from 'zustand';
import { isSelectableTheme, isThemeName, type ThemeName } from '../render/theme';

// One persisted blob for every user preference. A preference lives here only if
// it has a real seam to drive: it supplies the initial value of state that
// already exists, and writes through where the owning surface allows.

export interface Prefs {
  /** Keep a wide pin's slash + bit-count badge even once the pin is wired. */
  alwaysShowPinBusWidth: boolean;
  waveformArrows: boolean;
  glitchThresholdNs: number;
  hideAnswersDefault: boolean;
  timingModel: 'ideal' | 'datasheet';
  presentationAtLaunch: boolean;
  defaultTheme: ThemeName;
  restoreLastBoard: boolean;
  /** Frame a board to the viewport when it opens, as Home does. A bundled
   *  example always frames whatever this says -- it ships no camera worth
   *  restoring -- so this governs the user's own boards. */
  fitOnOpen: boolean;
  autosave: boolean;
  confirmReplaceBoard: boolean;
  /** Desktop only. Off: an available update is a passive indicator and nothing
   *  is fetched until asked. Hidden entirely in the browser build. */
  autoDownloadUpdates: boolean;
  /** Desktop only. On: quitting applies a downloaded update, so the next
   *  launch is the new version. Windows installers exit the app to run, which
   *  is why this is on close and not on startup. */
  applyUpdatesOnClose: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  alwaysShowPinBusWidth: false,
  waveformArrows: false,
  glitchThresholdNs: 25,
  hideAnswersDefault: true,
  timingModel: 'ideal',
  presentationAtLaunch: false,
  defaultTheme: 'light',
  restoreLastBoard: true,
  fitOnOpen: true,
  autosave: true,
  confirmReplaceBoard: true,
  autoDownloadUpdates: false,
  applyUpdatesOnClose: false,
};

export const PREFS_STORAGE_KEY = 'lcir.prefs';

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Clamped so a hand-edited or truncated blob can't produce a threshold that
 *  silently disables the glitch scan. */
function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function theme(v: unknown): ThemeName {
  if (typeof v !== 'string' || !isThemeName(v)) return DEFAULT_PREFS.defaultTheme;
  return isSelectableTheme(v) ? v : DEFAULT_PREFS.defaultTheme;
}

/** Field-by-field, so an unknown, missing or wrong-typed entry falls back
 *  rather than poisoning the whole blob. */
export function mergePrefs(raw: unknown): Prefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS };
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    alwaysShowPinBusWidth: bool(r['alwaysShowPinBusWidth'], d.alwaysShowPinBusWidth),
    waveformArrows: bool(r['waveformArrows'], d.waveformArrows),
    glitchThresholdNs: num(r['glitchThresholdNs'], d.glitchThresholdNs, 1, 10000),
    hideAnswersDefault: bool(r['hideAnswersDefault'], d.hideAnswersDefault),
    timingModel: r['timingModel'] === 'datasheet' ? 'datasheet' : 'ideal',
    presentationAtLaunch: bool(r['presentationAtLaunch'], d.presentationAtLaunch),
    defaultTheme: theme(r['defaultTheme']),
    restoreLastBoard: bool(r['restoreLastBoard'], d.restoreLastBoard),
    fitOnOpen: bool(r['fitOnOpen'], d.fitOnOpen),
    autosave: bool(r['autosave'], d.autosave),
    confirmReplaceBoard: bool(r['confirmReplaceBoard'], d.confirmReplaceBoard),
    autoDownloadUpdates: bool(r['autoDownloadUpdates'], d.autoDownloadUpdates),
    applyUpdatesOnClose: bool(r['applyUpdatesOnClose'], d.applyUpdatesOnClose),
  };
}

/** Storage can throw under a locked-down profile, and a preference is never
 *  worth failing startup over. */
export function loadPrefs(): Prefs {
  try {
    const saved = localStorage.getItem(PREFS_STORAGE_KEY);
    return mergePrefs(saved ? JSON.parse(saved) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // no persistence available
  }
}

interface PrefsState {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  resetPrefs: () => void;
}

export const usePrefsStore = create<PrefsState>((set) => ({
  prefs: loadPrefs(),
  setPref: (key, value) =>
    set((s) => {
      const prefs = { ...s.prefs, [key]: value };
      savePrefs(prefs);
      return { prefs };
    }),
  resetPrefs: () => {
    savePrefs(DEFAULT_PREFS);
    return set({ prefs: { ...DEFAULT_PREFS } });
  },
}));

/** Read outside React (module init, canvas draw paths). */
export function getPrefs(): Prefs {
  return usePrefsStore.getState().prefs;
}
