import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../examples';
import {
  formatCell,
  formatExpect,
  parseCell,
  parseExpect,
  sequenceTabApplies,
} from './sequenceCells';

describe('sequence tab availability', () => {
  it('shows on a board tab, never on a chip tab or an algebra board', () => {
    const algebra = EXAMPLES.filter((e) => e.group === 'Boolean algebra');
    expect(algebra.length).toBe(5);
    for (const e of algebra) expect(sequenceTabApplies('board', e.board.id)).toBe(false);
    const alu = EXAMPLES.find((e) => e.id === 'four-operation-alu')!;
    expect(sequenceTabApplies('board', alu.board.id)).toBe(true);
    expect(sequenceTabApplies('chip', alu.board.id)).toBe(false);
    expect(sequenceTabApplies(undefined, alu.board.id)).toBe(false);
  });
});

describe('sequence cells', () => {
  it('shows narrow values in binary, MSB first, and wide ones in hex', () => {
    expect(formatCell('toggle', 5, 4)).toBe('0101');
    expect(formatCell('toggle', 0xab, 12)).toBe('0AB');
    expect(formatCell('button', 1, 1)).toBe('1');
    expect(formatCell('spdt', 1, 1)).toBe('b');
  });

  it('reads a cell back in the base it is shown in', () => {
    expect(parseCell('toggle', '0101', 4)).toBe(5);
    expect(parseCell('toggle', 'ab', 12)).toBe(0xab);
    expect(parseCell('toggle', '0x0f', 4)).toBe(15);
    expect(parseCell('toggle', '0b11', 12)).toBe(3);
    expect(parseCell('spdt', 'B', 1)).toBe(1);
  });

  it('refuses text that is not a value for the column', () => {
    expect(parseCell('toggle', '2', 4)).toBeNull();
    expect(parseCell('toggle', '10000', 4)).toBeNull();
    expect(parseCell('toggle', '', 4)).toBeNull();
    expect(parseCell('spdt', 'c', 1)).toBeNull();
  });

  it('takes a dash, x or an empty cell as don’t care', () => {
    expect(parseExpect('-', 4)).toBeNull();
    expect(parseExpect(' X ', 4)).toBeNull();
    expect(parseExpect('0011', 4)).toBe(3);
    expect(parseExpect('z', 4)).toBeUndefined();
    expect(formatExpect(null, 4)).toBe('-');
  });

  it('keeps a full 32-bit value', () => {
    expect(parseCell('toggle', 'ffffffff', 32)).toBe(0xffffffff);
    expect(formatCell('toggle', 0xffffffff, 32)).toBe('FFFFFFFF');
  });
});
