// Two ways a cached tile can end up in the wrong place, both of which show up
// as a glyph whose pins no longer meet the wires drawn beside it:
//   - position is not part of the cache key, so an absolute origin baked into
//     the tile pins a moved component to wherever it was first drawn;
//   - tiles are rasterised at a bucketed zoom, so sizing one by the current
//     frame's scale rescales it by bucket/scale.

import { describe, expect, it } from 'vitest';
import { tileWorldSize, zoomBucket } from './glyphCache';

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
