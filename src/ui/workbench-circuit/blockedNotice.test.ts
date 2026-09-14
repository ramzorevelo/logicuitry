import { describe, expect, it, vi } from 'vitest';
import {
  HAPTIC_MIN_GAP_MS,
  NoticePolicy,
  RENOTICE_AFTER_MS,
  blockedText,
  makeHaptic,
} from './blockedNotice';

describe('NoticePolicy', () => {
  it('announces the first attempt', () => {
    const p = new NoticePolicy();
    expect(p.shouldAnnounce('powered-place', 0)).toBe(true);
  });

  it('stays silent through a burst of repeats', () => {
    const p = new NoticePolicy();
    expect(p.shouldAnnounce('bubble-edit', 0)).toBe(true);
    for (let t = 100; t < RENOTICE_AFTER_MS; t += 100)
      expect(p.shouldAnnounce('bubble-edit', t)).toBe(false);
  });

  it('re-arms only after a quiet gap, measured from the last attempt', () => {
    const p = new NoticePolicy();
    p.shouldAnnounce('powered-param', 0);
    // Still trying at 9s: the gap has not happened, so no second announcement,
    // and this attempt pushes the window out again.
    expect(p.shouldAnnounce('powered-param', 9_000)).toBe(false);
    expect(p.shouldAnnounce('powered-param', 18_000)).toBe(false);
    expect(p.shouldAnnounce('powered-param', 18_000 + RENOTICE_AFTER_MS)).toBe(true);
  });

  it('tracks each reason separately', () => {
    const p = new NoticePolicy();
    expect(p.shouldAnnounce('powered-place', 0)).toBe(true);
    expect(p.shouldAnnounce('powered-wire', 0)).toBe(true);
    expect(p.shouldAnnounce('powered-place', 10)).toBe(false);
  });

  it('reset makes every reason eligible again (power cycle, mode exit)', () => {
    const p = new NoticePolicy();
    p.shouldAnnounce('powered-place', 0);
    p.reset();
    expect(p.shouldAnnounce('powered-place', 10)).toBe(true);
  });

  it('every reason has text, and none of it uses an em dash', () => {
    for (const r of [
      'powered-place',
      'powered-wire',
      'powered-param',
      'powered-rename',
      'bubble-edit',
    ] as const) {
      expect(blockedText(r).length).toBeGreaterThan(0);
      expect(blockedText(r)).not.toMatch(/—/);
    }
  });
});

describe('makeHaptic', () => {
  it('buzzes every attempt once the throttle gap has passed', () => {
    const vibrate = vi.fn();
    let t = 0;
    const buzz = makeHaptic(vibrate, () => t);
    buzz();
    t += HAPTIC_MIN_GAP_MS;
    buzz();
    expect(vibrate).toHaveBeenCalledTimes(2);
    expect(vibrate).toHaveBeenCalledWith(15);
  });

  it('throttles a burst instead of machine-gunning', () => {
    const vibrate = vi.fn();
    let t = 0;
    const buzz = makeHaptic(vibrate, () => t);
    for (let i = 0; i < 20; i++) {
      buzz();
      t += 10;
    }
    // 20 attempts over 200ms: the first plus one more once the gap elapsed.
    expect(vibrate).toHaveBeenCalledTimes(2);
  });
});
