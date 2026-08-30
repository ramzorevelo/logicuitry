import { describe, expect, it } from 'vitest';
import { fromInt } from './format';
import { arithSolution, borrowMarks, carryString } from './solution';
import { add, subBorrow } from './compute';

describe('carryString', () => {
  it('renders carry-ins MSB-left', () => {
    // 0101 + 0011 = 1000, carry-ins per lane LSB->MSB: 0,1,1,1
    const r = add(fromInt(5, 4), fromInt(3, 4), 4);
    expect(carryString(r.carries)).toBe('1110');
  });
});

describe('arithSolution', () => {
  it('ADD unsigned: rows, sum, Cout flag', () => {
    const s = arithSolution('ADD', fromInt(5, 4), fromInt(3, 4), 4, 'unsigned');
    expect(s.rows.map((r) => r.label)).toEqual(['A', '+ B']);
    expect(s.sum.bits.v).toBe(8);
    expect(s.rows[0]!.carries).toBe('1110'); // Ex 1.11: carry line above A
    expect(s.sum.carries).toBeUndefined();
    expect(s.flags).toMatch(/Cout=0/);
    expect(s.answerDec).toBe('8');
    expect(s.answerHex).toBe('8');
  });

  it('ADD unsigned overflow reports Cout=1', () => {
    const s = arithSolution('ADD', fromInt(0xff, 8), fromInt(1, 8), 8, 'unsigned');
    expect(s.flags).toMatch(/Cout=1/);
    expect(s.answerDec).toBe('0');
  });

  it('SUB by complement shows the ~B row and carry-in 1 at bit 0', () => {
    const s = arithSolution('SUB', fromInt(6, 4), fromInt(2, 4), 4, 'unsigned', 'complement');
    expect(s.rows[1]!.label).toBe('+ ~B');
    expect(s.rows[1]!.bits.v).toBe(0b1101);
    expect(s.rows[0]!.carries!.endsWith('1')).toBe(true); // initial +1 as carry-in
    expect(s.answerDec).toBe('4');
    expect(s.flags).toMatch(/no borrow/);
  });

  it("two's complement reports V, not Cout", () => {
    // H&H Example 1.14 shape: 4-bit 0101 + 0110 = 1011, signed overflow
    const s = arithSolution('ADD', fromInt(5, 4), fromInt(6, 4), 4, 'twos');
    expect(s.flags).toMatch(/V=1/);
    expect(s.flags).not.toMatch(/Cout=/); // the V formula may cite Cout(MSB)
    expect(s.answerDec).toBe('-5');
  });

  it("two's complement without overflow reports V=0", () => {
    const s = arithSolution('ADD', fromInt(2, 4), fromInt(1, 4), 4, 'twos');
    expect(s.flags).toMatch(/V=0/);
  });

  it('SUB defaults to the borrow columns of section 1.4', () => {
    const s = arithSolution('SUB', fromInt(6, 4), fromInt(2, 4), 4, 'unsigned');
    expect(s.rows.map((r) => r.label)).toEqual(['A', '− B']);
    expect(s.rows[1]!.bits.v).toBe(2); // B itself, not ~B
    expect(s.rows[0]!.borrows).toBeDefined();
    expect(s.rows[0]!.carries).toBeUndefined(); // borrow method writes no carry line
    expect(s.answerDec).toBe('4');
    expect(s.flags).toMatch(/No borrow/);
  });

  it('SUB by borrowing flags a borrow out of the MSB when A < B', () => {
    const s = arithSolution('SUB', fromInt(3, 8), fromInt(5, 8), 8, 'unsigned');
    expect(s.flags).toMatch(/Borrow out of the MSB/);
  });
});

describe('borrowMarks', () => {
  // H&H Example 1.12: 10010110 - 01011001. The eights column borrows and the
  // chain runs on past two zeros to the one-hundred-and-twenty-eights.
  it('renders Example 1.12 lender, receiver and struck marks MSB-left', () => {
    const marks = borrowMarks(subBorrow(fromInt(150, 8), fromInt(89, 8), 8).borrows);
    expect(marks.lent).toBe('0110  0 ');
    expect(marks.received).toBe(' 1111  1');
    expect(marks.struck).toBe('1111  1 ');
  });

  it('writes nothing at all when no column borrows', () => {
    const marks = borrowMarks(subBorrow(fromInt(0b1110, 4), fromInt(0b0100, 4), 4).borrows);
    expect(marks.lent.trim()).toBe('');
    expect(marks.received.trim()).toBe('');
    expect(marks.struck.trim()).toBe('');
  });
});
