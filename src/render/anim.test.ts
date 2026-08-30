import { describe, expect, it } from 'vitest';
import { cardFlip, easeInOut, expApproach, lerp, tween, tweenDone } from './anim';

describe('anim: easing curves', () => {
  it('easeInOut ports endpoints and is symmetric about the midpoint', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 10);
  });

  it('lerp interpolates endpoints', () => {
    expect(lerp(2, 10, 0)).toBe(2);
    expect(lerp(2, 10, 1)).toBe(10);
    expect(lerp(2, 10, 0.25)).toBe(4);
  });
});

describe('anim: expApproach follower', () => {
  it('moves a fraction toward target and terminates exactly', () => {
    let v = 0;
    for (let i = 0; i < 500; i++) v = expApproach(v, 100);
    expect(v).toBe(100); // snaps, does not asymptote forever
  });

  it('is monotonic toward the target', () => {
    let v = 0;
    let prev = -1;
    for (let i = 0; i < 5; i++) {
      v = expApproach(v, 10, 0.16);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('anim: tween', () => {
  it('clamps outside the window and eases inside', () => {
    expect(tween(0, 0, 200)).toBe(0);
    expect(tween(300, 0, 200)).toBe(1); // past the end clamps to 1
    expect(tween(100, 0, 200)).toBeCloseTo(0.5, 10);
  });

  it('treats non-positive duration as instantly complete', () => {
    expect(tween(0, 0, 0)).toBe(1);
    expect(tweenDone(0, 0, 0)).toBe(true);
  });

  it('reports completion at the boundary', () => {
    expect(tweenDone(199, 0, 200)).toBe(false);
    expect(tweenDone(200, 0, 200)).toBe(true);
  });
});

describe('anim: cardFlip', () => {
  it('collapses to zero width edge-on and swaps face at the midpoint', () => {
    expect(cardFlip(0)).toEqual({ scaleX: 1, face: 'front' });
    expect(cardFlip(0.5).scaleX).toBeCloseTo(0, 10);
    expect(cardFlip(0.5).face).toBe('back');
    expect(cardFlip(1)).toEqual({ scaleX: 1, face: 'back' });
  });
});
