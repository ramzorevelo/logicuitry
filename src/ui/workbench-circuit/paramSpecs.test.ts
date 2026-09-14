import { describe, expect, it } from 'vitest';
import {
  clampParamValue,
  clampWidth,
  isLiveEditable,
  liveParamsOnly,
  isWidthCapable,
  paramKeysFor,
  paramLiveness,
} from './paramSpecs';
import { getPrimitive } from '../../core/sim/primitives/registry';

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

  it('led has width plus its physical colour and shape', () => {
    expect(paramKeysFor('led', { width: 1 })).toEqual(new Set(['width', 'color', 'shape']));
  });

  it('probe has only width', () => {
    expect(paramKeysFor('probe', { width: 1 })).toEqual(new Set(['width']));
  });

  it('led matrix has its two dimensions, clamped to the buildable range', () => {
    expect(paramKeysFor('ledmatrix', { rows: 8, cols: 8 })).toEqual(new Set(['rows', 'cols']));
    expect(clampParamValue('ledmatrix', 'rows', 99)).toBe(8);
    expect(clampParamValue('ledmatrix', 'cols', 0)).toBe(2);
    expect(clampParamValue('led', 'rows', 4)).toBeNull();
  });

  it('rejects a colour or shape it does not know', () => {
    expect(clampParamValue('led', 'color', 'chartreuse')).toBeNull();
    expect(clampParamValue('led', 'color', 'blue')).toBe('blue');
    expect(clampParamValue('led', 'shape', 'round')).toBe('round');
    expect(clampParamValue('probe', 'shape', 'round')).toBeNull();
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

describe('paramLiveness', () => {
  it("led colour/shape are render-only: the primitive's own pins() ignores them", () => {
    // The claim the powered-edit gate rests on, asserted against the real
    // primitive rather than trusting the key list.
    const led = getPrimitive('led');
    const shape = (params: Record<string, unknown>) =>
      JSON.stringify(led.pins(params as never).map((p) => [p.name, p.width, p.dir]));
    expect(shape({ width: 4, color: 'red', shape: 'round' })).toBe(
      shape({ width: 4, color: 'green', shape: 'square' }),
    );
    expect(paramLiveness('led', 'color')).toBe('render');
    expect(paramLiveness('led', 'shape')).toBe('render');
  });

  it('mux/demux selSide is render-only (glyph edge, same pin list)', () => {
    expect(paramLiveness('mux', 'selSide')).toBe('render');
    expect(paramLiveness('demux', 'selSide')).toBe('render');
  });

  it('constant value is stimulus: evaluate() re-reads it, no recompile needed', () => {
    expect(paramLiveness('constant', 'value')).toBe('stimulus');
  });

  it('pin-count and width params are structural', () => {
    expect(paramLiveness('led', 'width')).toBe('structural');
    expect(paramLiveness('and', 'inputs')).toBe('structural');
    expect(paramLiveness('mux', 'selectBits')).toBe('structural');
    expect(paramLiveness('decoder', 'addressBits')).toBe('structural');
    expect(paramLiveness('mux', 'hasEnable')).toBe('structural');
    expect(paramLiveness('ledmatrix', 'rows')).toBe('structural');
    expect(paramLiveness('ledmatrix', 'cols')).toBe('structural');
  });

  it('toggle initial is structural: it only seeds state at power-on', () => {
    expect(paramLiveness('toggle', 'initial')).toBe('structural');
  });

  it('an unclassified key defaults to structural (fail locked, not live)', () => {
    expect(paramLiveness('and', 'somethingNew')).toBe('structural');
    expect(paramLiveness('nosuchkind', 'color')).toBe('render');
  });

  it('isLiveEditable is the conjunction over a field set', () => {
    expect(isLiveEditable('led', ['color', 'shape'])).toBe(true);
    expect(isLiveEditable('led', ['color', 'width'])).toBe(false);
    expect(isLiveEditable('led', [])).toBe(true);
  });
});

describe('liveParamsOnly', () => {
  it('passes everything through when unpowered', () => {
    const p = { width: 4, color: 'green', pinView: 'y:collapsed' };
    expect(liveParamsOnly('led', p, false)).toEqual(p);
  });

  // The regression: the overlay commits its whole field set, so a colour-only
  // change also wrote width/pinView, and on an LED that had no explicit width
  // that new key read as a pin-shape change and powered the board off.
  it('drops the greyed fields the overlay always writes, while powered', () => {
    expect(
      liveParamsOnly('led', { width: 1, pinView: 'a:collapsed', color: 'green' }, true),
    ).toEqual({ color: 'green' });
  });

  it('keeps a stimulus param while powered', () => {
    expect(liveParamsOnly('constant', { width: 4, value: 9 }, true)).toEqual({ value: 9 });
  });

  it('can strip a commit down to nothing (a wholly structural overlay)', () => {
    expect(liveParamsOnly('toggle', { width: 2, initial: 1, pinView: '' }, true)).toEqual({});
  });

  it('does not mutate its input', () => {
    const p = { width: 1, color: 'red' };
    liveParamsOnly('led', p, true);
    expect(p).toEqual({ width: 1, color: 'red' });
  });
});
