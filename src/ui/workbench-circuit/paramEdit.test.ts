import { describe, expect, it } from 'vitest';
import { clampInt, clampPopupToCanvas, parseConstantValue } from './paramEdit';

describe('clampInt', () => {
  it('clamps into range and rounds', () => {
    expect(clampInt(5, 1, 32)).toBe(5);
    expect(clampInt(0, 1, 32)).toBe(1);
    expect(clampInt(99, 1, 32)).toBe(32);
    expect(clampInt(3.6, 1, 32)).toBe(4);
  });
});

describe('parseConstantValue', () => {
  it('parses plain decimal', () => {
    expect(parseConstantValue('23')).toBe(23);
    expect(parseConstantValue('0')).toBe(0);
  });

  it('parses 0x-prefixed hex, case-insensitive', () => {
    expect(parseConstantValue('0x1F')).toBe(31);
    expect(parseConstantValue('0X1f')).toBe(31);
  });

  it('trims whitespace', () => {
    expect(parseConstantValue('  10  ')).toBe(10);
  });

  it('rejects garbage', () => {
    expect(parseConstantValue('abc')).toBeNull();
    expect(parseConstantValue('')).toBeNull();
  });
});

describe('clampPopupToCanvas', () => {
  const canvas = { w: 800, h: 600 };
  const popup = { w: 200, h: 150 };

  it('keeps the default below-left anchor when there is room', () => {
    const anchor = { compLeft: 100, compTop: 80, compRight: 140, compBottom: 100 };
    expect(clampPopupToCanvas(anchor, popup, canvas)).toEqual({ x: 100, y: 100 });
  });

  it('flips above the component when below-left would overflow the bottom edge', () => {
    const anchor = { compLeft: 100, compTop: 500, compRight: 140, compBottom: 520 };
    const r = clampPopupToCanvas(anchor, popup, canvas);
    expect(r.y).toBe(500 - popup.h);
    expect(r.x).toBe(100);
  });

  it('flips right-aligned when the default left anchor would overflow the right edge', () => {
    const anchor = { compLeft: 700, compTop: 80, compRight: 740, compBottom: 100 };
    const r = clampPopupToCanvas(anchor, popup, canvas);
    expect(r.x).toBe(740 - popup.w);
    expect(r.y).toBe(100);
  });

  it('a component at the top-left corner flips to bottom-right of itself', () => {
    const anchor = { compLeft: 0, compTop: 0, compRight: 20, compBottom: 20 };
    // Not actually an overflow case (top-left has plenty of room below/right)
    // -- default below-left anchor already fits.
    expect(clampPopupToCanvas(anchor, popup, canvas)).toEqual({ x: 0, y: 20 });
  });

  it('a component pinned to the bottom-right corner clamps into the canvas without going negative', () => {
    const anchor = { compLeft: 780, compTop: 580, compRight: 800, compBottom: 600 };
    const r = clampPopupToCanvas(anchor, popup, canvas);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + popup.w).toBeLessThanOrEqual(canvas.w);
    expect(r.y + popup.h).toBeLessThanOrEqual(canvas.h);
  });

  it('never places the popup outside the canvas even for a popup larger than the canvas', () => {
    const anchor = { compLeft: 10, compTop: 10, compRight: 30, compBottom: 30 };
    const hugePopup = { w: 900, h: 700 };
    const r = clampPopupToCanvas(anchor, hugePopup, canvas);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});
