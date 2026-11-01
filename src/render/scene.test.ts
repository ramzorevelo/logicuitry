import { describe, expect, it } from 'vitest';
import {
  inflateRect,
  keepCentreOnHeightLoss,
  polylineBounds,
  rectContains,
  Scene,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  type Node,
} from './scene';
import { hitTest, padHitRect } from './hitTest';

const node = (id: string, x: number, y: number, w: number, h: number): Node => ({
  id,
  bounds: { x, y, w, h },
});

describe('scene: viewport transform', () => {
  it('worldToScreen and screenToWorld round-trip', () => {
    const vp = { panX: 10, panY: 20, zoom: 2 };
    const p = { x: 37, y: 4 };
    const round = screenToWorld(vp, worldToScreen(vp, p));
    expect(round.x).toBeCloseTo(p.x, 10);
    expect(round.y).toBeCloseTo(p.y, 10);
  });

  it('keepCentreOnHeightLoss holds the centre point as the screen shrinks and grows back', () => {
    const vp = { panX: 7, panY: 20, zoom: 0.5 };
    const centre = screenToWorld(vp, { x: 160, y: 200 });
    const shrunk = keepCentreOnHeightLoss(vp, 150);
    expect(screenToWorld(shrunk, { x: 160, y: 125 })).toEqual(centre);
    expect(shrunk.panX).toBe(vp.panX);
    expect(shrunk.zoom).toBe(vp.zoom);
    expect(keepCentreOnHeightLoss(shrunk, -150)).toEqual(vp);
  });

  it('applies pan then zoom about the origin', () => {
    const vp = { panX: 5, panY: 0, zoom: 3 };
    expect(worldToScreen(vp, { x: 5, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(worldToScreen(vp, { x: 6, y: 0 })).toEqual({ x: 3, y: 0 });
  });
});

describe('scene: culling helpers', () => {
  it('visibleWorldRect covers the screen at the current pan and zoom', () => {
    const vp = { panX: 100, panY: -50, zoom: 2 };
    const r = visibleWorldRect(vp, 800, 600);
    expect(r).toEqual({ x: 100, y: -50, w: 400, h: 300 });
    expect(screenToWorld(vp, { x: 800, y: 600 })).toEqual({ x: r.x + r.w, y: r.y + r.h });
  });

  it('polylineBounds encloses every point, inflateRect pads each side', () => {
    const b = polylineBounds([
      { x: 5, y: 9 },
      { x: -3, y: 9 },
      { x: -3, y: 2 },
    ]);
    expect(b).toEqual({ x: -3, y: 2, w: 8, h: 7 });
    expect(inflateRect(b, 2)).toEqual({ x: -5, y: 0, w: 12, h: 11 });
  });
});

describe('scene: rectContains', () => {
  it('includes edges, excludes outside', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectContains(r, { x: 0, y: 0 })).toBe(true);
    expect(rectContains(r, { x: 10, y: 10 })).toBe(true);
    expect(rectContains(r, { x: 11, y: 5 })).toBe(false);
  });
});

describe('hitTest', () => {
  it('returns the topmost (last-added) node at a point', () => {
    const scene = new Scene();
    scene.add(node('under', 0, 0, 20, 20));
    scene.add(node('over', 5, 5, 20, 20));
    expect(hitTest(scene, { x: 10, y: 10 })?.id).toBe('over');
  });

  it('honors the viewport when mapping the screen point', () => {
    const scene = new Scene();
    scene.add(node('a', 100, 100, 10, 10));
    const vp = { panX: 100, panY: 100, zoom: 1 };
    expect(hitTest(scene, { x: 5, y: 5 }, vp)?.id).toBe('a');
    expect(hitTest(scene, { x: 5, y: 5 })).toBeUndefined();
  });

  it('misses empty space', () => {
    const scene = new Scene();
    scene.add(node('a', 0, 0, 10, 10));
    expect(hitTest(scene, { x: 50, y: 50 })).toBeUndefined();
  });
});

describe('padHitRect', () => {
  it('grows small rects to the fat-target minimum, centered', () => {
    const padded = padHitRect({ x: 10, y: 10, w: 4, h: 4 }, false);
    expect(padded.w).toBe(12);
    expect(padded.h).toBe(12);
    expect(padded.x).toBe(6); // centered: (10 - (12-4)/2)
  });

  it('scales the minimum in presentation mode and leaves large rects alone', () => {
    expect(padHitRect({ x: 0, y: 0, w: 4, h: 4 }, true).w).toBeCloseTo(12 * 1.4, 10);
    expect(padHitRect({ x: 0, y: 0, w: 40, h: 40 }, false).w).toBe(40);
  });
});
