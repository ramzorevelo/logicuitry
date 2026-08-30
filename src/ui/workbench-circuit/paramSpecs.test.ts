import { describe, expect, it } from 'vitest';
import { clampParamValue, clampWidth, isWidthCapable, paramKeysFor } from './paramSpecs';

describe('isWidthCapable', () => {
  it('gates are width-capable (a../y scale with width)', () => {
    expect(isWidthCapable('and', { width: 1, inputs: 2 })).toBe(true);
  });

  it('toggle/led/probe/busdisplay are width-capable', () => {
    expect(isWidthCapable('toggle', { width: 1 })).toBe(true);
    expect(isWidthCapable('led', { width: 1 })).toBe(true);
    expect(isWidthCapable('probe', { width: 1 })).toBe(true);
    expect(isWidthCapable('busdisplay', { width: 1 })).toBe(true);
  });

  it('input/output are width-capable', () => {
    expect(isWidthCapable('inport', { width: 1 })).toBe(true);
    expect(isWidthCapable('outport', { width: 1 })).toBe(true);
  });

  it('mux is width-capable (per-line data width)', () => {
    expect(isWidthCapable('mux', { selectBits: 2, width: 1 })).toBe(true);
  });

  it('decoder/encoder are not width-capable (count-only via addressBits)', () => {
    expect(isWidthCapable('decoder', { addressBits: 2 })).toBe(false);
    expect(isWidthCapable('encoder', { addressBits: 2 })).toBe(false);
  });

  it('unknown kind is not width-capable', () => {
    expect(isWidthCapable('nope', {})).toBe(false);
  });
});

describe('clampWidth', () => {
  it('clamps into [1, max]', () => {
    expect(clampWidth(0, 32)).toBe(1);
    expect(clampWidth(40, 32)).toBe(32);
    expect(clampWidth(5, 32)).toBe(5);
  });
});

describe('paramKeysFor', () => {
  it('a gate has inputs + width once its width is expandable', () => {
    expect(paramKeysFor('and', { width: 1, inputs: 2 })).toEqual(new Set(['inputs', 'width']));
  });

  it('decoder/encoder share addressBits + width absent (decoder also has hasEnable)', () => {
    expect(paramKeysFor('decoder', { addressBits: 2 })).toEqual(
      new Set(['addressBits', 'hasEnable']),
    );
    expect(paramKeysFor('encoder', { addressBits: 2 })).toEqual(new Set(['addressBits']));
  });

  it('mux/demux share selectBits, not inputs/outputs/addressBits', () => {
    const mux = paramKeysFor('mux', { selectBits: 2, width: 1 });
    const demux = paramKeysFor('demux', { selectBits: 2, width: 1 });
    expect(mux.has('selectBits')).toBe(true);
    expect(demux.has('selectBits')).toBe(true);
    expect(mux.has('inputs')).toBe(false);
    expect(demux.has('outputs')).toBe(false);
    expect(mux.has('addressBits')).toBe(false);
  });

  it('a gate never shares identity with mux/demux/decoder/encoder', () => {
    const gate = paramKeysFor('and', { width: 1, inputs: 2 });
    expect(gate.has('selectBits')).toBe(false);
    expect(gate.has('addressBits')).toBe(false);
  });

  it('toggle has width + initial, no inputs', () => {
    expect(paramKeysFor('toggle', { width: 1 })).toEqual(new Set(['width', 'initial']));
  });

  it('led/probe have only width', () => {
    expect(paramKeysFor('led', { width: 1 })).toEqual(new Set(['width']));
  });
});

describe('clampParamValue', () => {
  it("decoder/encoder's addressBits clamps to 1..4, gate's inputs clamps to 2..8", () => {
    expect(clampParamValue('decoder', 'addressBits', 6)).toBe(4);
    expect(clampParamValue('encoder', 'addressBits', 0)).toBe(1);
    expect(clampParamValue('and', 'inputs', 6)).toBe(6);
    expect(clampParamValue('and', 'inputs', 1)).toBe(2);
  });

  it("mux/demux's selectBits clamps to 1..4", () => {
    expect(clampParamValue('mux', 'selectBits', 3)).toBe(3);
    expect(clampParamValue('demux', 'selectBits', 6)).toBe(4);
    expect(clampParamValue('demux', 'selectBits', 0)).toBe(1);
  });

  it('width clamps into [1, MAX_WIDTH] for any kind', () => {
    expect(clampParamValue('led', 'width', 40)).toBe(32);
    expect(clampParamValue('led', 'width', 0)).toBe(1);
  });

  it('selectBits/addressBits are rejected for the wrong kind (domain clash)', () => {
    expect(clampParamValue('and', 'selectBits', 2)).toBeNull();
    expect(clampParamValue('decoder', 'selectBits', 2)).toBeNull();
    expect(clampParamValue('mux', 'addressBits', 2)).toBeNull();
  });

  it('unknown key is always rejected', () => {
    expect(clampParamValue('and', 'nope', 1)).toBeNull();
  });
});
