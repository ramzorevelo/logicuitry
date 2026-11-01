import { describe, expect, it } from 'vitest';
import { holdTipPosition } from './HoldTip';

const phone = { w: 320, h: 579 };
const longTip = { w: 256, h: 40 };
const button = (left: number, top = 60) => ({ left, top, right: left + 44, bottom: top + 44 });

describe('holdTipPosition', () => {
  it('centres a tip that fits under the button', () => {
    expect(holdTipPosition(button(138), { w: 100, h: 30 }, phone)).toEqual({ x: 110, y: 110 });
  });

  it('keeps a long tip inside a 320px screen at either end of the toolbar', () => {
    for (const left of [0, 276]) {
      const { x } = holdTipPosition(button(left), longTip, phone);
      expect(x).toBeGreaterThanOrEqual(8);
      expect(x + longTip.w).toBeLessThanOrEqual(phone.w - 8);
    }
  });

  it('pins a tip wider than the screen to the left margin', () => {
    expect(holdTipPosition(button(200), { w: 400, h: 30 }, phone).x).toBe(8);
  });

  it('goes above a button too near the bottom edge', () => {
    expect(holdTipPosition(button(100, 520), longTip, phone).y).toBe(520 - 6 - 40);
  });
});
