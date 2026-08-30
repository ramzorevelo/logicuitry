import { describe, expect, it } from 'vitest';
import { lodFor, showsBloom, showsCorners, showsPattern, showsRelief } from './lod';
import { zoomBucket } from './glyphCache';

describe('lodFor', () => {
  it('keeps full detail on a normal board at normal zoom', () => {
    expect(lodFor(1, 20)).toBe('full');
  });

  it('degrades on zoom-out and on density alike', () => {
    expect(lodFor(0.6, 20)).toBe('reduced');
    expect(lodFor(1, 200)).toBe('reduced');
    expect(lodFor(0.3, 20)).toBe('flat');
    expect(lodFor(1, 500)).toBe('flat');
  });

  it('drops decoration in cost order: motifs, then patterns and bloom, then relief', () => {
    expect(showsCorners('reduced')).toBe(false);
    expect(showsPattern('reduced')).toBe(false);
    expect(showsBloom('reduced')).toBe(false);
    expect(showsRelief('reduced')).toBe(true);
    expect(showsRelief('flat')).toBe(false);
  });
});

describe('zoomBucket', () => {
  it('quantises upward, so a tile is never magnified at blit time', () => {
    expect(zoomBucket(1)).toBe(1);
    expect(zoomBucket(1.01)).toBe(1.125);
    expect(zoomBucket(1.2)).toBe(1.25);
    for (const scale of [0.4, 0.77, 1.01, 1.99, 3.3])
      expect(zoomBucket(scale), String(scale)).toBeGreaterThanOrEqual(scale);
  });

  it('never buckets to zero, which would produce an empty tile', () => {
    expect(zoomBucket(0.001)).toBeGreaterThan(0);
  });
});
