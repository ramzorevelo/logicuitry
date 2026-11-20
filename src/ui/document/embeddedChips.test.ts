import { describe, expect, it } from 'vitest';
import { builtinChipLibrary } from '../../core/parts/packages';
import type { Board, ChipDef, Component } from '../../core/model/types';
import { boardAsSaved, boardWithChips, planEmbedded, withoutChips } from './embeddedChips';

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

const boardUsing = (defIds: string[], chips?: ChipDef[]): Board => ({
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
  ...(chips ? { chips } : {}),
});

const lib = (...defs: ChipDef[]) => new Map(defs.map((d) => [d.id, d]));
const ids = (defs: readonly ChipDef[]) => defs.map((d) => d.id);

describe('boardWithChips', () => {
  it('embeds the nested user chips the board uses', () => {
    const a = chip('a', ['b']);
    const b = chip('b');
    const saved = boardWithChips(boardUsing(['a']), lib(a, b, chip('unused')), true);
    expect(ids(saved.chips ?? [])).toEqual(['a', 'b']);
  });

  it('writes no chips field with the setting off, even if the board carried one', () => {
    const saved = boardWithChips(boardUsing(['a'], [chip('a')]), lib(chip('a')), false);
    expect('chips' in saved).toBe(false);
  });

  it('carries a missing chip through from the copy the board was opened with', () => {
    const old = chip('gone', [], { version: 4 });
    const saved = boardWithChips(boardUsing(['gone'], [old]), lib(), true);
    expect(saved.chips).toEqual([old]);
  });

  it('writes no field for a board of built-in parts only', () => {
    const builtins = builtinChipLibrary();
    const [part] = [...builtins.keys()];
    expect('chips' in boardWithChips(boardUsing([part!]), builtins, true)).toBe(false);
  });
});

describe('boardAsSaved', () => {
  it('embeds the open copy of a chip, not the stale one the board carried', () => {
    const open = chip('a', [], { version: 2 });
    const stale = chip('a', [], { version: 1 });
    const saved = boardAsSaved(boardUsing(['a'], [stale]), lib(open), true);
    expect(saved.chips).toEqual([open]);
    expect('chips' in boardAsSaved(boardUsing(['a'], [stale]), lib(open), false)).toBe(false);
  });
});

describe('planEmbedded', () => {
  it('loads what is missing and asks only about real differences', () => {
    const same = chip('same');
    const changed = chip('changed', [], { name: 'new name' });
    const board = boardUsing([], [chip('missing'), same, chip('changed')]);
    const plan = planEmbedded(board, lib({ ...same, version: 9 }, changed), new Set());
    expect(ids(plan.load)).toEqual(['missing']);
    expect(ids(plan.differ)).toEqual(['changed']);
    expect(plan.kept).toEqual([]);
  });

  it('never offers to replace a chip whose tab has unsaved edits', () => {
    const board = boardUsing([], [chip('a')]);
    const plan = planEmbedded(board, lib(chip('a', [], { name: 'edited' })), new Set(['a']));
    expect(plan.differ).toEqual([]);
    expect(plan.kept).toEqual(['a']);
  });

  it('asks before a board chip replaces a built-in part, and not for an identical one', () => {
    const builtins = builtinChipLibrary();
    const [part] = [...builtins.keys()];
    const shadow = chip(part!, [], { name: 'my own' });
    const plan = planEmbedded(boardUsing([], [shadow]), builtins, new Set());
    expect(plan.load).toEqual([]);
    expect(plan.differ).toEqual([shadow]);
    expect(plan.builtin).toEqual([part]);
    const same = planEmbedded(boardUsing([], [builtins.get(part!)!]), builtins, new Set());
    expect(same.differ).toEqual([]);
  });

  it('a built-in id with different pins is a warning, not a block', () => {
    const builtins = builtinChipLibrary();
    const [part] = [...builtins.keys()];
    const pin = { id: 'p', name: 'A', dir: 'in', width: 1, role: 'data', order: 0 } as never;
    const shadow = chip(part!, [], { name: 'my own', pins: [pin] });
    const plan = planEmbedded(boardUsing([], [shadow]), builtins, new Set());
    expect(plan.builtinPinMismatch).toEqual([part]);
    expect(plan.pinMismatch).toEqual([]);
  });

  it('flags a differing chip whose pins changed, and one with a clean tab open', () => {
    const pin = { id: 'p', name: 'A', dir: 'in', width: 1, role: 'data', order: 0 } as never;
    const board = boardUsing([], [chip('a', [], { name: 'new', pins: [pin] }), chip('b')]);
    const library = lib(chip('a'), chip('b', [], { name: 'old' }));
    const plan = planEmbedded(board, library, new Set(), new Set(['b']));
    expect(plan.pinMismatch).toEqual(['a']);
    expect(plan.tabbed).toEqual(['b']);
  });
});

describe('withoutChips', () => {
  it('returns the same object when there is nothing to strip', () => {
    const board = boardUsing([]);
    expect(withoutChips(board)).toBe(board);
  });
});
