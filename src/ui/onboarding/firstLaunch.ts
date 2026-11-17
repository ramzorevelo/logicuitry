// Whether this launch is someone's first. The What's New marker is the only
// trace every earlier version left, so its absence is the signal; it is read
// once, at import, before useWhatsNew writes it on this same launch.

const SEEN_VERSION_KEY = 'lcir.lastSeenVersion';

/** `unreadable`: storage threw, so a dismissal could not be remembered either. */
export type SeenAtLaunch = 'never' | 'seen' | 'unreadable';

function readSeenAtLaunch(): SeenAtLaunch {
  try {
    return localStorage.getItem(SEEN_VERSION_KEY) === null ? 'never' : 'seen';
  } catch {
    return 'unreadable';
  }
}

const SEEN_AT_LAUNCH = readSeenAtLaunch();

export interface LaunchFacts {
  seen: SeenAtLaunch;
  /** A file, a launch-queue document or a restored session arrived at startup. */
  documentOpened: boolean;
  presentation: boolean;
}

/** Only a fresh profile, landing on nothing in particular, off the lecture screen. */
export function shouldWelcome(facts: LaunchFacts): boolean {
  return facts.seen === 'never' && !facts.documentOpened && !facts.presentation;
}

export function seenAtLaunch(): SeenAtLaunch {
  return SEEN_AT_LAUNCH;
}

let welcomeOffered = false;

/** True the first time only: a shell that mounts again in the same page load does not ask twice. */
export function takeWelcomeChance(): boolean {
  if (welcomeOffered) return false;
  welcomeOffered = true;
  return true;
}
