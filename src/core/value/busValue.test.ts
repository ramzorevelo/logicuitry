import { describe, expect, it } from 'vitest';
import * as bv from './busValue';

const s = (lit: string) => bv.fromString(lit);
const show = (value: bv.BusValue, w: number) => bv.toString(value, w);

describe('BusValue basics', () => {
  it('round-trips string literals', () => {
    for (const lit of ['0', '1', 'X', 'Z', '01XZ', '1111000010101010', 'Z'.repeat(32)]) {
      expect(show(s(lit), lit.length)).toBe(lit);
    }
  });

  it('masks to width, including width 32', () => {
    expect(bv.widthMask(32)).toBe(0xffffffff);
    expect(show(bv.known(0xff, 4), 4)).toBe('1111');
    expect(bv.isFullyKnown(bv.known(0xdeadbeef, 32), 32)).toBe(true);
  });

  it('canonicalizes: Z beats X beats V in norm', () => {
    const n = bv.norm({ v: 0b111, x: 0b011, z: 0b001 }, 3);
    expect(show(n, 3)).toBe('1XZ');
    expect(bv.equal(n, s('1XZ'))).toBe(true);
  });

  it('rejects bad widths', () => {
    expect(() => bv.widthMask(0)).toThrow();
    expect(() => bv.widthMask(33)).toThrow();
  });
});

describe('4-state gate ops (Z reads as X at inputs)', () => {
  // Per-bit truth tables over all 16 input pairs, positions: a=01XZ × b=01XZ.
  const pairs: [string, string][] = [];
  for (const a of '01XZ') for (const b of '01XZ') pairs.push([a, b]);
  const table = (op: (i: bv.BusValue[], w: number) => bv.BusValue) =>
    pairs.map(([a, b]) => show(op([s(a), s(b)], 1), 1)).join('');

  it('AND: 0 dominates', () => {
    //                 b: 0 1 X Z  (a=0) (a=1) (a=X) (a=Z)
    expect(table(bv.and)).toBe('0000' + '01XX' + '0XXX' + '0XXX');
  });

  it('OR: 1 dominates', () => {
    expect(table(bv.or)).toBe('01XX' + '1111' + 'X1XX' + 'X1XX');
  });

  it('XOR: any unknown poisons', () => {
    expect(table(bv.xor)).toBe('01XX' + '10XX' + 'XXXX' + 'XXXX');
  });

  it('NOT/BUF map Z to X', () => {
    expect(show(bv.not(s('01XZ'), 4), 4)).toBe('10XX');
    expect(show(bv.buf(s('01XZ'), 4), 4)).toBe('01XX');
  });

  it('n-ary AND across a bus', () => {
    expect(show(bv.and([s('0011'), s('0101'), s('1111')], 4), 4)).toBe('0001');
  });
});

describe('resolve (wired multi-driver)', () => {
  it('Z yields to the driver', () => {
    expect(show(bv.resolve([s('ZZ01'), s('10ZZ')], 4), 4)).toBe('1001');
  });
  it('agreement passes, disagreement is contention X', () => {
    expect(show(bv.resolve([s('0011'), s('0101')], 4), 4)).toBe('0XX1');
  });
  it('X from any driver wins over agreement', () => {
    expect(show(bv.resolve([s('X1'), s('11')], 2), 2)).toBe('X1');
  });
  it('all-Z stays Z; single driver passes through', () => {
    expect(show(bv.resolve([s('ZZ'), s('ZZ')], 2), 2)).toBe('ZZ');
    expect(show(bv.resolve([s('1X0Z')], 4), 4)).toBe('1X0Z');
  });
  it('three drivers: later driver conflicts with earlier consensus', () => {
    expect(show(bv.resolve([s('1'), s('1'), s('0')], 1), 1)).toBe('X');
  });
});

describe('slice / concat', () => {
  it('slice extracts sub-ranges preserving states', () => {
    expect(show(bv.slice(s('10XZ'), 0, 2), 2)).toBe('XZ');
    expect(show(bv.slice(s('10XZ'), 2, 2), 2)).toBe('10');
  });
  it('concat is LSB-first and inverse of slicing', () => {
    const whole = s('10XZ');
    const joined = bv.concat([
      { value: bv.slice(whole, 0, 2), width: 2 },
      { value: bv.slice(whole, 2, 2), width: 2 },
    ]);
    expect(show(joined, 4)).toBe('10XZ');
  });
  it('concat rejects overflow past MAX_WIDTH', () => {
    expect(() =>
      bv.concat([
        { value: bv.allX(32), width: 32 },
        { value: bv.allX(1), width: 1 },
      ]),
    ).toThrow();
  });
});
