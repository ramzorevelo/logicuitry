import { describe, expect, it } from 'vitest';
import { LruCache, thumbnailKey } from './thumbnailCache';

describe('LruCache', () => {
  it('drops the least recently used entry past its capacity', () => {
    const lru = new LruCache<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });

  it('replaces an existing key without growing', () => {
    const lru = new LruCache<string, number>(2);
    lru.set('a', 1);
    lru.set('a', 2);
    expect(lru.size).toBe(1);
    expect(lru.get('a')).toBe(2);
  });
});

describe('thumbnailKey', () => {
  it('differs by board, theme revision and backing size', () => {
    const base = thumbnailKey('b1', 'light', 800, 600);
    expect(thumbnailKey('b2', 'light', 800, 600)).not.toBe(base);
    expect(thumbnailKey('b1', 'dark', 800, 600)).not.toBe(base);
    expect(thumbnailKey('b1', 'light', 800, 601)).not.toBe(base);
    expect(thumbnailKey('b1', 'light', 800, 600)).toBe(base);
  });
});
