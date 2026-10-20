import { describe, expect, it } from 'vitest';
import {
  cellKeyAction,
  closeStep,
  constantNote,
  minimiseFirstBlock,
  nextCell,
  resizeTable,
  tableFromExpression,
} from './buildGrid';

describe('cellKeyAction', () => {
  it('types a value and falls through to the next row', () => {
    expect(cellKeyAction('0')).toEqual({ write: '0', step: 1 });
    expect(cellKeyAction('1')).toEqual({ write: '1', step: 1 });
  });

  it('accepts the three spellings of a dont-care, in either case', () => {
    for (const key of ['x', 'X', 'd', 'D', '-'])
      expect(cellKeyAction(key)).toEqual({ write: 'x', step: 1 });
  });

  it('moves without writing on the arrows', () => {
    expect(cellKeyAction('ArrowDown')).toEqual({ step: 1 });
    expect(cellKeyAction('ArrowUp')).toEqual({ step: -1 });
  });

  it('leaves every other key to the browser', () => {
    for (const key of ['2', 'a', 'Enter', 'Escape', 'Tab', ' ', 'ArrowLeft'])
      expect(cellKeyAction(key)).toBeNull();
  });
});

describe('nextCell', () => {
  it('cycles 0, 1, then a dont-care', () => {
    expect(nextCell('0')).toBe('1');
    expect(nextCell('1')).toBe('x');
    expect(nextCell('x')).toBe('0');
  });
});

describe('tableFromExpression', () => {
  it("takes the expression's own variable names and count", () => {
    const sync = tableFromExpression('[SW 1] + Q');
    expect(sync).toEqual({ kind: 'fit', names: ['Q', 'SW 1'], cells: ['0', '1', '1', '1'] });
  });

  it('says why a table cannot show one variable, five, or a constant', () => {
    expect(tableFromExpression("A'")).toEqual({
      kind: 'unfit',
      message: 'The truth table needs 2 to 4 variables; this expression has 1.',
    });
    expect(tableFromExpression('ABCDE')).toMatchObject({ kind: 'unfit' });
    expect(tableFromExpression('1')).toEqual({
      kind: 'unfit',
      message: 'The truth table needs 2 to 4 variables; this expression has none.',
    });
  });

  it('leaves the table alone while the expression does not parse', () => {
    expect(tableFromExpression('A +')).toEqual({ kind: 'unparsed' });
  });
});

describe('resizeTable', () => {
  it('refills from an expression with the new count of variables', () => {
    expect(resizeTable('XY', 2)).toEqual({ names: ['X', 'Y'], cells: ['0', '0', '0', '1'] });
  });

  it('resets to lettered columns otherwise', () => {
    expect(resizeTable('XY', 3)).toEqual({
      names: ['A', 'B', 'C'],
      cells: Array(8).fill('0'),
    });
  });
});

describe('minimiseFirstBlock', () => {
  it('allows 2 to 4 variables and names the range otherwise', () => {
    expect(minimiseFirstBlock("A'B + BC")).toBeNull();
    expect(minimiseFirstBlock("A'")).toBe('Minimise first needs 2 to 4 variables');
    expect(minimiseFirstBlock('A + B + C + D + E')).toBe('Minimise first needs 2 to 4 variables');
    expect(minimiseFirstBlock('1')).toBe('Minimise first needs 2 to 4 variables');
  });
});

describe('constantNote', () => {
  it('explains a constant cover and stays quiet otherwise', () => {
    expect(constantNote({ kind: 'const', value: 1 })).toBe('Y is constant 1: no input affects it');
    expect(constantNote({ kind: 'const', value: 0 })).toBe('Y is constant 0: no input affects it');
    expect(constantNote({ kind: 'var', name: 'A' })).toBeNull();
  });
});

describe('closeStep', () => {
  it('asks once before discarding an edited table', () => {
    expect(closeStep(false, false)).toBe('close');
    expect(closeStep(true, false)).toBe('confirm');
    expect(closeStep(true, true)).toBe('close');
  });
});
