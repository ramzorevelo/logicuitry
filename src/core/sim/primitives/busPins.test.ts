import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import {
  assembleBus,
  expandPin,
  packIndexed,
  parsePinView,
  pinViewOf,
  reindexPins,
  serializePinView,
  splitBus,
  unpackIndexed,
} from './busPins';
import type { PrimitivePin } from './types';

describe('busPins', () => {
  const base: PrimitivePin = { name: 'a', dir: 'in', width: 3, role: 'data', order: 0 };

  it('expandPin is MSB-first in array order (the MSB renders at the top)', () => {
    const pins = expandPin(base, 3);
    expect(pins.map((p) => p.name)).toEqual(['a2', 'a1', 'a0']);
    expect(pins.every((p) => p.width === 1)).toBe(true);
  });

  it('expandPin sets a bracket-notation display label distinct from the wiring name', () => {
    const pins = expandPin(base, 3);
    expect(pins.map((p) => p.label)).toEqual(['a[2]', 'a[1]', 'a[0]']);
    // Lane-expanding an already-indexed pin (mux's d0) keeps the same
    // formula: the bracket wraps whatever the base pin was already named.
    const indexed: PrimitivePin = { name: 'd0', dir: 'in', width: 2, role: 'data', order: 0 };
    const bits = expandPin(indexed, 2);
    expect(bits.map((p) => p.name)).toEqual(['d01', 'd00']);
    expect(bits.map((p) => p.label)).toEqual(['d0[1]', 'd0[0]']);
  });

  it('expandPin(bracketLabels=false) uses the plain name as the label', () => {
    const pins = expandPin(base, 3, false);
    expect(pins.map((p) => p.name)).toEqual(['a2', 'a1', 'a0']);
    expect(pins.map((p) => p.label)).toEqual(['a2', 'a1', 'a0']);
  });

  it('assembleBus/splitBus round-trip MSB-first', () => {
    const value = bv.known(0b101, 3);
    const bits = splitBus(value, 3); // [bit2, bit1, bit0], matching expandPin's rows
    expect(bits.map((b) => b.v)).toEqual([1, 0, 1]);
    expect(assembleBus(bits)).toEqual(value);
  });

  it('assembleBus preserves X/Z per lane', () => {
    const bits = [bv.allZ(1), bv.known(1, 1), bv.allX(1)]; // bit2..bit0
    const value = assembleBus(bits);
    expect(bv.toString(value, 3)).toBe('Z1X');
  });

  it('packIndexed/unpackIndexed is LSB-first (index i = bit i)', () => {
    const s0 = bv.known(1, 1);
    const s1 = bv.known(0, 1);
    const s2 = bv.known(1, 1);
    const packed = packIndexed([s0, s1, s2]);
    expect(packed.v).toBe(0b101); // bit0=1, bit1=0, bit2=1
    const back = unpackIndexed(packed, 3);
    expect(back.map((b) => b.v)).toEqual([1, 0, 1]);
  });

  it('reindexPins renumbers sequentially in array order', () => {
    const pins: PrimitivePin[] = [
      { name: 'x', dir: 'in', width: 1, role: 'data', order: 99 },
      { name: 'y', dir: 'out', width: 1, role: 'data', order: 5 },
    ];
    const out = reindexPins(pins);
    expect(out.map((p) => p.order)).toEqual([0, 1]);
  });

  it('parsePinView/serializePinView round-trip', () => {
    const s = serializePinView({ a: 'expanded', y: 'collapsed' });
    expect(parsePinView({ pinView: s })).toEqual({ a: 'expanded', y: 'collapsed' });
  });

  it('parsePinView tolerates missing/garbage input', () => {
    expect(parsePinView({})).toEqual({});
    expect(parsePinView({ pinView: 'garbage' })).toEqual({});
    expect(parsePinView({ pinView: 'a=bogus' })).toEqual({});
  });

  it('pinViewOf falls back when unset', () => {
    expect(pinViewOf({}, 'a', 'collapsed')).toBe('collapsed');
    expect(pinViewOf({ a: 'expanded' }, 'a', 'collapsed')).toBe('expanded');
  });
});
