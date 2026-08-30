import { describe, expect, it } from 'vitest';
import { equal } from '../value/busValue';
import {
  fromInt,
  parseBin,
  parseBinTyped,
  parseDec,
  parseHex,
  parseOct,
  renderBin,
  renderDec,
  renderHex,
  renderOct,
  toDecimal,
  toSigned,
  toUnsigned,
} from './format';
import { standardValues, WIDTHS } from './testValues';

describe('format: decimal interpretation', () => {
  it('reads all-ones as max unsigned and -1 signed', () => {
    const v = fromInt(0xff, 8);
    expect(toUnsigned(v, 8)).toBe(255);
    expect(toSigned(v, 8)).toBe(-1);
  });

  it('reads MSB-only as the most-negative signed value', () => {
    expect(toSigned(fromInt(0x80, 8), 8)).toBe(-128);
    expect(toSigned(fromInt(2 ** 31, 32), 32)).toBe(-(2 ** 31));
  });
});

describe('format: render is well-formed', () => {
  it('renders hex and oct with the right digit counts, MSB-left', () => {
    expect(renderHex(fromInt(0xa5, 8), 8)).toBe('A5');
    expect(renderBin(fromInt(0xa5, 8), 8)).toBe('10100101');
    expect(renderOct(fromInt(0o255, 8), 8)).toBe('255');
    expect(renderHex(fromInt(0xabc, 12), 12)).toBe('ABC');
  });
});

describe('format: parse(render(v)) === v (property)', () => {
  for (const width of WIDTHS) {
    for (const { name, bv } of standardValues(width)) {
      it(`round-trips ${name} @ w=${width}`, () => {
        expect(equal(parseBin(renderBin(bv, width), width), bv)).toBe(true);
        expect(equal(parseHex(renderHex(bv, width), width), bv)).toBe(true);
        expect(equal(parseOct(renderOct(bv, width), width), bv)).toBe(true);
        expect(equal(parseDec(renderDec(bv, width, 'unsigned'), width), bv)).toBe(true);
        expect(equal(parseDec(renderDec(bv, width, 'twos'), width), bv)).toBe(true);
      });
    }
  }
});

describe('parseBinTyped', () => {
  it("sign-extends a short string under two's complement", () => {
    expect(toDecimal(parseBinTyped('101', 8, 'twos'), 8, 'twos')).toBe(-3);
    expect(renderBin(parseBinTyped('101', 8, 'twos'), 8)).toBe('11111101');
    expect(renderBin(parseBinTyped('011', 8, 'twos'), 8)).toBe('00000011');
  });

  it('zero-pads when unsigned, whatever the leading digit', () => {
    expect(renderBin(parseBinTyped('101', 8, 'unsigned'), 8)).toBe('00000101');
  });

  it('leaves a full-width string alone, so renderBin still round-trips', () => {
    for (const interp of ['unsigned', 'twos'] as const)
      for (const n of [0, 1, 5, 127, 200, 255]) {
        const v = fromInt(n, 8);
        expect(parseBinTyped(renderBin(v, 8), 8, interp)).toEqual(parseBin(renderBin(v, 8), 8));
      }
  });
});
