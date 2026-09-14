// Feedback for a gesture the current mode refuses: a powered board rejecting a
// move or a wire, bubble-push mode swallowing an edit, a tap on a param field
// greyed out because it needs a recompile.
//
// The whole point is that repeating the gesture must not nag. A burst of
// attempts produces one explanation and then only the silent flash, and the
// explanation becomes eligible again once the user has stopped for a while --
// so a mistake made later in the lecture is still explained.

/** Why a gesture was refused. One key per distinct explanation, so two
 *  different blocks in the same burst each get to speak once. */
export type BlockedReason =
  | 'powered-place'
  | 'powered-wire'
  | 'powered-param'
  | 'powered-rename'
  | 'bubble-edit';

/** Quiet gap after which a reason may announce itself again. */
export const RENOTICE_AFTER_MS = 10_000;

/** How long an announcement stays on screen. */
export const NOTICE_LINGER_MS = 2_500;

/** Minimum gap between haptic pulses, so a burst cannot machine-gun. */
export const HAPTIC_MIN_GAP_MS = 150;

// Moving a component IS allowed while powered (a drag changes no connectivity),
// so there is deliberately no reason for it here.
const TEXT: Record<BlockedReason, string> = {
  'powered-place': 'Power off to add parts.',
  'powered-wire': 'Power off to change wiring.',
  'powered-param': 'Power off to change this.',
  'powered-rename': 'Power off to rename.',
  'bubble-edit': 'Leave bubble mode to edit the board.',
};

export function blockedText(reason: BlockedReason): string {
  return TEXT[reason];
}

/** Decides, per reason, whether this attempt gets the words or only the flash.
 *  Deliberately a plain object rather than store state: it is not something an
 *  undo should revisit, nor anything a board file should carry. */
export class NoticePolicy {
  private lastAt = new Map<BlockedReason, number>();

  /** True when `reason` may announce itself now. Records the attempt either
   *  way, so a steady stream of attempts keeps postponing the next one. */
  shouldAnnounce(reason: BlockedReason, now: number): boolean {
    const previous = this.lastAt.get(reason);
    this.lastAt.set(reason, now);
    return previous === undefined || now - previous >= RENOTICE_AFTER_MS;
  }

  /** Powering off/on (or leaving bubble mode) is a fresh context: whatever the
   *  previous mode explained should not be held against the next one. */
  reset(): void {
    this.lastAt.clear();
  }
}

/** Short buzz on a refused gesture, throttled. Android Chrome is the only
 *  engine that implements it; everywhere else this is a silent no-op, which is
 *  why it can only ever supplement something visible. */
export function makeHaptic(
  vibrate: (ms: number) => void,
  now: () => number = () => Date.now(),
): () => void {
  let lastAt = -Infinity;
  return () => {
    const t = now();
    if (t - lastAt < HAPTIC_MIN_GAP_MS) return;
    lastAt = t;
    vibrate(15);
  };
}
