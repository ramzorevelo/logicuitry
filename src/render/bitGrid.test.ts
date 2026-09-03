import { describe, expect, it } from 'vitest';
import {
  bitAtPoint,
  columnAtPoint,
  defaultMetrics,
  layoutBitRow,
  nearestBitAtPoint,
  scaleMetrics,
  superscript,
  weightLabel,
} from './bitGrid';

describe('bitGrid layout', () => {
  it('places the MSB leftmost and the LSB rightmost', () => {
    const layout = layoutBitRow(8, 0, 0);
    expect(layout.cells[0]!.bit).toBe(7);
    expect(layout.cells.at(-1)!.bit).toBe(0);
    expect(layout.cells[0]!.rect.x).toBeLessThan(layout.cells.at(-1)!.rect.x);
  });

  it('inserts a nibble gap every 4 bits', () => {
    const layout = layoutBitRow(8, 0, 0);
    const m = defaultMetrics;
    const gapBetween = (i: number) =>
      layout.cells[i + 1]!.rect.x - (layout.cells[i]!.rect.x + m.cellW);
    // Between column 3 (bit 4) and column 4 (bit 3) the nibble boundary widens.
    expect(gapBetween(3)).toBeCloseTo(m.gap + m.nibbleGap, 6);
    expect(gapBetween(0)).toBeCloseTo(m.gap, 6);
  });

  it('bitAtPoint resolves the cell under a point', () => {
    const layout = layoutBitRow(4, 0, 0);
    const cell = layout.cells[0]!;
    expect(bitAtPoint(layout, cell.rect.x + 2, cell.rect.y + 2)).toBe(cell.bit);
    expect(bitAtPoint(layout, -50, -50)).toBeUndefined();
  });

  it('nearestBitAtPoint claims the gaps for the cell they sit against', () => {
    const layout = layoutBitRow(8, 4, 4);
    const m = defaultMetrics;
    const y = layout.cells[0]!.rect.y + 2;
    const inter = layout.cells[0]!.rect.x + m.cellW + m.gap / 2; // plain gap
    expect(nearestBitAtPoint(layout, inter, y)).toBe(layout.cells[0]!.bit);
    // Nibble gap: nearer edge wins, so each side keeps its own cell.
    const gapX = layout.cells[3]!.rect.x + m.cellW;
    expect(nearestBitAtPoint(layout, gapX + 1, y)).toBe(layout.cells[3]!.bit);
    expect(nearestBitAtPoint(layout, gapX + m.gap + m.nibbleGap - 1, y)).toBe(layout.cells[4]!.bit);
    // Off the row entirely: still nothing.
    expect(nearestBitAtPoint(layout, inter, y - m.cellH)).toBeUndefined();
    expect(nearestBitAtPoint(layout, layout.cells[0]!.rect.x - 5, y)).toBeUndefined();
  });

  it('columnAtPoint addresses the cell clicked, never the boundary beside it', () => {
    const layout = layoutBitRow(8, 4, 4);
    const m = defaultMetrics;
    const cell = (i: number) => layout.cells[i]!.rect;
    // Both halves of a box belong to that box: editing overwrites a cell.
    expect(columnAtPoint(layout, cell(2).x + 2)).toBe(2);
    expect(columnAtPoint(layout, cell(2).x + m.cellW - 2)).toBe(2);
    // Gaps fall to the nearer cell; the row has no position past its last one.
    expect(columnAtPoint(layout, cell(3).x + m.cellW + 1)).toBe(3);
    expect(columnAtPoint(layout, -100)).toBe(0);
    expect(columnAtPoint(layout, 10_000)).toBe(layout.cells.length - 1);
  });

  it('scaleMetrics scales every dimension uniformly', () => {
    const m = scaleMetrics(2);
    expect(m.cellW).toBe(defaultMetrics.cellW * 2);
    expect(m.cellH).toBe(defaultMetrics.cellH * 2);
    expect(m.gap).toBe(defaultMetrics.gap * 2);
    expect(m.nibbleGap).toBe(defaultMetrics.nibbleGap * 2);
    expect(m.labelH).toBe(defaultMetrics.labelH * 2);
  });

  it('groupBits moves the wider gap to the octal triplet boundary', () => {
    const layout = layoutBitRow(6, 0, 0, defaultMetrics, 3);
    const m = defaultMetrics;
    const gapBetween = (i: number) =>
      layout.cells[i + 1]!.rect.x - (layout.cells[i]!.rect.x + m.cellW);
    // Columns are bits 5..0; the boundary sits between bit 3 and bit 2.
    expect(gapBetween(2)).toBeCloseTo(m.gap + m.nibbleGap, 6);
    expect(gapBetween(0)).toBeCloseTo(m.gap, 6);
  });

  it('the layout carries its grouping, which decides which columns get labelled', () => {
    expect(layoutBitRow(8, 0, 0).groupBits).toBe(4);
    expect(layoutBitRow(6, 0, 0, defaultMetrics, 3).groupBits).toBe(3);
  });

  it('a cell is upright, not square', () => {
    const cell = layoutBitRow(8, 0, 0).cells[0]!.rect;
    expect(cell.w).toBeLessThan(cell.h);
  });

  it('a scaled layout is proportionally wider', () => {
    const base = layoutBitRow(8, 0, 0);
    const scaled = layoutBitRow(8, 0, 0, scaleMetrics(2));
    expect(scaled.width).toBeCloseTo(base.width * 2, 6);
  });
});

describe('weightLabel', () => {
  it('power mode reads the decimal place value by default', () => {
    expect(weightLabel(7, 'power')).toBe('128');
    expect(weightLabel(0, 'power')).toBe('1');
  });

  it('the exponent form is typeset, not written with a caret', () => {
    expect(weightLabel(17, 'power', true)).toBe('2¹⁷');
    expect(weightLabel(0, 'power', true)).toBe('2⁰');
    expect(weightLabel(31, 'power', true)).toBe('2³¹');
    expect(weightLabel(17, 'power', true)).not.toContain('^');
  });

  it('superscript maps every digit', () => {
    expect(superscript(1234567890)).toBe('¹²³⁴⁵⁶⁷⁸⁹⁰');
  });

  it('group modes ignore the exponent form: they are single-digit weights', () => {
    const nibble = [7, 6, 5, 4, 3, 2, 1, 0].map((b) => weightLabel(b, 'nibble', true));
    expect(nibble).toEqual(['8', '4', '2', '1', '8', '4', '2', '1']);
    const triplet = [5, 4, 3, 2, 1, 0].map((b) => weightLabel(b, 'triplet', true));
    expect(triplet).toEqual(['4', '2', '1', '4', '2', '1']);
  });
});
