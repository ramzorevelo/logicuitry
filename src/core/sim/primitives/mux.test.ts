import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import type { EvalContext, Params } from './types';
import { mux } from './mux';

const s = (lit: string) => bv.fromString(lit);
const show = (value: bv.BusValue | null, w: number) => bv.toString(value!, w);

function ctx(params: Params, inputs: bv.BusValue[]): EvalContext {
  return { params, state: undefined, inputs, prevInputs: inputs, time: 0 };
}

describe('mux', () => {
  it('pin shape: selectBits=2 (4 data lines), no enable', () => {
    const pins = mux.pins({ selectBits: 2 });
    expect(pins.map((p) => p.name)).toEqual(['d0', 'd1', 'd2', 'd3', 's0', 's1', 'y']);
    expect(pins.find((p) => p.name === 'd0')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'data',
      order: 0,
    });
    expect(pins.find((p) => p.name === 's0')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'select',
      order: 4,
    });
    expect(pins.find((p) => p.name === 's1')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'select',
      order: 5,
    });
    expect(pins.find((p) => p.name === 'y')).toMatchObject({
      dir: 'out',
      width: 1,
      role: 'data',
      order: 6,
    });
  });

  it('pin shape: with enable', () => {
    const pins = mux.pins({ selectBits: 1, hasEnable: true });
    expect(pins.map((p) => p.name)).toEqual(['d0', 'd1', 's0', 'en', 'y']);
    expect(pins.find((p) => p.name === 'en')).toMatchObject({
      dir: 'in',
      width: 1,
      role: 'enable',
      order: 3,
    });
  });

  it('rejects selectBits outside 1..4', () => {
    expect(() => mux.pins({ selectBits: 5 })).toThrow(RangeError);
    expect(() => mux.pins({ selectBits: 0 })).toThrow(RangeError);
  });

  it('exhaustive: selectBits=1 (2 data lines), both sel values', () => {
    for (const selBit of [0, 1]) {
      const outs = mux.evaluate(
        ctx({ selectBits: 1 }, [bv.known(0, 1), bv.known(1, 1), bv.known(selBit, 1)]),
      ).outputs;
      expect(show(outs[0]!, 1)).toBe(selBit === 0 ? '0' : '1');
    }
  });

  it('exhaustive: selectBits=2 (4 data lines), every select index picks its own data line', () => {
    for (let idx = 0; idx < 4; idx++) {
      const data = [bv.known(0, 1), bv.known(0, 1), bv.known(0, 1), bv.known(0, 1)];
      data[idx] = bv.known(1, 1);
      const s0 = bv.known(idx & 1, 1);
      const s1 = bv.known((idx >> 1) & 1, 1);
      const outs = mux.evaluate(ctx({ selectBits: 2 }, [...data, s0, s1])).outputs;
      expect(show(outs[0]!, 1)).toBe('1');
    }
  });

  it('selected line X/Z propagates through to y', () => {
    const outsX = mux.evaluate(
      ctx({ selectBits: 1 }, [s('X'), bv.known(0, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outsX[0]!, 1)).toBe('X');
    const outsZ = mux.evaluate(
      ctx({ selectBits: 1 }, [s('Z'), bv.known(0, 1), bv.known(0, 1)]),
    ).outputs;
    expect(show(outsZ[0]!, 1)).toBe('X'); // buf() maps Z -> X, same as any other pass-through
  });

  it('any unknown select bit -> all-X, regardless of data', () => {
    const outs = mux.evaluate(
      ctx({ selectBits: 2 }, [
        bv.known(0, 1),
        bv.known(1, 1),
        bv.known(0, 1),
        bv.known(1, 1),
        s('X'),
        bv.known(0, 1),
      ]),
    ).outputs;
    expect(show(outs[0]!, 1)).toBe('X');
  });

  it('en known-0 dominates to known-0', () => {
    const outs = mux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [
        bv.known(1, 1),
        bv.known(1, 1),
        bv.known(0, 1),
        bv.known(0, 1),
      ]),
    ).outputs;
    expect(show(outs[0]!, 1)).toBe('0');
  });

  it('en unknown -> all-X regardless of sel/data', () => {
    const outs = mux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [
        bv.known(1, 1),
        bv.known(1, 1),
        bv.known(0, 1),
        s('X'),
      ]),
    ).outputs;
    expect(show(outs[0]!, 1)).toBe('X');
  });

  it('en known-1: selects normally', () => {
    const outs = mux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [
        bv.known(0, 1),
        bv.known(1, 1),
        bv.known(1, 1),
        bv.known(1, 1),
      ]),
    ).outputs;
    expect(show(outs[0]!, 1)).toBe('1');
  });

  it('M6.6: width>1 data lines route the whole lane through, select stays 1-bit', () => {
    const pins = mux.pins({ selectBits: 1, width: 4 });
    expect(pins.find((p) => p.name === 'd0')).toMatchObject({ width: 4, role: 'data' });
    expect(pins.find((p) => p.name === 's0')).toMatchObject({ width: 1, role: 'select' });
    expect(pins.find((p) => p.name === 'y')).toMatchObject({ width: 4 });
    const outs = mux.evaluate(
      ctx({ selectBits: 1, width: 4 }, [s('1010'), s('0101'), bv.known(1, 1)]),
    ).outputs;
    expect(show(outs[0]!, 4)).toBe('0101');
  });

  it('M6.6: width>1 en known-0 drives known-0 across the full width', () => {
    const outs = mux.evaluate(
      ctx({ selectBits: 1, width: 4, hasEnable: true }, [
        s('1111'),
        s('1111'),
        bv.known(0, 1),
        bv.known(0, 1),
      ]),
    ).outputs;
    expect(show(outs[0]!, 4)).toBe('0000');
  });

  it('M6.6: width>1 unknown select drives all-X across the full width', () => {
    const outs = mux.evaluate(
      ctx({ selectBits: 1, width: 4 }, [s('1010'), s('0101'), s('X')]),
    ).outputs;
    expect(show(outs[0]!, 4)).toBe('XXXX');
  });

  it('en absent behaves as en known-1', () => {
    const withEnKnown1 = mux.evaluate(
      ctx({ selectBits: 1, hasEnable: true }, [
        bv.known(0, 1),
        bv.known(1, 1),
        bv.known(1, 1),
        bv.known(1, 1),
      ]),
    ).outputs;
    const noEnable = mux.evaluate(
      ctx({ selectBits: 1 }, [bv.known(0, 1), bv.known(1, 1), bv.known(1, 1)]),
    ).outputs;
    expect(show(noEnable[0]!, 1)).toBe(show(withEnKnown1[0]!, 1));
  });
});
