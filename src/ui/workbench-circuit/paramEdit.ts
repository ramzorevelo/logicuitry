// Pure helpers for the width/param overlay: clamping and the constant value
// parser, split out so they're unit-testable without rendering the overlay.

export function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Accepts plain decimal or a `0x`-prefixed hex literal; null on anything else. */
export function parseConstantValue(text: string): number | null {
  const trimmed = text.trim();
  const parsed = /^0x/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Keeps a double-click popup inside the canvas: default anchor is
 *  below-left of the component; flips to above when it would overflow the
 *  bottom edge, and to right-aligned (extending leftward) when it would
 *  overflow the right edge, so a component near the bottom/right/corner of
 *  the canvas gets the popup on whichever side actually has room. */
export function clampPopupToCanvas(
  anchor: { compLeft: number; compTop: number; compRight: number; compBottom: number },
  popup: { w: number; h: number },
  canvas: { w: number; h: number },
): { x: number; y: number } {
  let y = anchor.compBottom;
  if (y + popup.h > canvas.h) {
    const above = anchor.compTop - popup.h;
    y = above >= 0 ? above : canvas.h - popup.h;
  }
  let x = anchor.compLeft;
  if (x + popup.w > canvas.w) {
    const flipped = anchor.compRight - popup.w;
    x = flipped >= 0 ? flipped : canvas.w - popup.w;
  }
  return {
    x: Math.max(0, Math.min(x, canvas.w - popup.w)),
    y: Math.max(0, Math.min(y, canvas.h - popup.h)),
  };
}
