import { describe, expect, it } from 'vitest';
import { layoutMemoryGrid, memoryCellAt, memoryGridMetrics, rowTop } from './memoryGrid';

const m = memoryGridMetrics(1);

describe('memoryGridMetrics', () => {
  it('scales with the chrome and holds a touch target floor', () => {
    expect(memoryGridMetrics(1.35).rowH).toBeGreaterThan(m.rowH);
    const touch = memoryGridMetrics(1, 32);
    expect(touch.rowH).toBe(32);
    expect(touch.bitW).toBe(32);
  });
});

describe('layoutMemoryGrid + memoryCellAt', () => {
  const layout = layoutMemoryGrid({ width: 8, addressBits: 4, invertedOut: false }, m);

  it('has one row per address under the header', () => {
    expect(layout.rows).toBe(16);
    expect(layout.height).toBe(layout.headerH + 16 * m.rowH);
    expect(rowTop(layout, 3)).toBe(layout.headerH + 3 * m.rowH);
  });

  it('puts the MSB leftmost', () => {
    const y = rowTop(layout, 2) + 1;
    expect(memoryCellAt(layout, layout.bitsX + 1, y)).toEqual({ row: 2, bit: 7 });
    expect(memoryCellAt(layout, layout.bitsX + 7.5 * m.bitW, y)).toEqual({ row: 2, bit: 0 });
  });

  it('gives the row alone off the bit columns, nothing in the header or outside', () => {
    expect(memoryCellAt(layout, layout.addrX, rowTop(layout, 5) + 1)).toEqual({ row: 5 });
    expect(memoryCellAt(layout, layout.hexX + 1, rowTop(layout, 5) + 1)).toEqual({ row: 5 });
    expect(memoryCellAt(layout, layout.bitsX + 1, 1)).toBeUndefined();
    expect(memoryCellAt(layout, layout.bitsX + 1, layout.height)).toBeUndefined();
  });

  it('adds the /O column only for an inverted-output RAM', () => {
    expect(layout.invX).toBeNull();
    const inv = layoutMemoryGrid({ width: 4, addressBits: 4, invertedOut: true }, m);
    expect(inv.invX).toBeGreaterThan(inv.hexX);
    expect(inv.width).toBeGreaterThan(inv.invX!);
  });
});
