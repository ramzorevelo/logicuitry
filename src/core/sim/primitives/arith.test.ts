import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import { splitBus } from './busPins';
import type { EvalContext, Params } from './types';
import { adder, comparator, parity } from './arith';

const s = (lit: string) => bv.fromString(lit);
const bit = (n: number) => bv.known(n, 1);
const show = (outs: (bv.BusValue | null)[], widths: number[]) =>
  outs.map((o, i) => bv.toString(o!, widths[i]!)).join(' ');

function ctx(params: Params, inputs: bv.BusValue[]): EvalContext {
  return { params, state: undefined, inputs, prevInputs: inputs, time: 0 };
}

const EXPANDED = 'a=expanded;b=expanded;sum=expanded';

describe('adder', () => {
  it('pin shape: a, b as 4-bit buses, cin, then sum and cout', () => {
    const pins = adder.pins({});
    expect(pins.map((p) => [p.name, p.dir, p.width])).toEqual([
      ['a', 'in', 4],
      ['b', 'in', 4],
      ['cin', 'in', 1],
      ['sum', 'out', 4],
      ['cout', 'out', 1],
    ]);
    expect(pins.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('pinView expands a, b and sum to MSB-first lanes', () => {
    const names = adder.pins({ pinView: EXPANDED }).map((p) => p.label ?? p.name);
    expect(names).toEqual([
      'a[3]',
      'a[2]',
      'a[1]',
      'a[0]',
      'b[3]',
      'b[2]',
      'b[1]',
      'b[0]',
      'cin',
      'sum[3]',
      'sum[2]',
      'sum[1]',
      'sum[0]',
      'cout',
    ]);
  });

  it('adds exhaustively over a, b and cin, collapsed and expanded alike', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++)
        for (const cin of [0, 1]) {
          const total = a + b + cin;
          const bus = adder.evaluate(ctx({}, [bv.known(a, 4), bv.known(b, 4), bit(cin)]));
          expect(show(bus.outputs, [4, 1]), `${a}+${b}+${cin}`).toBe(
            show([bv.known(total & 15, 4), bit(total >> 4)], [4, 1]),
          );
          const lanes = adder.evaluate(
            ctx({ pinView: EXPANDED }, [
              ...splitBus(bv.known(a, 4), 4),
              ...splitBus(bv.known(b, 4), 4),
              bit(cin),
            ]),
          );
          expect(lanes.outputs.map((o) => bv.toString(o!, 1)).join('')).toBe(
            bv.toString(bv.known(total, 5), 5).slice(1) + String(total >> 4),
          );
        }
  });

  it('keeps a carry the known bits decide past an unknown bit', () => {
    // 0X11 + 0101: bit 2 is X + 1 + carry 1, so its carry is 1 either way.
    const r = adder.evaluate(ctx({}, [s('0X11'), s('0101'), bit(0)]));
    expect(show(r.outputs, [4, 1])).toBe('1X00 0');
  });

  it('0 + 0 kills an unknown carry in', () => {
    const r = adder.evaluate(ctx({}, [s('0000'), s('0000'), s('X')]));
    expect(show(r.outputs, [4, 1])).toBe('000X 0');
  });

  it('an unknown that reaches the top bit leaves the carry out unknown', () => {
    const r = adder.evaluate(ctx({}, [s('1111'), s('0000'), s('Z')]));
    expect(show(r.outputs, [4, 1])).toBe('XXXX X');
  });
});

// The '85 function table, transcribed by row: data comparison first, then the
// cascade inputs decide on equal data. Outputs in gt eq lt order.
const CASCADE_ROWS: [string, string][] = [
  ['100', '100'], // IA>B IA=B IA<B = H L L -> A>B
  ['001', '001'], // L L H -> A<B
  ['010', '010'], // X H X -> A=B
  ['110', '010'],
  ['011', '010'],
  ['111', '010'],
  ['101', '000'], // H L H -> all L
  ['000', '101'], // L L L -> A>B and A<B both H
];

describe('comparator', () => {
  it('pin shape: cascade inputs only with hasCascade', () => {
    expect(comparator.pins({}).map((p) => p.name)).toEqual(['a', 'b', 'gt', 'eq', 'lt']);
    expect(comparator.pins({ hasCascade: true }).map((p) => p.name)).toEqual([
      'a',
      'b',
      'igt',
      'ieq',
      'ilt',
      'gt',
      'eq',
      'lt',
    ]);
    expect(comparator.pins({ pinView: 'a=expanded;b=expanded' }).length).toBe(11);
  });

  it('compares every pair of known operands', () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        const r = comparator.evaluate(ctx({}, [bv.known(a, 4), bv.known(b, 4)]));
        const want = `${a > b ? 1 : 0} ${a === b ? 1 : 0} ${a < b ? 1 : 0}`;
        expect(show(r.outputs, [1, 1, 1]), `${a} vs ${b}`).toBe(want);
      }
  });

  it("follows the '85 cascade rows on equal data, odd rows included", () => {
    for (const [cascade, want] of CASCADE_ROWS) {
      const levels = cascade.split('').map((c) => s(c));
      const r = comparator.evaluate(ctx({ hasCascade: true }, [s('0110'), s('0110'), ...levels]));
      expect(show(r.outputs, [1, 1, 1]).replace(/ /g, ''), cascade).toBe(want);
    }
  });

  it('a known data difference overrides the cascade inputs', () => {
    const r = comparator.evaluate(
      ctx({ hasCascade: true }, [s('1000'), s('0111'), s('X'), s('X'), s('X')]),
    );
    expect(show(r.outputs, [1, 1, 1])).toBe('1 0 0');
  });

  it('an unknown bit leaves X only on the outputs it could change', () => {
    const run = (a: string, b: string) =>
      show(comparator.evaluate(ctx({}, [s(a), s(b)])).outputs, [1, 1, 1]);
    expect(run('1X00', '0X11')).toBe('1 0 0');
    expect(run('10X0', '11X0')).toBe('0 0 1');
    // A3 cannot exceed a known 1, so A > B is out either way.
    expect(run('X000', '1000')).toBe('0 X X');
    expect(run('01Z1', '0101')).toBe('X X 0');
    // A known difference below an unknown top bit still rules out A = B.
    expect(run('X100', 'X011')).toBe('X 0 X');
  });

  it('an unknown cascade input matters only where the table reads it', () => {
    const run = (cascade: string) =>
      show(
        comparator.evaluate(
          ctx({ hasCascade: true }, [s('0011'), s('0011'), ...cascade.split('').map((c) => s(c))]),
        ).outputs,
        [1, 1, 1],
      );
    expect(run('1X0')).toBe('X X 0');
    expect(run('X1X')).toBe('0 1 0');
    expect(run('0X1')).toBe('0 X X');
  });
});

describe('parity', () => {
  it('has nine inputs and even, odd outputs', () => {
    const pins = parity.pins({});
    expect(pins.filter((p) => p.dir === 'in').map((p) => p.name)).toEqual(
      Array.from({ length: 9 }, (_, i) => `d${i}`),
    );
    expect(pins.filter((p) => p.dir === 'out').map((p) => p.name)).toEqual(['even', 'odd']);
  });

  it("matches the '280 table over all 512 input words", () => {
    for (let word = 0; word < 512; word++) {
      const inputs = Array.from({ length: 9 }, (_, i) => bit((word >> i) & 1));
      let ones = 0;
      for (let w = word; w; w >>= 1) ones += w & 1;
      const r = parity.evaluate(ctx({}, inputs));
      expect(show(r.outputs, [1, 1]), String(word)).toBe(ones % 2 ? '0 1' : '1 0');
    }
  });

  it('any unknown input gives X on both outputs', () => {
    for (const unknown of ['X', 'Z']) {
      const inputs = Array.from({ length: 9 }, (_, i) => (i === 4 ? s(unknown) : bit(0)));
      expect(show(parity.evaluate(ctx({}, inputs)).outputs, [1, 1])).toBe('X X');
    }
  });
});
