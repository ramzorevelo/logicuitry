import { describe, expect, it } from 'vitest';
import type { Rect } from '../../render/scene';
import { GridIndex } from './gridIndex';

/** Deterministic LCG so a failure replays. */
function lcg(seed: number): (lo: number, hi: number) => number {
  let s = seed >>> 0;
  return (lo, hi) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return lo + (s % (hi - lo + 1));
  };
}

const overlapsClosed = (r: Rect, x0: number, y0: number, x1: number, y1: number) =>
  x0 <= r.x + r.w && x1 >= r.x && y0 <= r.y + r.h && y1 >= r.y;

describe('GridIndex', () => {
  it('visits every item whose box meets the query box, on random boards with negative coordinates', () => {
    const rnd = lcg(7);
    for (let trial = 0; trial < 40; trial++) {
      const index = new GridIndex<Rect>(128);
      const rects: Rect[] = [];
      for (let i = 0; i < 60; i++) {
        const r = { x: rnd(-800, 800), y: rnd(-800, 800), w: rnd(0, 300), h: rnd(0, 300) };
        rects.push(r);
        index.insert(r, r.x, r.y, r.x + r.w, r.y + r.h);
      }
      for (let q = 0; q < 50; q++) {
        const x0 = rnd(-900, 900);
        const y0 = rnd(-900, 900);
        const x1 = x0 + rnd(0, 400);
        const y1 = y0 + rnd(0, 400);
        const visited = new Set<Rect>();
        index.some(x0, y0, x1, y1, (r) => (visited.add(r), false));
        for (const r of rects) if (overlapsClosed(r, x0, y0, x1, y1)) expect(visited).toContain(r);
      }
    }
  });

  it('catches a box that only touches the query along a cell boundary', () => {
    const index = new GridIndex<string>(128);
    index.insert('left', 0, 0, 128, 10);
    let hit = false;
    index.some(128, 0, 300, 0, () => (hit = true));
    expect(hit).toBe(true);
  });

  it('visits an item spanning many cells once per query', () => {
    const index = new GridIndex<string>(16);
    index.insert('long', 0, 0, 1000, 0);
    let visits = 0;
    index.some(0, 0, 1000, 0, () => (visits++, false));
    expect(visits).toBe(1);
    visits = 0;
    index.some(0, 0, 1000, 0, () => (visits++, false));
    expect(visits).toBe(1);
  });

  it('stops at the first hit and reports it', () => {
    const index = new GridIndex<number>(16);
    for (let i = 0; i < 10; i++) index.insert(i, 0, 0, 5, 5);
    let visits = 0;
    expect(index.some(0, 0, 5, 5, (i) => (visits++, i === 0))).toBe(true);
    expect(visits).toBe(1);
    expect(index.some(100, 100, 120, 120, () => true)).toBe(false);
  });

  it('keeps items whose cell keys wrap apart', () => {
    const index = new GridIndex<string>(1);
    index.insert('near', 0, 0, 0, 0);
    index.insert('far', 0x10000, 0, 0x10000, 0);
    const seen: string[] = [];
    index.some(0x10000, 0, 0x10000, 0, (s) => (seen.push(s), false));
    expect(seen).toContain('far');
  });
});
