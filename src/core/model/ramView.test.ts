import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import { compile } from './compile';
import type { ChipDef, ChipLibrary } from './types';
import { board, chipComp, comp, memChipDef, memWrapDef } from './testFixtures';
import {
  changedAddresses,
  hasRam,
  lastWritten,
  listRams,
  ramCells,
  typedValue,
  withBitFlipped,
  withCell,
  type RamEntry,
} from './ramView';
import { ramAddress, ramSize } from '../sim/primitives/ram';

const libOf = (...defs: ChipDef[]): ChipLibrary => new Map(defs.map((d) => [d.id, d]));
const k = (v: number, w = 8) => bv.known(v, w);
const X = (w = 8) => bv.allX(w);

function entry(over: Partial<RamEntry> = {}): RamEntry {
  return {
    index: 0,
    componentId: 'main/m',
    title: 'm',
    width: 8,
    addressBits: 2,
    invertedOut: false,
    preload: '',
    target: { kind: 'preload', componentId: 'm' },
    misfit: false,
    ...over,
  };
}

describe('listRams', () => {
  it('finds top-level, grouped and in-chip RAMs with their write targets', () => {
    const b = board({
      components: [
        comp('m', 'ram', { width: 4, addressBits: 3, preload: '1 2' }, 'MEM'),
        { ...comp('g1m', 'ram', { invertedOut: true }), group: 'g' },
        chipComp('u1', 'mem', 'U1', { r1: 'AA' }),
        chipComp('u2', 'wrap', 'U2'),
      ],
      groups: [{ id: 'g', name: 'G' }],
    });
    const rams = listRams(compile(b, libOf(memChipDef(), memWrapDef())));
    const byTitle = new Map(rams.map((r) => [r.title, r]));
    expect(byTitle.get('MEM')).toMatchObject({
      componentId: 'main/m',
      width: 4,
      addressBits: 3,
      preload: '1 2',
      target: { kind: 'preload', componentId: 'm' },
    });
    const grouped = rams.find((r) => r.componentId === 'main/g1m')!;
    expect(grouped.target).toEqual({ kind: 'preload', componentId: 'g1m' });
    expect(grouped.invertedOut).toBe(true);
    expect(byTitle.get('U1/r1')).toMatchObject({
      preload: 'AA',
      target: { kind: 'contents', instanceId: 'u1', key: 'r1' },
    });
    expect(byTitle.get('U2/M/r1')?.target).toEqual({
      kind: 'contents',
      instanceId: 'u2',
      key: 'M/r1',
    });
    expect(rams.every((r) => !r.misfit)).toBe(true);
  });

  it('flags a kept entry too big for the RAM it reaches', () => {
    const b = board({ components: [chipComp('u1', 'mem', 'U1', { r1: '1 2 3 4 5 6 7 8 9' })] });
    const [ram] = listRams(compile(b, libOf(memChipDef())));
    expect(ram!.misfit).toBe(true);
    expect(ram!.preload).toBe('01 02');
  });
});

describe('hasRam', () => {
  it('finds a RAM on the board or nested in chips, and none on a plain board', () => {
    const lib = libOf(memChipDef(), memWrapDef());
    expect(hasRam(board({ components: [comp('m', 'ram')] }), lib)).toBe(true);
    expect(hasRam(board({ components: [chipComp('u', 'wrap', 'U')] }), lib)).toBe(true);
    expect(hasRam(board({ components: [comp('a', 'and')] }), lib)).toBe(false);
    expect(hasRam(board({ components: [chipComp('u', 'gone', 'U')] }), lib)).toBe(false);
  });
});

describe('cell edits', () => {
  it('sets, clears and flips one cell, trimming trailing X', () => {
    const e = entry({ preload: '01 02' });
    expect(withCell(e, 3, 0xff)).toBe('01 02 X FF');
    expect(withCell(e, 1, null)).toBe('01');
    expect(withBitFlipped(e, 0, 7)).toBe('81 02');
  });

  it('flips a bit of an X cell from all zeros', () => {
    expect(withBitFlipped(entry(), 2, 0)).toBe('X X 01');
  });

  it('flips the top bit of a 32-bit cell', () => {
    const e = entry({ width: 32, addressBits: 1, preload: '0' });
    expect(withBitFlipped(e, 0, 31)).toBe('80000000');
  });

  it('masks a typed value to the width', () => {
    expect(typedValue('', 8)).toBeNull();
    expect(typedValue('F', 3)).toBe(7);
    expect(typedValue('2F', 8)).toBe(0x2f);
  });

  it('reads cells for every address', () => {
    expect(ramCells(entry({ preload: '0A' })).map((c) => bv.toString(c, 8))).toEqual([
      '00001010',
      'XXXXXXXX',
      'XXXXXXXX',
      'XXXXXXXX',
    ]);
  });
});

describe('run comparison', () => {
  it('counts addresses whose printed cell differs, partial X as X', () => {
    const partial = { v: 0, x: 1, z: 0 };
    expect(changedAddresses([k(1), X(), X()], [k(1), k(2), partial], 8)).toEqual([1]);
  });

  it('names the highest address a write changed', () => {
    expect(lastWritten([k(1), k(2)], [k(1), k(2)])).toBeNull();
    expect(lastWritten([k(1), k(2), k(3)], [k(9), k(2), k(8)])).toBe(2);
  });
});

describe('ram helpers', () => {
  it('reads the size clamped as the primitive clamps it', () => {
    expect(ramSize({ width: 99, addressBits: 0 })).toEqual({
      width: 32,
      addressBits: 1,
      invertedOut: false,
    });
  });

  it('reads the address from a bus or from lanes, null while any bit is unknown', () => {
    expect(ramAddress({ addressBits: 4 }, [k(5, 4)])).toBe(5);
    expect(ramAddress({ addressBits: 4 }, [{ v: 0, x: 1, z: 0 }])).toBeNull();
    expect(ramAddress({ addressBits: 4 }, [{ v: 0, x: 0, z: 2 }])).toBeNull();
    const lanes = { addressBits: 2, pinView: 'a=expanded' };
    expect(ramAddress(lanes, [k(1, 1), k(0, 1)])).toBe(2);
  });
});
