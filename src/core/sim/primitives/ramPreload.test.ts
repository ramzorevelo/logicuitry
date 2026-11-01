import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import {
  parsePreload,
  PreloadError,
  preloadError,
  printPreload,
  resizePreload,
} from './ramPreload';

const strings = (cells: bv.BusValue[], width: number) => cells.map((c) => bv.toString(c, width));

describe('RAM preload format', () => {
  it('reads hex cells in address order and pads the omitted tail with X', () => {
    const cells = parsePreload('1E 2F X 0A', 8, 6);
    expect(strings(cells, 8)).toEqual([
      '00011110',
      '00101111',
      'XXXXXXXX',
      '00001010',
      'XXXXXXXX',
      'XXXXXXXX',
    ]);
  });

  it('reads an empty preload as all X', () => {
    expect(strings(parsePreload('', 4, 2), 4)).toEqual(['XXXX', 'XXXX']);
    expect(strings(parsePreload('   ', 4, 2), 4)).toEqual(['XXXX', 'XXXX']);
  });

  it('prints ceil(width / 4) upper-case digits, X for an unknown cell, no trailing X', () => {
    const cells = [bv.known(0xa, 8), bv.allX(8), bv.known(0xff, 8), bv.allX(8), bv.allX(8)];
    expect(printPreload(cells, 8)).toBe('0A X FF');
    expect(printPreload([bv.known(5, 5)], 5)).toBe('05');
    expect(printPreload([bv.known(1, 1), bv.known(0, 1)], 1)).toBe('1 0');
    expect(printPreload([bv.allX(4), bv.allX(4)], 4)).toBe('');
  });

  it('prints a partly unknown cell as X', () => {
    expect(printPreload([{ v: 1, x: 2, z: 0 }], 4)).toBe('');
    expect(printPreload([{ v: 1, x: 2, z: 0 }, bv.known(3, 4)], 4)).toBe('X 3');
  });

  it('round-trips, X cells and the omitted tail included', () => {
    for (const [text, width, count] of [
      ['0A X FF', 8, 16],
      ['', 8, 16],
      ['X X 3', 4, 4],
      ['FFFFFFFF 00000000 X 12345678', 32, 8],
      ['1 0 1', 1, 4],
    ] as const) {
      const cells = parsePreload(text, width, count);
      expect(printPreload(cells, width)).toBe(text);
      expect(parsePreload(printPreload(cells, width), width, count)).toEqual(cells);
    }
  });

  it('masks digits above the width on load', () => {
    expect(strings(parsePreload('FF 3F', 6, 2), 6)).toEqual(['111111', '111111']);
    expect(strings(parsePreload('F', 1, 1), 1)).toEqual(['1']);
    expect(printPreload(parsePreload('FF', 6, 1), 6)).toBe('3F');
  });

  it('accepts lower-case hex and fewer digits than the width prints', () => {
    expect(strings(parsePreload('a x', 8, 2), 8)).toEqual(['00001010', 'XXXXXXXX']);
  });

  it('refuses a bad digit, too many digits and too many cells, naming the address', () => {
    expect(() => parsePreload('1 2G', 8, 4)).toThrow(PreloadError);
    expect(preloadError('1 2G', 8, 4)).toBe("address 1: '2G' is not a hex value or X");
    expect(preloadError('0x1', 8, 4)).toBe("address 0: '0x1' is not a hex value or X");
    expect(preloadError('123', 8, 4)).toBe("address 0: '123' has more than 2 hex digits");
    expect(preloadError('1 2 3', 8, 2)).toBe('3 cells for 2 addresses');
    expect(preloadError('1 2', 8, 2)).toBeNull();
  });

  it('resizes: truncates, pads with X and masks to the new width', () => {
    const from = { width: 8, count: 4 };
    expect(resizePreload('0A FF 3C 11', from, { width: 8, count: 2 })).toBe('0A FF');
    expect(resizePreload('0A FF', from, { width: 8, count: 8 })).toBe('0A FF');
    expect(resizePreload('0A FF X 3C', from, { width: 4, count: 4 })).toBe('A F X C');
    expect(resizePreload('A F', { width: 4, count: 2 }, { width: 8, count: 2 })).toBe('0A 0F');
    expect(resizePreload('X 3C', from, { width: 8, count: 1 })).toBe('');
  });

  it('leaves a preload that does not parse unchanged on resize', () => {
    expect(resizePreload('ZZ', { width: 8, count: 4 }, { width: 4, count: 4 })).toBe('ZZ');
  });
});
