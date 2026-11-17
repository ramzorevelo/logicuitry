import { describe, expect, it } from 'vitest';
import { makeTestTheme } from './theme.fixture';
import { layoutTruthTable, type TableModel } from './truthTable';

const theme = makeTestTheme();
const model = (heads: string[], rows: string[][], inputCount = 1): TableModel => ({
  headings: heads,
  inputCount,
  rows,
});

describe('layoutTruthTable', () => {
  it('widens a column for a longer heading', () => {
    const short = layoutTruthTable(model(['A', 'Y'], [['0', '0']]), theme);
    const long = layoutTruthTable(model(['SelectLine', 'Y'], [['0', '0']]), theme);
    expect(long.colX[1]! - long.colX[0]!).toBeGreaterThan(short.colX[1]! - short.colX[0]!);
    expect(long.width).toBeGreaterThan(short.width);
  });

  it('widens a column for a longer cell', () => {
    const a = layoutTruthTable(model(['A', 'Y'], [['0', '0']]), theme);
    const b = layoutTruthTable(model(['A', 'Y'], [['0', '0000000']]), theme);
    expect(b.width).toBeGreaterThan(a.width);
  });

  it('is (rows + 1) * rowH plus padding tall', () => {
    const rows = [
      ['0', '0'],
      ['1', '1'],
      ['1', '0'],
    ];
    const l = layoutTruthTable(model(['A', 'Y'], rows), theme);
    expect(l.height).toBe(4 * l.rowH + 20);
  });

  it('puts the divider at the input/output boundary', () => {
    const l = layoutTruthTable(model(['A', 'B', 'Y'], [['0', '0', '0']], 2), theme);
    expect(l.dividerX).toBe(l.colX[2]);
  });

  it('has no divider without outputs', () => {
    expect(layoutTruthTable(model(['A'], [['0']], 1), theme).dividerX).toBeNull();
  });
});
