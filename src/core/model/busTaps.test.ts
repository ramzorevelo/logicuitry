import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import { CompileError, compile } from './compile';
import { Simulator } from '../sim/kernel';
import { idealDelay } from '../sim/delay';
import type { ChipLibrary } from './types';
import { board, comp, tapWire, wire } from './testFixtures';

const lib: ChipLibrary = new Map();

// 180 = 1011_0100b: bit0=0 bit1=0 bit2=1 bit3=0 bit4=1 bit5=1 bit6=0 bit7=1.
const settledValue = (b: ReturnType<typeof board>, path: string): bv.BusValue => {
  const sim = new Simulator(compile(b, lib), idealDelay);
  sim.powerOn();
  return sim.netValueByPath(path);
};

describe('bus taps', () => {
  it('reads a single bit off a bus into a 1-bit stub', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 8, value: 180 }),
        comp('o', 'outport', { width: 8 }),
        comp('p', 'probe', { width: 1 }, 'BIT2'),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 2, lo: 2 }),
      ],
    });
    expect(settledValue(b, 'main/BIT2')).toEqual(bv.known(1, 1));
  });

  it('reads a [hi:lo] sub-range, matching a slice of the bus', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 8, value: 180 }),
        comp('o', 'outport', { width: 8 }),
        comp('p', 'probe', { width: 4 }, 'NIB'),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 5, lo: 2 }),
      ],
    });
    // bits [5:2] of 180 == (180 >> 2) & 0xF == 13.
    expect(settledValue(b, 'main/NIB')).toEqual(bv.slice(bv.known(180, 8), 2, 4));
    expect(settledValue(b, 'main/NIB')).toEqual(bv.known(13, 4));
  });

  it('low nibble tap equals the split primitive on the same bus', () => {
    const tapped = board({
      components: [
        comp('c', 'constant', { width: 8, value: 180 }),
        comp('o', 'outport', { width: 8 }),
        comp('p', 'probe', { width: 4 }, 'LOW'),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 3, lo: 0 }),
      ],
    });
    const viaSplit = board({
      components: [
        comp('c', 'constant', { width: 8, value: 180 }),
        comp('s', 'split', { width: 8, splits: '4,4' }),
        comp('p', 'probe', { width: 4 }, 'LOW'),
      ],
      wires: [wire('wbus', ['c', 'y'], ['s', 'bus']), wire('wlo', ['s', 'o0'], ['p', 'a'])],
    });
    expect(settledValue(tapped, 'main/LOW')).toEqual(settledValue(viaSplit, 'main/LOW'));
  });

  it('drives bus bits from taps (merge direction), floating the untapped bits', () => {
    const b = board({
      components: [
        comp('t1', 'toggle', { initial: true }),
        comp('t0', 'toggle', { initial: false }),
        comp('o', 'outport', { width: 2 }),
        comp('p', 'probe', { width: 2 }, 'BUS'),
      ],
      wires: [
        wire('wbus', ['o', 'a'], ['p', 'a']),
        tapWire('wt1', ['t1', 'y'], 'wbus', { hi: 1, lo: 1 }),
        tapWire('wt0', ['t0', 'y'], 'wbus', { hi: 0, lo: 0 }),
      ],
    });
    expect(settledValue(b, 'main/BUS')).toEqual(bv.known(0b10, 2));
  });

  it('rejects a tap range beyond the bus width', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 8 }),
        comp('o', 'outport', { width: 8 }),
        comp('p', 'probe', { width: 1 }),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 8, lo: 8 }),
      ],
    });
    expect(() => compile(b, lib)).toThrow(CompileError);
    expect(() => compile(b, lib)).toThrow(/outside bus/);
  });

  it('rejects an inverted tap range', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 8 }),
        comp('o', 'outport', { width: 8 }),
        comp('p', 'probe', { width: 1 }),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 1, lo: 3 }),
      ],
    });
    expect(() => compile(b, lib)).toThrow(/outside bus/);
  });

  it('rejects a range whose width does not match the stub pin', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 8 }),
        comp('o', 'outport', { width: 8 }),
        comp('p', 'probe', { width: 1 }),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 3, lo: 0 }),
      ],
    });
    expect(() => compile(b, lib)).toThrow(/does not match pin/);
  });

  it('rejects a tap referencing an unknown bus wire', () => {
    const b = board({
      components: [comp('p', 'probe', { width: 1 })],
      wires: [tapWire('wt', ['p', 'a'], 'nope', { hi: 0, lo: 0 })],
    });
    expect(() => compile(b, lib)).toThrow(/unknown wire/);
  });
});
