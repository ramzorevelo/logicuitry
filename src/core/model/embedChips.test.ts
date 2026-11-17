import { describe, expect, it } from 'vitest';
import { builtinChipLibrary } from '../parts/packages';
import { chipsThatDiffer, chipsUsedBy } from './embedChips';
import type { Board, ChipDef, Component } from './types';

const inst = (id: string, defId: string): Component => ({
  id,
  kind: 'chip',
  defId,
  pos: { x: 0, y: 0 },
});

const chip = (id: string, uses: string[] = [], extra: Partial<ChipDef> = {}): ChipDef => ({
  format: 'lcir.chip',
  formatVersion: 8,
  id,
  name: id,
  version: 1,
  pins: [],
  components: uses.map((u, i) => inst(`u${i}`, u)),
  wires: [],
  junctions: [],
  ...extra,
});

const boardUsing = (...defIds: string[]): Board => ({
  format: 'lcir.board',
  formatVersion: 16,
  id: 'b',
  name: 'b',
  components: defIds.map((d, i) => inst(`c${i}`, d)),
  wires: [],
  junctions: [],
  probes: [],
  view: { x: 0, y: 0, zoom: 1 },
  timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
  runSpeed: 25_000,
});

const lib = (...defs: ChipDef[]) => new Map(defs.map((d) => [d.id, d]));
const ids = (defs: ChipDef[]) => defs.map((d) => d.id);

describe('chipsUsedBy', () => {
  it('follows nested chips transitively', () => {
    const a = chip('a', ['b']);
    const b = chip('b', ['c']);
    const c = chip('c');
    const unused = chip('z');
    expect(ids(chipsUsedBy(boardUsing('a'), lib(a, b, c, unused)))).toEqual(['a', 'b', 'c']);
  });

  it('survives a cycle', () => {
    const a = chip('a', ['b']);
    const b = chip('b', ['a']);
    expect(ids(chipsUsedBy(boardUsing('a'), lib(a, b)))).toEqual(['a', 'b']);
  });

  it('skips a missing def, or takes the previous copy', () => {
    const old = chip('gone', [], { version: 3 });
    expect(chipsUsedBy(boardUsing('gone'), lib())).toEqual([]);
    expect(chipsUsedBy(boardUsing('gone'), lib(), [old])).toEqual([old]);
  });

  it('prefers the library over the previous copy', () => {
    const fresh = chip('a', [], { version: 2 });
    expect(chipsUsedBy(boardUsing('a'), lib(fresh), [chip('a')])).toEqual([fresh]);
  });

  it('includes a user def that shadows a built-in id and excludes the built-in', () => {
    const builtin = builtinChipLibrary().get('74LS00')!;
    const shadow = chip('74LS00');
    expect(chipsUsedBy(boardUsing('74LS00'), new Map([['74LS00', builtin]]))).toEqual([]);
    expect(chipsUsedBy(boardUsing('74LS00'), new Map([['74LS00', shadow]]))).toEqual([shadow]);
  });

  it('orders by id whatever the board order', () => {
    const library = lib(chip('m'), chip('b'), chip('x'));
    expect(ids(chipsUsedBy(boardUsing('x', 'm', 'b'), library))).toEqual(['b', 'm', 'x']);
    expect(ids(chipsUsedBy(boardUsing('b', 'x', 'm'), library))).toEqual(['b', 'm', 'x']);
  });
});

describe('chipsThatDiffer', () => {
  it('ignores version and hidden checks', () => {
    const a = chip('a');
    const loaded = lib({ ...a, version: 9, hiddenChecks: ['unwired:u0.a'] });
    expect(chipsThatDiffer([a], loaded)).toEqual([]);
  });

  it('reports a real change, and only for ids present in both', () => {
    const a = chip('a');
    const changed = chip('a', ['q']);
    expect(chipsThatDiffer([a, chip('only-embedded')], lib(changed))).toEqual(['a']);
  });

  it('does not count a built-in loaded def', () => {
    const builtin = builtinChipLibrary().get('74LS00')!;
    expect(chipsThatDiffer([chip('74LS00')], new Map([['74LS00', builtin]]))).toEqual([]);
  });

  it('is indifferent to key order', () => {
    const a = chip('a');
    const reordered = JSON.parse(JSON.stringify(a, Object.keys(a).reverse())) as ChipDef;
    expect(chipsThatDiffer([a], lib(reordered))).toEqual([]);
  });
});
