import { describe, expect, it } from 'vitest';
import {
  bin2dec,
  bin2hex,
  bin2oct,
  dec2bin,
  dec2hex,
  hex2bin,
  hex2dec,
  oct2bin,
  twosDecode,
  twosEncode,
} from './convert';
import { fromInt, renderBin, renderDec, renderHex, renderOct } from './format';
import { standardValues, WIDTHS } from './testValues';

describe('convert: bin2dec golden', () => {
  it('narrates the weighted sum of 44 in 8 bits (running total badge-only)', () => {
    expect(bin2dec(fromInt(44, 8), 8)).toEqual([
      {
        kind: 'weight',
        text: 'bit 5 is 1 -> add 2^5 = 32',
        highlights: [{ row: 'value', bit: 5 }],
        partial: '32',
      },
      {
        kind: 'weight',
        text: 'bit 3 is 1 -> add 2^3 = 8',
        highlights: [{ row: 'value', bit: 3 }],
        partial: '40',
      },
      {
        kind: 'weight',
        text: 'bit 2 is 1 -> add 2^2 = 4',
        highlights: [{ row: 'value', bit: 2 }],
        partial: '44',
      },
      {
        kind: 'note',
        text: '00101100 =',
        highlights: [],
        partial: '44',
      },
    ]);
  });

  it('subtracts the MSB weight under two’s complement', () => {
    const steps = bin2dec(fromInt(0x80, 8), 8, true);
    expect(steps[0]!.text).toBe('bit 7 is 1 -> subtract 2^7 = 128');
    expect(steps[0]!.partial).toBe('-128');
    expect(steps.at(-1)!.partial).toBe('-128');
  });
});

describe('convert: dec2bin golden (H&H Example 1.2, 84 = 1010100)', () => {
  it('narrates repeated division for 84 in 8 bits', () => {
    const steps = dec2bin(fromInt(84, 8), 8, 'division');
    expect(steps.map((s) => s.text)).toEqual([
      '84 / 2 = 42 remainder 0 -> bit 0 = 0',
      '42 / 2 = 21 remainder 0 -> bit 1 = 0',
      '21 / 2 = 10 remainder 1 -> bit 2 = 1',
      '10 / 2 = 5 remainder 0 -> bit 3 = 0',
      '5 / 2 = 2 remainder 1 -> bit 4 = 1',
      '2 / 2 = 1 remainder 0 -> bit 5 = 0',
      '1 / 2 = 0 remainder 1 -> bit 6 = 1',
      '84 =',
    ]);
    expect(steps.at(-1)!.partial).toBe('01010100');
  });
});

describe('convert: hex2dec / dec2hex golden (H&H Example 1.4, 333 <-> 14D)', () => {
  it('narrates hex2dec as a direct base-16 weighted sum for 0x2ED (= 749)', () => {
    const steps = hex2dec(fromInt(0x2ed, 12), 12);
    expect(steps.map((s) => s.text)).toEqual([
      '2 × 16^2 = 512',
      'E × 16^1 = 224',
      'D × 16^0 = 13',
      '0x2ED =',
    ]);
    expect(steps.at(-1)!.partial).toBe('749');
  });

  it('narrates dec2hex via repeated division for 333 (16 bits)', () => {
    const steps = dec2hex(fromInt(333, 16), 16, 'division');
    expect(steps.map((s) => s.text)).toEqual([
      '333 / 16 = 20 remainder 13 -> digit = D',
      '20 / 16 = 1 remainder 4 -> digit = 4',
      '1 / 16 = 0 remainder 1 -> digit = 1',
      '333 =',
    ]);
    expect(steps.at(-1)!.partial).toBe('014D');
  });

  it('narrates dec2hex via subtracting descending powers of 16 for 333 (16 bits)', () => {
    const steps = dec2hex(fromInt(333, 16), 16, 'weight-subtraction');
    expect(steps.map((s) => s.text)).toEqual([
      '16^3 = 4096 into 333 -> digit 0, remainder 333',
      '16^2 = 256 into 333 -> digit 1, remainder 77',
      '16^1 = 16 into 77 -> digit 4, remainder 13',
      '16^0 = 1 into 13 -> digit D, remainder 0',
      '333 =',
    ]);
    expect(steps.at(-1)!.partial).toBe('014D');
  });
});

describe('convert: twosEncode golden', () => {
  it('encodes -6 in 8 bits via invert-and-add-one (patterns badge-only)', () => {
    expect(twosEncode(-6, 8)).toEqual([
      {
        kind: 'note',
        text: 'encode -6: start from |-6| = 6',
        highlights: expect.any(Array),
        partial: '00000110',
      },
      {
        kind: 'complement',
        text: "invert every bit (one's complement)",
        highlights: expect.any(Array),
        partial: '11111001',
      },
      {
        kind: 'add-one',
        text: 'add 1: 11111001 + 1',
        highlights: expect.any(Array),
        partial: '11111010',
      },
    ]);
  });

  it('encodes -5 in 8 bits via the 2^n - |x| alternative (no binary-conversion narration)', () => {
    const steps = twosEncode(-5, 8, 'alternative');
    expect(steps.map((s) => s.text)).toEqual(['2^8 - 5 = 251', '251 =']);
    expect(steps.at(-1)!.partial).toBe('11111011');
    expect(steps.at(-1)!.partial).toBe(twosEncode(-5, 8, 'invert-add').at(-1)!.partial);
  });

  it('decodes 11111010 back to -6', () => {
    const steps = twosDecode(fromInt(0xfa, 8), 8);
    expect(steps.at(-1)!.partial).toBe('-6');
  });

  it('decodes via the MSB-negative-weight alternative, matching bin2dec(twos)', () => {
    const bv = fromInt(0xfa, 8);
    expect(twosDecode(bv, 8, 'alternative')).toEqual(bin2dec(bv, 8, true));
  });

  it('invert-add binary badges stay binary until the decimal-conversion step', () => {
    const steps = twosDecode(fromInt(0xfa, 8), 8, 'invert-add');
    expect(steps.map((s) => s.text)).toEqual([
      'MSB is 1: value is negative',
      'invert the bits',
      'add 1: 00000101 + 1',
      'convert the binary magnitude to decimal',
      'add a negative sign',
    ]);
    expect(steps[1]!.partial).toBe('00000101');
    expect(steps[2]!.partial).toBe('00000110'); // binary magnitude, not decimal
    expect(steps[3]!.partial).toBe('6');
    expect(steps[4]!.partial).toBe('-6');
  });
});

describe('convert: final result for every direction × standard set', () => {
  for (const width of WIDTHS) {
    for (const { name, bv } of standardValues(width)) {
      it(`${name} @ w=${width}`, () => {
        const last = <T extends { partial?: string }>(a: T[]) => a.at(-1)!.partial;
        expect(last(bin2dec(bv, width))).toBe(renderDec(bv, width, 'unsigned'));
        expect(last(dec2bin(bv, width, 'division'))).toBe(renderBin(bv, width));
        expect(last(dec2bin(bv, width, 'weight-subtraction'))).toBe(renderBin(bv, width));
        expect(last(bin2hex(bv, width))).toBe(renderHex(bv, width));
        expect(last(hex2bin(bv, width))).toBe(renderBin(bv, width));
        expect(last(bin2oct(bv, width))).toBe(renderOct(bv, width));
        expect(last(oct2bin(bv, width))).toBe(renderBin(bv, width));
        expect(last(hex2dec(bv, width))).toBe(renderDec(bv, width, 'unsigned'));
        expect(last(dec2hex(bv, width))).toBe(renderHex(bv, width));
      });
    }
  }
});

describe('convert: value appears once (badge-only) + masked variants', () => {
  const BLANK = '▯';

  it('bin2dec prose states the operation only; totals live in the badge', () => {
    const steps = bin2dec(fromInt(44, 8), 8);
    for (const s of steps) {
      expect(s.maskedText).toBeUndefined();
      expect(s.partial).toBeDefined();
    }
    // Prose never states the running total (first step's weight = total aside).
    expect(steps[1]!.text).not.toContain(steps[1]!.partial!);
  });

  it('masks the discovered bit in dec2bin (both methods)', () => {
    for (const method of ['division', 'weight-subtraction'] as const) {
      const steps = dec2bin(fromInt(44, 8), 8, method);
      for (const s of steps) {
        if (s.maskedText === undefined) continue;
        // A masked step never leaks the digit/total it is asking the class to predict.
        expect(s.maskedText).toContain(BLANK);
      }
    }
  });

  it('masks digit results in grouping conversions; finals carry only a badge', () => {
    expect(bin2hex(fromInt(0xab, 8), 8)[0]!.maskedText).toContain(BLANK);
    expect(hex2bin(fromInt(0xab, 8), 8)[0]!.maskedText).toContain(BLANK);
    expect(bin2hex(fromInt(0xab, 8), 8).at(-1)!.maskedText).toBeUndefined();
    expect(bin2hex(fromInt(0xab, 8), 8).at(-1)!.partial).toBe('AB');
  });

  it('ungroup accumulates discovered bits in the badge (narration grid source)', () => {
    const steps = hex2bin(fromInt(0xab, 8), 8);
    expect(steps[0]!.partial).toBe('1010....');
    expect(steps[1]!.partial).toBe('10101011');
    expect(steps.at(-1)!.partial).toBe('10101011');
  });

  it('two’s-complement patterns live in the badge only', () => {
    const enc = twosEncode(-6, 8);
    for (const s of enc) expect(s.maskedText).toBeUndefined();
    const dec = twosDecode(fromInt(0xfa, 8), 8);
    expect(dec.at(-1)!.partial).toBe('-6');
    expect(dec.at(-1)!.text).not.toContain('-6');
  });

  it('every generator final states the source expression with the answer badged', () => {
    expect(dec2bin(fromInt(44, 8), 8).at(-1)!.text).toBe('44 =');
    expect(bin2hex(fromInt(0xab, 8), 8).at(-1)!.text).toBe('10101011 =');
    expect(hex2bin(fromInt(0xab, 8), 8).at(-1)!.text).toBe('AB =');
    expect(twosEncode(5, 8).at(-1)!.text).toBe('5 =');
  });
});

describe('convert: deterministic', () => {
  it('produces byte-identical steps on repeat', () => {
    const v = fromInt(0x3c, 8);
    expect(JSON.stringify(bin2dec(v, 8))).toBe(JSON.stringify(bin2dec(v, 8)));
    expect(JSON.stringify(dec2bin(v, 8))).toBe(JSON.stringify(dec2bin(v, 8)));
    expect(JSON.stringify(twosEncode(-42, 8))).toBe(JSON.stringify(twosEncode(-42, 8)));
  });
});
