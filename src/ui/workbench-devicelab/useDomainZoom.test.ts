import { describe, expect, it } from 'vitest';
import { clampSpan } from './useDomainZoom';

// The full domain in these is 0..5, as a 5V rail.
describe('clampSpan', () => {
  it('leaves a window that already fits alone', () => {
    expect(clampSpan(1, 3, 0, 5)).toEqual([1, 3]);
  });

  it('slides a window back inside rather than shrinking it', () => {
    // Panned off the top: same 2V span, moved down to sit against the rail.
    expect(clampSpan(4, 6, 0, 5)).toEqual([3, 5]);
    expect(clampSpan(-2, 0, 0, 5)).toEqual([0, 2]);
  });

  it('never zooms out past the full domain', () => {
    expect(clampSpan(-10, 20, 0, 5)).toEqual([0, 5]);
  });

  it('stops zooming in at a twentieth of the domain, where the axis stops meaning anything', () => {
    const [lo, hi] = clampSpan(2.5, 2.5, 0, 5);
    expect(hi - lo).toBeCloseTo(0.25, 10);
    expect((lo + hi) / 2).toBeCloseTo(2.5, 10);
  });
});
