import { describe, expect, it } from 'vitest';
import { clampPan, zoomAbout, FIT, MAX_ZOOM } from './useCanvasZoom';

// A 400x300 window onto the figure.
const W = 400;
const H = 300;

describe('clampPan', () => {
  it('pins an unmagnified figure at the origin: there is nowhere to pan to', () => {
    expect(clampPan({ zoom: 1, panX: 120, panY: 90 }, W, H)).toEqual(FIT);
  });

  it('lets a doubled figure pan by exactly its overhang, and no further', () => {
    expect(clampPan({ zoom: 2, panX: 9999, panY: 9999 }, W, H)).toEqual({
      zoom: 2,
      panX: W,
      panY: H,
    });
  });

  it('refuses to drag the figure off its own edge', () => {
    expect(clampPan({ zoom: 2, panX: -50, panY: -50 }, W, H)).toEqual({
      zoom: 2,
      panX: 0,
      panY: 0,
    });
  });

  it('never zooms out past fit, or in past the cap', () => {
    expect(clampPan({ zoom: 0.2, panX: 0, panY: 0 }, W, H).zoom).toBe(1);
    expect(clampPan({ zoom: 99, panX: 0, panY: 0 }, W, H).zoom).toBe(MAX_ZOOM);
  });
});

describe('zoomAbout', () => {
  it('keeps the point under the fingers under the fingers', () => {
    const focalX = 100;
    const focalY = 75;
    const before = { zoom: 2, panX: 200, panY: 150 };
    // Which point of the figure sits at the focal point right now.
    const figureX = (before.panX + focalX) / before.zoom;
    const after = zoomAbout(before, 1.5, focalX, focalY, W, H);
    expect((after.panX + focalX) / after.zoom).toBeCloseTo(figureX, 6);
  });

  it('zooming out to fit leaves no pan behind', () => {
    const out = zoomAbout({ zoom: 2, panX: 400, panY: 300 }, 0.1, 200, 150, W, H);
    expect(out).toEqual(FIT);
  });
});
