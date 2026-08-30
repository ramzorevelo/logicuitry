import { describe, expect, it } from 'vitest';
import {
  bitAtPoint,
  columnAtPoint,
  defaultMetrics,
  fitScale,
  layoutBitRow,
  nearestBitAtPoint,
  scaleMetrics,
  weightLabel,
  MIN_FIT_SCALE,
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
      layout.cells[i + 1]!.rect.x - (layout.cells[i]!.rect.x + m.cell);
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
    const inter = layout.cells[0]!.rect.x + m.cell + m.gap / 2; // plain gap
    expect(nearestBitAtPoint(layout, inter, y)).toBe(layout.cells[0]!.bit);
    // Nibble gap: nearer edge wins, so each side keeps its own cell.
    const gapX = layout.cells[3]!.rect.x + m.cell;
    expect(nearestBitAtPoint(layout, gapX + 1, y)).toBe(layout.cells[3]!.bit);
    expect(nearestBitAtPoint(layout, gapX + m.gap + m.nibbleGap - 1, y)).toBe(layout.cells[4]!.bit);
    // Off the row entirely: still nothing.
    expect(nearestBitAtPoint(layout, inter, y - m.cell)).toBeUndefined();
    expect(nearestBitAtPoint(layout, layout.cells[0]!.rect.x - 5, y)).toBeUndefined();
  });

  it('columnAtPoint addresses the cell clicked, never the boundary beside it', () => {
    const layout = layoutBitRow(8, 4, 4);
    const m = defaultMetrics;
    const cell = (i: number) => layout.cells[i]!.rect;
    // Both halves of a box belong to that box: editing overwrites a cell.
    expect(columnAtPoint(layout, cell(2).x + 2)).toBe(2);
    expect(columnAtPoint(layout, cell(2).x + m.cell - 2)).toBe(2);
    // Gaps fall to the nearer cell; the row has no position past its last one.
    expect(columnAtPoint(layout, cell(3).x + m.cell + 1)).toBe(3);
    expect(columnAtPoint(layout, -100)).toBe(0);
    expect(columnAtPoint(layout, 10_000)).toBe(layout.cells.length - 1);
  });

  it('scaleMetrics scales every dimension uniformly', () => {
    const m = scaleMetrics(2);
    expect(m.cell).toBe(defaultMetrics.cell * 2);
    expect(m.gap).toBe(defaultMetrics.gap * 2);
    expect(m.nibbleGap).toBe(defaultMetrics.nibbleGap * 2);
    expect(m.labelH).toBe(defaultMetrics.labelH * 2);
  });

  it('groupBits moves the wider gap to the octal triplet boundary', () => {
    const layout = layoutBitRow(6, 0, 0, defaultMetrics, 3);
    const m = defaultMetrics;
    const gapBetween = (i: number) =>
      layout.cells[i + 1]!.rect.x - (layout.cells[i]!.rect.x + m.cell);
    // Columns are bits 5..0; the boundary sits between bit 3 and bit 2.
    expect(gapBetween(2)).toBeCloseTo(m.gap + m.nibbleGap, 6);
    expect(gapBetween(0)).toBeCloseTo(m.gap, 6);
  });

  it('a scaled layout is proportionally wider', () => {
    const base = layoutBitRow(8, 0, 0);
    const scaled = layoutBitRow(8, 0, 0, scaleMetrics(2));
    expect(scaled.width).toBeCloseTo(base.width * 2, 6);
  });
});

describe('weightLabel', () => {
  it('power mode reads the whole word, switching to 2^i past 16 bits', () => {
    expect(weightLabel(7, 8, 'power')).toBe('128');
    expect(weightLabel(0, 8, 'power')).toBe('1');
    expect(weightLabel(17, 32, 'power')).toBe('2^17');
  });

  it('nibble mode restarts at 8 4 2 1 in every group', () => {
    const labels = [7, 6, 5, 4, 3, 2, 1, 0].map((b) => weightLabel(b, 8, 'nibble'));
    expect(labels).toEqual(['8', '4', '2', '1', '8', '4', '2', '1']);
  });

  it('triplet mode restarts at 4 2 1 in every group', () => {
    const labels = [5, 4, 3, 2, 1, 0].map((b) => weightLabel(b, 6, 'triplet'));
    expect(labels).toEqual(['4', '2', '1', '4', '2', '1']);
  });
});

describe('fitScale', () => {
  const natural = (width: number) => layoutBitRow(width, 0, 0).width;

  it('never enlarges a row that already fits', () => {
    expect(fitScale(8, natural(8) + 100)).toBe(1);
  });

  it('shrinks just enough to fit', () => {
    const target = natural(16) / 2;
    expect(fitScale(16, target)).toBeCloseTo(0.5, 5);
  });

  it('stops at the legibility floor rather than shrinking without limit', () => {
    expect(fitScale(32, 10)).toBe(MIN_FIT_SCALE);
  });

  it('scales relative to the metrics it is given, not the default ones', () => {
    const big = scaleMetrics(2);
    expect(fitScale(8, layoutBitRow(8, 0, 0, big).width, 4, big)).toBe(1);
  });
});
