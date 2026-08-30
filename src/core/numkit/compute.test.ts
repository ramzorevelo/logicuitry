import { describe, expect, it } from 'vitest';
import { add, bitwise, neg, not, sar, shl, shr, subBorrow, subComplement } from './compute';
import { fromInt, toSigned, toUnsigned } from './format';

const v = (n: number, w = 8) => fromInt(n, w);

describe('compute: add', () => {
  it('sums with a full carry chain and no overflow', () => {
    const r = add(v(5), v(3), 8);
    expect(toUnsigned(r.result, 8)).toBe(8);
    expect(r.carryOut).toBe(0);
    expect(r.overflow).toBe(false);
    expect(r.carries).toHaveLength(8);
  });

  it('sets carry-out when the sum exceeds the width', () => {
    const r = add(v(200), v(100), 8);
    expect(toUnsigned(r.result, 8)).toBe(44); // 300 wraps
    expect(r.carryOut).toBe(1);
  });

  it('flags two’s-complement overflow: 127 + 1', () => {
    const r = add(v(127), v(1), 8);
    expect(toSigned(r.result, 8)).toBe(-128);
    expect(r.overflow).toBe(true);
  });

  it('no overflow when carry-out matches carry-in at the MSB', () => {
    const r = add(v(0xff), v(1), 8); // -1 + 1 = 0
    expect(toUnsigned(r.result, 8)).toBe(0);
    expect(r.carryOut).toBe(1);
    expect(r.overflow).toBe(false);
  });
});

describe('compute: sub by complement (A + ~B + 1)', () => {
  it('computes positive and negative differences', () => {
    expect(toSigned(subComplement(v(5), v(3), 8).result, 8)).toBe(2);
    expect(toSigned(subComplement(v(3), v(5), 8).result, 8)).toBe(-2);
  });
});

describe('compute: sub by borrowing', () => {
  // H&H Example 1.12: subtract 89 from 150 in eight bits.
  it('matches Example 1.12 column for column', () => {
    const r = subBorrow(v(150), v(89), 8);
    expect(toUnsigned(r.result, 8)).toBe(61);
    expect(r.borrowOut).toBe(0); // A >= B, nothing borrowed past the MSB
    // The prose: the ones column borrows; the twos lends and reads 0 - 0; the
    // eights borrows and the chain runs on to the one-hundred-and-twenty-eights.
    expect(r.borrows.map((b) => b.borrowOut).join('')).toBe('10011110'); // bit 0 first
    expect(r.borrows[1]!.minuend).toBe(0);
    expect(r.borrows[0]!.minuend).toBe(2); // the book's "10"
  });

  it('borrows across the whole word: 128 - 1 = 127', () => {
    const r = subBorrow(v(128), v(1), 8);
    expect(toUnsigned(r.result, 8)).toBe(127);
    // Every 0 the borrow passes turns into a 1 and the leading 1 into a 0.
    expect(r.borrows.slice(0, 7).every((b) => b.borrowOut === 1)).toBe(true);
    expect(r.borrows[7]!.borrowOut).toBe(0);
    expect(r.borrowOut).toBe(0);
  });

  it('borrows out of the MSB when A < B', () => {
    const r = subBorrow(v(3), v(5), 8);
    expect(r.borrowOut).toBe(1);
    expect(toSigned(r.result, 8)).toBe(-2);
  });

  it('agrees with the complement method on the bits and the overflow flag', () => {
    for (const [x, y] of [
      [150, 89],
      [3, 5],
      [0, 255],
      [128, 1],
    ]) {
      const borrow = subBorrow(v(x!), v(y!), 8);
      const complement = subComplement(v(x!), v(y!), 8);
      expect(toUnsigned(borrow.result, 8)).toBe(toUnsigned(complement.result, 8));
      expect(borrow.overflow).toBe(complement.overflow);
      // Cout of the complement adder is the inverse of a borrow.
      expect(borrow.borrowOut).toBe(complement.carryOut === 1 ? 0 : 1);
    }
  });
});

describe('compute: neg / not', () => {
  it('negates via ~A + 1', () => {
    expect(toSigned(neg(v(5), 8).result, 8)).toBe(-5);
    expect(toUnsigned(neg(v(0), 8).result, 8)).toBe(0);
  });

  it('inverts every bit', () => {
    expect(toUnsigned(not(v(0x0f), 8), 8)).toBe(0xf0);
  });
});

describe('compute: shifts', () => {
  it('shl discards the top bits it pushes off', () => {
    expect(toUnsigned(shl(v(0b00000011), 2, 8).result, 8)).toBe(0b00001100);
    const off = shl(v(0b11000000), 2, 8);
    expect(toUnsigned(off.result, 8)).toBe(0);
    expect(off.shiftedOut).toEqual([1, 1]);
  });

  it('shr is logical (zero fill)', () => {
    const r = shr(v(0b00001100), 2, 8);
    expect(toUnsigned(r.result, 8)).toBe(0b00000011);
    expect(r.shiftedOut).toEqual([0, 0]);
  });

  it('sar sign-fills from the MSB', () => {
    expect(toUnsigned(sar(v(0b10000000), 1, 8).result, 8)).toBe(0b11000000);
    expect(toUnsigned(sar(v(0b01000000), 1, 8).result, 8)).toBe(0b00100000);
  });
});

describe('compute: bitwise matches busValue', () => {
  it('AND/OR/XOR', () => {
    expect(toUnsigned(bitwise('AND', v(0b1100), v(0b1010), 8), 8)).toBe(0b1000);
    expect(toUnsigned(bitwise('OR', v(0b1100), v(0b1010), 8), 8)).toBe(0b1110);
    expect(toUnsigned(bitwise('XOR', v(0b1100), v(0b1010), 8), 8)).toBe(0b0110);
  });
});
