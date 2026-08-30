import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import type { EvalContext, Params } from './types';
import { demux } from './demux';

const s = (lit: string) => bv.fromString(lit);
const show = (value: bv.BusValue | null, w: number) => bv.toString(value!, w);

function ctx(params: Params, inputs: bv.BusValue[]): EvalContext {
  return { params, state: undefined, inputs, prevInputs: inputs, time: 0 };
}

describe('demux', () => {
  it('pin shape: selectBits=2 (4 outputs), no enable', () => {
    const pins = demux.pins({ selectBits: 2 });
    expect(pins.map((p) => p.name)).toEqual(['d', 's0', 's1', 'y0', 'y1', 'y2', 'y3']);
    expect(pins.find((p) => p.name === 'd')).toMatchObject({ dir: 'in', width: 1, role: 'data' });
    expect(pins.find((p) => p.name === 's0')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'select',
    });
    expect(pins.find((p) => p.name === 'y0')).toMatchObject({
      dir: 'out',
      width: 1,
      role: 'data',
    });
  });

  it('pin shape: with enable', () => {
    const pins = demux.pins({ selectBits: 1, hasEnable: true });
    expect(pins.map((p) => p.name)).toEqual(['d', 's0', 'en', 'y0', 'y1']);
    expect(pins.find((p) => p.name === 'en')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'enable',
    });
  });

  it('rejects selectBits outside 1..4', () => {
    expect(() => demux.pins({ selectBits: 5 })).toThrow(RangeError);
    expect(() => demux.pins({ selectBits: 0 })).toThrow(RangeError);
  });

  it('routes d to the selected output, others driven known-0', () => {
    const outs = demux.evaluate(ctx({ selectBits: 1 }, [bv.known(1, 1), bv.known(1, 1)])).outputs;
    expect(show(outs[0]!, 1)).toBe('0');
    expect(show(outs[1]!, 1)).toBe('1');
  });

  it('exhaustive: selectBits=2 (4 outputs), every select index routes to its own line', () => {
    for (let idx = 0; idx < 4; idx++) {
      const s0 = bv.known(idx & 1, 1);
      const s1 = bv.known((idx >> 1) & 1, 1);
      const outs = demux.evaluate(ctx({ selectBits: 2 }, [bv.known(1, 1), s0, s1])).outputs;
      for (let i = 0; i < 4; i++) expect(show(outs[i]!, 1)).toBe(i === idx ? '1' : '0');
    }
  });

  it('unknown select bit -> all outputs X', () => {
    const outs = demux.evaluate(ctx({ selectBits: 1 }, [bv.known(1, 1), s('X')])).outputs;
    expect(outs.every((o) => show(o!, 1) === 'X')).toBe(true);
  });

  it('en known-0 dominates to all outputs known-0', () => {
    const outs = demux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [bv.known(1, 1), bv.known(1, 1), bv.known(0, 1)]),
    ).outputs;
    expect(outs.every((o) => show(o!, 1) === '0')).toBe(true);
  });

  it('en unknown -> all outputs X regardless of sel/data', () => {
    const outs = demux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [bv.known(1, 1), bv.known(0, 1), s('X')]),
    ).outputs;
    expect(outs.every((o) => show(o!, 1) === 'X')).toBe(true);
  });

  it('en absent behaves as en known-1', () => {
    const noEnable = demux.evaluate(
      ctx({ selectBits: 1 }, [bv.known(1, 1), bv.known(0, 1)]),
    ).outputs;
    const withEn = demux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [bv.known(1, 1), bv.known(0, 1), bv.known(1, 1)]),
    ).outputs;
    expect(noEnable.map((o, i) => show(o!, 1) === show(withEn[i]!, 1)).every(Boolean)).toBe(true);
  });

  it('M6.6: width>1 data routes the whole lane through, others known-0 across the width', () => {
    const pins = demux.pins({ selectBits: 1, width: 4 });
    expect(pins.find((p) => p.name === 'd')).toMatchObject({ width: 4 });
    expect(pins.find((p) => p.name === 'y0')).toMatchObject({ width: 4 });
    const outs = demux.evaluate(
      ctx({ selectBits: 1, width: 4 }, [s('1010'), bv.known(1, 1)]),
    ).outputs;
    expect(show(outs[0]!, 4)).toBe('0000');
    expect(show(outs[1]!, 4)).toBe('1010');
  });

  it('defaultPart per size: 2/4 -> 74LS139, 8 -> 74LS138, 16 -> 74LS154', () => {
    const part = demux.defaultPart as (p: Params) => string | undefined;
    expect(part({ selectBits: 1 })).toBe('74LS139');
    expect(part({ selectBits: 2 })).toBe('74LS139');
    expect(part({ selectBits: 3 })).toBe('74LS138');
    expect(part({ selectBits: 4 })).toBe('74LS154');
  });
});
