// Desktop updates. Manual mode throughout: check, then download, then install,
// each a separate step, none of them automatic by default.
//
// The Windows constraint that shapes all of this: `install()` exits the
// application to run the installer. There is no stage-now-apply-silently-at-
// next-launch. The download can be invisible; the apply cannot. So the apply
// happens on close, never on startup: a launch-time apply would bounce the app
// at exactly the moment someone starts lecturing.
//
// INVARIANT: `install()` is reachable from exactly two places: an explicit
// "Restart now" click, and the app-close path when `applyUpdatesOnClose` is on.
// Nothing else may call it. That is what protects a live lecture.

import { isDesktop } from '../../io/platform';
import { getPrefs } from '../prefs';

export interface UpdateState {
  /** A newer version exists. */
  available: boolean;
  version?: string;
  /** The installer is on disk and ready to apply. */
  downloaded: boolean;
  downloading: boolean;
}

type Listener = (state: UpdateState) => void;

let state: UpdateState = { available: false, downloaded: false, downloading: false };
const listeners = new Set<Listener>();

// The plugin's Update object, held between check -> download -> install.
let pending: {
  version: string;
  downloadAndInstall?: unknown;
  download(): Promise<void>;
  install(): Promise<void>;
} | null = null;

function emit(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l(state);
}

export function subscribeUpdates(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

export function updateState(): UpdateState {
  return state;
}

/**
 * Look for an update. Offline this fails and is swallowed: it must never block
 * launch, never show an error, and never retry in a loop.
 */
export async function checkForUpdate(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const found = await check();
    if (!found) return;
    pending = found as unknown as typeof pending;
    emit({ available: true, version: found.version });
    if (getPrefs().autoDownloadUpdates) await downloadUpdate();
  } catch {
    // No network, no manifest, or a malformed one. Nothing to say.
  }
}

/** Fetch the installer in the background. The board stays editable throughout. */
export async function downloadUpdate(): Promise<void> {
  if (!pending || state.downloaded || state.downloading) return;
  emit({ downloading: true });
  try {
    await pending.download();
    emit({ downloading: false, downloaded: true });
  } catch {
    emit({ downloading: false });
  }
}

/**
 * Apply and exit. One of the two permitted call sites; see the invariant at the
 * top of this file. The caller is responsible for having settled unsaved work
 * first, since this does not ask.
 */
export async function installUpdate(): Promise<void> {
  if (!pending || !state.downloaded) return;
  await pending.install();
}

/** The close path: applies only when the preference says so and one is ready. */
export async function applyUpdateOnClose(): Promise<boolean> {
  if (!getPrefs().applyUpdatesOnClose || !state.downloaded) return false;
  await installUpdate();
  return true;
}
