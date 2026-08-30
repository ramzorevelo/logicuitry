// Worked-solution content for ADD/SUB: the column layout the instructor writes
// on the board (carry row above, operand rows, sum), plus the prose that frames
// it. Pure data; the Compute tab owns the rendering and its show/hide.

import * as bv from '../value/busValue';
import type { BusValue } from '../value/busValue';
import { add, subBorrow, subComplement, type LaneBorrow, type LaneCarry } from './compute';
import { renderDec, renderHex } from './format';
import type { Interpretation, SubMethod } from './types';

/** Example 1.12's borrow marks, MSB-left; a space writes nothing over a column. */
export interface BorrowMarks {
  lent: string;
  received: string;
  struck: string;
}

export interface SolutionRow {
  label: string;
  bits: BusValue;
  /** Carry-in per lane, MSB-left; drawn above the cells of the first operand
   *  row, where Example 1.11 writes the carry line. */
  carries?: string;
  /** Borrow notation over the minuend row (borrow method only). */
  borrows?: BorrowMarks;
}

export interface ArithSolution {
  intro: string[];
  rows: SolutionRow[];
  sum: SolutionRow;
  flags: string;
  answerDec: string;
  answerHex: string;
}

/** Carry-in per lane as an MSB-left string, matching the bit-grid top band. */
export function carryString(carries: LaneCarry[]): string {
  let s = '';
  for (let i = carries.length - 1; i >= 0; i--) s += String(carries[i]!.carryIn);
  return s;
}

/**
 * The three annotation strings the borrow columns need: a lender's reduced
 * digit, a receiver's "10", and which original digits to strike through.
 */
export function borrowMarks(borrows: LaneBorrow[]): BorrowMarks {
  let lent = '';
  let received = '';
  let struck = '';
  for (let i = borrows.length - 1; i >= 0; i--) {
    const b = borrows[i]!;
    lent += b.borrowIn === 1 ? String(b.lent) : ' ';
    received += b.borrowOut === 1 ? '1' : ' ';
    struck += b.borrowIn === 1 ? '1' : ' ';
  }
  return { lent, received, struck };
}

function flagsText(
  op: 'ADD' | 'SUB',
  r: { carryOut: 0 | 1; overflow: boolean },
  interp: Interpretation,
): string {
  if (interp === 'twos') {
    return r.overflow
      ? 'V=1 signed overflow: Cin(MSB) ⊕ Cout(MSB) = 1, the true sum does not fit'
      : 'V=0: Cin(MSB) ⊕ Cout(MSB) = 0, no signed overflow';
  }
  if (op === 'ADD')
    return r.carryOut === 1
      ? 'Cout=1: unsigned overflow, sum exceeds the width'
      : 'Cout=0: no unsigned overflow';
  return r.carryOut === 1 ? 'Cout=1: no borrow, A ≥ B' : 'Cout=0: borrow, A < B';
}

const COLUMN_RULE =
  'Each column, bit 0 first: sum = A ⊕ B ⊕ Cin; the carry-out lands above the next column.';

function borrowSolution(
  a: BusValue,
  b: BusValue,
  width: number,
  interp: Interpretation,
): ArithSolution {
  const r = subBorrow(a, b, width);
  const flags =
    interp === 'twos'
      ? flagsText('SUB', { carryOut: r.borrowOut === 1 ? 0 : 1, overflow: r.overflow }, interp)
      : r.borrowOut === 1
        ? 'Borrow out of the MSB: A < B, the difference wrapped'
        : 'No borrow out of the MSB: A ≥ B';
  return {
    intro: [
      'Borrowing 1 from column n subtracts 1 from column n and adds 2 to column n−1: one unit of a column is worth two of the column below it.',
      'A column that cannot subtract borrows from its left neighbour, and where that neighbour is 0 the borrow travels on until it reaches a 1.',
    ],
    rows: [
      { label: 'A', bits: a, borrows: borrowMarks(r.borrows) },
      { label: '− B', bits: b },
    ],
    sum: { label: 'Diff', bits: r.result },
    flags,
    answerDec: renderDec(r.result, width, interp),
    answerHex: renderHex(r.result, width),
  };
}

export function arithSolution(
  op: 'ADD' | 'SUB',
  a: BusValue,
  b: BusValue,
  width: number,
  interp: Interpretation,
  method: SubMethod = 'borrow',
): ArithSolution {
  if (op === 'SUB' && method === 'borrow') return borrowSolution(a, b, width, interp);
  const r = op === 'ADD' ? add(a, b, width) : subComplement(a, b, width);
  const intro =
    op === 'ADD'
      ? [COLUMN_RULE]
      : [
          'A − B = A + ~B + 1: flip every bit of B, then add with carry-in 1 (the 1 shows in the carry row at bit 0).',
          COLUMN_RULE,
        ];
  const carries = carryString(r.carries);
  const rows: SolutionRow[] =
    op === 'ADD'
      ? [
          { label: 'A', bits: a, carries },
          { label: '+ B', bits: b },
        ]
      : [
          { label: 'A', bits: a, carries },
          { label: '+ ~B', bits: bv.not(b, width) },
        ];
  return {
    intro,
    rows,
    sum: {
      label: op === 'ADD' ? 'Sum' : 'Diff',
      bits: r.result,
    },
    flags: flagsText(op, r, interp),
    answerDec: renderDec(r.result, width, interp),
    answerHex: renderHex(r.result, width),
  };
}
