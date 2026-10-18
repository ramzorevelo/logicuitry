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

  it('en unknown: the addressed output is X, the rest stay inactive', () => {
    const outs = decoder.evaluate(
      ctx({ addressBits: 2, hasEnable: true }, [bv.known(0, 2), s('X')]),
    ).outputs;
    expect(outs.map((o) => show(o, 1))).toEqual(['X', '0', '0', '0']);
  });

  it('an X address bit leaves X only on the outputs it could select', () => {
    const outs = decoder.evaluate(ctx({ addressBits: 2 }, [s('X0')])).outputs;
    expect(outs.map((o) => show(o, 1))).toEqual(['X', '0', 'X', '0']);
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

  it('an unknown above the highest known-1 leaves X only on the code bits it could change', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [bv.known(0, 1), bv.known(1, 1), bv.known(0, 1), s('X')]),
    ).outputs;
    expect(show(outs[0]!, 2)).toBe('X1');
    expect(show(outs[1]!, 1)).toBe('1');
  });

  it('all known-0 -> valid known-0', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [bv.known(0, 1), bv.known(0, 1), bv.known(0, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outs[1]!, 1)).toBe('0');
  });

  it('no known-1, not all known-0: valid is X, the code holds what every case agrees on', () => {
    const outs = encoder.evaluate(
      ctx({ addressBits: 2 }, [s('X'), bv.known(0, 1), bv.known(0, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outs[0]!, 2)).toBe('00');
    expect(show(outs[1]!, 1)).toBe('X');
    const high = encoder.evaluate(
      ctx({ addressBits: 2 }, [bv.known(0, 1), bv.known(0, 1), bv.known(0, 1), s('X')]),
    ).outputs;
    expect(show(high[0]!, 2)).toBe('XX');
  });
});

describe('decoder as a real part (hidden params)', () => {
  const ls138 = {
    addressBits: 3,
    enablesHigh: 1,
    enablesLow: 2,
    activeLowOut: true,
    pinView: 'a=expanded',
  };
  // Inputs in pins() order: a2 a1 a0 enh0 enl0 enl1.
  const run = (lits: string) =>
    decoder
      .evaluate(ctx(ls138, [...lits].map(s)))
      .outputs.map((v) => show(v, 1))
      .join('');

  it('pin shape: three enables replace en, low-true pins are flagged', () => {
    const pins = decoder.pins(ls138);
    expect(pins.filter((p) => p.dir === 'in').map((p) => p.name)).toEqual([
      'a2',
      'a1',
      'a0',
      'enh0',
      'enl0',
      'enl1',
    ]);
    const low = pins.filter((p) => p.activeLow).map((p) => p.name);
    expect(low).toEqual(['enl0', 'enl1', 'y0', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7']);
    expect(pins.find((p) => p.name === 'enh0')!.role).toBe('enable');
    expect(pins.some((p) => p.name === 'en')).toBe(false);
  });

  it('the block decoder flags nothing active low', () => {
    expect(decoder.pins({ addressBits: 2, hasEnable: true }).some((p) => p.activeLow)).toBe(false);
  });

  it('a known-inactive enable wins over an unknown one and over an unknown address', () => {
    expect(run('XXX0XX')).toBe('11111111');
    expect(run('0001X1')).toBe('11111111');
    expect(run('101X10')).toBe('11111111');
  });

  it('an unknown enable with none known inactive leaves only the addressed output X', () => {
    expect(run('000X00')).toBe('X1111111');
    expect(run('00010Z')).toBe('X1111111');
  });

  it('enabled with an unknown address bit: only the outputs it could select are X', () => {
    expect(run('0X0100')).toBe('X1X11111');
  });

  it('rejects enable counts no part has', () => {
    expect(() => decoder.pins({ enablesHigh: 2 })).toThrow(RangeError);
    expect(() => decoder.pins({ enablesLow: 3 })).toThrow(RangeError);
  });
});

describe('encoder as a real part (hidden params)', () => {
  const ls148 = { addressBits: 3, activeLow: true, cascade: true, pinView: 'a=expanded' };
  // Inputs in pins() order: i0..i7 ei. Outputs: a2 a1 a0 gs eo.
  const run = (lits: string) =>
    encoder
      .evaluate(ctx(ls148, [...lits].map(s)))
      .outputs.map((v) => show(v, 1))
      .join('');

  it('pin shape: ei in, gs and eo out in place of valid, every pin low-true', () => {
    const pins = encoder.pins(ls148);
    expect(pins.map((p) => p.name)).toEqual([
      ...['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'ei'],
      ...['a2', 'a1', 'a0', 'gs', 'eo'],
    ]);
    expect(pins.every((p) => p.activeLow)).toBe(true);
  });

  it('a known-high EI disables whatever the inputs are', () => {
    expect(run('XXXXXXXX1')).toBe('11111');
  });

  it('an unknown EI leaves EO high, which it is enabled or not, and the rest X', () => {
    expect(run('11111110X')).toBe('XXXX1');
  });

  it('unknowns below the winner do not matter, one above it only where the codes differ', () => {
    expect(run('XXXXX0110')).toBe('01001');
    // Input 5 or 7 is the top one: A2 and A0 agree, GS is low, EO high either way.
    expect(run('1111101X0')).toBe('0X001');
  });

  it('cascade alone keeps active-high levels', () => {
    const high = { addressBits: 2, cascade: true };
    const out = (lits: string) =>
      encoder
        .evaluate(ctx(high, [...lits].map(s)))
        .outputs.map((v, i) => show(v, i === 0 ? 2 : 1))
        .join(' ');
    // i0..i3 ei -> a gs eo
    expect(out('00101')).toBe('10 1 0');
    expect(out('00001')).toBe('00 0 1');
    expect(out('00100')).toBe('00 0 0');
  });
});
