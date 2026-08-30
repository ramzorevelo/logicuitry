import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import type { EvalContext, Params } from './types';
import { decoder, encoder } from './coder';

const s = (lit: string) => bv.fromString(lit);
const show = (value: bv.BusValue | null, w: number) => bv.toString(value!, w);

function ctx(params: Params, inputs: bv.BusValue[]): EvalContext {
  return { params, state: undefined, inputs, prevInputs: inputs, time: 0 };
}

describe('decoder', () => {
  it('pin shape: no enable', () => {
    const pins = decoder.pins({ addressBits: 2 });
    expect(pins.map((p) => p.name)).toEqual(['a', 'y0', 'y1', 'y2', 'y3']);
    expect(pins.find((p) => p.name === 'a')).toMatchObject({
      dir: 'in',
      width: 2,
      role: 'data',
      order: 0,
    });
    expect(pins.find((p) => p.name === 'y3')).toMatchObject({
      dir: 'out',
      width: 1,
      role: 'data',
      order: 4,
    });
  });

  it('pin shape: with enable', () => {
    const pins = decoder.pins({ addressBits: 1, hasEnable: true });
    expect(pins.map((p) => p.name)).toEqual(['a', 'en', 'y0', 'y1']);
    expect(pins.find((p) => p.name === 'en')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'enable',
      order: 1,
    });
  });

  it('rejects addressBits outside 1..4', () => {
    expect(() => decoder.pins({ addressBits: 5 })).toThrow(RangeError);
    expect(() => decoder.pins({ addressBits: 0 })).toThrow(RangeError);
  });

  it('exhaustive truth table addressBits=2, no enable', () => {
    for (let idx = 0; idx < 4; idx++) {
      const outs = decoder.evaluate(ctx({ addressBits: 2 }, [bv.known(idx, 2)])).outputs;
      for (let i = 0; i < 4; i++) expect(show(outs[i]!, 1)).toBe(i === idx ? '1' : '0');
    }
  });

  it('en known-0 dominates to all-0', () => {
    const outs = decoder.evaluate(
      ctx({ addressBits: 2, hasEnable: true }, [bv.known(3, 2), bv.known(0, 1)]),
    ).outputs;
    for (const o of outs) expect(show(o, 1)).toBe('0');
  });

  it('en known-1: decodes normally', () => {
    const outs = decoder.evaluate(
      ctx({ addressBits: 2, hasEnable: true }, [bv.known(1, 2), bv.known(1, 1)]),
    ).outputs;
    expect(outs.map((o) => show(o, 1))).toEqual(['0', '1', '0', '0']);
  });

  it('en unknown -> all-X regardless of a', () => {
    const outs = decoder.evaluate(
      ctx({ addressBits: 2, hasEnable: true }, [bv.known(0, 2), s('X')]),
    ).outputs;
    for (const o of outs) expect(show(o, 1)).toBe('X');
  });

  it('X in a -> all-X', () => {
    const outs = decoder.evaluate(ctx({ addressBits: 2 }, [s('X0')])).outputs;
    for (const o of outs) expect(show(o, 1)).toBe('X');
  });

  it('decoder with en absent behaves as en known-1', () => {
    const withEnKnown1 = decoder.evaluate(
      ctx({ addressBits: 2, hasEnable: true }, [bv.known(2, 2), bv.known(1, 1)]),
    ).outputs;
    const noEnable = decoder.evaluate(ctx({ addressBits: 2 }, [bv.known(2, 2)])).outputs;
    expect(noEnable.map((o) => show(o, 1))).toEqual(withEnKnown1.map((o) => show(o, 1)));
  });
});

describe('encoder', () => {
  it('pin shape: addressBits=2 (4 one-hot inputs)', () => {
    const pins = encoder.pins({ addressBits: 2 });
    expect(pins.map((p) => p.name)).toEqual(['i0', 'i1', 'i2', 'i3', 'a', 'valid']);
    expect(pins.find((p) => p.name === 'a')).toMatchObject({
      dir: 'out',
      width: 2,
      role: 'data',
      order: 4,
    });
    expect(pins.find((p) => p.name === 'valid')).toMatchObject({
      dir: 'out',
      width: 1,
      role: 'data',
      order: 5,
    });
  });

  it('rejects addressBits outside 1..4', () => {
    expect(() => encoder.pins({ addressBits: 5 })).toThrow(RangeError);
    expect(() => encoder.pins({ addressBits: 0 })).toThrow(RangeError);
  });

  it('exhaustive: addressBits=2 (4 one-hot inputs), single-hot wins its own index', () => {
    for (let idx = 0; idx < 4; idx++) {
      const ins = Array.from({ length: 4 }, (_, i) => bv.known(i === idx ? 1 : 0, 1));
      const outs = encoder.evaluate(ctx({ addressBits: 2 }, ins)).outputs;
      expect(show(outs[0]!, 2)).toBe(bv.toString(bv.known(idx, 2), 2));
      expect(show(outs[1]!, 1)).toBe('1');
    }
  });

  it('exhaustive: addressBits=1 (2 one-hot inputs), all fully-known combos', () => {
    for (let i0 = 0; i0 <= 1; i0++) {
      for (let i1 = 0; i1 <= 1; i1++) {
        const outs = encoder.evaluate(
          ctx({ addressBits: 1 }, [bv.known(i0, 1), bv.known(i1, 1)]),
        ).outputs;
        if (i1 === 1) {
          expect(show(outs[0]!, 1)).toBe('1');
          expect(show(outs[1]!, 1)).toBe('1');
        } else if (i0 === 1) {
          expect(show(outs[0]!, 1)).toBe('0');
          expect(show(outs[1]!, 1)).toBe('1');
        } else {
          expect(show(outs[0]!, 1)).toBe('0');
          expect(show(outs[1]!, 1)).toBe('0');
        }
      }
    }
  });

  it('priority: highest index wins, unknowns below winner do not matter', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [s('X'), s('X'), bv.known(1, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outs[0]!, 2)).toBe(bv.toString(bv.known(2, 2), 2));
    expect(show(outs[1]!, 1)).toBe('1');
  });

  it('unknown above the highest known-1 -> all-X', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [bv.known(0, 1), bv.known(1, 1), bv.known(0, 1), s('X')]),
    ).outputs;
    expect(show(outs[0]!, 2)).toBe('XX');
    expect(show(outs[1]!, 1)).toBe('X');
  });

  it('all known-0 -> valid known-0', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [bv.known(0, 1), bv.known(0, 1), bv.known(0, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outs[1]!, 1)).toBe('0');
  });

  it('no known-1, not all known-0 -> all-X', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [s('X'), bv.known(0, 1), bv.known(0, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outs[0]!, 2)).toBe('XX');
    expect(show(outs[1]!, 1)).toBe('X');
  });
});
