import { describe, expect, it } from 'vitest';
import {
  MATRIX_MAX,
  MATRIX_MIN,
  ledmatrix,
  matrixCols,
  matrixDotLit,
  matrixRows,
  segmentLit,
  sevenseg,
} from './display';

describe('sevenseg pinout', () => {
  const names = sevenseg.pins({}).map((p) => p.name);

  it('is the real 10-pin package, bottom edge first', () => {
    expect(names).toEqual(['e', 'd', 'com1', 'c', 'dp', 'b', 'a', 'com2', 'f', 'g']);
  });

  it('ties its two commons together', () => {
    expect(sevenseg.tiedPins).toEqual([['com1', 'com2']]);
  });

  it('is observer only: every pin is a 1-bit input', () => {
    expect(sevenseg.pins({}).every((p) => p.dir === 'in' && p.width === 1)).toBe(true);
  });
});

describe('segmentLit', () => {
  it('needs the common tied to the matching rail', () => {
    expect(segmentLit('1', 'cathode', '0')).toBe(true);
    expect(segmentLit('0', 'anode', '1')).toBe(true);
  });

  it('stays dark while the common is unwired', () => {
    expect(segmentLit('1', 'cathode', undefined)).toBe(false);
    expect(segmentLit('0', 'anode', undefined)).toBe(false);
  });

  it('stays dark on the wrong rail', () => {
    expect(segmentLit('1', 'cathode', '1')).toBe(false);
    expect(segmentLit('0', 'anode', '0')).toBe(false);
  });

  it('leaves an open-collector Z dark on an anode display', () => {
    expect(segmentLit('Z', 'anode', '1')).toBe(false);
  });
});

describe('ledmatrix', () => {
  it('names rows down the left then columns along the bottom', () => {
    expect(ledmatrix.pins({ rows: 2, cols: 3 }).map((p) => p.name)).toEqual([
      'r0',
      'r1',
      'c0',
      'c1',
      'c2',
    ]);
  });

  it('defaults to 8x8 and clamps anything outside the buildable range', () => {
    expect(ledmatrix.pins({}).length).toBe(16);
    expect(matrixRows({ rows: 99 })).toBe(MATRIX_MAX);
    expect(matrixCols({ cols: 0 })).toBe(MATRIX_MIN);
  });

  it('lights a dot on a driven row and a sunk column', () => {
    expect(matrixDotLit('1', '0')).toBe(true);
    expect(matrixDotLit('1', '1')).toBe(false);
    expect(matrixDotLit('0', '0')).toBe(false);
    expect(matrixDotLit(undefined, '0')).toBe(false);
    expect(matrixDotLit('1', undefined)).toBe(false);
  });
});
