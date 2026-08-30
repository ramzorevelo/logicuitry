// The waveform panel's window arithmetic, kept pure so it can be tested. The
// panel owns three pieces of state and this turns them into the one window
// that gets drawn.

export interface Win {
  t0: number;
  t1: number;
}

/**
 * The window to draw, or null to let the trace view pick its own full span.
 *
 * autoFit  on  -> the whole trace, span included.
 * autoFit  off -> `frozen` is the user's span and nothing widens it.
 * autoScroll on-> the right edge rides the newest sample, span unchanged.
 */
export function effectiveWindow(
  frozen: Win | null,
  full: Win,
  autoFit: boolean,
  autoScroll: boolean,
): Win | null {
  if (autoFit || !frozen) return null;
  if (!autoScroll) return frozen;
  const span = Math.max(1, frozen.t1 - frozen.t0);
  // Clamped at the trace start: following the end must never invent history
  // to the left of the oldest record still in the ring buffer.
  return { t0: Math.max(full.t0, full.t1 - span), t1: full.t1 };
}
