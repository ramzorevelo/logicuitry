// The one easing vocabulary, ported from the prototypes. Pure: callers pass the
// current clock, nothing schedules itself, so animation stays deterministic and
// testable. Feedback only, never idle motion; everything resolves under 400ms.

export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;

// Smoothstep: the default for bounded reveals (120-200ms transitions).
export const easeInOut: Easing = (t) => t * t * (3 - 2 * t);

export const easeOut: Easing = (t) => 1 - (1 - t) * (1 - t);

/**
 * Exponential follower for continuous state changes (hover, value settle). One
 * step toward target; factor 0.14-0.18 matches the prototype feel. Frame-rate
 * dependent by design (per-frame factor), which is what the prototypes used.
 */
export function expApproach(current: number, target: number, factor = 0.16): number {
  const next = current + (target - current) * factor;
  // Snap once within a sub-pixel of target so followers actually terminate.
  return Math.abs(target - next) < 1e-3 ? target : next;
}

/** Normalized [0,1] progress of a fixed-duration transition, eased. */
export function tween(
  now: number,
  start: number,
  durationMs: number,
  ease: Easing = easeInOut,
): number {
  if (durationMs <= 0) return 1;
  const raw = (now - start) / durationMs;
  const clamped = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
  return ease(clamped);
}

/** True once a fixed-duration transition has fully elapsed. */
export function tweenDone(now: number, start: number, durationMs: number): boolean {
  return now - start >= durationMs;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Card-flip progress for value inversion (NOT, two's-complement steps). Returns
 * the horizontal scale (1 -> 0 -> 1) and which face shows; swap the rendered
 * value as `face` flips so the glyph changes edge-on.
 */
export interface Flip {
  scaleX: number;
  face: 'front' | 'back';
}

export function cardFlip(progress: number): Flip {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return { scaleX: Math.abs(1 - 2 * p), face: p < 0.5 ? 'front' : 'back' };
}
