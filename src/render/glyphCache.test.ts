// Two ways a cached tile can end up in the wrong place, both of which show up
// as a glyph whose pins no longer meet the wires drawn beside it:
//   - position is not part of the cache key, so an absolute origin baked into
//     the tile pins a moved component to wherever it was first drawn;
//   - tiles are rasterised at a bucketed zoom, so sizing one by the current
//     frame's scale rescales it by bucket/scale.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGlyphCache,
  drawCachedGlyph,
  drawWithGlyphBudget,
  fitGlyphCacheTo,
  glyphCacheSize,
  paintWithoutGlyphCache,
  tileWorldSize,
  zoomBucket,
} from './glyphCache';

describe('tileWorldSize', () => {
  it('measures a tile in its own scale, so world size is zoom-independent', () => {
    const atBucket1 = tileWorldSize(64, 48, 1);
    const atBucket2 = tileWorldSize(128, 96, 2);
    expect(atBucket1).toEqual({ w: 64, h: 48 });
    expect(atBucket2).toEqual({ w: 64, h: 48 });
  });

  it('stays exact where the frame scale sits furthest from its bucket', () => {
    // 1.12 buckets to 1.0: sizing by the frame scale would shrink the glyph by
    // ~11% while its wires stayed put.
    const scale = 1.12;
    const bucket = zoomBucket(scale);
    expect(bucket).not.toBe(scale);
    expect(tileWorldSize(100, 100, bucket).w).toBe(100 / bucket);
  });
});

describe('zoomBucket', () => {
  it('is stable across a small zoom change and never zero', () => {
    expect(zoomBucket(1.02)).toBe(zoomBucket(1.08));
    expect(zoomBucket(0.0001)).toBeGreaterThan(0);
  });
});

describe('drawWithGlyphBudget', () => {
  // Node has no canvas: every tile is a stub whose one painted pixel is opaque.
  const fakeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        setTransform: () => {},
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(255),
        }),
      }),
    };
    return canvas;
  };
  const blits: unknown[] = [];
  const screen = {
    drawImage: (img: unknown) => blits.push(img),
  } as unknown as CanvasRenderingContext2D;
  const bounds = { x: 0, y: 0, w: 10, h: 10 };
  let painted: unknown[] = [];
  const paint = (c: CanvasRenderingContext2D) => painted.push(c);
  const draw = (key: string, scale: number) =>
    drawCachedGlyph(screen, key, scale, bounds, paint, 0);

  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
    clearGlyphCache();
    blits.length = 0;
    painted = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('builds every missing tile at once outside a budgeted frame', () => {
    draw('a', 1);
    draw('b', 1);
    expect(painted).toHaveLength(2);
    expect(glyphCacheSize()).toBe(2);
  });

  it('past the budget, stands in with the previous zoom and asks for a frame', () => {
    draw('a', 1);
    const firstTile = blits[0];
    const pending = drawWithGlyphBudget(() => draw('a', 2), -1);
    expect(pending).toBe(true);
    expect(painted).toHaveLength(1);
    expect(blits[1]).toBe(firstTile);

    expect(drawWithGlyphBudget(() => draw('a', 2), 1000)).toBe(false);
    expect(painted).toHaveLength(2);
    expect(blits[2]).not.toBe(firstTile);
  });

  it('paints a glyph with no tile at all straight to the screen', () => {
    expect(drawWithGlyphBudget(() => draw('a', 1), -1)).toBe(true);
    expect(painted).toEqual([screen]);
    expect(glyphCacheSize()).toBe(0);
  });

  it('keeps two zoom levels per glyph', () => {
    for (const scale of [1, 2, 3]) draw('a', scale);
    expect(glyphCacheSize()).toBe(2);
  });

  it('caps the cache at 1000 tiles for a small board', () => {
    fitGlyphCacheTo(10);
    for (let i = 0; i < 1100; i++) draw(`k${i}`, 1);
    expect(glyphCacheSize()).toBe(1000);
  });

  it('holds every glyph of a board larger than the floor', () => {
    fitGlyphCacheTo(1500);
    for (let i = 0; i < 1500; i++) draw(`k${i}`, 1);
    expect(glyphCacheSize()).toBe(1500);
    fitGlyphCacheTo(0);
  });

  it('paints a one-off picture without touching the tiles or the cap', () => {
    fitGlyphCacheTo(1500);
    for (let i = 0; i < 1500; i++) draw(`k${i}`, 1);
    painted = [];
    paintWithoutGlyphCache(() => {
      fitGlyphCacheTo(10);
      draw('thumb', 0.3);
    });
    expect(painted).toEqual([screen]);
    expect(glyphCacheSize()).toBe(1500);
    draw('after', 1);
    expect(glyphCacheSize()).toBe(1501);
    fitGlyphCacheTo(0);
  });
});
