import { describe, expect, it } from 'vitest';
import * as bv from '../core/value/busValue';
import type { TruthTable } from '../core/boolean/truthTable';
import { buildKmap } from '../core/boolean/kmap';
import { cornerPlan, groupBlocks, kmapCellAt, layoutKmap } from './kmap';

function table(inputPaths: string[], onesList: number[]): TruthTable {
  const ones = new Set(onesList);
  const rows = Array.from({ length: 2 ** inputPaths.length }, (_, m) => [
    bv.known(ones.has(m) ? 1 : 0, 1),
  ]);
  return { inputPaths, outputPaths: ['Y'], rows };
}

const metrics = { cell: 40, labelW: 50, labelH: 30 };

describe('layoutKmap + kmapCellAt', () => {
  it('maps screen points back to Gray-ordered minterms', () => {
    const g = buildKmap(table(['A', 'B', 'C'], [0]), 0);
    const layout = layoutKmap(g, 0, 0, metrics);
    expect(layout.width).toBe(50 + 4 * 40);
    expect(layout.height).toBe(30 + 2 * 40);
    // Column 2 is Gray code 11 (AB=11); row 0 is C=0 -> minterm 110 = 6.
    expect(kmapCellAt(layout, 50 + 2 * 40 + 5, 30 + 5)).toBe(6);
    expect(kmapCellAt(layout, 5, 5)).toBeUndefined();
  });
});

describe('groupBlocks', () => {
  it('a contiguous quad is one closed block', () => {
    const g = buildKmap(table(['A', 'B', 'C'], [0, 1, 2, 3]), 0);
    const layout = layoutKmap(g, 0, 0, metrics);
    const blocks = groupBlocks(layout, [0, 1, 2, 3]); // AB=00,01 x both rows
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.open).toEqual({ left: false, right: false, top: false, bottom: false });
  });

  it('an edge-wrapping pair splits into two blocks open toward the wrap', () => {
    // 3-var {0,4} = B'C' spans columns AB=00 and AB=10 (first and last).
    const g = buildKmap(table(['A', 'B', 'C'], [0, 4]), 0);
    const layout = layoutKmap(g, 0, 0, metrics);
    const blocks = groupBlocks(layout, [0, 4]);
    expect(blocks).toHaveLength(2);
    const opens = blocks.map((b) => b.open);
    expect(opens.some((o) => o.left && !o.right)).toBe(true);
    expect(opens.some((o) => o.right && !o.left)).toBe(true);
  });

  it('the 4-corner wrap yields four blocks, each open on two sides', () => {
    const g = buildKmap(table(['A', 'B', 'C', 'D'], [0, 2, 8, 10]), 0);
    const layout = layoutKmap(g, 0, 0, metrics);
    const blocks = groupBlocks(layout, [0, 2, 8, 10]);
    expect(blocks).toHaveLength(4);
    for (const b of blocks) {
      const openCount = Object.values(b.open).filter(Boolean).length;
      expect(openCount).toBe(2);
    }
  });
});

describe('cornerPlan', () => {
  const m = { cell: 48, labelW: 64, labelH: 44 };
  const labelPx = 14;

  it('gives a short name its own line above the column variables', () => {
    const plan = cornerPlan(m, labelPx, 9, 256);
    expect(plan.nameY).not.toBeNull();
    // Line boxes (one font high) must not intersect.
    expect(plan.nameY! + labelPx / 2).toBeLessThanOrEqual(plan.colVarsY - labelPx / 2 + 1);
  });

  it('drops a name wider than the map and keeps the column variables', () => {
    const plan = cornerPlan(m, labelPx, 400, 256);
    expect(plan.nameY).toBeNull();
    expect(plan.colVarsY).toBeCloseTo(m.labelH * 0.35);
  });

  it('holds at maximized metrics', () => {
    const big = { cell: 120, labelW: 156, labelH: 108 };
    const px = 36;
    const plan = cornerPlan(big, px, 60, 156 + 4 * 120);
    expect(plan.nameY).not.toBeNull();
    expect(plan.nameY! + px / 2).toBeLessThanOrEqual(plan.colVarsY - px / 2 + 1);
  });
});
