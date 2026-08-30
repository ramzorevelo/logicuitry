import { describe, expect, it } from 'vitest';
import { rectContains, Scene, screenToWorld, worldToScreen, type Node } from './scene';
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

  it('applies pan then zoom about the origin', () => {
    const vp = { panX: 5, panY: 0, zoom: 3 };
    expect(worldToScreen(vp, { x: 5, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(worldToScreen(vp, { x: 6, y: 0 })).toEqual({ x: 3, y: 0 });
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
