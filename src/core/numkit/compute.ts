// Two-operand (and unary) operations with the per-lane detail the Compute tab
// animates: carry chain for ADD/SUB, shifted-out bits for shifts, overflow flag
// for two's complement. Bitwise ops route through busValue so they match the
// simulator exactly. Pure; the UI owns the animation, this owns the truth.

import * as bv from '../value/busValue';
import type { BusValue } from '../value/busValue';
import { fromInt, toUnsigned } from './format';
import type { BinaryOp } from './types';

export interface LaneCarry {
  bit: number;
  carryIn: 0 | 1;
  sum: 0 | 1;
  carryOut: 0 | 1;
}

export interface AddResult {
  result: BusValue;
  carries: LaneCarry[];
  carryOut: 0 | 1;
  /** Two's-complement signed overflow: carryIn(MSB) XOR carryOut(MSB). */
  overflow: boolean;
}

export interface LaneBorrow {
  bit: number;
  /** A borrow this column must pay: the column below took one unit from it. */
  borrowIn: 0 | 1;
  /** This column could not subtract and borrowed from the column above. */
  borrowOut: 0 | 1;
  /** Effective minuend digit once lending and borrowing settle; 2 is the book's "10". */
  minuend: 0 | 1 | 2;
  /** The minuend digit after lending downward, before this column's own borrow. */
  lent: 0 | 1;
  diff: 0 | 1;
}

export interface SubResult {
  result: BusValue;
  borrows: LaneBorrow[];
  /** Borrow out of the MSB: unsigned A < B. */
  borrowOut: 0 | 1;
  overflow: boolean;
}

export interface ShiftResult {
  result: BusValue;
  shiftedOut: (0 | 1)[]; // bits discarded past the edge, in shift order
}

function bit(u: number, i: number): 0 | 1 {
  return ((u >>> i) & 1) as 0 | 1;
}

function addCore(aU: number, bU: number, width: number, cin: 0 | 1): AddResult {
  const carries: LaneCarry[] = [];
  let carry: 0 | 1 = cin;
  let resultU = 0;
  for (let i = 0; i < width; i++) {
    const ai = bit(aU, i);
    const bi = bit(bU, i);
    const sum = (ai ^ bi ^ carry) as 0 | 1;
    const cout = ((ai & bi) | (carry & (ai ^ bi))) as 0 | 1;
    carries.push({ bit: i, carryIn: carry, sum, carryOut: cout });
    resultU |= sum << i;
    carry = cout;
  }
  const msb = carries[width - 1]!;
  return {
    result: fromInt(resultU, width),
    carries,
    carryOut: carry,
    overflow: (msb.carryIn ^ msb.carryOut) === 1,
  };
}

export function add(a: BusValue, b: BusValue, width: number): AddResult {
  return addCore(toUnsigned(a, width), toUnsigned(b, width), width, 0);
}

/** SUB by two's complement: A + ~B + 1, reusing the adder carry chain. */
export function subComplement(a: BusValue, b: BusValue, width: number): AddResult {
  const notB = toUnsigned(bv.not(b, width), width);
  return addCore(toUnsigned(a, width), notB, width, 1);
}

/**
 * SUB by borrowing, the column procedure of H&H section 1.4: a column that
 * cannot subtract borrows one unit from its left neighbour, which is worth two
 * of its own, and the borrow travels past every 0 until it reaches a 1.
 */
export function subBorrow(a: BusValue, b: BusValue, width: number): SubResult {
  const aU = toUnsigned(a, width);
  const bU = toUnsigned(b, width);
  const borrows: LaneBorrow[] = [];
  let borrow: 0 | 1 = 0;
  let resultU = 0;
  for (let i = 0; i < width; i++) {
    const ai = bit(aU, i);
    const bi = bit(bU, i);
    const lent = ai - borrow; // -1 once a 0 has lent downward
    const borrowOut = lent - bi < 0 ? 1 : 0;
    const minuend = (borrowOut === 1 ? lent + 2 : lent) as 0 | 1 | 2;
    const diff = (minuend - bi) as 0 | 1;
    borrows.push({
      bit: i,
      borrowIn: borrow,
      borrowOut: borrowOut as 0 | 1,
      minuend,
      // A 0 that must lend borrows first, so it ends holding 1, not -1.
      lent: (lent < 0 ? 1 : lent) as 0 | 1,
      diff,
    });
    resultU |= diff << i;
    borrow = borrowOut as 0 | 1;
  }
  // The signed reading is the same subtraction, so the overflow rule is too.
  const { overflow } = subComplement(a, b, width);
  return { result: fromInt(resultU, width), borrows, borrowOut: borrow, overflow };
}

export function bitwise(
  op: 'AND' | 'OR' | 'XOR',
  a: BusValue,
  b: BusValue,
  width: number,
): BusValue {
  if (op === 'AND') return bv.and([a, b], width);
  if (op === 'OR') return bv.or([a, b], width);
  return bv.xor([a, b], width);
}

export function not(a: BusValue, width: number): BusValue {
  return bv.not(a, width);
}

/** Two's-complement negate: ~A + 1, carry detail included. */
export function neg(a: BusValue, width: number): AddResult {
  return addCore(toUnsigned(bv.not(a, width), width), 0, width, 1);
}

export function shl(a: BusValue, amount: number, width: number): ShiftResult {
  const u = toUnsigned(a, width);
  const shiftedOut: (0 | 1)[] = [];
  for (let k = 0; k < amount && k < width; k++) shiftedOut.push(bit(u, width - 1 - k));
  let resultU = 0;
  for (let i = 0; i < width; i++) if (i - amount >= 0) resultU |= bit(u, i - amount) << i;
  return { result: fromInt(resultU, width), shiftedOut };
}

export function shr(a: BusValue, amount: number, width: number): ShiftResult {
  const u = toUnsigned(a, width);
  const shiftedOut: (0 | 1)[] = [];
  for (let k = 0; k < amount && k < width; k++) shiftedOut.push(bit(u, k));
  let resultU = 0;
  for (let i = 0; i < width; i++) if (i + amount < width) resultU |= bit(u, i + amount) << i;
  return { result: fromInt(resultU, width), shiftedOut };
}

/** Arithmetic shift right: sign-fill the vacated top bits. */
export function sar(a: BusValue, amount: number, width: number): ShiftResult {
  const u = toUnsigned(a, width);
  const sign = bit(u, width - 1);
  const shiftedOut: (0 | 1)[] = [];
  for (let k = 0; k < amount && k < width; k++) shiftedOut.push(bit(u, k));
  let resultU = 0;
  for (let i = 0; i < width; i++) {
    const src = i + amount < width ? bit(u, i + amount) : sign;
    resultU |= src << i;
  }
  return { result: fromInt(resultU, width), shiftedOut };
}

/** Convenience dispatch for the two-operand arithmetic/bitwise ops. */
export function compute(op: BinaryOp, a: BusValue, b: BusValue, width: number): BusValue {
  switch (op) {
    case 'ADD':
      return add(a, b, width).result;
    case 'SUB':
      return subComplement(a, b, width).result;
    default:
      return bitwise(op, a, b, width);
  }
}
