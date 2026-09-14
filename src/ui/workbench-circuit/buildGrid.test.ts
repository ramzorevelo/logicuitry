import { describe, expect, it } from 'vitest';
import { cellKeyAction, nextCell } from './buildGrid';

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
