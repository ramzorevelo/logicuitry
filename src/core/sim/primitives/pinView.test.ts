// M6.6 Phase 6: per-pin bus expand/collapse, exercised end-to-end (pins() +
// evaluate()) against the primitives that support it.
import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import { andGate, bufGate } from './gates';
import { mux } from './mux';
import { demux } from './demux';
import { toggleSwitch } from './stimulus';
import { inputPin, outputPin } from './structural';
import { serializePinView } from './busPins';
import type { EvalContext, Params } from './types';

const s = (lit: string) => bv.fromString(lit);
const show = (value: bv.BusValue | null, w: number) => bv.toString(value!, w);
const ctx = (params: Params, inputs: bv.BusValue[]): EvalContext => ({
  params,
  state: undefined,
  inputs,
  prevInputs: inputs,
  time: 0,
});

describe('gate lane expand (pinView)', () => {
  it('collapsed (default) keeps one wide pin per letter', () => {
    const pins = andGate.pins({ width: 3 });
    expect(pins.map((p) => p.name)).toEqual(['a', 'b', 'y']);
    expect(pins.every((p) => p.width === 3)).toBe(true);
  });

  it('expanding "a" splits it into a2/a1/a0, MSB first (top row), others untouched', () => {
    const params = { width: 3, pinView: serializePinView({ a: 'expanded' }) };
    const pins = andGate.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['a2', 'a1', 'a0', 'b', 'y']);
    expect(pins.every((p) => p.name.startsWith('a') === false || p.width === 1)).toBe(true);
  });

  it('evaluate assembles expanded lanes back into the same result as collapsed', () => {
    const collapsed = ctx({ width: 3 }, [s('101'), s('111')]);
    const expandedParams = { width: 3, pinView: serializePinView({ a: 'expanded' }) };
    // rows are a2,a1,a0 = 1,0,1 (same as '101'), b = '111'
    const expanded = ctx(expandedParams, [s('1'), s('0'), s('1'), s('111')]);
    expect(show(andGate.evaluate(collapsed).outputs[0]!, 3)).toBe(
      show(andGate.evaluate(expanded).outputs[0]!, 3),
    );
  });

  it('expanding y splits the output into per-bit pins/values', () => {
    const params = { width: 2, pinView: serializePinView({ y: 'expanded' }) };
    const pins = bufGate.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['a', 'y1', 'y0']);
    const result = bufGate.evaluate(ctx(params, [s('10')]));
    expect(result.outputs.map((o) => show(o, 1))).toEqual(['1', '0']);
  });
});

describe('mux group collapse (pinView)', () => {
  it('default: individual s0/s1 select lines, individual d0..d3 data lines', () => {
    const pins = mux.pins({ selectBits: 2 });
    expect(pins.map((p) => p.name)).toEqual(['d0', 'd1', 'd2', 'd3', 's0', 's1', 'y']);
  });

  it('collapsing "s" merges select lines into one k-wide bus pin', () => {
    const params = { selectBits: 2, pinView: serializePinView({ s: 'collapsed' }) };
    const pins = mux.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['d0', 'd1', 'd2', 'd3', 's', 'y']);
    expect(pins.find((p) => p.name === 's')).toMatchObject({ width: 2, role: 'select' });
  });

  it('collapsed select evaluates identically to expanded (bit i = si)', () => {
    const expandedParams = { selectBits: 2 };
    const collapsedParams = { selectBits: 2, pinView: serializePinView({ s: 'collapsed' }) };
    const d0 = bv.known(0, 1);
    const d1 = bv.known(1, 1);
    const d2 = bv.known(0, 1);
    const d3 = bv.known(1, 1);
    // select = 3 (s0=1, s1=1) -> packed bus value 0b11 = 3
    const expanded = ctx(expandedParams, [d0, d1, d2, d3, s('1'), s('1')]);
    const collapsed = ctx(collapsedParams, [d0, d1, d2, d3, bv.known(3, 2)]);
    expect(show(mux.evaluate(expanded).outputs[0]!, 1)).toBe(
      show(mux.evaluate(collapsed).outputs[0]!, 1),
    );
    expect(show(mux.evaluate(collapsed).outputs[0]!, 1)).toBe('1'); // d3
  });

  it('data group collapses into one n-wide "d" pin only when width === 1', () => {
    const params = { selectBits: 2, width: 1, pinView: serializePinView({ d: 'collapsed' }) };
    const pins = mux.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['d', 's0', 's1', 'y']);
    expect(pins.find((p) => p.name === 'd')).toMatchObject({ width: 4 });
  });

  it('data group ignores a collapse request when width >= 2 (owner rule)', () => {
    const params = { selectBits: 2, width: 2, pinView: serializePinView({ d: 'collapsed' }) };
    const pins = mux.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['d0', 'd1', 'd2', 'd3', 's0', 's1', 'y']);
  });

  it('an individual data line lane-expands when width >= 2', () => {
    const params = { selectBits: 1, width: 2, pinView: serializePinView({ d0: 'expanded' }) };
    const pins = mux.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['d01', 'd00', 'd1', 's0', 'y']);
  });
});

describe('demux group collapse (pinView)', () => {
  it('collapsing "y" merges outputs into one n-wide bus pin (width === 1 only)', () => {
    const params = { selectBits: 2, width: 1, pinView: serializePinView({ y: 'collapsed' }) };
    const pins = demux.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['d', 's0', 's1', 'y']);
    expect(pins.find((p) => p.name === 'y')).toMatchObject({ width: 4 });
    // sel = 2 (s0=0, s1=1) -> y2 = d, others 0 -> packed bus = 0b0100 = 4
    const result = demux.evaluate(ctx(params, [s('1'), s('0'), s('1')]));
    expect(result.outputs[0]!.v).toBe(0b0100);
  });
});

describe('toggle lane expand (pinView)', () => {
  it('expanding y splits the toggle output into per-bit pins', () => {
    const params = { width: 3, pinView: serializePinView({ y: 'expanded' }) };
    const pins = toggleSwitch.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['y2', 'y1', 'y0']);
    const result = toggleSwitch.evaluate({
      params,
      state: { value: 0b101 },
      inputs: [],
      prevInputs: [],
      time: 0,
    });
    expect(result.outputs.map((o) => show(o, 1))).toEqual(['1', '0', '1']);
  });
});

describe('port lane expand (pinView)', () => {
  it("expanding an In port's y splits it into per-bit pins", () => {
    const params = { width: 3, pinView: serializePinView({ y: 'expanded' }) };
    const pins = inputPin.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['y2', 'y1', 'y0']);
    const result = inputPin.evaluate({
      params,
      state: { value: bv.known(0b101, 3) },
      inputs: [],
      prevInputs: [],
      time: 0,
    });
    expect(result.outputs.map((o) => show(o, 1))).toEqual(['1', '0', '1']);
  });

  it('collapsed In port evaluates as a single wide value (unchanged)', () => {
    const params = { width: 3 };
    const pins = inputPin.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['y']);
    const result = inputPin.evaluate({
      params,
      state: { value: bv.known(0b101, 3) },
      inputs: [],
      prevInputs: [],
      time: 0,
    });
    expect(show(result.outputs[0]!, 3)).toBe('101');
  });

  it("expanding an Out port's a splits it into per-bit pins", () => {
    const params = { width: 2, pinView: serializePinView({ a: 'expanded' }) };
    const pins = outputPin.pins(params);
    expect(pins.map((p) => p.name)).toEqual(['a1', 'a0']);
    expect(pins.every((p) => p.width === 1)).toBe(true);
  });
});
