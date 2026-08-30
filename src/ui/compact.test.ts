import { describe, expect, it } from 'vitest';
import { COMPACT_MAX_HEIGHT, COMPACT_MAX_WIDTH, COMPACT_QUERY, LANDSCAPE_QUERY } from './compact';

/** Stand-in for matchMedia over the handful of features the query uses. */
function matches(query: string, vp: { w: number; h: number; coarse: boolean }): boolean {
  return query.split(',').some((arm) =>
    arm.split(' and ').every((cond) => {
      const w = /\(max-width:\s*(\d+)px\)/.exec(cond);
      if (w) return vp.w <= Number(w[1]);
      const h = /\(max-height:\s*(\d+)px\)/.exec(cond);
      if (h) return vp.h <= Number(h[1]);
      if (/pointer:\s*coarse/.test(cond)) return vp.coarse;
      if (/orientation:\s*landscape/.test(cond)) return vp.w > vp.h;
      throw new Error(`unhandled condition ${cond}`);
    }),
  );
}

describe('COMPACT_QUERY', () => {
  const phonePortrait = { w: 390, h: 844, coarse: true };
  const phoneLandscape = { w: 844, h: 390, coarse: true };
  const tabletLandscape = { w: 1024, h: 768, coarse: true };
  const laptop = { w: 1440, h: 900, coarse: false };
  const shortDesktopWindow = { w: 1440, h: 420, coarse: false };

  it('a phone is compact both ways up', () => {
    expect(matches(COMPACT_QUERY, phonePortrait)).toBe(true);
    // The regression: landscape clears the width test, so only the height arm
    // catches it.
    expect(matches(COMPACT_QUERY, phoneLandscape)).toBe(true);
  });

  it('tablets and laptops keep the desktop shell', () => {
    expect(matches(COMPACT_QUERY, tabletLandscape)).toBe(false);
    expect(matches(COMPACT_QUERY, laptop)).toBe(false);
  });

  it('a short desktop window is not a phone, because its pointer is fine', () => {
    expect(matches(COMPACT_QUERY, shortDesktopWindow)).toBe(false);
  });

  it('landscape is the second axis, not a second threshold', () => {
    // Both are compact; which way up is what decides where the chrome goes.
    expect(matches(LANDSCAPE_QUERY, phonePortrait)).toBe(false);
    expect(matches(LANDSCAPE_QUERY, phoneLandscape)).toBe(true);
    // A laptop is landscape too, which is why the shell only stamps the class
    // when it is also compact.
    expect(matches(LANDSCAPE_QUERY, laptop)).toBe(true);
    expect(matches(COMPACT_QUERY, laptop)).toBe(false);
  });

  it('the thresholds sit between a phone landscape and a tablet', () => {
    expect(COMPACT_MAX_HEIGHT).toBeGreaterThan(390);
    expect(COMPACT_MAX_HEIGHT).toBeLessThan(768);
    expect(COMPACT_MAX_WIDTH).toBeLessThan(844);
  });
});
