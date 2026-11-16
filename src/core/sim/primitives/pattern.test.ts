import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import { parsePatternValues, pattern, patternParamError } from './pattern';
import { clockShape, nextClockFall } from './stimulus';
import type { Params } from './types';

const atTime = (params: Params, time: number) =>
  pattern.evaluate({ params, state: pattern.init!(params), inputs: [], prevInputs: [], time });

describe('pattern values', () => {
  it('parses hex separated by spaces or commas', () => {
    expect(parsePatternValues('3 5, 9 f')).toEqual([3, 5, 9, 15]);
    expect(parsePatternValues('ffffffff')).toEqual([0xffffffff]);
  });

  it('refuses an empty list and anything that is not hex', () => {
    expect(parsePatternValues('  ')).toBeNull();
    expect(parsePatternValues('3 g')).toBeNull();
    expect(parsePatternValues('123456789')).toBeNull();
  });

  it('names a bad param', () => {
    expect(patternParamError({ values: '' })).toMatch(/hex/);
    expect(patternParamError({ stepPs: 1 })).toMatch(/2 ps/);
    expect(patternParamError({ after: 'loop' })).toMatch(/repeat/);
    expect(patternParamError({ values: '1 2', stepPs: 10, after: 'hold' })).toBeNull();
  });
});

describe('pattern in time mode', () => {
  const params = { width: 4, values: '3 5 9', stepPs: 100 };

  it('plays each value for one step and wakes at the next boundary', () => {
    expect(atTime(params, 0)).toEqual({ outputs: [bv.known(3, 4)], nextWake: 100 });
    expect(atTime(params, 199)).toEqual({ outputs: [bv.known(5, 4)], nextWake: 200 });
  });

  it('repeats by default', () => {
    expect(atTime(params, 300).outputs).toEqual([bv.known(3, 4)]);
  });

  it('holds the last value with no further wake', () => {
    const hold = { ...params, after: 'hold' };
    expect(atTime(hold, 250)).toEqual({ outputs: [bv.known(9, 4)] });
    expect(atTime(hold, 10_000)).toEqual({ outputs: [bv.known(9, 4)] });
  });

  it('masks values to the width', () => {
    expect(atTime({ width: 2, values: 'f', stepPs: 10 }, 0).outputs).toEqual([bv.known(3, 2)]);
  });

  it('has one output pin and no input', () => {
    expect(pattern.pins(params).map((p) => [p.name, p.dir, p.width])).toEqual([['y', 'out', 4]]);
  });
});

describe('pattern in clocked mode', () => {
  const params = { width: 4, values: '1 2', clocked: true };
  const lo = bv.known(0, 1);
  const hi = bv.known(1, 1);
  const step = (state: unknown, prev: bv.BusValue, cur: bv.BusValue) =>
    pattern.evaluate({ params, state, inputs: [cur], prevInputs: [prev], time: 0 });

  it('grows a clk input', () => {
    expect(pattern.pins(params).map((p) => p.name)).toEqual(['clk', 'y']);
  });

  it('shows the first value until the first rising edge, then steps once per edge', () => {
    const s0 = pattern.init!(params);
    expect(step(s0, lo, lo)).toEqual({ outputs: [bv.known(1, 4)] });
    const r1 = step(s0, lo, hi);
    expect(r1.outputs).toEqual([bv.known(2, 4)]);
    expect(step(r1.state, hi, lo).outputs).toEqual([bv.known(2, 4)]);
    expect(step(r1.state, lo, hi).outputs).toEqual([bv.known(1, 4)]);
  });

  it('shows X while the clock is unknown and keeps its count', () => {
    const s0 = pattern.init!(params);
    expect(step(s0, lo, bv.allX(1))).toEqual({ outputs: [bv.allX(4)] });
    expect(step(s0, bv.allX(1), hi)).toEqual({ outputs: [bv.known(1, 4)] });
  });
});

describe('nextClockFall', () => {
  it('finds the first fall after the phase and every period after it', () => {
    const shape = clockShape({ periodPs: 100, dutyPercent: 30, phasePs: 50 });
    expect(nextClockFall(shape, 0)).toBe(80);
    expect(nextClockFall(shape, 79)).toBe(80);
    expect(nextClockFall(shape, 80)).toBe(180);
    expect(nextClockFall(shape, 1000)).toBe(1080);
  });

  it('rounds the HIGH length exactly as the clock does', () => {
    const shape = clockShape({ periodPs: 3, dutyPercent: 50 });
    expect(shape.highLen).toBe(2);
    expect(nextClockFall(shape, 0)).toBe(2);
  });
});
