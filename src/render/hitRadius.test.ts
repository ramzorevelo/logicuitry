import { describe, expect, it } from 'vitest';
import { MIN_HIT_RADIUS, TOUCH_HIT_RADIUS, WIRE_BODY_HIT_RADIUS, hitRadius } from './hitTest';

describe('hitRadius', () => {
  it('is the plain constant in world units at 100% zoom', () => {
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 1 })).toBe(MIN_HIT_RADIUS);
  });

  it('grows as the board is zoomed out, so a pin stays as easy to hit', () => {
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 0.5 })).toBe(MIN_HIT_RADIUS * 2);
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 2 })).toBe(MIN_HIT_RADIUS / 2);
  });

  it('a finger gets at least the 44px target, a mouse does not', () => {
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 1, touch: true })).toBe(TOUCH_HIT_RADIUS);
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 1, touch: false })).toBe(MIN_HIT_RADIUS);
    // Strictly larger for every radius the editor uses.
    for (const base of [MIN_HIT_RADIUS, WIRE_BODY_HIT_RADIUS])
      expect(hitRadius(base, { zoom: 1, touch: true })).toBeGreaterThan(
        hitRadius(base, { zoom: 1 }),
      );
  });

  it('never shrinks a budget that is already bigger than the touch floor', () => {
    expect(hitRadius(40, { zoom: 1, touch: true })).toBe(40);
  });

  it('presentation scaling still applies, and composes with touch', () => {
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 1, presentation: true })).toBeCloseTo(16.8);
    expect(hitRadius(MIN_HIT_RADIUS, { zoom: 1, presentation: true, touch: true })).toBeCloseTo(
      TOUCH_HIT_RADIUS * 1.4,
    );
  });

  it('a degenerate zoom cannot produce an infinite radius', () => {
    expect(Number.isFinite(hitRadius(MIN_HIT_RADIUS, { zoom: 0 }))).toBe(true);
  });
});
